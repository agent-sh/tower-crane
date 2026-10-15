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
// How long a dispatch waits for its supervisor's startup receipt.
const STARTUP_MS = 10000;
const Sessions = require('./spawn-session');
const A = require('./agents');
const R = require('./reviewer');
const Settings = require('./spawn-settings');
const Secrets = require('./secrets');
const Rules = require('./rules');
const Health = require('./harness-health');
const Auth = require('./authority');

const ROLE_SKILLS = { worker: 'tower-crane-work', reviewer: 'tower-crane-review' };
const EMBEDDED_SKILL_HARNESSES = new Set(['claude', 'codex', 'opencode', 'agy']);
const MISSING_SKILL_WARNINGS = new Set();
// The harness starts only after its monitor writes a line to the gate's stdin,
// which happens once the worker's lease is taken. Then its stdin is /dev/null,
// the same as the ignored stream it replaces.
const LEASE_GATE = ['/bin/sh', '-c', 'read -r _ || exit 1; exec "$@" </dev/null', 'tower-crane-gate'];

function skillFile(job, env) {
  const name = ROLE_SKILLS[job];
  return name ? path.join(env.TOWER_CRANE_PLUGIN_ROOT || path.join(__dirname, '..'), 'skills', name, 'SKILL.md') : null;
}

// The role skill's copy in the state directory (skillStore in lib/agents.js),
// which every agent's sandbox can read and no agent's exit removes.
function storedSkillFile(job, env, stateDir) {
  const store = A.skillStore(env, stateDir);
  return store ? path.join(store.dir, ROLE_SKILLS[job], 'SKILL.md') : null;
}

// A user's worktree has no skills/ directory; prompts name the stored copy.
// A harness that neither embeds nor loads the skill reads only this name, so
// a plugin root without the file warns here too, and the prompt then names no
// path that would not exist.
function skillRef(job, env, stateDir) {
  const file = skillFile(job, env);
  if (!isFile(file)) {
    warnMissingSkill(file);
    return `the ${ROLE_SKILLS[job]} skill`;
  }
  return `the ${ROLE_SKILLS[job]} skill (${storedSkillFile(job, env, stateDir)})`;
}

// The review packet is built before the skills are stored; command() puts the
// stored path in place of this marker. It sits in the packet's first line,
// ahead of any diff or finding text, and only its first occurrence is replaced.
const REVIEW_SKILL = 'the tower-crane-review skill (TOWER_CRANE_REVIEW_SKILL)';

// Any stat failure (missing, unreadable, not a directory) counts as no skill.
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
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
function piSkill(job, env, stateDir) {
  const file = skillFile(job, env);
  if (!file) return null;
  if (isFile(file)) return stateDir ? path.dirname(storedSkillFile(job, env, stateDir)) : path.dirname(file);
  warnMissingSkill(file);
  return null;
}

function filteredBrief(ctx, text) {
  const cache = process.platform === 'win32'
    ? ctx.env.LOCALAPPDATA || path.join(ctx.env.USERPROFILE || ctx.env.HOME || os.homedir(), 'AppData', 'Local')
    : ctx.env.XDG_CACHE_HOME || path.join(ctx.env.HOME || os.homedir(), '.cache');
  const root = path.resolve(ctx.env.TOWER_CRANE_TMP || ctx.env.TOWER_CRANE_TEST_TMP || path.join(cache, 'tower-crane'));
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

function buildCommand(job, rung, prompt, subs, env = process.env, own = [], session = null, stateDir = null) {
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
      return ['opencode', 'run', '--format', 'json', ...opt('-m', rung.model), ...opt('--variant', rung.effort), ...own, prompt, ...extra];
    case 'agy':
      return ['agy', '-p', prompt, '--mode', 'accept-edits', '--output-format', 'json', ...opt('--model', rung.model), ...opt('--effort', rung.effort), ...own, ...extra];
    case 'pi':
      return [
        'pi', '-p', prompt, '--mode', 'json', ...opt('--model', rung.model), ...opt('--provider', rung.provider),
        ...opt('--thinking', rung.effort), ...opt('--skill', piSkill(job, env, stateDir)), ...own, ...extra,
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

// A reservation is gone only when its monitor and its harness's process group
// have both exited; an unknown process counts as live, so it is never cleared.
function reservationGone(proc) {
  return P.processState({ host: proc.host, pid: proc.monitor_pid, start_ticks: proc.monitor_start_ticks }) === 'exited'
    && P.processGroupState({ host: proc.host, pid: proc.pid, start_ticks: proc.start_ticks }) === 'exited';
}

// Dispatch and wait clear reservations under the state lock so claim and
// every other reader count the same audited holders.
function clearGoneReservations(st, emit, commit, now) {
  const gone = T.reservations(st, now).filter((r) => reservationGone(r.proc));
  for (const r of gone) emit(r.task, { agent: r.agent, attempt: r.attempt, pid: r.proc.pid, reason: 'process gone' }, 'reservation clear');
  if (gone.length) commit();
}

// Capacity is counted after clearing so a gone reservation cannot hide a free slot.
function clearDeadReservations(ctx) {
  if (!T.reservations(S.loadState(ctx.stateDir), Date.now()).some((r) => reservationGone(r.proc))) return false;
  S.mutate(ctx, 'spawn', (st, emit, commit) => clearGoneReservations(st, emit, commit, Date.now()));
  return true;
}

// With no --role the task's own tier picks the rung, so the orchestrator
// dispatches work at the tier it planned. spawn calls this twice: once to
// refuse early, before a worktree exists, and again on the state it reads
// under the lock, so a tier, ladder or brief change that lands in between is
// the one that runs.
function dispatch(ctx, st, preparedDiff, preparedRepo, preparedCI, findings) {
  const f = ctx.flags;
  if (st.project.limits.paused && !f['dry-run']) throw refuse(`project paused: ${st.project.limits.paused}`);
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
    const verdict = T.latestGateEvidence(task, 'review', st.events);
    if (!f['dry-run'] && verdict?.ok === false && !require('./review-findings').bodyOnly(verdict.findings)) {
      throw refuse(`${task.id}: current review FAIL; run tower-crane rework --from-review ${task.id}`);
    }
    const report = R.softwareReport(st, task, preparedCI);
    if (!report.ok) throw refuse(`${task.id}: software gates must pass before review: ${report.missing.join('; ')}`);
    if (!f['dry-run'] && st.events.some((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'reviewer'
      && shaMatch(e.detail.sha, task.sha) && e.detail.revision === task.revision && !Sessions.exitedAttempt(e, st.events))) {
      throw refuse(`${task.id}: a reviewer is still running; wait for its result`);
    }
    const project = { ...st.project, base: require('./stack').targetBase(st, task) };
    const reviewScope = R.reReview(st, task);
    const diff = preparedDiff ? R.checkedDiff(preparedDiff, project, task, reviewScope) : R.diffOf(repo, project, task, reviewScope);
    if (preparedDiff) R.checkedLight(st, task, diff);
    else R.prepareLight(st, task, repo, diff);
    const selection = R.choose(st, task, layers, diff, ctx.env);
    return {
      ...healthyRoute(st, task, selection.rung), rungName, job: 'reviewer', task,
      brief: R.context(st, task, diff, report, selection, findings, true, REVIEW_SKILL),
      reviewSummary: R.context(st, task, diff, report, selection, findings, false, REVIEW_SKILL),
      briefFile: path.join(st.dir, 'reviews', `${task.id}-${diff.sha}.md`),
      reviewChoice: selection.name, reviewLevel: selection.level, reviewSha: diff.sha, reviewDiff: diff, findings,
    };
  }
  const broken = L.rungErrors(rungName, layers.ladder[rungName], layers);
  if (broken.length) throw refuse(`${broken.join('; ')}; fix it with tower-crane ladder set ${rungName}`);
  const job = L.JOBS[rungName];
  const briefFile = T.briefPath(st.dir, task.id);
  let brief;
  try {
    brief = fs.readFileSync(briefFile, 'utf8');
  } catch {
    throw refuse(`${task.id} has no brief; write one with tower-crane brief set ${task.id} --file F before spawning`);
  }
  return { ...healthyRoute(st, task, L.rungOf(layers, rungName)), rungName, job, task, brief, briefFile };
}

// A paused harness takes no route. The rung runs on its first route whose
// harness is healthy, and the routes after it stay as fallbacks.
function healthyRoute(st, task, rung) {
  const all = L.routes(rung);
  const routes = Health.usable(st, all);
  if (!routes.length) throw refuse(`${task.id}: ${Health.refusal(st, all)}`);
  return { rung: routes[0] === all[0] ? rung : routes[0], routes };
}

function prepare(ctx) {
  const f = ctx.flags;
  if (!f.task) throw usage('spawn needs --task ID');
  if (f.role !== undefined && !L.RUNGS.includes(f.role)) throw usage(`--role must be a rung: ${L.RUNGS.join(', ')}; got "${f.role}"`);
  let st = S.loadState(ctx.stateDir);
  // A dry run only previews, so it reads the pause without probing.
  if (!f['dry-run'] && Health.probe(ctx, st)) st = S.loadState(ctx.stateDir);
  return { st, ...dispatch(ctx, st), repo: W.needRepo(ctx) };
}

// Reads the excludes the agent's git will see. An existing worktree applies its
// own worktree-scoped config; a worktree not yet created has none, so the main
// checkout's worktree-scoped entry does not apply to it.
function reportSweep({ failures }) {
  for (const { relative, error } of failures) process.stderr.write(`tower-crane: could not remove stale Claude sandbox placeholder ${relative}: ${error.message}\n`);
}

function inheritedGitExclude(planned, root, env) {
  const result = cp.spawnSync('git', ['config', '--show-scope', '--get-all', '--path', 'core.excludesFile'], {
    cwd: planned.exists ? planned.path : root, env: { ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, windowsHide: true,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw refuse(`cannot read Git core.excludesFile${result.error ? ` (${result.error.message})` : `: ${String(result.stderr || '').trim()}`}`);
  }
  // Each line is a scope, a tab and a value. The last value wins, as it does for git.
  const values = String(result.stdout || '').split(/\r?\n/).filter(Boolean)
    .map((line) => ({ scope: line.slice(0, line.indexOf('\t')), value: line.slice(line.indexOf('\t') + 1) }))
    .filter((entry) => planned.exists || entry.scope !== 'worktree');
  const last = values.at(-1);
  if (last && !last.value) return '';
  const home = Object.entries(env).find(([key]) => key.toUpperCase() === 'HOME')?.[1]
    || Object.entries(env).find(([key]) => key.toUpperCase() === 'USERPROFILE')?.[1]
    || os.homedir();
  const xdg = Object.entries(env).find(([key]) => key.toUpperCase() === 'XDG_CONFIG_HOME')?.[1];
  const defaultConfig = xdg
    ? (path.isAbsolute(xdg) ? xdg : path.resolve(root, xdg))
    : path.join(home, '.config');
  // Git resolves a relative excludes path against the worktree it runs in.
  const file = last
    ? path.resolve(planned.path, last.value)
    : path.join(defaultConfig, 'git', 'ignore');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw refuse(`cannot read Git excludes file ${file} (${error.code || error.message})`);
  }
}

function missing(argv0, rungName) {
  return refuse(`could not start ${argv0}: no executable file by that name${path.isAbsolute(argv0) || /[\\/]/.test(argv0) ? '' : ' on PATH'}; install it, or fix the rung with tower-crane ladder set ${rungName}`);
}

// A worker that picks up a task with a linked PR continues that PR, so it does not open a second one.
function pullRequestNote(p) {
  if (p.job !== 'worker' || !p.task.pr) return '';
  const branch = p.task.branch ? ` on branch ${p.task.branch}` : '';
  return `## Pull request ${p.task.id}\n\nThis task's pull request is #${p.task.pr}${branch}. If it is still open, push to that branch and submit with --pr ${p.task.pr}; do not open another PR.`;
}

function reworkNote(p, events, resumed, env, stateDir) {
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
      ? `Continue in this worktree. Your worker identity and claim are kept. Follow ${skillRef('worker', env, stateDir)} and submit the corrected head.`
      : `Claim this task in this worktree. Follow ${skillRef('worker', env, stateDir)} and submit the corrected head.`,
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
  const parentCwd = p.parentCwd || process.cwd();
  const from = A.origin(ctx.env, parentCwd);
  const settings = Settings.prepare(Settings.resolve(project, p.rung), from.home, p.repo.root);
  // Before the worktree exists, the repository's own checkout stands in for it.
  const root = fs.existsSync(cwd) ? cwd : p.repo.root;
  const rules = Rules.chain({ harness: p.rung.harness, cwd: root, gitRoot: root, origin: from, env: ctx.env });
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
  let iso = A.isolation(p.job, p.rung, p.rungName, { stateDir: ctx.stateDir, repo: p.repo, projectRepo: project.repo, gitDirs: p.gitDirs, env: ctx.env, agent, cwd, parentCwd, task: p.task.id, taskSpec: p.task, routes: p.routes || L.routes(p.rung), attempt: n, settings, rules, reviewSystem, gitExcludeText: p.gitExcludeText, gitConfig: p.gitConfig, remoteHosts: p.remoteHosts });
  const resumeFallbackReason = resume && p.rung.harness === 'codex'
    ? Sessions.missingCodexSession(resume.id, iso)
    : null;
  if (resumeFallbackReason) {
    resumeFallbackAgent = resume.agent;
    resume = null;
    agent = `${p.job}-${p.task.id}-${n}`;
    iso = A.isolation(p.job, p.rung, p.rungName, { stateDir: ctx.stateDir, repo: p.repo, projectRepo: project.repo, gitDirs: p.gitDirs, env: ctx.env, agent, cwd, parentCwd, task: p.task.id, taskSpec: p.task, routes: p.routes || L.routes(p.rung), attempt: n, settings, rules, gitExcludeText: p.gitExcludeText, gitConfig: p.gitConfig, remoteHosts: p.remoteHosts });
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
    resume ? `Your worker identity and claim are restored. Follow ${skillRef('worker', ctx.env, ctx.stateDir)} and submit the finished head.`
      : `Claim this task, follow ${skillRef('worker', ctx.env, ctx.stateDir)} and submit the finished head.`,
  ].join('\n\n') : '';
  // An interrupted rework run is still a rework: its failed review feedback goes with the interrupt.
  const note = [interruptNote, reworkNote(p, events, !!resume, ctx.env, ctx.stateDir), pullRequestNote(p)].filter(Boolean).join('\n\n');
  const scratchNote = iso.scratch
    ? `Task scratch: ${iso.scratch}. XDG_CACHE_HOME points here. Earlier attempts' files survive worker spawns and rework; reuse them here. Scratch is removed with the task worktree when the task closes.`
    : '';
  const ownReviewSkill = (text) => text?.replace(REVIEW_SKILL, () => skillRef('reviewer', ctx.env, ctx.stateDir));
  const reviewBrief = p.job === 'reviewer' ? ownReviewSkill(p.brief) : null;
  const roleBrief = p.job === 'reviewer' ? reviewBrief : [B.forRole(p.brief, p.job), p.job === 'worker' ? TestsHostOnly.section(project) : '', scratchNote].filter(Boolean).map((text) => text.trimEnd()).join('\n\n');
  // Keep Windows argv below its 32K limit; the CLI writes the full diff packet
  // before launching, and the reviewer reads that one file.
  const brief = p.job === 'reviewer' && roleBrief.length > 12000
    ? `${ownReviewSkill(p.reviewSummary)}\n\nRead ${p.briefFile} for the diff at ${p.reviewSha}.`
    : roleBrief;
  const researchInstructions = p.job === 'worker' && p.rungName === 'research' && !L.ISOLATED.includes(p.rung.harness)
    ? A.load('researcher').body : '';
  const hooks = require('./harness-hooks');
  const inboxMessages = hooks.unread(events, agent);
  const messages = hooks.context(inboxMessages);
  const house = { goal: project.goal, rules: splitReview ? '' : Rules.section(rules) };
  const prompt = [
    resume ? [note, scratchNote].filter(Boolean).join('\n\n') : buildPrompt(p.task, [researchInstructions, brief, note].filter(Boolean).join('\n\n'), p.job, agent, splitReview ? '' : skill, house),
    ...(splitReview && iso?.mcp.length ? [`Approved MCP servers for this dispatch: ${iso.mcp.join(', ')}. Use browser tools only for the task's UI.`] : []),
    messages,
  ].filter(Boolean).join('\n\n');
  const briefCopy = p.rung.harness === 'command' && p.rung.command.some((arg) => arg.includes('{brief}'))
    ? filteredBrief(ctx, briefCopyText(p.task, [researchInstructions, roleBrief, note].filter(Boolean).join('\n\n'), p.job, { ...house, messages }))
    : null;
  const subs = { task: p.task.id, brief: briefCopy?.file || p.briefFile, prompt, cwd };
  const own = [...(iso ? iso.flags : []), ...(splitReview && p.rung.harness === 'claude'
    ? ['--append-system-prompt-file', path.join(iso.home, 'system.md'), '--exclude-dynamic-system-prompt-sections'] : [])];
  const argv = buildCommand(p.job, rung, prompt, subs, ctx.env, own, resume?.id, ctx.stateDir);
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
  return { agent, argv, env, log, resume, resumeFallbackAgent, resumeFallbackReason, attempt: n, prompt, reviewBrief, system: reviewSystem, subs, session_id: sessionId, iso, briefCopy, inbox, settings, startup };
}

// The supervisor runs in the dispatcher's environment, which a fallback
// route's agent starts from.
function fallbackEnv() {
  return { ...process.env };
}

function routeProblems(rung, env, cwd, project = {}, parentCwd = process.cwd()) {
  const problems = L.rungErrors('fallback', { own: rung, harness: rung.harness, from: 'user', harness_from: 'rung' }, { user_file: L.userFile(env) });
  if (problems.length) return problems;
  const executable = rung.harness === 'command' ? rung.command[0] : rung.harness;
  // Command templates need the task's prompt and worktree before lookup.
  const template = rung.harness === 'command' && /\{(task|brief|prompt|cwd|session)\}/.test(executable);
  if (!template && findExecutable(executable, cwd, fs.existsSync(cwd), env) === null) problems.push(`no executable ${executable} on this machine`);
  const from = A.origin(env, parentCwd);
  problems.push(...require('./claude-provider').problems(rung, env, from, Settings.resolve(project, rung)));
  if (rung.harness === 'codex' && rung.profile) {
    const home = from.codex;
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
// cannot run inside a state mutation. Only an unsandboxed fallback route
// receives it.
function fallbackSecrets(spawn) {
  return A.ghToken(fallbackEnv());
}

function fallbackCommand(spawn, rung, secrets) {
  const env = fallbackEnv();
  const problems = routeProblems(rung, env, spawn.cwd, spawn.dispatch.project, spawn.dispatch.parentCwd);
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
    const agentEnv = { ...env, ...c.env, ...(c.iso && !c.iso.sandbox ? secrets : {}), ...Settings.agentEnv(c.settings),
      ...(c.iso ? c.iso.credentialEnv() : {}) };
    // A sandboxed codex agent's own temp directory wins over the project's env.
    if (c.iso?.tmp) Object.assign(agentEnv, A.ownTmpEnv(c.iso.tmp, agentEnv));
    const from = A.origin(agentEnv);
    return { ...c, agentEnv, billing: L.billing(rung, require('./claude-provider').routedEnv(agentEnv, from), from) };
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

// A worker pushes its task branch to origin and opens its PR there. Without
// origin it can only fail at the end, after a full session, so dispatch
// refuses before it creates a worktree or starts a harness.
function requireOrigin(repo) {
  if (S.git(['remote', 'get-url', 'origin'], repo.root)) return;
  throw refuse('this repository has no origin remote; workers push their task branch to origin and open the PR there. Add it with git remote add origin URL, then spawn again');
}

async function spawn(ctx) {
  if (ctx.flags.ready) return require('./actions').spawn(ctx);
  const f = ctx.flags;
  if (f.role === 'review' && f.task && !f['dry-run']) {
    const rejected = await require('./actions').failedReview(ctx, f.task);
    if (rejected) return rejected;
  }
  let p = prepare(ctx);
  const worker = !f['dry-run'] && p.job === 'worker';
  if (worker) requireOrigin(p.repo);
  // Stack reads and syncs (gh, git, possibly pushes) and the fetches a new
  // worktree needs run before the dispatch lock: none of them takes a slot,
  // and the dispatch reads the state again once it holds the lock.
  if (worker && ['todo', 'rework'].includes(T.effectiveStatus(p.task, Date.now()))) {
    require('./stack').refreshReadiness(ctx, p.task.id);
    p = prepare(ctx);
  }
  if (!f['dry-run'] && p.task.stack?.linked) {
    await require('./automation').refreshStacks(ctx);
    p = prepare(ctx);
  }
  // A proven-dead reservation must not refuse the readiness check that gates the prefetch.
  if (worker && clearDeadReservations(ctx)) p = prepare(ctx);
  const fetched = worker ? prefetchReady(ctx, p) : null;
  // Worker dispatches take slots one at a time. Another dispatch that is still
  // preparing the first ready task's worktree refuses it for now, and without
  // this lock that refusal would hand the slot to a task ranked below it.
  const lock = worker ? dispatchLock(ctx) : null;
  let result;
  try {
    result = await dispatchJob(ctx, lock ? prepare(ctx) : p, fetched);
  } finally {
    if (lock) S.releaseLock(lock);
  }
  return result.wait ? result.wait() : result;
}

// A task the dispatch would refuse does no network work: readiness is
// checked first, as dispatchJob checks it again before its worktree and under
// the state lock. A worktree another dispatch is still creating leaves the
// decision to the check under the dispatch lock.
function prefetchReady(ctx, p) {
  let planned;
  try { planned = W.plan(p.repo, p.task); } catch { return null; }
  workerReadiness(p.st, p.task, command(ctx, p, planned.path, 1), Date.now());
  return W.prefetch(p.repo, p.st, p.task);
}

// The longest a dispatch lock holder can wait while it holds the lock: the
// worktree lock (new worktree's admin move), the state lock (the spawn
// record) and two supervisor startup windows (the lease handshake, then the
// receipt). Checkout time comes on top and is seconds for a normal repository.
// A waiter gets that much before it gives up. A task with dependencies does
// its stack reads (gh) and base fetch under the lock, where a dependency merge
// cannot slip past them, so a slow GitHub or origin can take its dispatch past
// this budget and the waiter retries on the next pass.
const DISPATCH_WAIT_MS = W.WORKTREE_LOCK_MS + S.LOCK_WAIT_MS + 2 * STARTUP_MS;

// Holds the state directory's dispatch lock, which is apart from the write
// lock: worktree preparation runs git, which the write lock forbids. A
// timeout is marked so a batch stops and a refill retries instead of
// treating it as a refusal of the task.
function dispatchLock(ctx) {
  const dir = path.join(ctx.stateDir, 'dispatch');
  fs.mkdirSync(dir, { recursive: true });
  try {
    return S.acquireLock(dir, DISPATCH_WAIT_MS, 'dispatch');
  } catch (e) {
    if (e.code === 3) {
      e.message = e.message.replace(/^state is locked/, 'worker dispatch is locked');
      e.dispatchLocked = true;
    }
    throw e;
  }
}

async function dispatchJob(ctx, p, fetched) {
  const f = ctx.flags;
  // A proven-dead reservation holds a slot until it is cleared, so clear it before the first capacity check.
  if (!f['dry-run'] && p.job === 'worker' && clearDeadReservations(ctx)) p = prepare(ctx);
  // An orchestrator spawn can act as the orchestrator, so starting one hands
  // out that authority. The approval is used up, and the delegation audited,
  // only by the write that records a spawn that started.
  const delegation = p.job === 'orchestrator' && !f['dry-run'] ? { spawn: p.task.id, role: 'orchestrator' } : null;
  if (delegation) {
    S.mutate(ctx, 'spawn', (st, emit, commit) => Auth.enforce(ctx, st, ['delegation'], { change: delegation, emit, commit, keep: true, quiet: true }));
  }
  const planned = W.plan(p.repo, p.task);
  if (!f['dry-run'] && A.sandboxed(p.job, 'claude') && L.routes(p.rung).some((route) => route.harness === 'claude')) {
    // Placeholders an earlier agent left would count as the worktree's own
    // files from here on; git cannot run under the lock, so sweep them now.
    if (planned.exists) reportSweep(require('./claude-sandbox-placeholders').sweep(planned.path, ctx.env));
    p.gitExcludeText = inheritedGitExclude(planned, p.repo.root, ctx.env);
  }
  // git cannot run under the state lock, where the home is built.
  if (!f['dry-run'] && L.routes(p.rung).some((route) => A.sandboxed(p.job, route.harness) && ['claude', 'codex'].includes(route.harness))) {
    p.gitConfig = require('./git-config').render(planned.exists ? planned.path : p.repo.root, ctx.env, A.origin(ctx.env).home);
  }
  // The remotes' hosts, which claude's sandbox does not allow unless
  // sandbox.domains lists them; spawn names the rest in a notice
  // (remoteNotice). git reads them here, outside the state lock.
  if (L.routes(p.rung).some((route) => route.harness === 'claude' && A.sandboxed(p.job, route.harness))) {
    p.remoteHosts = A.remoteHosts(planned.exists ? planned.path : p.repo.root, ctx.env);
  }
  const providerProblems = require('./claude-provider').problems(p.rung, ctx.env, A.origin(ctx.env), Settings.resolve(p.st.project, p.rung));
  if (providerProblems.length) throw refuse(providerProblems.join('; '));
  if (f['dry-run']) {
    const c = command(ctx, p, planned.path, countSpawns(ctx.stateDir, p.job, p.task.id) + 1);
    const argv = Settings.scopeCommand(c.settings, c.argv);
    const env = { ...c.env, ...(Settings.scoped(c.settings) ? { TOWER_CRANE_SCOPED: '1' } : {}) };
    // The agent's PATH is the user's with its git and gh shims in front.
    const shown = (k, v) => (c.iso && k.toUpperCase() === 'PATH' ? `${shellQuote(c.iso.bin)}${path.delimiter}"$PATH"` : shellQuote(v));
    const envLine = Object.entries(env).map(([k, v]) => `${k}=${shown(k, v)}`).join(' ');
    const home = c.iso && { path: c.iso.home, agent_file: c.iso.agent_file, mcp: c.iso.mcp, tools: c.iso.tools,
      ...(p.rung.harness === 'pi' ? { mcp_supported: false, sandbox: false } : {}) };
    const s = c.startup;
    const head = (home ? `# agent file ${home.agent_file}; home ${home.path}; MCP servers: ${home.mcp.join(', ') || 'none'}; opted-in tools: ${home.tools.join(', ') || 'none'}\n` : '')
      + `# rules: ${s.rules.map((r) => `${r.path} (${r.loaded})`).join(', ') || 'none'}; ${s.rules_bytes} bytes, about ${s.rules_tokens} tokens; prompt ${s.prompt_bytes} bytes, about ${s.prompt_tokens} tokens\n`
      + (p.rung.harness === 'pi' ? '# MCP opt-ins are unsupported on pi; command sandbox unavailable\n' : '')
      + (c.iso?.browser_kit?.warning ? `# ${c.iso.browser_kit.warning}\n` : '')
      + (c.iso?.notices || []).map((n) => `# ${n}\n`).join('');
    return {
      data: {
        agent: c.agent, rung: p.rungName, ...(p.reviewChoice ? { review_rung: p.reviewChoice } : {}),
        harness: p.rung.harness, cwd: planned.path, worktree_exists: planned.exists,
        ...(p.rung.harness === 'pi' ? { sandbox: false } : {}),
        argv, env, log: c.log, home, session_id: c.session_id, resumed: !!c.resume, attempt: c.attempt, startup: c.startup,
        ...(c.system ? { system: c.system } : {}),
        ...(c.iso?.browser_kit ? { browser_kit: c.iso.browser_kit } : {}),
        ...(c.iso?.notices?.length ? { notices: c.iso.notices } : {}),
        ...(c.resumeFallbackReason ? { resume_fallback_reason: c.resumeFallbackReason } : {}),
      },
      text: `${head}cd ${shellQuote(planned.path)} && ${envLine} ${argv.map(shellQuote).join(' ')}`,
    };
  }
  const initial = command(ctx, p, planned.path, 1);
  // Before any worktree work, so a task that cannot be claimed is refused with claim's reason.
  if (p.job === 'worker') workerReadiness(p.st, p.task, initial, Date.now());
  // Keyring commands run outside the mutation; this auth is shared by every route.
  const githubAuth = A.ghToken(ctx.env);
  const preparedCI = T.prepareCI(p.st, p.task);
  // Fetch inline findings before locking state so network latency does not block state writers.
  const findings = p.job === 'reviewer' ? await R.revuto(ctx, p.st, p.task, p.repo, p.reviewDiff?.sha || p.task.sha) : undefined;
  checkScope(initial.settings, planned.path, planned.exists, ctx.env);
  const argv0 = initial.argv[0];
  if (findExecutable(argv0, planned.path, planned.exists, ctx.env) === null) throw missing(argv0, p.rungName);
  const wt = W.create(p.repo, p.st, p.task, undefined, fetched);
  wt.head = S.git(['rev-parse', 'HEAD'], wt.path);
  const gitDirs = { common: p.repo.commonDir,
    own: S.gitLocation(wt.path, 'own') };
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
      // A board request spawns on the owner's own approval of it, which is
      // used up and recorded here as the orchestrator's is.
      if (delegation && (Auth.role(ctx, st.events) === 'orchestrator' || ctx.requestApproval)) {
        delegated = Auth.approval(st, ['delegation'], delegation, ctx.requestApproval ? ctx.agent : null);
        if (!delegated) throw refuse(`${p.task.id}: the owner's approval of this orchestrator spawn was used or changed while spawning; retry spawn`);
      }
      q = dispatch(ctx, st, p.reviewDiff, p.repo, preparedCI, findings);
      q.gitExcludeText = p.gitExcludeText || '';
      q.gitConfig = p.gitConfig;
      q.remoteHosts = p.remoteHosts;
      if (q.job === 'worker') {
        const now = Date.now();
        clearGoneReservations(st, emit, commit, now);
        const held = T.reservations(st, now).filter((r) => r.task === q.task.id);
        if (held.length) throw refuse(`${q.task.id} is held by ${held.map((r) => `${r.agent} (reservation, pid ${r.proc.pid})`).join(', ')}; wait for its worker to claim, exit or stop before spawning another`);
      }
      const over = T.budgetBreaches(st, q.task);
      if (over.length) throw refuse(`${over.map(T.breachText).join('; ')}; only the owner raises a budget (tower-crane project set or task update --budget-tokens, --budget-hours)`);
      // A commit before launch (a fallback takeover, a Windows lease) writes the
      // claim alone; the rest waits for the spawn event, so a failed launch
      // leaves the task as it was. Only this task changes before launch, and
      // never its evidence, so the copy reads no stored evidence file.
      const { evidence, ...fields } = q.task;
      const untouched = { ...structuredClone(fields), evidence };
      const withSpawn = [];
      const emitWithSpawn = (...args) => withSpawn.push(args);
      // A probe interval is spent only by a spawn that runs.
      const probe = Health.admitted(st, emitWithSpawn, q.routes[0]);
      const commitClaim = () => {
        const full = st.tasks;
        const task = { ...untouched, claim: q.task.claim && { ...q.task.claim }, status: q.task.status };
        st.tasks = { ...full, tasks: full.tasks.map((t) => (t.id === q.task.id ? task : t)) };
        try { commit(); } finally { st.tasks = full; }
      };
      W.record(st, q.task, wt, emitWithSpawn);
      const c = command(ctx, { ...q, project: st.project, repo: p.repo, gitDirs }, wt.path, countSpawns(ctx.stateDir, q.job, q.task.id) + 1, st.events);
      // Under the lock, the same check again: the state read before the worktree may have changed.
      if (q.job === 'worker') workerReadiness(st, q.task, c, Date.now());
      let usageBefore = null;
      if (c.resume) {
        T.collectSpawn(st, emitWithSpawn, c.resume.previous);
        if (q.rung.harness === 'codex') usageBefore = require('./usage-files').readUsage(c.resume.previous.detail);
      }
      // The claim as it was before this spawn changed it, kept once a change is committed before launch.
      const prior = { claim: q.task.claim && { ...q.task.claim }, status: q.task.status };
      let committedClaim = null;
      let workerStarted = false;
      let env;
      let hostEnv;
      let billing;
      let observed;
      const restoreClaim = (error) => {
        if (!committedClaim || workerStarted) return;
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
        q.task.claim = committedClaim.claim;
        q.task.status = committedClaim.status;
        if (committedClaim.claim) {
          emit(q.task.id, {
            holder: committedClaim.claim.agent,
            until: committedClaim.claim.until,
            from: committedClaim.claim.from,
            restored_from: c.agent,
            rollback: true,
          }, 'claim');
        } else {
          emit(q.task.id, { reason: 'its harness did not start', holder: c.agent, status: q.task.status, rollback: true }, 'release');
        }
        try {
          commitClaim();
        } catch (rollbackError) {
          error.message += `; could not restore prior claim: ${rollbackError.message}`;
        }
      };
      try {
        if (c.resumeFallbackAgent && q.task.claim?.agent === c.resumeFallbackAgent) {
          const now = Date.now();
          const expired = T.leaseExpired(q.task, now);
          const previous = q.task.claim.agent;
          committedClaim = prior;
          const from = q.task.claim.from || 'rework';
          const until = new Date(now + st.project.limits.lease_minutes * 60000).toISOString();
          q.task.claim = { agent: c.agent, since: new Date(now).toISOString(), until, from };
          q.task.status = 'in_progress';
          emit(q.task.id, { holder: c.agent, until, from, took_over_from: previous }, 'claim');
          commitClaim();
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
        // The supervisor runs gates, merges and broker commands on the host,
        // so it keeps the dispatcher's environment. The user file path is
        // resolved here: a relative one would name another file from the worktree.
        hostEnv = Settings.cleanAgentEnv({ ...process.env, ...ctx.env, TOWER_CRANE_CONFIG: L.userFile(ctx.env) });
        env = { ...hostEnv, ...c.env };
        // Credentials the agent process needs at run time only, kept out of c.env
        // so dry runs and events never show them. A sandboxed agent gets no
        // GitHub token: its broker pushes and runs gh (lib/github-broker.js).
        // Preparation may have seen another harness; use the route selected under the lock.
        if (c.iso) Object.assign(env, c.iso.sandbox ? {} : githubAuth, c.iso.credentialEnv());
        if (c.iso) c.iso.write();
        const from = A.origin(env);
        billing = L.billing(q.rung, require('./claude-provider').routedEnv(env, from), from);
        if (c.iso?.scratch) q.task.scratch = c.iso.scratch;
        if (q.job === 'reviewer') {
          fs.mkdirSync(path.dirname(q.briefFile), { recursive: true });
          S.writeAtomic(q.briefFile, c.reviewBrief);
        }
        fs.mkdirSync(logs, { recursive: true });
        // Exclusive creation prevents replacing a log or following a planted link.
        const openLog = () => fs.openSync(c.log, 'ax', 0o600);
        try {
          logFd = openLog();
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          if (!setAsideStartupLog(st, q.task.id, c)) throw refuse(`EEXIST: log already exists: ${c.log}; preserve or move it before retrying`);
          logFd = openLog();
        }
        const cache = path.join(os.homedir(), '.cache', 'tower-crane');
        fs.mkdirSync(cache, { recursive: true });
        receiptDir = fs.mkdtempSync(path.join(cache, 'spawn-'));
        receipt = path.join(receiptDir, 'started.json');
        // Without the lease gate's shell (Windows has none), a worker's supervisor
        // reports ready and launches the harness only after this lock span records the lease.
        const handshake = q.job === 'worker' && (process.platform === 'win32' || !fs.existsSync(LEASE_GATE[0]))
          ? { ready: path.join(receiptDir, 'ready'), go: path.join(receiptDir, 'go') } : null;
        const brokered = [...new Set(q.routes.filter((r) => A.sandboxed(q.job, r.harness)).map((r) => r.harness))];
        const job = {
          state: ctx.stateDir, task: q.task.id, agent: c.agent, role: q.job, rung: q.rungName,
          harness: q.rung.harness, rung_config: q.rung, cwd: wt.path, log: c.log, argv: c.argv, receipt, handshake, billing,
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
          hook: c.env.TOWER_CRANE_HOOK,
          // What the agent's process adds to the supervisor's environment: its
          // home, shims, cache, identity and credentials. Its values travel
          // with the other env values, never in the job file.
          agent_env: { env: Object.fromEntries(Object.entries(env).filter(([key, value]) => hostEnv[key] !== value)) },
          // A sandboxed codex agent's own temp directory: its env wins over the
          // project's env and env_file, which the monitor applies later.
          agent_tmp: c.iso?.tmp || null,
          inbox: c.inbox,
          settings: c.settings,
          routes: q.routes, route_index: 0, log_start: 0, probe,
          git_env: c.iso?.gitEnv || {},
          dispatch: {
            job: q.job, rungName: q.rungName, task: q.task, brief: q.brief, briefFile: q.briefFile,
            reviewSha: q.reviewSha, reviewSummary: q.reviewSummary, project: st.project, repo: p.repo, gitDirs, gitExcludeText: q.gitExcludeText, gitConfig: q.gitConfig, remoteHosts: q.remoteHosts,
            parentCwd: process.cwd(),
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
        ], { cwd: wt.path, env: { ...hostEnv, ...Secrets.handoff(secrets, receiptDir) }, stdio: ['ignore', wait ? 'pipe' : logFd, wait ? 'pipe' : logFd, logFd], detached: !wait, windowsHide: true });
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
        let deadline = Date.now() + STARTUP_MS;
        // This wait blocks the event loop, so the child's exit event cannot
        // end it; the process table can, where it shows a zombie.
        let exited = false;
        const running = () => !!child.pid && !(exited ||= P.processState({ pid: child.pid }) === 'exited');
        if (handshake) {
          while (running() && !fs.existsSync(handshake.ready) && !fs.existsSync(receipt) && Date.now() < deadline) sleepSync(10);
          if (fs.existsSync(handshake.ready) && !fs.existsSync(receipt)) {
            // The lease is on disk before the harness exists; a launch that then fails restores the prior claim.
            if (q.task.claim?.agent !== c.agent) {
              const now = Date.now();
              T.grantClaim(q.task, emit, c.agent, T.claimReadiness(st, q.task, now, c.agent), st.project.limits.lease_minutes, now);
            }
            committedClaim = prior;
            commitClaim();
            fs.writeFileSync(handshake.go, '');
            deadline = Date.now() + STARTUP_MS;
          }
        }
        while (running() && !fs.existsSync(receipt) && Date.now() < deadline) sleepSync(10);
        if (fs.existsSync(receipt)) {
          observed = JSON.parse(fs.readFileSync(receipt, 'utf8'));
          fs.rmSync(receipt, { force: true });
        }
        if (!observed?.pid) {
          if (child.pid) child.kill();
          closeLog();
          const kept = keepStartupLog(c.log);
          if (!kept) {
            try { fs.rmdirSync(logs); } catch {
              // Other agents' logs are there.
            }
          }
          const failed = observed?.error?.startsWith('no lease:')
            ? refuse(`${c.agent} did not start: ${observed.error}`)
            : refuse(`could not start ${c.argv[0]}: ${startupFailure(observed, !!child.pid, exited)}`);
          // Printed last, after every note the refusal gathers on its way out.
          if (kept) failed.startupLog = `\nThe supervisor log is kept at ${kept}; it ends:\n${P.logTail(kept)}`;
          throw failed;
        }
        workerStarted = true;
      } catch (error) {
        restoreClaim(error);
        throw error;
      }
      const detail = {
        role: q.job, rung: q.rungName, agent: c.agent, harness: q.rung.harness,
        ...(q.rung.harness === 'pi' ? { sandbox: false } : {}),
        tool: c.iso.tool,
        ...(q.reviewChoice ? { review_rung: q.reviewChoice, review_level: q.reviewLevel, sha: q.task.sha, revision: q.task.revision,
          review_scope: q.reviewDiff.review_scope,
          revuto: (q.findings || []).map(({ body, ...f }) => f) } : {}),
        // A worker's revision scopes the respawn cap (escalation.js).
        ...(q.job === 'worker' ? { revision: q.task.revision } : {}),
        route: q.rung, attempt: c.attempt, resumed: !!c.resume, billing,
        ...(c.resumeFallbackReason ? { resume_fallback_reason: c.resumeFallbackReason } : {}),
        ...(c.resume && q.rung.harness === 'codex' ? { usage_before: usageBefore } : {}),
        model: q.rung.model || null, profile: q.rung.profile || null,
        ...observed, phase: 'running', retry: 0,
        claim_since: q.task.claim?.agent === c.agent ? q.task.claim.since : null,
        ...(q.job === 'worker' && q.task.claim?.agent !== c.agent ? { reserved: true } : {}),
        session_id: c.session_id,
        cwd: wt.path, log: c.log,
        // What the agent cannot reach that it may expect to (agents.js claude):
        // remote hosts off claude's host list, or a temp directory too deep for its proxy sockets.
        ...(c.iso?.notices?.length ? { notices: c.iso.notices } : {}),
        ...(q.rung.harness === 'codex' ? { codex_home: (c.iso && c.iso.usageRoot) || env.CODEX_HOME || path.join(os.homedir(), '.codex') } : {}),
      };
      if (delegation) {
        if (delegated) Auth.apply(ctx, delegated);
        const who = Auth.role(ctx, st.events);
        if (who === 'owner') Auth.applyOwner(ctx, st, ['delegation'], delegation, emit);
        Auth.audit(ctx, who, ['delegation'], emit, delegated);
      }
      for (const args of withSpawn) emit(...args);
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
    e.message += `; its worktree stays at ${wt.path} for the next spawn${e.startupLog || ''}`;
    throw e;
  } finally {
    if (receiptDir) fs.rmSync(receiptDir, { recursive: true, force: true });
  }
  if (!wait) {
    closeLog();
    child.unref();
    return { data: started, text: `${started.agent} started, pid ${started.pid}, log ${started.log}${started.browser_kit?.warning ? `\n${started.browser_kit.warning}` : ''}${(started.notices || []).map((n) => `\n${n}`).join('')}` };
  }
  // The caller releases the dispatch lock before this wait for the agent's exit.
  const exited = new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (c) => resolve(c === null ? 1 : c));
  });
  return { wait: async () => {
    const code = await exited;
    removeFilteredBrief(started.filteredBriefFile);
    try {
      await T.spend({ ...ctx, pos: [q.task.id], flags: { 'from-spawn': started.agent } });
    } catch (e) {
      process.stderr.write(`tower-crane: usage not recorded: ${e.message}; retry spend ${q.task.id} --from-spawn ${started.agent}\n`);
    }
    return { data: { ...started, code }, text: `${started.agent} exited with ${code}${started.browser_kit?.warning ? `\n${started.browser_kit.warning}` : ''}${(started.notices || []).map((n) => `\n${n}`).join('')}`, code };
  } };
}

// Why a dispatch got no startup receipt with a pid. Only a harness the
// supervisor could not find is a PATH problem; a supervisor that exits or
// stalls before it reports names that instead.
function startupFailure(observed, started, exited) {
  if (observed?.exit_code !== undefined) {
    return `supervisor startup failed: the supervisor exited with code ${observed.exit_code} before it reported ready${observed.error ? `: ${observed.error}` : ''}`;
  }
  if (observed?.error) return observed.code === 'ENOENT' || /\bENOENT\b/.test(observed.error) ? `${observed.error}; check that it is installed and on PATH` : observed.error;
  if (!started) return 'supervisor startup failed: the supervisor process did not start';
  if (exited) return 'supervisor startup failed: the supervisor exited before it reported ready';
  return `supervisor startup failed: the supervisor did not report ready within ${STARTUP_MS / 1000} s`;
}

const startupFailedName = (log) => log.replace(/\.log$/, `-startup-failed-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

// A failed start records no spawn, so the next spawn takes the same agent name
// and log name. A log keepStartupLog could not move is that start's, and it is
// moved aside now, unless a recorded spawn of the agent may still be running
// or the name holds something other than a plain file (a planted link).
// Called under the state lock, so no other dispatch of the agent is starting.
function setAsideStartupLog(st, task, c) {
  const at = fs.lstatSync(c.log, { throwIfNoEntry: false });
  if (!at?.isFile()) return false;
  const live = st.events.some((e) => e.cmd === 'spawn' && e.task === task && e.detail?.agent === c.agent
    && !reservationGone({ host: e.detail.host, pid: e.detail.pid, start_ticks: e.detail.start_ticks,
      monitor_pid: e.detail.monitor_pid, monitor_start_ticks: e.detail.monitor_start_ticks }));
  if (live) return false;
  const aside = startupFailedName(c.log);
  try {
    S.renameRetry(c.log, aside, true);
  } catch {
    return false;
  }
  process.stderr.write(`tower-crane: moved ${c.log}, left by a start that failed before it was recorded, to ${aside}\n`);
  return true;
}

// A failed start keeps a log with output under a name of its own, so the next
// spawn can take the agent's log name. An empty log says nothing and goes.
function keepStartupLog(log) {
  let size = 0;
  try { size = fs.statSync(log).size; } catch { return null; }
  if (!size) {
    fs.rmSync(log, { force: true });
    return null;
  }
  // Only this dispatch writes its log, so its name and the time are unique.
  // Windows refuses the rename while the killed supervisor or a scanner still
  // holds the log. A refusal that outlasts the retry keeps the log under the
  // agent's log name, so the startup failure is still reported with its log
  // rather than as EPERM; the next spawn of that agent moves it aside then
  // (setAsideStartupLog).
  const kept = startupFailedName(log);
  try {
    S.renameRetry(log, kept, true);
  } catch {
    return log;
  }
  return kept;
}

module.exports = { spawn, clearDeadReservations, buildPrompt, buildCommand, findExecutable, launchCommand, fallbackCommand, fallbackSecrets, routeProblems, removeFilteredBrief, LEASE_GATE };
