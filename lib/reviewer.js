'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('./commands');
const L = require('./ladder');
const { refuse, shaMatch } = require('./util');

// One short patch and a handful of files can be checked without a repository tour.
const DEFAULTS = { small_lines: 100, small_files: 5, risk_paths: [] };
const RATE_KEYS = ['input', 'cache_write', 'cache_read', 'output'];
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);

function errors(config) {
  if (config === undefined) return [];
  if (!object(config)) return ['review must be an object'];
  const errs = [];
  for (const key of Object.keys(config)) if (![...Object.keys(DEFAULTS), 'prices'].includes(key)) errs.push(`unknown review field ${key}`);
  for (const key of ['small_lines', 'small_files']) {
    if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < 0)) errs.push(`review.${key} must be a non-negative safe integer`);
  }
  if (config.risk_paths !== undefined && (!Array.isArray(config.risk_paths) || !config.risk_paths.every((s) => typeof s === 'string' && s.trim()))) {
    errs.push('review.risk_paths must be an array of non-blank globs');
  }
  if (config.prices !== undefined) {
    if (!object(config.prices)) errs.push('review.prices must be a model price table');
    else {
      const identities = new Set();
      for (const [model, rates] of Object.entries(config.prices)) {
        const identity = L.modelIdentity(model);
        if (!model.trim() || !object(rates) || RATE_KEYS.some((key) => !Number.isFinite(rates[key]) || rates[key] < 0)
          || Object.keys(rates).some((key) => !RATE_KEYS.includes(key))) {
          errs.push(`review.prices.${model} needs non-negative input, cache_write, cache_read and output rates per million tokens`);
        }
        if (identities.has(identity)) errs.push(`review.prices has more than one entry for model ${identity}`);
        identities.add(identity);
      }
    }
  }
  return errs;
}

function canonicalPolicy(config) {
  if (!object(config) || !object(config.prices)) return config;
  const prices = Object.fromEntries(Object.entries(config.prices)
    .map(([model, rates]) => [L.modelIdentity(model), rates]));
  return { ...config, prices };
}

function modelOf(rung, env = process.env) {
  if (rung.harness === 'command') return L.modelIdentity(L.identity(rung));
  if (rung.model) {
    const provider = require('./claude-provider');
    return L.modelIdentity(provider.selected(rung) ? provider.model(rung.provider, rung.model) : rung.model);
  }
  if (rung.harness === 'codex' && rung.profile) {
    const home = env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.codex');
    const TOML = require('./toml');
    for (const file of [`${rung.profile}.config.toml`, 'config.toml']) {
      try {
        const doc = TOML.parse(fs.readFileSync(path.join(home, file), 'utf8'));
        const model = file === 'config.toml'
          ? doc.profiles?.[rung.profile]?.model || (L.modelIdentity(rung.profile) !== rung.profile ? rung.profile : doc.model)
          : doc.model;
        if (typeof model === 'string' && model) return L.modelIdentity(model);
      } catch {
        // Profiles without a readable model keep their configured identity.
      }
    }
  }
  return L.modelIdentity(rung.profile || '');
}

function builderOf(st, task, layers, env) {
  const spawn = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.agent === task.submitted_by && e.detail.role === 'worker');
  return modelOf(spawn?.detail.route || L.rungOf(layers, task.tier), env);
}

function diffOf(repo, project, task) {
  if (task.stack && !task.stack_disabled) project = { ...project, base: task.stack.base };
  const git = (args) => {
    try {
      return cp.execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      throw refuse(`${task.id}: cannot read the submitted diff; fetch ${project.base} and ${task.sha} before review`);
    }
  };
  const sha = git(['rev-parse', '--verify', `${task.sha}^{commit}`]).trim();
  const refs = project.base.startsWith('origin/') ? [project.base] : [project.base, `origin/${project.base}`];
  let base;
  for (const ref of refs) {
    let candidate;
    try { candidate = git(['merge-base', ref, sha]).trim(); } catch { continue; }
    if (!base) base = candidate;
    else if (candidate !== base) {
      try {
        git(['merge-base', '--is-ancestor', base, candidate]);
        base = candidate;
      } catch {
        // Keep the nearer base already found on a different history.
      }
    }
  }
  if (!base) throw refuse(`${task.id}: cannot read the submitted diff; fetch ${project.base} before review`);
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const files = git([...args, '--name-only', '-z', base, sha]).split('\0').filter(Boolean);
  const stats = git([...args, '--numstat', '-z', base, sha]).split('\0').filter(Boolean);
  const binary = stats.some((line) => line.startsWith('-\t'));
  const lines = stats.reduce((n, line) => {
    const [add, del] = line.split('\t');
    return n + (Number(add) || 0) + (Number(del) || 0);
  }, 0);
  return { sha, base, files, lines, binary, text: git([...args, base, sha]), submitted_sha: task.sha, project_base: project.base,
    tree: require('./scope').tree(repo.root, [base, sha]) };
}

function checkedDiff(diff, project, task) {
  if (diff.submitted_sha !== task.sha || diff.project_base !== project.base) {
    throw refuse(`${task.id}: submitted head or base changed after diff preparation; retry review dispatch`);
  }
  return diff;
}

function softwareReport(st, task, preparedCI) {
  const report = require('./tasks').gateReport(task, st.events, st, preparedCI);
  const gates = report.gates.filter((g) => g.type !== 'review');
  return { ok: !!task.sha && gates.every((g) => g.ok), gates, missing: gates.filter((g) => !g.ok).map((g) => `${g.type}: ${g.reason}`) };
}

function cost(entry, rates) {
  if (!rates || ['input', 'cached', 'output'].some((key) => !Number.isSafeInteger(entry[key]) || entry[key] < 0)) return null;
  const fresh = entry.input - entry.cached;
  if (fresh < 0 || (entry.cache_write != null && (!Number.isSafeInteger(entry.cache_write) || entry.cache_write < 0 || entry.cache_write > fresh))) return null;
  // Older inclusive telemetry cannot separate cache writes. Price that part at
  // the higher rate so missing write accounting cannot make a model look cheap.
  const inputCost = entry.cache_write == null
    ? fresh * Math.max(rates.input, rates.cache_write)
    : (fresh - entry.cache_write) * rates.input + entry.cache_write * rates.cache_write;
  return (inputCost + entry.cached * rates.cache_read + entry.output * rates.output) / 1000000;
}

function medians(st, prices, env) {
  const samples = new Map();
  const ratesByModel = new Map(Object.entries(prices || {}).map(([model, rates]) => [L.modelIdentity(model), rates]));
  for (const task of st.tasks.tasks) for (const entry of task.spend.entries || []) {
    // A running reviewer's partial reading is not its cost until exit finalizes it.
    if (entry.agent === task.submitted_by || entry.live) continue;
    const spawn = st.events.find((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.agent === entry.agent && e.detail.role === 'reviewer');
    if (entry.rung !== 'review' && !spawn) continue;
    const model = entry.model || modelOf({ harness: entry.harness, profile: entry.profile }, env);
    const identity = L.modelIdentity(model);
    const value = cost(entry, ratesByModel.get(identity));
    if (value === null || !Number.isFinite(value)) continue;
    if (!samples.has(identity)) samples.set(identity, []);
    samples.get(identity).push(value);
  }
  return new Map([...samples].map(([model, values]) => {
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return [model, values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2];
  }));
}

function choose(st, task, layers, diff, env) {
  const config = { ...DEFAULTS, ...st.project.review };
  const builder = builderOf(st, task, layers, env);
  const { globToRegExp } = require('./gates/tests');
  const risk = diff.binary || config.risk_paths.some((glob) => diff.files.some((file) => globToRegExp(glob).test(file)));
  const broad = diff.lines > config.small_lines || diff.files.length > config.small_files;
  let level = L.TIERS.indexOf(task.tier);
  if (broad) level = Math.max(level, 1);
  if (risk) level = Math.max(level, 2);
  const failures = task.evidence.filter((e) => e.type === 'review' && !e.ok && e.revision === task.revision && shaMatch(e.sha, task.sha)
    && require('./tasks').eligibleGateEvidence(task, e, st.events));
  level += failures.length;
  for (const failure of failures) {
    const prior = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.agent === failure.agent
      && e.detail.role === 'reviewer' && shaMatch(e.detail.sha, task.sha) && e.detail.revision === task.revision);
    const rank = L.TIERS.indexOf(prior?.detail.review_rung);
    if (rank >= 0) level = Math.max(level, rank + 1);
  }
  level = Math.min(L.TIERS.length - 1, level);
  const candidates = L.TIERS.slice(level).map((name) => ({ name, rung: L.rungOf(layers, name) }))
    .filter((c) => !L.rungErrors(c.name, layers.ladder[c.name], layers).length);
  const fallback = { name: 'review', rung: L.rungOf(layers, 'review') };
  const canFallback = !L.rungErrors('review', layers.ladder.review, layers).length;
  let selected = candidates[0];
  if (!selected) selected = canFallback ? fallback : null;
  if (!selected) throw refuse(`${task.id}: no runnable reviewer rung at or above ${L.TIERS[level]} and no runnable review fallback`);
  const costs = medians(st, config.prices, env);
  let current = costs.get(L.modelIdentity(modelOf(selected.rung, env)));
  for (const candidate of candidates) {
    if (selected.name === 'review' || L.TIERS.indexOf(candidate.name) <= L.TIERS.indexOf(selected.name)) continue;
    if (L.modelIdentity(modelOf(candidate.rung, env)) === L.modelIdentity(modelOf(selected.rung, env))) continue;
    const next = costs.get(L.modelIdentity(modelOf(candidate.rung, env)));
    if (current !== undefined && next !== undefined && next <= current) {
      selected = candidate;
      current = next;
    }
  }
  return { ...selected, builder, level: L.TIERS[level], median_cost: current ?? null, risk };
}

function reviewerSection(st, task) {
  const file = require('./tasks').briefPath(st.dir, task.id);
  let brief;
  try {
    brief = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  return require('./brief').sections(brief).content.reviewer.join('\n').trim();
}

// The scope gate's finding for the reviewer: files the diff changes outside
// the paths the task names, each to be justified by the task or sent back.
function scopeSection(st, task, diff) {
  if (!diff.tree) return '';
  const Scope = require('./scope');
  const scope = Scope.check({ task, brief: Scope.briefText(require('./tasks').briefPath(st.dir, task.id)), files: diff.files, tree: diff.tree, project: st.project });
  if (!scope.outside.length) return `## Scope\n\n${Scope.line(scope)}.`;
  return `## Scope\n\n${Scope.line(scope)}.\nCheck that the task needs each of these files; an unneeded change outside the task is a finding.`;
}

function staticContext(root, rules, standards, skill, env) {
  const plugin = env.TOWER_CRANE_PLUGIN_ROOT || path.join(__dirname, '..');
  const read = (file) => {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  };
  // Worktree paths change for each task; labels relative to the checkout keep
  // unchanged documents in the same cache prefix.
  const label = (file) => {
    const relative = path.relative(root, file);
    return (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ? file : relative).split(path.sep).join('/');
  };
  const section = (file, heading) => {
    const lines = read(file).split('\n');
    const start = lines.indexOf(heading);
    if (start < 0) return '';
    const level = heading.match(/^#+/)[0].length;
    let end = start + 1;
    let fence = null;
    for (; end < lines.length; end++) {
      const mark = /^ {0,3}(`{3,}|~{3,})/.exec(lines[end]);
      if (mark) {
        if (!fence) fence = mark[1];
        else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
      }
      if (!fence && new RegExp(`^#{1,${level}} `).test(lines[end])) break;
    }
    return lines.slice(start, end).join('\n').trim();
  };
  const profile = standards === 'default' ? path.join(plugin, 'standards', 'default.md') : path.resolve(root, standards);
  return [
    skill,
    '## House rules\n\nThe owner\'s task instructions take precedence. These rule contents are a snapshot for this dispatch, general first and nearest last. Imported rule files are included below.',
    ...rules.map((r) => `### ${r.scope}: ${label(r.path)}\n\n${read(r.path)}`),
    `## Standards: ${standards}\n\n${read(profile)}`,
    ...[
      ['docs/state.md', '### Acceptance gates'],
      ['docs/cli.md', '## Gates'],
    ].map(([file, heading]) => {
      const text = section(path.join(root, file), heading);
      return text ? `## Review contract: ${file}\n\n${text}` : '';
    }),
  ].filter(Boolean).join('\n\n');
}

function context(st, task, diff, report, selection, includeDiff = true) {
  const T = require('./tasks');
  const gates = report.gates.map((g) => {
    const entry = T.latestGateEvidence(task, g.type, st.events);
    return { type: g.type, ok: g.ok, waived: !!g.waived, summary: entry?.summary || g.reason,
      sha: entry?.sha, revision: entry?.revision, source: entry?.source, tests_mode: entry?.tests_mode,
      commands: entry?.commands, receipt: entry?.receipt };
  });
  const research = require('./research');
  const needsSources = research.required(task);
  const sources = needsSources ? T.latestGateEvidence(task, 'sources', st.events) : null;
  return [
    `Review ${task.id} at ${diff.sha}${task.pr ? ` (PR #${task.pr})` : ''}. Follow skills/tower-crane-review/SKILL.md.`,
    `Selected ${selection.name}; complexity ${selection.level}; builder model ${selection.builder}.`,
    `Standards: ${st.project.standards}. Base: ${diff.base}.`,
    'Use the supplied gate results. Do not re-run the full suite unless you change something in a scratch checkout to probe a specific concern. Run only the affected tests for that probe. Read surrounding code only where the diff requires it.',
    `Review only ${diff.sha}. If worktree HEAD differs, read surrounding files with git show ${diff.sha}:<path>.`,
    reviewerSection(st, task),
    scopeSection(st, task, diff),
    '## Gate results', JSON.stringify(gates, null, 2),
    ...(needsSources ? [
      `Read ${research.deliverable(task)} at ${diff.sha}. Check each claim maps to a cited source and that its quote supports the claim. Check source credibility and any factual claims outside the structured claims array.`,
      ...(sources?.receipt ? ['## Sources receipt', JSON.stringify(sources.receipt, null, 2)] : []),
    ] : []),
    ...(includeDiff ? ['## Diff', diff.text] : []),
  ].filter(Boolean).join('\n\n');
}

module.exports = { cost, errors, canonicalPolicy, modelOf, diffOf, checkedDiff, softwareReport, choose, staticContext, context };
