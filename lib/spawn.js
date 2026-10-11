'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('./commands');
const os = require('node:os');
const crypto = require('node:crypto');
const { randomUUID } = crypto;
const { refuse, usage, sleepSync, shaMatch } = require('./util');
const S = require('./state');
const T = require('./tasks');
const W = require('./worktree');
const L = require('./ladder');
const P = require('./processes');
const B = require('./brief');
const TestsHostOnly = require('./tests-host-only');
const Sessions = require('./spawn-session');
const A = require('./agents');
const R = require('./reviewer');
const Settings = require('./spawn-settings');
const Secrets = require('./secrets');
const Rules = require('./rules');
const Auth = require('./authority');

const ROLE_SKILLS = { worker: 'tower-crane-work', reviewer: 'tower-crane-review' };
const EMBEDDED_SKILL_HARNESSES = new Set(['claude', 'codex', 'opencode', 'agy']);
const MISSING_SKILL_WARNINGS = new Set();

function skillFile(job, env) {
  const name = ROLE_SKILLS[job];
  return name ? path.join(env.TOWER_CRANE_PLUGIN_ROOT || path.join(__dirname, '..'), 'skills', name, 'SKILL.md') : null;
}

function warnMissingSkill(file) {
  if (MISSING_SKILL_WARNINGS.has(file)) return;
  MISSING_SKILL_WARNINGS.add(file);
  process.stderr.write(`tower-crane: role skill ${file} is missing; continuing without it\n`);
}

function embeddedSkill(job, harness, env) {
  const file = skillFile(job, env);
  if (!file || !EMBEDDED_SKILL_HARNESSES.has(harness)) return '';
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      warnMissingSkill(file);
      return '';
    }
    throw error;
  }
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return text.trim();
  const close = lines.indexOf('---', 1);
  if (close < 0) throw refuse(`${file} has no closing frontmatter delimiter`);
  return lines.slice(close + 1).join('\n').trim();
}

function roleInstructions(role, skill) {
  return skill ? `## Role instructions: ${ROLE_SKILLS[role]}\n\n${skill}` : '';
}

// The project goal and the task's target lead the brief, so an agent that
// skims still works toward the owner's goal; restating them first shows the
// orchestrator what the agent understood.
function goalSection(task, goal, role) {
  return [
    '## Goal',
    '',
    ...(goal ? [`Project goal: ${goal}`] : []),
    `Task target: ${task.id}, "${task.title}"; it is done when every acceptance item in the task below holds.`,
    `Begin your first message by restating the project goal and this target in one or two sentences, then work only toward them.${role === 'worker' ? ' Changes outside the paths the brief and acceptance name are flagged to the reviewer and the orchestrator.' : ''}`,
  ].join('\n');
}

function taskSection(task) {
  const taskJson = JSON.stringify({ id: task.id, title: task.title, acceptance: task.acceptance, kind: task.kind, needs: task.needs, locks: task.locks, environment: task.environment }, null, 2);
  return ['## Task', '', '```json', taskJson, '```'].join('\n');
}

// A command adapter that reads only {brief} gets the goal, the house rules and
// the acceptance in the brief file, as {prompt} carries them.
function briefCopyText(task, brief, role, context = {}) {
  return [goalSection(task, context.goal, role), context.rules, brief.replace(/\s+$/, ''), taskSection(task), context.messages]
    .filter(Boolean).join('\n\n') + '\n';
}

function buildPrompt(task, brief, role, agent, skill, context = {}) {
  const text = [
    ...(skill ? [roleInstructions(role, skill), ''] : []),
    goalSection(task, context.goal, role), '',
    ...(context.rules ? [context.rules, ''] : []),
    brief.replace(/\s+$/, ''),
    '',
    taskSection(task),
    '',
    ...(task.stack ? [`This task builds on ${task.stack.parent}. Its PR targets ${task.stack.base}.${role === 'worker' ? ` Create or update the PR with --base ${task.stack.base}. Submit through tower-crane; the dispatch supervisor links the PR stack after submission. Refresh through tower-crane stack sync ${task.id} when idle.` : ''}`, ''] : []),
    `You are ${agent}, the ${role} for ${task.id}; you are not the owner; never pass --agent owner. Use the tower-crane CLI for every state change: claim, submit, evidence, notes and spend (tower-crane --help lists the commands); never edit the state files by hand. TOWER_CRANE_STATE, TOWER_CRANE_TASK and TOWER_CRANE_AGENT are set, so tower-crane finds the state and records you as ${agent}; run tower-crane with --agent ${agent} if TOWER_CRANE_AGENT is missing.`,
  ].join('\n');
  // Harness CLIs read an argument that starts with "-" as an option; a brief
  // that opens with a list item would otherwise be mistaken for flags.
  return text.startsWith('-') ? `\n${text}` : text;
}

// pi can load Tower Crane's own skills; they ship next to lib/ in the package, or
// TOWER_CRANE_PLUGIN_ROOT points at a plugin checkout that holds them.
function piSkill(job, env) {
  const file = skillFile(job, env);
  if (!file) return null;
  try {
    if (!fs.statSync(file).isFile()) {
      warnMissingSkill(file);
      return null;
    }
    return path.dirname(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      warnMissingSkill(file);
      return null;
    }
    throw error;
  }
}

function filteredBrief(ctx, text) {
  const root = path.resolve(ctx.env.TOWER_CRANE_TMP || ctx.env.TOWER_CRANE_TEST_TMP || os.tmpdir());
  return { dir: root, file: path.join(root, `tower-crane-brief-${process.pid}-${randomUUID()}-brief.md`), text };
}

function removeFilteredBrief(file) {
  if (!file) return;
  try {
    // One unlink removes the whole copy, so observers cannot see an empty
    // per-copy directory left behind after the brief disappears.
    fs.rmSync(file, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      process.stderr.write(`tower-crane: could not remove temporary brief copy: ${error.message}\n`);
    }
  }
}

function buildCommand(job, rung, prompt, subs, env = process.env, own = [], session = null) {
  const opt = (flag, value) => (value ? [flag, value] : []);
  const extra = rung.args || [];
  if (session && rung.harness === 'claude' && extra.includes('--fork-session')) throw refuse('session resume cannot use --fork-session; remove it with tower-crane ladder set');
  switch (rung.harness) {
    case 'claude':
      return ['claude', ...opt('--resume', session), '-p', prompt,
        ...opt('--model', rung.provider ? require('./claude-provider').model(rung.provider, rung.model) : rung.model),
        ...opt('--effort', rung.effort), '--output-format', 'json', ...own, ...extra];
    case 'codex':
      return [
        'codex', 'exec', ...(session ? [] : ['--json']), ...opt('-p', rung.profile),
        ...(session ? ['resume', '--json'] : []), ...opt('-m', rung.model),
        ...(rung.effort ? ['-c', `model_reasoning_effort=${rung.effort}`] : []), ...own, ...(session ? [session] : []), prompt, ...extra,
      ];
    case 'opencode':
      return ['opencode', 'run', '--format', 'json', ...opt('-m', rung.model), ...opt('--variant', rung.effort), prompt, ...extra];
    case 'agy':
      return ['agy', '-p', prompt, '--mode', 'accept-edits', '--output-format', 'json', ...opt('--model', rung.model), ...opt('--effort', rung.effort), ...own, ...extra];
    case 'pi':
      return [
        'pi', '-p', prompt, '--mode', 'json', ...opt('--model', rung.model), ...opt('--provider', rung.provider),
        ...opt('--thinking', rung.effort), ...opt('--skill', piSkill(job, env)), ...own, ...extra,
      ];
    case 'command':
      return [...rung.command.map((a) => a.replace(/\{(task|brief|prompt|cwd|session)\}/g, (_, k) => k === 'session' ? session || '' : subs[k])), ...extra];
    default:
      throw refuse(`unknown harness ${rung.harness}; fix the rung with tower-crane ladder set`);
  }
}

function countSpawns(dir, job, id) {
  return S.readEvents(dir).filter((e) => e.cmd === 'spawn' && e.task === id && e.detail && e.detail.role === job).length;
}

function shellQuote(a) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

// With no --role the task's own tier picks the rung, so the orchestrator
// dispatches work at the tier it planned. spawn calls this twice: once to
// refuse early, before a worktree exists, and again on the state it reads
// under the lock, so a tier, ladder or brief change that lands in between is
// the one that runs.
function dispatch(ctx, st, preparedDiff, preparedRepo, preparedCI) {
  const f = ctx.flags;
  const task = T.getTask(st, f.task);
  T.requireSupportedTask(task, st);
  if (T.isRetiring(task)) throw refuse(`${task.id}'s worktree is being removed after its merge or cancel; spawn once the removal ends`);
  if (ctx.readyBatch && (!['todo', 'rework'].includes(task.status) || !T.isReady(st, task, Date.now())
    || require('./inbox').liveWorker(st, task))) throw refuse(`${task.id}: no longer ready without a live worker`);
  const rungName = f.role || task.tier;
  if (L.JOBS[rungName] === 'worker' && !f['dry-run']) {
    require('./escalation').guard(ctx, st, task);
    if (task.tier_range && rungName !== task.tier) throw refuse(`${task.id}: ranged work must run at its current tier ${task.tier}`);
  }
  const layers = L.resolve(st.project, ctx.env);
  const repo = preparedRepo || W.needRepo(ctx);
  if (rungName === 'review') {
    if (f['dry-run'] && task.status !== 'submitted') {
      const broken = L.rungErrors('review', layers.ladder.review, layers);
      if (broken.length) throw refuse(broken.join('; '));
      return { rung: L.rungOf(layers, 'review'), rungName, job: 'reviewer', task,
        brief: 'Preview only. Review dispatch needs a submitted diff and passing software gates.',
        briefFile: T.briefPath(st.dir, task.id) };
    }
    if (task.status !== 'submitted') throw refuse(`${task.id}: review needs a submitted task`);
    const report = R.softwareReport(st, task, preparedCI);
    if (!report.ok) throw refuse(`${task.id}: software gates must pass before review: ${report.missing.join('; ')}`);
    if (!f['dry-run'] && st.events.some((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'reviewer'
      && e.detail.sha === task.sha && e.detail.revision === task.revision && !Sessions.exitedAttempt(e, st.events))) {
      throw refuse(`${task.id}: a reviewer is still running; wait for its result`);
    }
    const project = { ...st.project, base: require('./stack').targetBase(st, task) };
    const diff = preparedDiff ? R.checkedDiff(preparedDiff, project, task) : R.diffOf(repo, project, task);
    const selection = R.choose(st, task, layers, diff, ctx.env);
    return {
      rung: selection.rung, rungName, job: 'reviewer', task,
      brief: R.context(st, task, diff, report, selection),
      reviewSummary: R.context(st, task, diff, report, selection, false),
      briefFile: path.join(st.dir, 'reviews', `${task.id}-${diff.sha}.md`),
      reviewChoice: selection.name, reviewSha: diff.sha, reviewDiff: diff,
    };
  }
  const broken = L.rungErrors(rungName, layers.ladder[rungName], layers);
  if (broken.length) throw refuse(`${broken.join('; ')}; fix it with tower-crane ladder set ${rungName}`);
  const rung = L.rungOf(layers, rungName);
  const job = L.JOBS[rungName];
  const briefFile = T.briefPath(st.dir, task.id);
  let brief;
  try {
    brief = fs.readFileSync(briefFile, 'utf8');
  } catch {
    throw refuse(`${task.id} has no brief; write one with tower-crane brief set ${task.id} --file F before spawning`);
  }
  return { rung, rungName, job, task, brief, briefFile };
}

function prepare(ctx) {
  const f = ctx.flags;
  if (!f.task) throw usage('spawn needs --task ID');
  if (f.role !== undefined && !L.RUNGS.includes(f.role)) throw usage(`--role must be a rung: ${L.RUNGS.join(', ')}; got "${f.role}"`);
  const st = S.loadState(ctx.stateDir);
  return { st, ...dispatch(ctx, st), repo: W.needRepo(ctx) };
}

function missing(argv0, rungName) {
  return refuse(`could not start ${argv0}: no executable file by that name${path.isAbsolute(argv0) || /[\\/]/.test(argv0) ? '' : ' on PATH'}; install it, or fix the rung with tower-crane ladder set ${rungName}`);
}

function reworkNote(p, events, resumed) {
  if (p.job !== 'worker' || !(p.task.status === 'rework' || p.task.claim?.from === 'rework')) return '';
  const rework = events.findLast((e) => e.cmd === 'rework' && e.task === p.task.id);
  const revision = rework ? rework.detail.previous_revision : p.task.revision;
  const reviews = p.task.evidence.filter((e) => e.type === 'review' && !e.ok && e.revision === revision
    && shaMatch(e.sha, rework?.detail.sha || p.task.sha) && T.eligibleGateEvidence(p.task, e, events));
  return [
    `## Rework ${p.task.id}`,
    rework?.detail.reason || 'Continue the requested rework.',
    ...reviews.map((e) => `Failed review by ${e.agent} at ${e.sha}: ${e.summary || 'No summary'}${e.ref ? `\nEvidence: ${e.ref}` : ''}`),
    resumed
      ? 'Continue in this worktree. Your worker identity and claim are kept. Follow skills/tower-crane-work/SKILL.md and submit the corrected head.'
      : 'Claim this task in this worktree. Follow skills/tower-crane-work/SKILL.md and submit the corrected head.',
  ].join('\n\n');
}

function command(ctx, p, cwd, n, events = S.readEvents(ctx.stateDir), freshAgent = null) {
  if (p.rung.harness === 'command' && !p.rung.command.some((arg) => /\{(prompt|brief)\}/.test(arg))) {
    throw refuse('command harness needs {prompt} or {brief} in its command argv to receive the goal, task and house rules');
  }
  let resume = freshAgent || p.task.escalation_pending ? null : Sessions.eligible(p, cwd, events);
  let resumeFallbackAgent = null;
  let agent = freshAgent || (resume ? resume.agent : `${p.job}-${p.task.id}-${n}`);
  const project = p.project || p.st.project;
  const settings = Settings.prepare(Settings.resolve(project, p.rung), A.origin(ctx.env).home, p.repo.root);
  // Before the worktree exists, the repository's own checkout stands in for it.
  const root = fs.existsSync(cwd) ? cwd : p.repo.root;
  const rules = Rules.chain({ harness: p.rung.harness, cwd: root, gitRoot: root, origin: A.origin(ctx.env), env: ctx.env });
  const splitReview = p.job === 'reviewer' && ['claude', 'codex'].includes(p.rung.harness);
  const skill = resume ? '' : embeddedSkill(p.job, p.rung.harness, ctx.env);
  let reviewSystem = splitReview ? [
    A.load('reviewer').body,
    R.staticContext(root, rules, project.standards, roleInstructions(p.job, skill), ctx.env),
  ].join('\n\n') : '';
  let rung = p.rung;
  if (splitReview && rung.harness === 'claude' && rung.args?.includes('--append-system-prompt')) {
    const args = [];
    for (let i = 0; i < rung.args.length; i++) {
      if (rung.args[i] === '--append-system-prompt') reviewSystem += `\n\n${rung.args[++i]}`;
      else args.push(rung.args[i]);
    }
    rung = { ...rung, args };
  }
  let iso = A.isolation(p.job, p.rung, p.rungName, { stateDir: ctx.stateDir, repo: p.repo, projectRepo: project.repo, gitDirs: p.gitDirs, env: ctx.env, agent, cwd, task: p.task.id, taskSpec: p.task, routes: p.routes || L.routes(p.rung), attempt: n, settings, rules, reviewSystem });
  const resumeFallbackReason = resume && p.rung.harness === 'codex'
    ? Sessions.missingCodexSession(resume.id, iso)
    : null;
  if (resumeFallbackReason) {
    resumeFallbackAgent = resume.agent;
    resume = null;
    agent = `${p.job}-${p.task.id}-${n}`;
    iso = A.isolation(p.job, p.rung, p.rungName, { stateDir: ctx.stateDir, repo: p.repo, projectRepo: project.repo, gitDirs: p.gitDirs, env: ctx.env, agent, cwd, task: p.task.id, taskSpec: p.task, routes: p.routes || L.routes(p.rung), attempt: n, settings, rules });
  }
  if (resume) {
    const submit = events.findLast((e) => e.cmd === 'submit' && e.task === p.task.id && e.agent === resume.agent && e.detail.claim);
    resume.claim = resume.interrupted?.detail.claim || submit?.detail.claim || null;
  }
  const last = events.findLast((e) => e.cmd === 'spawn' && e.task === p.task.id && e.detail.role === 'worker');
  const interrupted = p.job === 'worker' ? Sessions.interruptedAttempt(last, events) : null;
  const interruptNote = interrupted ? [
    `## Interrupt ${p.task.id}`,
    interrupted.detail.reason,
    'Continue the unfinished work in this worktree. Tracked and untracked edits are kept. Read the current brief and task requirements before continuing.',
    JSON.stringify({ title: p.task.title, acceptance: p.task.acceptance, kind: p.task.kind, needs: p.task.needs }),
    resume ? 'Your worker identity and claim are restored. Follow skills/tower-crane-work/SKILL.md and submit the finished head.'
      : 'Claim this task, follow skills/tower-crane-work/SKILL.md and submit the finished head.',
  ].join('\n\n') : '';
  // An interrupted rework run is still a rework: its failed review feedback goes with the interrupt.
  const note = [interruptNote, reworkNote(p, events, !!resume)].filter(Boolean).join('\n\n');
  const roleBrief = p.job === 'reviewer' ? p.brief : [B.forRole(p.brief, p.job), p.job === 'worker' ? TestsHostOnly.section(project) : ''].filter(Boolean).join('\n\n');
  // Keep Windows argv below its 32K limit; the CLI writes the full diff packet
  // before launching, and the reviewer reads that one file.
  const brief = p.job === 'reviewer' && roleBrief.length > 12000
    ? `${p.reviewSummary}\n\nRead ${p.briefFile} for the diff at ${p.reviewSha}.`
    : roleBrief;
  const researchInstructions = p.job === 'worker' && p.rungName === 'research' && !L.ISOLATED.includes(p.rung.harness)
    ? A.load('researcher').body : '';
  const hooks = require('./harness-hooks');
  const inboxMessages = hooks.unread(events, agent);
  const messages = hooks.context(inboxMessages);
  const house = { goal: project.goal, rules: splitReview ? '' : Rules.section(rules) };
  const prompt = [
    resume ? note : buildPrompt(p.task, [researchInstructions, brief, note].filter(Boolean).join('\n\n'), p.job, agent, splitReview ? '' : skill, house),
    ...(splitReview && iso?.mcp.length ? [`Approved MCP servers for this dispatch: ${iso.mcp.join(', ')}. Use browser tools only for the task's UI.`] : []),
    messages,
  ].filter(Boolean).join('\n\n');
  const briefCopy = p.rung.harness === 'command' && p.rung.command.some((arg) => arg.includes('{brief}'))
    ? filteredBrief(ctx, briefCopyText(p.task, [researchInstructions, roleBrief, note].filter(Boolean).join('\n\n'), p.job, { ...house, messages }))
    : null;
  const subs = { task: p.task.id, brief: briefCopy?.file || p.briefFile, prompt, cwd };
  const own = [...(iso ? iso.flags : []), ...(splitReview && p.rung.harness === 'claude'
    ? ['--append-system-prompt-file', path.join(iso.home, 'system.md'), '--exclude-dynamic-system-prompt-sections'] : [])];
  const argv = buildCommand(p.job, rung, prompt, subs, ctx.env, own, resume?.id);
  let sessionId = resume?.id || null;
  if (p.rung.harness === 'claude') {
    const index = argv.indexOf('--session-id');
    const resumed = argv.indexOf('--resume');
    sessionId = resumed >= 0 ? argv[resumed + 1] : index >= 0 ? argv[index + 1] : crypto.randomUUID();
    if (index < 0 && resumed < 0) argv.push('--session-id', sessionId);
  }
  const env = { TOWER_CRANE_STATE: ctx.stateDir, TOWER_CRANE_TASK: p.task.id, TOWER_CRANE_AGENT: agent,
    TOWER_CRANE_CONFIG: L.userFile(ctx.env), TOWER_CRANE_HOST_ONLY: TestsHostOnly.envValue(project), ...(iso ? iso.env : {}),
    ...(p.rung.harness === 'claude' ? { FORCE_PROMPT_CACHING_5M: '1' } : {}) };
  const log = path.join(ctx.stateDir, 'logs', `${p.task.id}-${agent}${resume ? `-attempt-${n}` : ''}.log`);
  const receivesContext = p.rung.harness !== 'command' || p.rung.command.some((arg) => /\{(prompt|brief)\}/.test(arg));
  const inbox = receivesContext ? inboxMessages.map((e) => e.id) : [];
  // What the agent starts with, for the startup receipt and its token cost.
  // A resumed session already holds them from its first prompt.
  const instructionsFile = iso?.instructions_file || (iso && ['claude', 'codex', 'pi'].includes(p.rung.harness)
    ? path.join(iso.home, p.rung.harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md') : null);
  const sum = Rules.summary(rules);
  const startup = {
    agent, role: p.job, harness: p.rung.harness, goal: project.goal || null, target: { id: p.task.id, title: p.task.title, acceptance: p.task.acceptance.length },
    ...(p.rung.harness === 'pi' ? { sandbox: false, confinement: 'unconfined' } : {}),
    rules: rules.map((r) => ({ path: r.path, scope: r.scope, loaded: splitReview ? 'system' : r.loaded, bytes: r.bytes })),
    rules_bytes: sum.bytes, rules_tokens: sum.tokens, instructions_file: instructionsFile,
    prompt_bytes: Buffer.byteLength(prompt), prompt_tokens: Rules.tokens(Buffer.byteLength(prompt)),
    ...(splitReview ? { system_bytes: Buffer.byteLength(reviewSystem), system_tokens: Rules.tokens(Buffer.byteLength(reviewSystem)) } : {}),
    resumed: !!resume, receives_prompt: receivesContext,
  };
  return { agent, argv, env, log, resume, resumeFallbackAgent, resumeFallbackReason, attempt: n, prompt, system: reviewSystem, subs, session_id: sessionId, iso, briefCopy, inbox, settings, startup };
}

function fallbackEnv(spawn) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(spawn.original_env || {})) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

function routeProblems(rung, env, cwd, project = {}) {
  const problems = L.rungErrors('fallback', { own: rung, harness: rung.harness, from: 'user', harness_from: 'rung' }, { user_file: L.userFile(env) });
  if (problems.length) return problems;
  const executable = rung.harness === 'command' ? rung.command[0] : rung.harness;
  // Command templates need the task's prompt and worktree before lookup.
  const template = rung.harness === 'command' && /\{(task|brief|prompt|cwd|session)\}/.test(executable);
  if (!template && findExecutable(executable, cwd, fs.existsSync(cwd), env) === null) problems.push(`no executable ${executable} on this machine`);
  problems.push(...require('./claude-provider').problems(rung, env, A.origin(env), Settings.resolve(project, rung)));
  if (rung.harness === 'codex' && rung.profile) {
    const home = A.origin(env).codex;
    try {
      const toml = require('./toml');
      const config = path.join(home, 'config.toml');
      const doc = fs.existsSync(config) ? toml.parse(fs.readFileSync(config, 'utf8')) : {};
      const file = path.join(home, `${rung.profile}.config.toml`);
      const profile = fs.existsSync(file) ? toml.parse(fs.readFileSync(file, 'utf8')) : doc.profiles?.[rung.profile];
      if (!profile) problems.push(`codex profile ${rung.profile} is not configured in ${home}`);
      else if (!rung.model && !profile.model && !doc.model) problems.push(`codex profile ${rung.profile} has no model`);
    } catch (e) {
      problems.push(`cannot read codex profile ${rung.profile}: ${e.message}`);
    }
  }
  return problems;
}

// Asks gh for the token before the supervisor takes the state lock; gh
// cannot run inside a state mutation.
function fallbackSecrets(spawn) {
  return A.ghToken(fallbackEnv(spawn));
}

function fallbackCommand(spawn, rung, secrets) {
  const env = fallbackEnv(spawn);
  const problems = routeProblems(rung, env, spawn.cwd, spawn.dispatch.project);
  if (problems.length) throw refuse(problems.join('; '));
  const ctx = { stateDir: spawn.state, env };
  const c = command(ctx, { ...spawn.dispatch, rung, routes: spawn.routes }, spawn.cwd, spawn.attempt, S.readEvents(spawn.state), spawn.agent);
  checkScope(c.settings, spawn.cwd, true, env);
  if (findExecutable(c.argv[0], spawn.cwd, true, env) === null) throw missing(c.argv[0], spawn.rung);
  // Rebuild the home only after the previous process group has stopped.
  c.iso?.write();
  try {
    if (c.briefCopy) {
      fs.mkdirSync(c.briefCopy.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(c.briefCopy.file, c.briefCopy.text, { flag: 'wx', mode: 0o600 });
    }
    return { ...c, agentEnv: { ...env, ...c.env, ...(c.iso ? secrets : {}), ...Settings.agentEnv(c.settings) } };
  } catch (error) {
    removeFilteredBrief(c.briefCopy?.file);
    throw error;
  }
}

function npmShimScript(file) {
  try {
    const shim = fs.readFileSync(file, 'utf8');
    const target = shim.match(/"(?:%dp0%|%~dp0)[\\/]([^"\r\n]+)"\s+%\*/i);
    if (!target) return null;
    const script = path.resolve(path.dirname(file), target[1].replace(/\\/g, path.sep));
    return fs.statSync(script).isFile() ? script : null;
  } catch {
    return null;
  }
}

function launchCommand(argv, cwd, env) {
  if (process.platform !== 'win32') return argv;
  const file = findExecutable(argv[0], cwd, true, env);
  if (!file || !/\.cmd$/i.test(file)) return argv;
  const script = npmShimScript(file);
  if (!script) throw refuse(`could not resolve npm shim ${file} to its Node script; reinstall the harness`);
  // cmd.exe expands prompt text and splits newlines, so bypass the npm shim.
  return [process.execPath, script, ...argv.slice(1)];
}

// Finds the program the way a shell-less spawn would, so a harness that
// cannot start is refused before a worktree is created or state is written.
// Windows follows libuv: a bare name is looked up in the cwd, then PATH; a
// name with an extension is tried as given, then with .com and .exe appended.
// npm .cmd shims are also accepted when their Node script exists.
// Returns null when it is missing, undefined when it cannot be known yet
// because it lives in a worktree that does not exist.
function findExecutable(cmd, cwd, cwdExists, env) {
  const win = process.platform === 'win32';
  const abs = path.isAbsolute(cmd);
  const hasDir = /[\\/]/.test(cmd);
  const inWorktree = abs ? path.resolve(cmd).startsWith(path.resolve(cwd) + path.sep) : hasDir;
  if (inWorktree && !cwdExists) return undefined;
  let dirs;
  if (abs) dirs = [''];
  else if (hasDir) dirs = [cwd];
  else {
    // libuv falls back to the default search path when PATH is unset.
    const key = win ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') : 'PATH';
    const list = env[key] === undefined ? (win ? '' : '/usr/bin:/bin') : env[key];
    dirs = [...(win && cwdExists ? [cwd] : []), ...String(list).split(path.delimiter).map((d) => d.replace(/^"(.*)"$/, '$1')).filter(Boolean)];
  }
  const exts = win ? [...(path.extname(cmd) ? [''] : []), '.com', '.exe', '.cmd'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = dir ? path.resolve(dir, cmd + ext) : cmd + ext;
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!win) fs.accessSync(file, fs.constants.X_OK);
        if (win && /\.cmd$/i.test(file) && !npmShimScript(file)) continue;
        return file;
      } catch {
        // Not here, or not executable.
      }
    }
  }
  return null;
}

function checkScope(settings, cwd, cwdExists, env) {
  if (!Settings.scoped(settings)) return;
  if (process.platform !== 'linux') throw refuse('scope requires Linux with systemd-run and a user systemd session');
  if (!findExecutable('systemd-run', cwd, cwdExists, env)) {
    throw refuse('scope requires systemd-run on PATH and a user systemd session; install it or ask the owner to clear scope');
  }
}

// A worker must pass claim's readiness. A fallback taking over an active claim
// needs only a free worker slot.
function workerReadiness(st, task, c, now) {
  const activeFallback = c.resumeFallbackAgent && task.claim?.agent === c.resumeFallbackAgent && !T.leaseExpired(task, now);
  if (activeFallback) T.checkWorkers(st, task, now, 'the workers limit is reached', c.resumeFallbackAgent);
  else T.claimReadiness(st, task, now, c.agent);
}

async function spawn(ctx) {
  if (ctx.flags.ready) return require('./actions').spawn(ctx);
  const f = ctx.flags;
  let p = prepare(ctx);
  if (!f['dry-run'] && p.job === 'worker'
    && ['todo', 'rework'].includes(T.effectiveStatus(p.task, Date.now()))) {
    require('./stack').refreshReadiness(ctx, p.task.id);
    p = prepare(ctx);
  }
  // An orchestrator spawn can act as the orchestrator, so starting one hands
  // out that authority. The approval is used up, and the delegation audited,
  // only by the write that records a spawn that started.
  const delegation = p.job === 'orchestrator' && !f['dry-run'] ? { spawn: p.task.id, role: 'orchestrator' } : null;
  if (delegation) {
    S.mutate(ctx, 'spawn', (st, emit, commit) => Auth.enforce(ctx, st, ['delegation'], { change: delegation, emit, commit, keep: true, quiet: true }));
  }
  const planned = W.plan(p.repo, p.task);
  const providerProblems = require('./claude-provider').problems(p.rung, ctx.env, A.origin(ctx.env), Settings.resolve(p.st.project, p.rung));
  if (providerProblems.length) throw refuse(providerProblems.join('; '));
  if (f['dry-run']) {
    const c = command(ctx, p, planned.path, countSpawns(ctx.stateDir, p.job, p.task.id) + 1);
    const argv = Settings.scopeCommand(c.settings, c.argv);
    const env = { ...c.env, ...(Settings.scoped(c.settings) ? { TOWER_CRANE_SCOPED: '1' } : {}) };
    // The agent's PATH is the user's with its git and gh shims in front.
    const shown = (k, v) => (c.iso && k.toUpperCase() === 'PATH' ? `${shellQuote(path.join(c.iso.home, 'bin'))}${path.delimiter}"$PATH"` : shellQuote(v));
    const envLine = Object.entries(env).map(([k, v]) => `${k}=${shown(k, v)}`).join(' ');
    const home = c.iso && { path: c.iso.home, agent_file: c.iso.agent_file, mcp: c.iso.mcp, tools: c.iso.tools,
      ...(p.rung.harness === 'pi' ? { mcp_supported: false, sandbox: false } : {}) };
    const s = c.startup;
    const head = (home ? `# agent file ${home.agent_file}; home ${home.path}; MCP servers: ${home.mcp.join(', ') || 'none'}; opted-in tools: ${home.tools.join(', ') || 'none'}\n` : '')
      + `# rules: ${s.rules.map((r) => `${r.path} (${r.loaded})`).join(', ') || 'none'}; ${s.rules_bytes} bytes, about ${s.rules_tokens} tokens; prompt ${s.prompt_bytes} bytes, about ${s.prompt_tokens} tokens\n`
      + (p.rung.harness === 'pi' ? '# MCP opt-ins are unsupported on pi; command sandbox unavailable\n' : '')
      + (c.iso?.browser_kit?.warning ? `# ${c.iso.browser_kit.warning}\n` : '');
    return {
      data: {
        agent: c.agent, rung: p.rungName, ...(p.reviewChoice ? { review_rung: p.reviewChoice } : {}),
        harness: p.rung.harness, cwd: planned.path, worktree_exists: planned.exists,
        ...(p.rung.harness === 'pi' ? { sandbox: false } : {}),
        argv, env, log: c.log, home, session_id: c.session_id, resumed: !!c.resume, attempt: c.attempt, startup: c.startup,
        ...(c.system ? { system: c.system } : {}),
        ...(c.iso?.browser_kit ? { browser_kit: c.iso.browser_kit } : {}),
        ...(c.resumeFallbackReason ? { resume_fallback_reason: c.resumeFallbackReason } : {}),
      },
      text: `${head}cd ${shellQuote(planned.path)} && ${envLine} ${argv.map(shellQuote).join(' ')}`,
    };
  }
  if (p.task.stack?.linked) {
    await require('./automation').refreshStacks(ctx);
    p = prepare(ctx);
  }
  const initial = command(ctx, p, planned.path, 1);
  // Before any worktree work, so a task that cannot be claimed is refused with claim's reason.
  if (p.job === 'worker') workerReadiness(p.st, p.task, initial, Date.now());
  const secretEnv = initial.iso ? initial.iso.secretEnv() : null;
  const preparedCI = T.prepareCI(p.st, p.task);
  checkScope(initial.settings, planned.path, planned.exists, ctx.env);
  const argv0 = initial.argv[0];
  if (findExecutable(argv0, planned.path, planned.exists, ctx.env) === null) throw missing(argv0, p.rungName);
  const wt = W.create(p.repo, p.st, p.task);
  wt.head = S.git(['rev-parse', 'HEAD'], wt.path);
  const gitDirs = { common: p.repo.commonDir,
    own: S.git(['rev-parse', '--path-format=absolute', '--git-dir'], wt.path) };
  const logs = path.join(ctx.stateDir, 'logs');
  const wait = !!f.wait;
  let child;
  let supervisorClosed;
  let started;
  let q;
  let logFd;
  let receipt;
  let receiptDir;
  let filteredBriefFile;
  const closeLog = () => {
    if (logFd === undefined) return;
    const fd = logFd;
    logFd = undefined;
    fs.closeSync(fd);
  };
  try {
    // The branch is recorded in the same write as the spawn, so a spawn that
    // fails leaves the task as it was.
    started = S.mutate(ctx, 'spawn', (st, emit, commit) => {
      let delegated = null;
      if (delegation && Auth.role(ctx, st.events) === 'orchestrator') {
        delegated = Auth.approval(st, ['delegation'], delegation);
        if (!delegated) throw refuse(`${p.task.id}: the owner's approval of this orchestrator spawn was used or changed while spawning; retry spawn`);
      }
      q = dispatch(ctx, st, p.reviewDiff, p.repo, preparedCI);
      const over = T.budgetBreaches(st, q.task);
      if (over.length) throw refuse(`${over.map(T.breachText).join('; ')}; only the owner raises a budget (tower-crane project set or task update --budget-tokens, --budget-hours)`);
      W.record(st, q.task, wt, emit);
      const c = command(ctx, { ...q, project: st.project, repo: p.repo, gitDirs }, wt.path, countSpawns(ctx.stateDir, q.job, q.task.id) + 1, st.events);
      // Under the lock, the same check again: the state read before the worktree may have changed.
      if (q.job === 'worker') workerReadiness(st, q.task, c, Date.now());
      let usageBefore = null;
      if (c.resume) {
        T.collectSpawn(st, emit, c.resume.previous);
        if (q.rung.harness === 'codex') usageBefore = require('./usage-files').readUsage(c.resume.previous.detail);
      }
      let fallbackClaim = null;
      let workerStarted = false;
      let env;
      let observed;
      const restoreFallbackClaim = (error) => {
        if (!fallbackClaim || workerStarted) return;
        if (child?.pid) {
          try { child.kill(); } catch (killError) {
            error.message += `; could not stop the supervisor: ${killError.message}`;
          }
        }
        if (logFd !== undefined) {
          try { closeLog(); } catch (closeError) {
            error.message += `; could not close the unused log: ${closeError.message}`;
          }
          try { fs.rmSync(c.log, { force: true }); } catch (removeError) {
            error.message += `; could not remove the unused log: ${removeError.message}`;
          }
          try { fs.rmdirSync(logs); } catch {
            // Other agents' logs are there.
          }
        }
        q.task.claim = fallbackClaim.claim;
        q.task.status = fallbackClaim.status;
        emit(q.task.id, {
          holder: fallbackClaim.claim.agent,
          until: fallbackClaim.claim.until,
          from: fallbackClaim.claim.from,
          restored_from: c.agent,
          rollback: true,
        }, 'claim');
        try {
          commit();
        } catch (rollbackError) {
          error.message += `; could not restore prior claim: ${rollbackError.message}`;
        }
      };
      try {
        if (c.resumeFallbackAgent && q.task.claim?.agent === c.resumeFallbackAgent) {
          const now = Date.now();
          const expired = T.leaseExpired(q.task, now);
          const previous = q.task.claim.agent;
          fallbackClaim = { claim: { ...q.task.claim }, status: q.task.status };
          const from = q.task.claim.from || 'rework';
          const until = new Date(now + st.project.limits.lease_minutes * 60000).toISOString();
          q.task.claim = { agent: c.agent, since: new Date(now).toISOString(), until, from };
          q.task.status = 'in_progress';
          emit(q.task.id, { holder: c.agent, until, from, took_over_from: previous }, 'claim');
          commit();
        }
        if (c.resume && (!q.task.claim || T.leaseExpired(q.task, Date.now()))) {
          const since = q.task.claim?.since || c.resume.claim?.since || new Date().toISOString();
          const from = c.resume.interrupted ? c.resume.claim?.from || 'todo' : 'rework';
          q.task.claim = { agent: c.agent, since, until: new Date(Date.now() + st.project.limits.lease_minutes * 60000).toISOString(), from };
          q.task.status = 'in_progress';
          emit(q.task.id, { holder: c.agent, until: q.task.claim.until, from, resumed: true }, 'claim');
        } else if (q.job === 'worker' && q.task.claim?.agent === c.agent && T.leaseExpired(q.task, Date.now())) {
          // A matching expired claim must hold a slot before supervision can renew it.
          q.task.claim.until = new Date(Date.now() + st.project.limits.lease_minutes * 60000).toISOString();
          emit(q.task.id, { holder: c.agent, until: q.task.claim.until, restored: true }, 'renew');
        }
        // The rung may have changed since the early check; its program is
        // checked again before anything starts.
        if (c.argv[0] !== argv0 && findExecutable(c.argv[0], wt.path, true, ctx.env) === null) throw missing(c.argv[0], q.rungName);
        checkScope(c.settings, wt.path, true, ctx.env);
        if (c.briefCopy) {
          filteredBriefFile = c.briefCopy.file;
          fs.mkdirSync(c.briefCopy.dir, { recursive: true, mode: 0o700 });
          fs.writeFileSync(filteredBriefFile, c.briefCopy.text, { flag: 'wx', mode: 0o600 });
        }
        env = Settings.cleanAgentEnv({ ...process.env, ...ctx.env, ...c.env });
        // Credentials the agent process needs at run time only, kept out of c.env
        // so dry runs and events never show them.
        if (c.iso) {
          if (secretEnv === null) throw refuse('isolation changed after spawn preparation; retry spawn');
          Object.assign(env, secretEnv);
        }
        if (c.iso) c.iso.write();
        if (q.job === 'reviewer') {
          fs.mkdirSync(path.dirname(q.briefFile), { recursive: true });
          S.writeAtomic(q.briefFile, q.brief);
        }
        fs.mkdirSync(logs, { recursive: true });
        // Exclusive creation prevents replacing a log or following a planted link.
        try {
          logFd = fs.openSync(c.log, 'ax', 0o600);
        } catch (e) {
          if (e.code === 'EEXIST') throw refuse(`EEXIST: log already exists: ${c.log}; preserve or move it before retrying`);
          throw e;
        }
        const cache = path.join(os.homedir(), '.cache', 'tower-crane');
        fs.mkdirSync(cache, { recursive: true });
        receiptDir = fs.mkdtempSync(path.join(cache, 'spawn-'));
        receipt = path.join(receiptDir, 'started.json');
        const brokered = [...new Set(L.routes(q.rung).filter((r) => A.sandboxed(q.job, r.harness)).map((r) => r.harness))];
        const job = {
          state: ctx.stateDir, task: q.task.id, agent: c.agent, role: q.job, rung: q.rungName,
          harness: q.rung.harness, rung_config: q.rung, cwd: wt.path, log: c.log, argv: c.argv, receipt,
          codex_home: c.iso?.usageRoot || env.CODEX_HOME || path.join(os.homedir(), '.codex'), wait, filteredBriefFile,
          // Live usage only: the supervisor reads the session file there; events never carry it.
          claude_home: c.iso?.env.CLAUDE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
          usage_before: usageBefore,
          prompt: c.prompt, subs: c.subs, owned_flags: c.iso?.flags || [],
          browser_kit: c.iso?.browser_kit || null,
          session_id: c.session_id,
          // A sandboxed agent cannot write the state; the monitor brokers its
          // changes, with the credentials in its private broker directory,
          // for every sandboxed harness among the rung's fallbacks.
          broker: brokered.length ? path.join(require('./broker').dir(ctx.stateDir, c.agent), require('./broker').FILE) : null,
          broker_harnesses: brokered, sandboxed: !!c.iso?.sandbox,
          attempt: c.attempt, route: q.rung, resumed: !!c.resume,
          task_status: q.task.status, task_sha: q.task.sha, task_revision: q.task.revision,
          dispatch_path: process.env.PATH || process.env.Path,
          hook: c.env.TOWER_CRANE_HOOK,
          inbox: c.inbox,
          settings: c.settings,
          routes: L.routes(q.rung), route_index: 0, log_start: 0,
          original_env: Object.fromEntries(Object.keys(c.iso?.env || {}).map((key) => [key, ctx.env[key] ?? null])),
          dispatch: {
            job: q.job, rungName: q.rungName, task: q.task, brief: q.brief, briefFile: q.briefFile,
            reviewSha: q.reviewSha, reviewSummary: q.reviewSummary, project: st.project, repo: p.repo, gitDirs,
          },
        };
        // The job file outlives a killed dispatch, so env values reach the
        // supervisor in its environment, or a file it deletes on read, never
        // in the job file or its argv. This process waits for the receipt
        // synchronously; a pipe would not flush.
        const { value: jobDoc, secrets } = Secrets.split(job);
        const jobFile = path.join(receiptDir, 'job.json');
        fs.writeFileSync(jobFile, JSON.stringify(jobDoc), { flag: 'wx', mode: 0o600 });
        child = cp.spawn(process.execPath, [
          ...process.execArgv, path.join(c.iso.tool.path, 'lib', 'spawn-monitor.js'), jobFile,
        ], { cwd: wt.path, env: { ...env, ...Secrets.handoff(secrets, receiptDir) }, stdio: ['ignore', wait ? 'pipe' : logFd, wait ? 'pipe' : logFd, logFd], detached: !wait, windowsHide: true });
        supervisorClosed = new Promise((resolve) => {
          child.once('close', resolve);
          child.once('error', () => { if (!child.pid) resolve(); });
        });
        child.on('error', (error) => process.stderr.write(`tower-crane: supervisor process failed: ${error.message}\n`));
        if (wait) {
          const capture = (dest) => (data) => dest.write(data);
          child.stdout?.on('data', capture(ctx.json ? process.stderr : process.stdout));
          child.stderr?.on('data', capture(process.stderr));
          child.on('close', closeLog);
        }
        const deadline = Date.now() + 10000;
        while (child.pid && !fs.existsSync(receipt) && Date.now() < deadline) sleepSync(10);
        if (fs.existsSync(receipt)) {
          observed = JSON.parse(fs.readFileSync(receipt, 'utf8'));
          fs.rmSync(receipt, { force: true });
        }
        if (!observed?.pid) {
          if (child.pid) child.kill();
          closeLog();
          fs.rmSync(c.log, { force: true });
          try { fs.rmdirSync(logs); } catch {
            // Other agents' logs are there.
          }
          throw refuse(`could not start ${c.argv[0]}: ${observed?.error || 'supervisor startup failed'}; check that it is installed and on PATH`);
        }
        workerStarted = true;
      } catch (error) {
        restoreFallbackClaim(error);
        throw error;
      }
      const detail = {
        role: q.job, rung: q.rungName, agent: c.agent, harness: q.rung.harness,
        ...(q.rung.harness === 'pi' ? { sandbox: false } : {}),
        tool: c.iso.tool,
        ...(q.reviewChoice ? { review_rung: q.reviewChoice, sha: q.task.sha, revision: q.task.revision } : {}),
        route: q.rung, attempt: c.attempt, resumed: !!c.resume,
        ...(c.resumeFallbackReason ? { resume_fallback_reason: c.resumeFallbackReason } : {}),
        ...(c.resume && q.rung.harness === 'codex' ? { usage_before: usageBefore } : {}),
        model: q.rung.model || null, profile: q.rung.profile || null,
        ...observed, phase: 'running', retry: 0,
        claim_since: q.task.claim?.agent === c.agent ? q.task.claim.since : null,
        ...(q.job === 'worker' && q.task.claim?.agent !== c.agent ? { reserved: true } : {}),
        session_id: c.session_id,
        cwd: wt.path, log: c.log,
        ...(q.rung.harness === 'codex' ? { codex_home: (c.iso && c.iso.usageRoot) || env.CODEX_HOME || path.join(os.homedir(), '.codex') } : {}),
      };
      if (delegation) {
        if (delegated) Auth.apply(ctx, delegated);
        const who = Auth.role(ctx, st.events);
        if (who === 'owner') Auth.applyOwner(ctx, st, ['delegation'], delegation, emit);
        Auth.audit(ctx, who, ['delegation'], emit, delegated);
      }
      // Before the spawn event, which views read as the task's latest step.
      emit(q.task.id, { ...c.startup, attempt: c.attempt }, 'startup');
      emit(q.task.id, detail);
      if (q.job === 'worker' && q.task.escalation_pending) q.task.escalation_pending = false;
      st.rerender = true;
      return { ...detail, argv0: c.argv[0], filteredBriefFile };

    });
  } catch (e) {
    if (child?.pid) child.kill();
    if (supervisorClosed) await supervisorClosed;
    closeLog();
    removeFilteredBrief(filteredBriefFile);
    // spawn never deletes a worktree or branch: another command may already
    // have been handed it, and the next spawn of the task reuses it.
    e.message += `; its worktree stays at ${wt.path} for the next spawn`;
    throw e;
  } finally {
    if (receiptDir) fs.rmSync(receiptDir, { recursive: true, force: true });
  }
  if (!wait) {
    closeLog();
    child.unref();
    return { data: started, text: `${started.agent} started, pid ${started.pid}, log ${started.log}${started.browser_kit?.warning ? `\n${started.browser_kit.warning}` : ''}` };
  }
  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (c) => resolve(c === null ? 1 : c));
  });
  removeFilteredBrief(started.filteredBriefFile);
  try {
    T.spend({ ...ctx, pos: [q.task.id], flags: { 'from-spawn': started.agent } });
  } catch (e) {
    process.stderr.write(`tower-crane: usage not recorded: ${e.message}; retry spend ${q.task.id} --from-spawn ${started.agent}\n`);
  }
  return { data: { ...started, code }, text: `${started.agent} exited with ${code}${started.browser_kit?.warning ? `\n${started.browser_kit.warning}` : ''}`, code };
}

module.exports = { spawn, buildPrompt, buildCommand, findExecutable, launchCommand, fallbackCommand, fallbackSecrets, routeProblems, removeFilteredBrief };
