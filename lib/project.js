'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { refuse, usage, conflict } = require('./util');
const S = require('./state');
const L = require('./ladder');
const testsPolicy = require('./tests-policy');
const SpawnSettings = require('./spawn-settings');
const Authority = require('./authority');
const RouteGrants = require('./route-grants');

// The setting each guarded init and project set flag changes
// (lib/authority.js classifies them). Budget flags are classified by
// direction in settingsOf.
const FLAG_SETTINGS = {
  'tests-cmd': 'gates.tests_cmd',
  'clean-cmd': 'gates.clean_cmd',
  'clean-paths': 'gates.clean_paths',
  'tests-proof-cmd': 'gates.tests_proof_cmd',
  executors: 'gates.executors',
  'tests-timeout-min': 'gates.tests_timeout_min',
  'clean-timeout-min': 'gates.clean_timeout_min',
  'host-probe-timeout-min': 'gates.host_probe_timeout_min',
  'tmp-root': 'gates.tmp_root',
  'rework-hold-min': 'gates.rework_hold_min',
  'final-review': 'gates.final_review',
  'gates-cpu-weight': 'gates.cpu_weight',
  'agents-cpu-weight': 'agents.cpu_weight',
  'ci-required': 'ci.required',
  'ci-ignore-apps': 'ci.ignore_apps',
  'ci-capped-review': 'ci.capped_review',
  'ci-local': 'ci.local',
  'ci-dispatch': 'ci.dispatch',
  'tests-paths': 'tests.paths',
  'tests-keep': 'tests.keep',
  'tests-host-only': 'tests.host_only',
  'tests-host-env': 'tests.host_env',
  'tests-mode': 'tests.mode',
  'tests-by-kind': 'tests.by_kind',
  'tests-expensive': 'tests.expensive',
  'tests-map': 'tests.map',
  'tests-crucial': 'tests.crucial',
  'research-min-sources': 'research.min_sources',
  workers: 'limits.workers',
  'lease-minutes': 'limits.lease_minutes',
  owners: 'limits.owners',
  'owner-idle-minutes': 'limits.owner_idle_minutes',
  paused: 'limits.paused',
  'tasks-max': 'resources.tasks_max',
  'memory-max-bytes': 'resources.memory_max_bytes',
  'merge-keep-branch': 'merge.keep_branch',
  'merge-admin': 'merge.admin',
  'decision-delegation': 'decision_delegation',
  'publish-policy': 'publish.policy',
  'review-policy': 'review',
  governor: 'governor',
  'session-bus': 'sandbox.session_bus',
  ...Object.fromEntries(SpawnSettings.FIELDS.map((k) => [k, k])),
};

// A limit of null is no limit, so lowering from none is setting one.
function budgetSetting(before, after) {
  if (after === before) return 'budget.lower';
  if (after === null || after === undefined) return 'budget.raise';
  return before === null || before === undefined || after <= before ? 'budget.lower' : 'budget.raise';
}

function settingsOf(flags, project) {
  const out = Object.keys(FLAG_SETTINGS).filter((k) => flags[k] !== undefined).map((k) => FLAG_SETTINGS[k]);
  for (const [flag, key] of [['budget-hours', 'hours'], ['budget-tokens', 'tokens']]) {
    if (flags[flag] !== undefined) out.push(budgetSetting(project?.budget?.[key] ?? null, flags[flag]));
  }
  return out;
}

function requested(flags, settings) {
  const names = Object.entries(FLAG_SETTINGS).filter(([, s]) => settings.includes(s)).map(([f]) => f);
  if (settings.includes('budget.raise')) names.push('budget-hours', 'budget-tokens');
  const out = Object.fromEntries(names.filter((f) => flags[f] !== undefined).map((f) => [f, flags[f]]));
  return Object.keys(out).length ? out : null;
}

function githubSlug(url) {
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url || '');
  return m ? m[1] : null;
}

function checkRepoSlug(v) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(v)) throw usage(`--repo must look like owner/repo, got "${v}"`);
}

function resolveStandards(value, cwd, repo) {
  if (value === 'default') return 'default';
  const abs = path.resolve(cwd, value);
  try {
    fs.readFileSync(abs, 'utf8');
  } catch {
    throw refuse(`standards file ${abs} cannot be read; pass "default" or a readable Markdown file`);
  }
  if (repo) {
    const rel = path.relative(repo.root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return abs;
}

function applyListSetting(project, f, flag, section, key, allowEmpty) {
  if (f[flag] === undefined) return;
  const message = `--${flag} must be a ${allowEmpty ? '' : 'non-empty '}JSON array of non-blank strings or null`;
  let list;
  try {
    list = JSON.parse(f[flag]);
  } catch {
    throw usage(message);
  }
  const current = project[section];
  const settings = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  if (list === null) {
    delete settings[key];
    if (Object.keys(settings).length) project[section] = settings;
    else delete project[section];
    return;
  }
  if (!Array.isArray(list) || (!allowEmpty && !list.length) || !list.every((s) => typeof s === 'string' && s.trim())) {
    throw usage(message);
  }
  project[section] = { ...settings, [key]: list.map((s) => s.trim()) };
}

function applyTestsPolicy(project, f) {
  for (const [flag, key] of [['tests-mode', 'mode'], ['tests-by-kind', 'by_kind'], ['tests-expensive', 'expensive'], ['tests-map', 'map'], ['tests-crucial', 'crucial']]) {
    if (f[flag] === undefined) continue;
    let value = f[flag] === 'null' ? null : f[flag];
    if (key !== 'mode') {
      try {
        value = JSON.parse(f[flag]);
      } catch {
        throw usage(`--${flag} ${testsPolicy.settingError(key, 'invalid')}`);
      }
    }
    const error = testsPolicy.settingError(key, value);
    if (error) throw usage(`--${flag} ${error}`);
    const current = project.tests;
    const settings = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    if (value === null) delete settings[key];
    else settings[key] = value;
    if (Object.keys(settings).length) project.tests = settings;
    else delete project.tests;
  }
}




// Flags shared by init and project set.
function applySettings(project, f, cwd, repo) {
  if (f['research-min-sources'] !== undefined) {
    const value = f['research-min-sources'];
    const errs = require('./research').errors({ min_sources: value });
    if (errs.length) throw usage(errs.join('; '));
    project.research = { min_sources: value };
  }
  const minuteFields = [...require('./gate-timeouts').FIELDS, ...require('./rework-hold').FIELDS];
  for (const key of [...require('./gate-commands').FIELDS, ...minuteFields, ...require('./gate-tmp').FIELDS]) {
    const flag = key.replaceAll('_', '-');
    if (f[flag] === undefined) continue;
    const value = f[flag] === 'null' ? null
      : minuteFields.includes(key) ? Number(f[flag]) : f[flag].trim();
    const bad = require('./gate-commands').errors({ [key]: value });
    if (bad.length) throw usage(`--${flag}: ${bad.join('; ')}`);
    const gates = project.gates && typeof project.gates === 'object' && !Array.isArray(project.gates) ? { ...project.gates } : {};
    if (value === null) delete gates[key];
    else gates[key] = value;
    if (Object.keys(gates).length) project.gates = gates;
    else delete project.gates;
  }
  for (const k of SpawnSettings.FIELDS) {
    if (f[k] === undefined) continue;
    if (f[k] === 'null') delete project[k];
    else {
      let value = f[k];
      if (k !== 'env_file') {
        try { value = JSON.parse(value); } catch { throw usage(`--${k} must be a JSON object or null`); }
      }
      const errs = SpawnSettings.errors({ [k]: value });
      if (errs.length) throw usage(errs.join('; '));
      project[k] = value;
    }
  }
  // Off is the default, so false removes the grant and an empty sandbox goes with it.
  if (f['session-bus'] !== undefined) {
    let on;
    try { on = JSON.parse(f['session-bus']); } catch { on = undefined; }
    if (typeof on !== 'boolean') throw usage('--session-bus must be true or false');
    const sandbox = { ...project.sandbox };
    if (on) sandbox.session_bus = true;
    else delete sandbox.session_bus;
    if (Object.keys(sandbox).length) project.sandbox = sandbox;
    else delete project.sandbox;
  }
  if (f.name !== undefined) {
    if (!f.name.trim()) throw usage('--name cannot be empty');
    project.name = f.name;
  }
  if (f.goal !== undefined) {
    if (!f.goal.trim()) throw usage('--goal cannot be empty');
    project.goal = f.goal;
  }
  if (f.repo !== undefined) {
    checkRepoSlug(f.repo);
    project.repo = f.repo;
  }
  if (f.base !== undefined) {
    if (!f.base.trim()) throw usage('--base cannot be empty');
    project.base = f.base;
  }
  for (const [flag, key] of [['gates-cpu-weight', 'gates'], ['agents-cpu-weight', 'agents']]) {
    if (f[flag] === undefined) continue;
    const value = f[flag] === 'null' ? null : Number(f[flag]);
    const C = require('./containment');
    if (value !== null && !C.validWeight(value)) {
      throw usage(`--${flag} must be an integer from ${C.WEIGHT_RANGE[0]} to ${C.WEIGHT_RANGE[1]} or null`);
    }
    const owner = project[key] && typeof project[key] === 'object' && !Array.isArray(project[key]) ? { ...project[key] } : {};
    if (value === null) delete owner.cpu_weight;
    else owner.cpu_weight = value;
    if (Object.keys(owner).length) project[key] = owner;
    else delete project[key];
  }
  if (f.executors !== undefined) {
    if (f.executors < 1) throw usage('--executors must be at least 1');
    project.gates = { ...project.gates, executors: f.executors };
  }
  if (f.workers !== undefined) {
    if (f.workers < 1) throw usage('--workers must be at least 1');
    project.limits.workers = f.workers;
  }
  if (f['lease-minutes'] !== undefined) {
    if (f['lease-minutes'] < 1) throw usage('--lease-minutes must be at least 1');
    project.limits.lease_minutes = f['lease-minutes'];
  }
  if (f.owners !== undefined) {
    if (f.owners < 0) throw usage('--owners cannot be negative; 0 has every worker exit after submit');
    project.limits.owners = f.owners;
  }
  if (f['owner-idle-minutes'] !== undefined) {
    if (!(f['owner-idle-minutes'] > 0)) throw usage('--owner-idle-minutes must be above 0');
    project.limits.owner_idle_minutes = f['owner-idle-minutes'];
  }
  for (const [flag, key] of [['tasks-max', 'tasks_max'], ['memory-max-bytes', 'memory_max_bytes']]) {
    if (f[flag] !== undefined) {
      if (!Number.isSafeInteger(f[flag]) || f[flag] < 1) throw usage(`--${flag} must be a positive integer`);
      project.resources = { ...project.resources, [key]: f[flag] };
    }
  }
  if (f['budget-hours'] !== undefined) {
    if (f['budget-hours'] < 0) throw usage('--budget-hours cannot be negative');
    project.budget.hours = f['budget-hours'];
  }
  if (f.paused !== undefined) {
    if (f.paused.trim()) project.limits.paused = f.paused.trim();
    else delete project.limits.paused;
  }
  if (f['budget-tokens'] !== undefined) {
    if (f['budget-tokens'] < 0) throw usage('--budget-tokens cannot be negative');
    project.budget.tokens = f['budget-tokens'];
  }
  if (f.standards !== undefined) project.standards = resolveStandards(f.standards, cwd, repo);
  if (f['review-policy'] !== undefined) {
    let config;
    try { config = JSON.parse(f['review-policy']); } catch { throw usage('--review-policy must be a JSON object or null'); }
    if (config === null) delete project.review;
    else {
      const errs = require('./reviewer').errors(config);
      if (errs.length) throw usage(errs.join('; '));
      project.review = require('./reviewer').canonicalPolicy(config);
    }
  }
  if (f.governor !== undefined) {
    let config;
    try { config = JSON.parse(f.governor); } catch { throw usage('--governor must be a JSON object or null'); }
    const errs = require('./governor').errors(config);
    if (errs.length) throw usage(errs.join('; '));
    if (config === null) delete project.governor;
    else project.governor = config;
  }
  if (f['final-review'] !== undefined) {
    let value;
    try { value = JSON.parse(f['final-review']); } catch { throw usage('--final-review must be a JSON object {command, when, capped_pattern, timeout, concerns_exit} or null'); }
    const gates = project.gates && typeof project.gates === 'object' && !Array.isArray(project.gates) ? { ...project.gates } : {};
    if (value === null) delete gates.final_review;
    else {
      const bad = require('./final-review').errors({ final_review: value });
      if (bad.length) throw usage(`--final-review: ${bad.join('; ')}`);
      gates.final_review = value;
    }
    if (Object.keys(gates).length) project.gates = gates;
    else delete project.gates;
  }
  applyListSetting(project, f, 'tests-paths', 'tests', 'paths', false);
  applyListSetting(project, f, 'clean-paths', 'gates', 'clean_paths', true);
  const gatePathsErrors = require('./gate-paths').errors(project.gates);
  if (gatePathsErrors.length) throw usage(`--clean-paths: ${gatePathsErrors.join('; ')}`);
  applyListSetting(project, f, 'tests-keep', 'tests', 'keep', true);
  applyListSetting(project, f, 'tests-host-only', 'tests', 'host_only', true);
  if (f['tests-host-env'] !== undefined) {
    let value;
    try { value = JSON.parse(f['tests-host-env']); } catch { throw usage('--tests-host-env must be a JSON map of environment names to string values or null'); }
    const error = require('./gates/tests').hostEnvError(value);
    if (error) throw usage(`--tests-host-env ${error}`);
    const current = project.tests;
    const settings = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    if (value === null) delete settings.host_env;
    else settings.host_env = value;
    if (Object.keys(settings).length) project.tests = settings;
    else delete project.tests;
  }
  applyTestsPolicy(project, f);
  applyListSetting(project, f, 'ci-ignore-apps', 'ci', 'ignore_apps', true);
  applyListSetting(project, f, 'ci-required', 'ci', 'required', true);
  if (f['ci-capped-review'] !== undefined) {
    let rules;
    try { rules = JSON.parse(f['ci-capped-review']); } catch { throw usage('--ci-capped-review must be a JSON array of {app, pattern} or null'); }
    const settings = project.ci && typeof project.ci === 'object' && !Array.isArray(project.ci) ? { ...project.ci } : {};
    if (rules === null) delete settings.capped_review;
    else {
      const bad = require('./ci-hosted').resolve({ ci: { capped_review: rules } }).error;
      if (bad) throw usage(`--ci-capped-review: ${bad}`);
      settings.capped_review = rules.map((rule) => ({ app: rule.app, pattern: rule.pattern }));
    }
    if (Object.keys(settings).length) project.ci = settings;
    else delete project.ci;
  }
  if (f['ci-dispatch'] !== undefined) {
    let value;
    try { value = JSON.parse(f['ci-dispatch']); } catch { throw usage('--ci-dispatch must be JSON {"workflow": "FILE.yml" or id, "per_hour": N} or null'); }
    const settings = project.ci && typeof project.ci === 'object' && !Array.isArray(project.ci) ? { ...project.ci } : {};
    if (value === null) delete settings.dispatch;
    else {
      const bad = require('./ci-dispatch').settings({ ci: { dispatch: value } }).error;
      if (bad) throw usage(`--ci-dispatch: ${bad}`);
      settings.dispatch = value;
    }
    if (Object.keys(settings).length) project.ci = settings;
    else delete project.ci;
  }
  for (const [flag, key] of [['merge-keep-branch', 'keep_branch'], ['merge-admin', 'admin']]) {
    if (f[flag] === undefined) continue;
    let value;
    try { value = JSON.parse(f[flag]); } catch { throw usage(`--${flag} must be true, false or null`); }
    if (value !== null && typeof value !== 'boolean') throw usage(`--${flag} must be true, false or null`);
    const settings = { ...project.merge };
    if (value === null) delete settings[key];
    else settings[key] = value;
    if (Object.keys(settings).length) project.merge = settings;
    else delete project.merge;
  }
  if (f['decision-delegation'] !== undefined) {
    const delegationUsage = '--decision-delegation must be an object with boolean orchestrator_technical and/or orchestrator_escalated_questions, or null';
    let delegation;
    try {
      delegation = JSON.parse(f['decision-delegation']);
    } catch {
      throw usage(delegationUsage);
    }
    if (delegation === null) {
      delete project.decision_delegation;
    } else {
      const keys = delegation && typeof delegation === 'object' && !Array.isArray(delegation) ? Object.keys(delegation) : [];
      if (!delegation || typeof delegation !== 'object' || Array.isArray(delegation)
        || keys.some((key) => !['orchestrator_technical', 'orchestrator_escalated_questions'].includes(key) || typeof delegation[key] !== 'boolean')) {
        throw usage(delegationUsage);
      }
      project.decision_delegation = delegation;
    }
  }
  if (f['publish-policy'] !== undefined) {
    const policy = require('./publish-policy').parse(f['publish-policy']);
    if (policy === null) delete project.publish_policy;
    else project.publish_policy = { conditions: policy.conditions };
  }
  if (f['ci-local'] !== undefined) {
    let local;
    try {
      local = JSON.parse(f['ci-local']);
    } catch {
      throw usage('--ci-local must be JSON {command: argv, timeout: seconds} or null');
    }
    const Local = require('./ci-local');
    if (local !== null && !Local.valid(local)) {
      throw usage(Local.receiptsError(local) || '--ci-local must have a nonempty command argv, a positive timeout in seconds (within Node timer range) and valid optional by_kind overrides, artifacts and receipts (relative globs without ..) and artifact_pattern (a regular expression), or null');
    }
    const settings = project.ci && typeof project.ci === 'object' && !Array.isArray(project.ci) ? { ...project.ci } : {};
    if (local === null) delete settings.local;
    else settings.local = local;
    if (Object.keys(settings).length) project.ci = settings;
    else delete project.ci;
  }
}

function addExclude(repo, stateDir) {
  const rel = path.relative(repo.root, stateDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  const line = rel === '.tower-crane' ? '.tower-crane/' : `/${rel.split(path.sep).join('/')}/`;
  const file = path.join(repo.commonDir, 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  if (text.split(/\r?\n/).includes(line)) return;
  fs.appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + line + '\n');
}

function ladderLines(layers) {
  const rows = L.RUNGS.map((n) => {
    const e = layers.ladder[n];
    return [n, e.harness_from === 'default' ? `${e.harness} (default)` : e.harness, L.describe(e.own), L.SOURCE[e.from]];
  });
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.flatMap((r) => [
    `  ${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2].padEnd(w[2])}  from ${r[3]}`.replace(/\s+$/, ''),
    ...(layers.ladder[r[0]].fallbacks || []).map((route, i) =>
      `    ${r[0]} fallback ${i + 1}  ${route.harness || layers.ladder[r[0]].harness}  ${L.describe(route)}  from user file ${layers.user_file}`),
    ...(layers.ladder[r[0]].fallbacks?.length === 0 ? [`    ${r[0]} fallbacks: [] from user file ${layers.user_file}`] : []),
  ]);
}

function summary(p, env) {
  const budget = [p.budget.hours != null ? `${p.budget.hours} h` : null, p.budget.tokens != null ? `${p.budget.tokens} tokens` : null].filter(Boolean).join(', ') || 'none';
  const head = [
    `${p.name}: ${p.goal}`,
    `repo: ${p.repo || '-'}  base: ${p.base}  standards: ${p.standards}`,
    `limits: ${p.limits.workers} workers, ${p.limits.lease_minutes} min lease, ${require('./ownership').limits(p).owners} PR owners idle up to ${require('./ownership').limits(p).idle_minutes} min  budget: ${budget}`,
    `resources: ${JSON.stringify(require('./containment').resolve(p))}`,
    `reviewer resources: ${JSON.stringify(require('./containment').resolve(p, 'reviewer'))}`,
    `orchestrator resources: ${JSON.stringify(require('./containment').resolve(p, 'orchestrator'))}`,
    `gate resources: ${JSON.stringify(require('./containment').resolveGate(p))}`,
    ...(p.limits.paused ? [`paused: ${p.limits.paused}`] : []),
    `tests.paths: ${p.tests?.paths == null ? 'default layouts' : JSON.stringify(p.tests.paths)}`,
    `tests.keep: ${JSON.stringify(p.tests?.keep ?? [])}`,
    `tests.host_only: ${JSON.stringify(p.tests?.host_only ?? [])}`,
    `tests.host_env: ${JSON.stringify(p.tests?.host_env ?? {})}`,
    `tests.mode: ${p.tests?.mode ?? 'prove'}`,
    `tests.by_kind: ${JSON.stringify(p.tests?.by_kind ?? {})}`,
    `tests.expensive: ${p.tests?.expensive ?? false}`,
    `tests.map: ${p.tests?.map == null ? 'not pinned' : JSON.stringify(p.tests.map)}`,
    `tests.crucial: ${p.tests?.crucial == null ? 'not pinned' : JSON.stringify(p.tests.crucial)}`,
    ...require('./gate-commands').FIELDS.map((key) => `gates.${key}: ${JSON.stringify(p.gates?.[key] ?? null)}`),
    `gates.clean_paths: ${JSON.stringify(p.gates?.clean_paths ?? [])}`,
    `gates.executors: ${p.gates?.executors ?? 2}`,
    ...['tests', 'clean', 'host_probe'].map((type) => `gates.${type}_timeout_min: ${require('./gate-timeouts').minutes(p, type)}`),
    `gates.tmp_root: ${JSON.stringify(p.gates?.tmp_root ?? null)}`,
    `gates.rework_hold_min: ${require('./rework-hold').minutes(p)}`,
    `gates.final_review: ${p.gates?.final_review == null ? 'off' : JSON.stringify(require('./final-review').settings(p) ?? p.gates.final_review)}`,
    `gates.cpu_weight: ${require('./containment').gateWeight(p)}`,
    `agents.cpu_weight: ${require('./containment').agentWeight(p)}`,
    `ci.ignore_apps: ${JSON.stringify(p.ci?.ignore_apps ?? [])}`,
    `ci.required: ${JSON.stringify(p.ci?.required ?? [])}`,
    `ci.capped_review: ${JSON.stringify(p.ci?.capped_review ?? [])}`,
    `ci.local: ${p.ci?.local == null ? 'hosted' : JSON.stringify(p.ci.local)}`,
    `ci.dispatch: ${JSON.stringify(require('./ci-dispatch').settings(p).policy ?? p.ci?.dispatch ?? null)}`,
    `merge.keep_branch: ${p.merge?.keep_branch ?? false}`,
    `merge.admin: ${p.merge?.admin ?? false}`,
    `decision_delegation.orchestrator_technical: ${p.decision_delegation?.orchestrator_technical ?? true}`,
    `decision_delegation.orchestrator_escalated_questions: ${p.decision_delegation?.orchestrator_escalated_questions ?? true}`,
    `review: ${p.review == null ? 'tier and diff defaults' : JSON.stringify(p.review)}`,
    `research.min_sources: ${require('./research').minimum(p)}`,
    `governor: ${p.governor == null ? 'defaults' : JSON.stringify(p.governor)}`,
    ...SpawnSettings.FIELDS.filter((k) => p[k] !== undefined).map((k) => `${k}: ${JSON.stringify(p[k])}`),
  ];
  // A broken user file must not hide a project set that already succeeded.
  let layers;
  try {
    layers = L.resolve(p, env);
  } catch (e) {
    return [...head, `ladder: ${e.message}`].join('\n');
  }
  return [...head, `ladder (default harness ${layers.harness}):`, ...ladderLines(layers)].join('\n');
}




function init(ctx) {
  // No state yet, so no decision to open: an owner-required setting waits
  // for the owner, and the orchestrator inits without it.
  const guarded = settingsOf(ctx.flags, null);
  const who = Authority.enforce(ctx, null, guarded);
  const f = ctx.flags;
  const dir = ctx.stateDir;
  const repo = S.findRepo(dir, ctx.cwd);
  // The defaults are checked where they come from, so a bad user file is
  // named as such instead of as this project's ladder.
  const defaults = L.resolve({}, ctx.env);
  const bad = L.check({}, ctx.env);
  if (bad.length) throw refuse(`the default ladder is invalid: ${bad.join('; ')}`);
  // Only the owner's init takes what the user file grants, and only an
  // owner at a terminal records its folder: anything running as the user can
  // write that file, and TOWER_CRANE_CONFIG names any file.
  // Named before anything else is resolved, so a second init says so.
  if (fs.existsSync(path.join(dir, 'project.json'))) {
    throw refuse(`Tower Crane state already exists at ${dir}; change it with tower-crane project set`);
  }
  const owner = who === 'owner';
  const copied = initLadder(defaults, ctx.env, owner);
  const notices = copied.withheld.map(withheldText);
  if (copied.withheld.length) notices.push('the owner grants these with tower-crane ladder set --agent owner, or approves the decision the orchestrator\'s same ladder set opens');
  // A headless owner proved the key in the default directory (checkOwner).
  const configDir = owner && !ctx.ownerConfigDir ? null : ctx.ownerConfigDir || Authority.defaultOwnerConfigDir();
  const userDir = Authority.canonicalPath(path.dirname(L.userFile(ctx.env)));
  if (configDir && userDir !== configDir) {
    notices.push(`owner_config_dir is the default ${configDir}, not ${userDir} where the user file ${L.userFile(ctx.env)} is; only the owner's init at a terminal records another (tower-crane init --agent owner)`);
  }
  fs.mkdirSync(path.join(dir, 'briefs'), { recursive: true });
  if (ctx.agent === 'orchestrator') require('./orchestrator').identity(ctx);
  const lock = S.acquireLock(dir);
  let project;
  try {
    if (fs.existsSync(path.join(dir, 'project.json'))) {
      throw refuse(`Tower Crane state already exists at ${dir}; change it with tower-crane project set`);
    }
    let base = 'main';
    let slug = null;
    if (repo) {
      const head = S.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo.root);
      if (head) base = head;
      slug = githubSlug(S.git(['remote', 'get-url', 'origin'], repo.root));
    }
    project = {
      version: 1, schema_version: S.SCHEMA_VERSION,
      name: '',
      goal: '',
      repo: slug,
      base,
      standards: 'default',
      owner_config_dir: configDir || Authority.resolveOwnerConfigDir(ctx.env),
      harness: defaults.harness,
      ladder: copied.ladder,
      limits: { workers: 6, lease_minutes: 60 },
      resources: {},
      budget: { hours: null, tokens: null },
    };
    applySettings(project, f, ctx.cwd, repo);
    const errs = S.validateProject(project);
    if (errs.length) throw usage(errs.join('; '));
    const tasks = { version: 1, next: 1, tasks: [] };
    const decisions = { version: 1, next: 1, decisions: [] };
    require('./orchestrator').guard(ctx, { tasks, project, events: [] }, true);
    S.writeAtomic(path.join(dir, 'tasks.json'), S.json(tasks));
    S.writeAtomic(path.join(dir, 'decisions.json'), S.json(decisions));
    // project.json last: its presence is what marks the state as initialized.
    S.writeAtomic(path.join(dir, 'project.json'), S.json(project));
    const at = new Date().toISOString();
    const events = [{ at, agent: ctx.agent, cmd: 'init', task: null, detail: { name: project.name, ...(copied.withheld.length ? { withheld: copied.withheld } : {}) } }];
    const emit = (task, detail, cmd) => events.push({ at, agent: ctx.agent, cmd, task, detail });
    emit.cmd = 'init';
    Authority.audit(ctx, who, guarded, emit);
    S.appendEvents(dir, events);
    if (repo) addExclude(repo, dir);
    S.renderSafely({ dir, project, tasks, decisions });
  } finally {
    S.releaseLock(lock);
  }
  return {
    data: { state: dir, project, ...(copied.withheld.length ? { withheld: copied.withheld } : {}), ...(notices.length ? { notices } : {}), ...(scopeWarnings(f.scope).length ? { warnings: scopeWarnings(f.scope) } : {}) },
    text: [`initialized ${dir}`, ...notices.map((n) => `notice: ${n}`), ...scopeWarnings(f.scope).map((w) => `warning: ${w}`), summary(project, ctx.env)].join('\n'),
  };
}

// The primary rungs init writes. The owner's init copies the defaults whole.
// Any other init copies what ladder set lets the orchestrator write and
// withholds the rest: sandbox, env, env_file, scope, command and web_mcp,
// tools that are not built-ins keeping the rung's sandbox, and MCP servers
// the owner's harness config does not define. A rung that would run outside
// its sandbox or as a command, from its own harness or the default one, gets
// the built-in rung on its built-in harness instead. A route the built-in rung
// already takes is no grant of the user file: init would write the same one.
function initLadder(defaults, env, owner) {
  const A = require('./agents');
  const ladder = {};
  const withheld = [];
  let from;
  for (const name of L.RUNGS) {
    const entry = defaults.ladder[name];
    let own = entry.own;
    if (!owner) {
      const route = { ...own, harness: entry.harness };
      const builtin = L.ordered({ ...L.BUILTIN.ladder[name], harness: L.BUILTIN.ladder[name].harness || L.BUILTIN.harness });
      const asBuiltin = route.harness === builtin.harness && JSON.stringify(route.args || []) === JSON.stringify(builtin.args || []);
      if (!asBuiltin && (route.harness === 'command' || Authority.unconfinedRoute(L.JOBS[name], route))) {
        own = builtin;
        withheld.push({ rung: name, harness: route.harness });
      } else {
        const out = { rung: name };
        const fields = OWNER_FIELDS.filter((k) => own[k] !== undefined);
        const tools = (own.tools || []).filter((t) => A.optInKind(route.harness, t) !== 'builtin');
        from ??= own.mcp ? A.origin(env) : undefined;
        const mcp = (own.mcp || []).filter((m) => !A.availableMcp(route.harness, from, [m], env).length);
        if (fields.length || tools.length || mcp.length) {
          own = { ...own };
          for (const k of fields) delete own[k];
          for (const [k, list] of [['tools', tools], ['mcp', mcp]]) {
            if (!list.length) continue;
            const kept = own[k].filter((v) => !list.includes(v));
            if (kept.length) own[k] = kept;
            else delete own[k];
            out[k] = list;
          }
          if (fields.length) out.fields = fields;
          withheld.push(out);
        }
      }
    }
    ladder[name] = own;
  }
  return { ladder, withheld };
}

function withheldText(w) {
  if (w.harness) {
    return `ladder ${w.rung}: the user file runs it ${w.harness === 'command' ? 'as a command' : `on ${w.harness} outside its sandbox`}, which only the owner grants; init wrote the built-in rung`;
  }
  const parts = [
    ...(w.fields ? [w.fields.join(', ')] : []),
    ...(w.tools ? [`tools ${w.tools.join(', ')}`] : []),
    ...(w.mcp ? [`MCP servers ${w.mcp.join(', ')} (not defined in the owner's harness config)`] : []),
  ];
  return `ladder ${w.rung}: init left out ${parts.join('; ')} from the user file; only the owner grants them`;
}

function parseArgv(flag, text, allowEmpty) {
  let list;
  try {
    list = JSON.parse(text);
  } catch (e) {
    throw usage(`${flag} must be a JSON array of strings (${e.message})`);
  }
  if (!Array.isArray(list) || (!allowEmpty && !list.length) || !list.every((a) => typeof a === 'string' && (allowEmpty || a !== ''))) {
    throw usage(`${flag} must be a ${allowEmpty ? '' : 'non-empty '}JSON array of strings`);
  }
  return list;
}

function checkRung(name) {
  if (!L.RUNGS.includes(name)) throw usage(`unknown rung "${name}"; the rungs are ${L.RUNGS.join(', ')}`);
}

// Turns field values into a rung change. ladder set and the serve Settings
// view both build their changes here, so they refuse the same values with the
// same words. Flags name fields as --model, the form as model.
function rungPatch(values, clear, flags, name = 'easy') {
  const label = (k) => (flags ? `--${k}` : k);
  const set = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    const field = k === 'web-mcp' ? 'web_mcp' : k;
    if (!L.FIELDS.includes(field)) throw usage(`unknown rung field ${k}; a rung takes ${L.FIELDS.join(', ')}`);
    if (typeof v !== 'string') throw usage(`${label(k)} must be a string`);
    if (field === 'web_mcp') {
      try { set.web_mcp = JSON.parse(v); } catch { throw usage(`${label(k)} must be a JSON object`); }
      const errs = L.webMcpErrors(set.web_mcp);
      if (errs.length) throw usage(errs.join('; '));
    }
    else if (k === 'args') set.args = parseArgv(label(k), v, true);
    else if (k === 'command' || k === 'tools' || k === 'mcp') set[k] = parseArgv(label(k), v, false);
    else if (k === 'supervision') {
      try { set[k] = JSON.parse(v); } catch { throw usage(`${label(k)} must be a JSON object`); }
      const errs = L.supervisionErrors(set[k]);
      if (errs.length) throw usage(errs.join('; '));
    }
    else if (SpawnSettings.FIELDS.includes(k)) {
      if (k === 'env_file') set[k] = v;
      else {
        try { set[k] = JSON.parse(v); } catch { throw usage(`${label(k)} must be a JSON object`); }
      }
      const errs = SpawnSettings.errors({ [k]: set[k] });
      if (errs.length) throw usage(errs.join('; '));
    }
    else if (k === 'harness' && !L.HARNESSES.includes(v)) throw usage(`${label(k)} must be one of ${L.HARNESSES.join(', ')}, got "${v}"`);
    else if (!v.trim()) throw usage(`${label(k)} cannot be empty; clear the field instead`);
    else set[k] = v.trim();
  }
  for (const k of clear) {
    if (!L.FIELDS.includes(k)) throw usage(`--clear takes a rung field (${L.FIELDS.join(', ')}), got "${k}"`);
    if (k in set) throw usage(`${k} is both set and cleared`);
  }
  return { set, clear: [...new Set(clear)] };
}

// Refuses an edit made against a ladder that has since changed. The Settings
// page sends the default harness and the fields of each rung it edits as it
// loaded them; a CLI change in between would otherwise be overwritten by
// fields the person never touched.
function checkExpected(layers, expect) {
  const stale = [];
  if (expect.harness !== layers.harness) stale.push(`the default harness is now ${layers.harness}, not ${expect.harness}`);
  for (const [name, own] of Object.entries(expect.rungs || {})) {
    const now = layers.ladder[name].own;
    if (JSON.stringify(L.ordered(own)) !== JSON.stringify(now)) stale.push(`ladder ${name} is now ${L.describe(now) || 'empty'}${now.harness ? ` on ${now.harness}` : ''}`);
  }
  if (stale.length) throw conflict(`the ladder changed since this page loaded: ${stale.join('; ')}; reload the page and make the edit again`);
}

// The one write path for the ladder: ladder set, ladder harness and the
// serve Settings view. A change that leaves a rung unable to run, where it
// could run before, is refused whole, so project.json never holds half of an
// edit. Rungs already broken (by a user file that changed) do not block a
// change, so the ladder can always be repaired one rung at a time.
// changes.expect, when given, is what the edit was based on (checkExpected).
// Each field is a setting in lib/authority.js: the program a rung runs and
// its sandbox, environment and scope are the owner's, the rest operational.
const OWNER_FIELDS = ['command', 'web_mcp', ...SpawnSettings.FIELDS];

function fieldSetting(k) {
  return SpawnSettings.FIELDS.includes(k) ? k : `ladder.${k}`;
}

// The settings a ladder change touches, read before it applies.
function ladderSettings(changes, rungs) {
  const out = changes.harness !== undefined ? ['ladder.harness'] : [];
  const owned = {};
  for (const [name, patch] of rungs) {
    out.push(...[...Object.keys(patch.set), ...patch.clear].map(fieldSetting));
    const touched = [...Object.keys(patch.set), ...patch.clear].filter((k) => OWNER_FIELDS.includes(k));
    if (touched.length) owned[name] = Object.fromEntries(touched.map((k) => [k, patch.set[k] ?? null]));
  }
  return { settings: out, change: Object.keys(owned).length ? { ladder: owned } : null };
}

// A rung with patch applied. A rung the project leaves out starts from the
// default it falls back to.
function patched(p, env, name, patch) {
  const next = { ...L.resolve(p, env).ladder[name].own };
  for (const k of patch.clear) delete next[k];
  Object.assign(next, patch.set);
  return L.ordered(next);
}

function ladderAfter(p, env, changes, rungs) {
  const after = { ...p, ladder: { ...(p.ladder || {}) } };
  if (changes.harness !== undefined) after.harness = changes.harness;
  for (const [name, patch] of rungs) after.ladder[name] = patched(p, env, name, patch);
  return after;
}

// The tools and MCP servers each rung route opts in to after a change that it
// did not opt in to on the same harness before, including rungs that move to
// a new default harness.
function projectPolicyRoutes(p, env) {
  const layers = L.resolve(p, env);
  return L.RUNGS.flatMap(name => L.routes(L.rungOf(layers, name)).map(route => ({ rung: name, route })));
}

// Personal routes affect every project. An inherited harness can resolve
// differently elsewhere; an explicit harness is a different binding even
// when it happens to match this project's primary.
function personalPolicyRoutes(name, routes, env) {
  const layers = { user_file: L.userFile(env) };
  return routes.flatMap(route => {
    const harnesses = route.harness ? [route.harness] : L.HARNESSES;
    return harnesses.filter(harness => !L.rungErrors(name, {
      own: route, harness, harness_from: 'rung', from: 'user',
    }, layers).length).map(harness => ({
      rung: name, route: { ...route, harness }, binding: route.harness ? 'explicit' : 'inherited',
    }));
  });
}

function addedOptIns(before, after) {
  const list = routes => routes.flatMap(({ rung, route, binding }) => ['tools', 'mcp'].flatMap(field =>
    (route[field] || []).map(item => ({ rung, harness: route.harness, field, item, binding }))));
  const key = o => JSON.stringify([o.binding, o.rung, o.harness, o.field, o.item]);
  const was = new Set(list(before).map(key));
  return list(after).filter(o => !was.has(key(o)));
}

function newOptIns(p, env, changes, rungs) {
  return addedOptIns(projectPolicyRoutes(p, env), projectPolicyRoutes(ladderAfter(p, env, changes, rungs), env));
}

// Tools and MCP servers are operational under two conditions; the owner can
// overrule either. An MCP server must already be defined in the owner's own
// harness config, so the orchestrator never introduces a new command (an MCP
// server runs outside the rung's sandbox). A tool must be a harness built-in
// that leaves the rung's sandbox confinement (write paths, env, scope,
// network) unchanged; any other tool is ladder.reach, owner-required. The
// sandbox, env, env_file and scope fields are owner-required themselves.
function optInSettings(optIns) {
  const A = require('./agents');
  const reach = optIns.filter((o) => o.field === 'tools' && A.optInKind(o.harness, o.item) !== 'builtin');
  if (!reach.length) return { settings: [], change: null };
  const ladder = {};
  for (const o of reach) (ladder[o.rung] ||= { tools: [] }).tools.push(o.item);
  return { settings: ['ladder.reach'], change: { ladder } };
}

// A newly unconfined route requires owner authority, including a personal
// fallback that follows the primary harness. Authority reads the adapter's
// sandbox capability; home isolation alone does not establish confinement.
function addedUnconfinedRoutes(before, after) {
  const list = routes => routes.flatMap(({ rung, route, binding }) => {
    const args = route.args || [];
    if (!Authority.unconfinedRoute(L.JOBS[rung], route)) return [];
    return [{ rung, harness: route.harness, binding, ...(args.length ? { args } : {}) }];
  });
  const key = o => JSON.stringify([o.binding, o.rung, o.harness, o.args || []]);
  const was = new Set(list(before).map(key));
  const moved = list(after).filter(o => !was.has(key(o)));
  if (!moved.length) return { settings: [], change: null };
  const ladder = {};
  for (const { rung, binding, ...route } of moved) (ladder[rung] ||= { unconfined: [] }).unconfined.push(route);
  return { settings: ['ladder.reach'], change: { ladder } };
}

function unconfinedRoutes(p, env, changes, rungs) {
  return addedUnconfinedRoutes(projectPolicyRoutes(p, env), projectPolicyRoutes(ladderAfter(p, env, changes, rungs), env));
}

function checkMcpDefined(optIns, env) {
  const A = require('./agents');
  const from = A.origin(env);
  const missing = optIns.filter((o) => o.field === 'mcp' && !A.availableMcp(o.harness, from, [o.item], env).length);
  if (!missing.length) return;
  const where = (h) => (h === 'claude' ? `${path.join(from.claude.dir, 'mcp.json')} or ${from.claude.json}`
    : h === 'opencode' ? `${from.opencode.dir} and OPENCODE_CONFIG_CONTENT`
    : h === 'agy' ? path.join(from.agy, 'config', 'mcp_config.json') : path.join(from.codex, 'config.toml'));
  throw refuse(`${missing.map((o) => `ladder ${o.rung} opts in MCP server ${o.item}, which ${where(o.harness)} does not define`).join('; ')}; the orchestrator opts in only MCP servers the owner's harness config already defines; ask the owner with tower-crane ask to add the server or make the change`);
}

// Describe the grants an owner writes, even when they already exist. Only
// explicitly written primary fields and routes following a written harness
// count; an unrelated model edit cannot settle a pending reach request.
function ladderOwnerWrite(p, env, changes, rungs, fields) {
  const layers = L.resolve(ladderAfter(p, env, changes, rungs), env);
  const patches = new Map(rungs);
  const ladder = { ...fields.change?.ladder };
  for (const name of L.RUNGS) {
    const patch = patches.get(name);
    const wrote = key => Object.hasOwn(patch?.set || {}, key) || !!patch?.clear.includes(key);
    const harness = wrote('harness') || (changes.harness !== undefined && layers.ladder[name].harness_from === 'default');
    const tools = harness || wrote('tools');
    const args = harness || wrote('args');
    if (!tools && !args) continue;
    const rung = L.rungOf(layers, name);
    const routes = L.routes(rung).filter((route, i) => i === 0 || (harness && !rung.fallbacks[i - 1].harness));
    const reach = tools ? optInSettings(routes.flatMap(route => (route.tools || []).map(item => ({
      rung: name, harness: route.harness, field: 'tools', item,
    })))).change?.ladder?.[name] : null;
    const unconfined = args ? routes.filter(route => Authority.unconfinedRoute(L.JOBS[name], route)).map(route => ({
      harness: route.harness, ...(route.args?.length ? { args: route.args } : {}),
    })) : [];
    if (reach || unconfined.length) ladder[name] = {
      ...ladder[name], ...reach, ...(unconfined.length ? { unconfined } : {}),
    };
  }
  return {
    settings: [...fields.settings, 'ladder.reach'],
    change: Object.keys(ladder).length ? {
      ...(changes.harness !== undefined ? { harness: changes.harness } : {}), ladder,
    } : null,
  };
}

// A rung edit that moves the rung to another harness drops the fields it
// did not name that do not fit there (L.harnessDrops), as if cleared. The
// Settings page sends every field of a row it saves; patch.carried lists the
// ones it sent unchanged, which do not count as named.
function harnessMoves(p, env, changes, rungs) {
  const layers = L.resolve(p, env);
  const def = changes.harness ?? layers.harness;
  const moved = {};
  const out = rungs.map(([name, patch]) => {
    const now = layers.ladder[name];
    const to = patch.set.harness ?? (patch.clear.includes('harness') || !now.own.harness ? def : now.own.harness);
    if (to === now.harness) return [name, patch];
    const named = Object.keys(patch.set).filter((k) => !(patch.carried || []).includes(k));
    const kept = patched(p, env, name, { set: {}, clear: [...patch.clear, ...named] });
    for (const k of Object.keys(patch.set)) if (!named.includes(k)) kept[k] = patch.set[k];
    const drop = L.harnessDrops(kept, to, env, { ...kept, ...patch.set });
    if (!Object.keys(drop).length) return [name, patch];
    moved[name] = { from: now.harness, to, dropped: drop };
    // The tools the new harness knows stay, so a partial drop sets the rest.
    const tools = drop.tools ? kept.tools.filter((tool) => !drop.tools.includes(tool)) : [];
    const set = Object.fromEntries(Object.entries(patch.set).filter(([k]) => !(k in drop)));
    if (tools.length) set.tools = tools;
    const cleared = Object.keys(drop).filter((k) => k in now.own && !(k === 'tools' && tools.length));
    return [name, { set, clear: [...new Set([...patch.clear, ...cleared])] }];
  });
  // A rung that follows a new default harness is not edited, so a model or
  // tool it cannot run there is refused by name instead.
  const stuck = [];
  const h = changes.harness;
  if (h !== undefined && h !== layers.harness) {
    const edited = new Set(rungs.map(([name]) => name));
    for (const name of L.RUNGS) {
      const e = layers.ladder[name];
      if (edited.has(name) || e.own.harness) continue;
      const where = `ladder ${name} (${h}, the default harness)`;
      if (e.own.model !== undefined && !L.modelFits(e.own.model, h, e.own, env)) stuck.push(`${where}: model ${e.own.model} does not run on ${h}`);
      // tools on a harness that takes none is a rung error already.
      const unknown = L.ISOLATED.includes(h) ? (e.own.tools || []).filter((tool) => !L.toolFits(tool, h)) : [];
      if (unknown.length) stuck.push(`${where}: ${h} does not know tool${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`);
    }
  }
  return { rungs: out, moved, stuck };
}

// Personal fallback routes that follow their rung's harness move with it.
// The user file is not the project's to edit, so a route the move leaves
// unable to run is named, and spawn skips it (spawn.routeProblems). Pinned
// routes are not judged here: a pin covers the harness a route resolves to,
// so a moved route that carries authority is unapproved until the owner
// approves it again, and ladder show names it.
function fallbackMoves(before, after, env) {
  return L.RUNGS.filter((name) => after.ladder[name].harness !== before.ladder[name].harness)
    .flatMap((name) => L.inheritedMisfits(after, name, env).map((m) => {
      const h = after.ladder[name].harness;
      return `${name} fallback ${m.route} from user file ${after.user_file} follows the rung to ${h}, where ${m.why.join(' and ')}; spawn skips it until the route names its harness or what ${h} runs`;
    }));
}

function droppedText(name, m, verb = 'dropped') {
  return `ladder ${name}: moving from ${m.from} to ${m.to} ${verb} ${L.describe(m.dropped)}, which ${Object.keys(m.dropped).length > 1 ? 'do' : 'does'} not fit ${m.to}`;
}

function updateLadder(ctx, changes, via) {
  if (changes.harness !== undefined && !L.HARNESSES.includes(changes.harness)) {
    throw usage(`the default harness must be one of ${L.HARNESSES.join(', ')}, got "${changes.harness}"`);
  }
  for (const [name] of Object.entries(changes.rungs || {})) checkRung(name);
  return S.mutate(ctx, 'ladder set', (st, emit, commit) => {
    const p = st.project;
    const previous = L.resolve(p, ctx.env);
    const { rungs, moved, stuck } = harnessMoves(p, ctx.env, changes, Object.entries(changes.rungs || {}));
    const fields = ladderSettings(changes, rungs);
    const optIns = newOptIns(p, ctx.env, changes, rungs);
    const reach = optInSettings(optIns);
    const unconfined = unconfinedRoutes(p, ctx.env, changes, rungs);
    const ladder = {};
    for (const c of [reach.change, unconfined.change, fields.change]) for (const [name, r] of Object.entries(c?.ladder || {})) ladder[name] = { ...ladder[name], ...r };
    const change = Object.keys(ladder).length ? { ...(unconfined.change && changes.harness !== undefined ? { harness: changes.harness } : {}), ladder } : null;
    const ownerWrite = ladderOwnerWrite(p, ctx.env, changes, rungs, fields);
    const who = Authority.enforce(ctx, st, [...fields.settings, ...reach.settings, ...unconfined.settings], { change, ownerWrite, emit, commit });
    if (who !== 'owner') checkMcpDefined(optIns, ctx.env);
    if (changes.expect) checkExpected(L.resolve(p, ctx.env), changes.expect);
    const before = new Set(L.check(p, ctx.env));
    const extra = { ...(via ? { via } : {}), ...(who === 'orchestrator' ? { authority: who } : {}) };
    if (changes.harness !== undefined) {
      p.harness = changes.harness;
      emit(null, { harness: p.harness, ...extra }, 'ladder harness');
    }
    for (const [name, patch] of rungs) {
      const ladder = { ...(p.ladder || {}), [name]: patched(p, ctx.env, name, patch) };
      p.ladder = Object.fromEntries(L.RUNGS.filter((n) => ladder[n]).map((n) => [n, ladder[n]]));
      emit(null, { rung: name, ...p.ladder[name], ...(moved[name] ? { dropped: moved[name].dropped } : {}), ...extra });
    }
    const errs = [...L.check(p, ctx.env).filter((e) => !before.has(e)), ...stuck];
    if (errs.length && changes.harness !== undefined && !rungs.length) {
      errs.push('fix those rungs first with tower-crane ladder set, or give them their own --harness');
    }
    if (errs.length) {
      for (const [name, m] of Object.entries(moved)) errs.push(`${droppedText(name, m, 'would drop')}, so name what the rung runs on ${m.to}`);
      throw refuse(errs.join('; '));
    }
    const layers = L.resolve(p, ctx.env);
    if (Object.keys(moved).length) layers.moved = moved;
    const notices = fallbackMoves(previous, layers, ctx.env);
    if (notices.length) layers.notices = notices;
    return layers;
  });
}

function showData(layers) {
  const ladder = {};
  for (const n of L.RUNGS) {
    const e = layers.ladder[n];
    ladder[n] = { ...L.rungOf(layers, n), harness_from: e.harness_from, from: e.from,
      ...(e.fallbacks_from ? { fallbacks_from: e.fallbacks_from } : {}) };
  }
  return { harness: layers.harness, harness_from: layers.harness_from, user_file: layers.user_file, user_file_exists: fs.existsSync(layers.user_file), ladder };
}

function ladderShow(ctx) {
  const st = S.loadState(ctx.stateDir);
  const layers = L.resolve(st.project, ctx.env);
  const data = { ...showData(layers), problems: L.check(st.project, ctx.env) };
  for (const name of L.RUNGS) {
    const routes = L.routes(L.rungOf(layers, name));
    const primaryProblems = require('./claude-provider').problems(routes[0], ctx.env, require('./agents').origin(ctx.env), SpawnSettings.resolve(st.project, routes[0]));
    data.problems.push(...primaryProblems.map((problem) => `ladder ${name}: ${problem}`));
    // A route that cannot follow the rung is skipped whatever its approval,
    // so it is named for that, not for an approval.
    const misfits = L.inheritedMisfits(layers, name, ctx.env);
    const skipped = new Set(misfits.map((m) => m.route));
    const unapproved = RouteGrants.unapproved(st.project, layers.user_file, name, layers.ladder[name].fallbacks,
      routes.slice(1).map((r) => r.harness), routeBase(ctx)).filter((r) => !skipped.has(r.route));
    // In route order, so a rung's list reads as its user-file list does.
    const byRoute = [
      ...misfits.map((m) => [m.route, [require('./spawn').misfitText({ rung: name, ...m }, layers.user_file)]]),
      ...unapproved.map((r) => [r.route, [RouteGrants.describe({ rung: name, ...r }, layers.user_file)]]),
    ];
    routes.slice(1).forEach((route, i) => {
      if (skipped.has(i + 1)) return;
      const problems = require('./spawn').routeProblems(route, ctx.env, ctx.cwd, st.project);
      byRoute.push([i + 1, problems.map((problem) => `${name} fallback ${i + 1} from user file ${layers.user_file}: ${problem}; skipped`)]);
    });
    data.problems.push(...byRoute.sort((a, b) => a[0] - b[0]).flatMap(([, texts]) => texts));
  }
  const lines = [
    `default harness: ${data.harness}, from ${L.SOURCE[data.harness_from]}`,
    `user file: ${data.user_file}${data.user_file_exists ? '' : ' (none)'}`,
    ...ladderLines(layers),
    ...data.problems.map((e) => `cannot run: ${e}`),
  ];
  return { data, text: lines.join('\n') };
}

function ladderSet(ctx) {
  const [name] = ctx.pos;
  checkRung(name);
  const { clear = [], fallbacks, ...values } = ctx.flags;
  if (fallbacks !== undefined || clear.includes('fallbacks')) {
    if (Object.keys(values).length || clear.some(k => k !== 'fallbacks')) throw usage('edit personal fallbacks separately from project primary fields');
    if (fallbacks !== undefined && clear.length) throw usage('fallbacks is both set and cleared');
    let routes;
    if (fallbacks !== undefined) {
      try { routes = JSON.parse(fallbacks); } catch { throw usage('--fallbacks must be a JSON array of routes'); }
    }
    const data = showData(updateFallbacks(ctx, name, routes)).ladder[name];
    return { data: { rung: name, ...data }, text: `${name}: ${L.describe(data)}` };
  }
  const patch = rungPatch(values, clear, true, name);
  if (!Object.keys(patch.set).length && !patch.clear.length) throw usage('ladder set needs a change: a field to set or --clear FIELD');
  const layers = updateLadder(ctx, { rungs: { [name]: patch } });
  const data = showData(layers).ladder[name];
  const moved = layers.moved?.[name];
  const text = `${name}: ${data.harness}${data.harness_from === 'default' ? ' (default harness)' : ''}, ${L.describe(data)}`;
  const notices = layers.notices || [];
  const warnings = scopeWarnings(values.scope);
  return {
    data: { rung: name, ...data, ...(moved ? { dropped: moved.dropped } : {}), ...(notices.length ? { notices } : {}), ...(warnings.length ? { warnings } : {}) },
    text: [text, ...(moved ? [droppedText(name, moved)] : []), ...notices.map((n) => `notice: ${n}`), ...warnings.map((w) => `warning: ${w}`)].join('\n'),
  };
}

// Where a route's env_file resolves, as spawn resolves it: ~ in the user's
// home, a relative path in the repository root.
function routeBase(ctx) {
  return { home: require('./agents').origin(ctx.env).home, cwd: S.findRepo(ctx.stateDir, ctx.cwd)?.root || ctx.cwd || process.cwd() };
}

// Fallbacks belong to the personal file. Resolve the proposed file before
// writing it, so primary and fallback edits share the same authority checks.
function updateFallbacks(ctx, name, routes) {
  checkRung(name);
  // Read before the state lock: finding the repository runs git.
  const base = routeBase(ctx);
  return S.mutate(ctx, 'ladder set', (st, emit, commit) => {
    const before = L.readUser(ctx.env) || {};
    const next = { ...before, ladder: { ...before.ladder } };
    const rung = { ...next.ladder[name] };
    if (routes === undefined) delete rung.fallbacks;
    else rung.fallbacks = routes;
    if (Object.keys(rung).length) next.ladder[name] = rung;
    else delete next.ladder[name];
    const errors = L.shapeErrors(next, true);
    if (errors.length) throw usage(errors.join('; '));
    if (routes !== undefined) rung.fallbacks = routes.map(L.ordered);
    const layers = L.resolve(st.project, ctx.env, next);
    const resolved = L.routes(L.rungOf(layers, name)).slice(1);
    for (const [i, route] of resolved.entries()) {
      errors.push(...L.rungErrors(`${name} fallback ${i + 1}`, {
        own: route, harness: route.harness, harness_from: 'rung', from: 'user',
      }, layers));
    }
    if (errors.length) throw usage(errors.join('; '));
    const oldRoutes = before.ladder?.[name]?.fallbacks || [];
    const newRoutes = rung.fallbacks || [];
    const settings = ['ladder.fallbacks'];
    for (let i = 0; i < Math.max(oldRoutes.length, newRoutes.length); i++) {
      for (const field of L.FIELDS) {
        if (!isDeepStrictEqual(oldRoutes[i]?.[field], newRoutes[i]?.[field])) settings.push(fieldSetting(field));
      }
    }
    // Authority counts from what the owner approved, not from what the file
    // holds: a route edited into the file by hand needs the owner even when
    // this write leaves it as it is (lib/route-grants.js).
    const file = layers.user_file;
    const harnesses = resolved.map((r) => r.harness);
    for (const r of RouteGrants.unapproved(st.project, file, name, newRoutes, harnesses, base)) {
      settings.push(...RouteGrants.PINNED.filter((k) => newRoutes[r.route - 1][k] !== undefined).map(fieldSetting));
    }
    RouteGrants.canPin(st.project, name, newRoutes, harnesses);
    const oldHarnesses = L.routes(L.rungOf(L.resolve(st.project, ctx.env, before), name)).slice(1).map((r) => r.harness);
    const previous = personalPolicyRoutes(name, RouteGrants.approvedRoutes(st.project, file, name, oldRoutes, oldHarnesses, base), ctx.env);
    const proposed = personalPolicyRoutes(name, newRoutes, ctx.env);
    const optIns = addedOptIns(previous, proposed);
    const reach = optInSettings(optIns);
    const unconfined = addedUnconfinedRoutes(previous, proposed);
    const change = { user_file: file, rung: name, fallbacks: rung.fallbacks ?? null };
    // Replacing the list writes every route field, even when its grant already
    // exists. Retirement matches that complete write; the audit uses the delta.
    const ownerWrite = { settings: [...L.FIELDS.map(fieldSetting), 'ladder.reach'], change };
    const who = Authority.enforce(ctx, st, [...settings, ...reach.settings, ...unconfined.settings], { change, ownerWrite, emit, commit });
    if (who !== 'owner') checkMcpDefined(optIns, ctx.env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    S.writeAtomic(file, S.json(next));
    RouteGrants.pin(st.project, file, name, newRoutes, harnesses, base);
    emit(null, { rung: name, file, fallbacks: rung.fallbacks ?? null, ...(who === 'orchestrator' ? { authority: who } : {}) });
    return layers;
  });
}

function ladderHarness(ctx) {
  const layers = updateLadder(ctx, { harness: ctx.pos[0] });
  const follow = L.RUNGS.filter((n) => layers.ladder[n].harness_from === 'default');
  const notices = layers.notices || [];
  return {
    data: { ...showData(layers), ...(notices.length ? { notices } : {}) },
    text: [`default harness: ${layers.harness}; ${follow.length ? `${follow.join(', ')} run on it` : 'every rung names its own harness'}`,
      ...notices.map((n) => `notice: ${n}`)].join('\n'),
  };
}

// The user file keeps any keys it has beyond harness and ladder. Only what the
// project defines is written: a default harness or rung the project leaves out
// keeps the user file's value, or stays unset so the built-in applies. A ladder
// that cannot run is not saved: every later init would copy it and refuse.
function ladderSaveUser(ctx) {
  const out = S.mutate(ctx, 'ladder save-user', (st, emit, commit) => {
    const who = Authority.enforce(ctx, st, ['ladder.save_user'], { emit, commit });
    const broken = L.check(st.project, ctx.env);
    if (broken.length) throw refuse(`${broken.join('; ')}; fix the ladder with tower-crane ladder set before saving it as the default`);
    const layers = L.resolve(st.project, ctx.env);
    const file = layers.user_file;
    let doc = {};
    if (fs.existsSync(file)) {
      try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        throw refuse(`${file} is not valid JSON (${e.message}); fix it or remove it first`);
      }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw refuse(`${file} must hold an object; fix it or remove it first`);
    }
    const saved = {};
    if (layers.harness_from === 'project') saved.harness = layers.harness;
    const rungs = L.RUNGS.filter((n) => layers.ladder[n].from === 'project');
    if (rungs.length) saved.ladder = { ...doc.ladder, ...Object.fromEntries(rungs.map((n) => [n, {
      ...layers.ladder[n].own, ...(layers.ladder[n].fallbacks !== undefined ? { fallbacks: layers.ladder[n].fallbacks } : {}),
    }])) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    S.writeAtomic(file, S.json({ ...doc, ...saved }));
    emit(null, { file, ...(who === 'orchestrator' ? { authority: who } : {}) });
    return { file, ...saved };
  });
  return { data: out, text: `wrote the ladder to ${out.file}; new projects start from it` };
}

// Real launches append the containment properties after the owner's scope, so systemd keeps those.
function scopeWarnings(value) {
  if (value === undefined || value === 'null') return [];
  const keys = require('./containment').overridden(JSON.parse(value));
  return keys.length ? [`scope ${keys.join(', ')}: containment replaces ${keys.length > 1 ? 'these' : 'this'} on every real launch; set the caps with tower-crane project set --tasks-max N --memory-max-bytes N`] : [];
}

function projectSet(ctx) {
  const keys = Object.keys(ctx.flags);
  if (!keys.length) throw usage('project set needs at least one setting; see tower-crane project set --help');
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const rechecks = [];
  const project = S.mutate(ctx, 'project set', (st, emit, commit) => {
    const settings = settingsOf(ctx.flags, st.project);
    // The requested amount may now be a decrease. An owner still settles the
    // earlier raise request by writing it; authorization and audit keep today's class.
    const ownerSettings = settings.map((key) => key === 'budget.lower' ? 'budget.raise' : key)
      .filter((key) => Authority.classOf(key) === Authority.OWNER);
    const who = Authority.enforce(ctx, st, settings, {
      change: requested(ctx.flags, settings.filter((key) => Authority.classOf(key) === Authority.OWNER)),
      ownerWrite: { settings: ownerSettings, change: requested(ctx.flags, ownerSettings) }, emit, commit,
    });
    const previous = structuredClone(st.project);
    applySettings(st.project, ctx.flags, ctx.cwd, repo);
    emit(null, { ...ctx.flags, ...(who === 'orchestrator' ? { authority: who } : {}) });
    const commands = require('./gate-commands');
    const changed = [
      ...(!isDeepStrictEqual(commands.resolve(previous, 'tests').policy, commands.resolve(st.project, 'tests').policy) ? ['tests'] : []),
      ...(!isDeepStrictEqual(commands.resolve(previous, 'clean').policy, commands.resolve(st.project, 'clean').policy) ? ['clean'] : []),
      ...(!isDeepStrictEqual(previous.ci, st.project.ci) ? ['ci'] : []),
    ];
    for (const task of st.tasks.tasks) {
      if (task.status !== 'accepted' || !task.pr || require('./stack').merged(st, task)) continue;
      const required = require('./tasks').requiredGates(task);
      const gates = changed.filter((g) => required.includes(g));
      if (required.includes('tests') && !gates.includes('tests')
        && testsPolicy.resolve(previous, task.kind).mode !== testsPolicy.resolve(st.project, task.kind).mode) gates.unshift('tests');
      if (!gates.length) continue;
      rechecks.push({ id: task.id, gates });
      emit(task.id, { sha: task.sha, revision: task.revision, gates, reason: 'project gate policy changed' }, 'automation reconcile');
    }
    return st.project;
  });
  const warnings = scopeWarnings(ctx.flags.scope);
  return { data: { ...project, ...(warnings.length ? { warnings } : {}) }, text: [...warnings.map((w) => `warning: ${w}`), summary(project, ctx.env),
    ...(rechecks.length ? [`queued gate re-checks: ${rechecks.map(({ id, gates }) => `${id} (${gates.join(', ')})`).join('; ')}`] : [])].join('\n') };
}

function projectShow(ctx) {
  const st = S.loadState(ctx.stateDir);
  return { data: st.project, text: summary(st.project, ctx.env) };
}

module.exports = { FLAG_SETTINGS, init, projectSet, projectShow, ladderShow, ladderSet, ladderHarness, ladderSaveUser, updateLadder, updateFallbacks, rungPatch, showData, droppedText, budgetSetting };
