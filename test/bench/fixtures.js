'use strict';

// Scratch states for the human bench, built through the CLI only, so they stay
// valid as the state format changes. Each command can run on a moved clock
// (test/fixtures/hooks.js), which gives events, leases and decisions the ages
// a real run has. Nothing here touches a live state directory.

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createRepoSeed } = require('../repo-seed');

const HOOKS = path.join(__dirname, '..', 'fixtures', 'hooks.js');
const STUB = path.join(__dirname, '..', 'fixtures', 'live-usage-harness.js');
const MIN = 60e3;
const HOUR = 60 * MIN;

// A clean env, as test/helpers.js builds it: no agent identity or task from
// the caller, the owner as the acting identity, and no user git or ladder files.
function cleanEnv(base) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('TOWER_CRANE_') || k.startsWith('GIT_') || k.startsWith('NODE_TEST')) delete env[k];
  env.TOWER_CRANE_AGENT = 'owner';
  env.GIT_CONFIG_GLOBAL = path.join(base, 'gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.TOWER_CRANE_CONFIG = path.join(base, 'user-config', 'config.json');
  // Spawns keep caches under HOME; the scratch state gets one of its own.
  env.HOME = path.join(base, 'home');
  env.XDG_CACHE_HOME = path.join(base, 'home', '.cache');
  fs.mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
  return env;
}

class Scratch {
  // bin is the CLI of the tree under test, so each build writes its own state.
  constructor(root, name, bin) {
    this.bin = bin;
    this.base = path.join(root, name);
    fs.rmSync(this.base, { recursive: true, force: true });
    fs.mkdirSync(this.base, { recursive: true });
    const seed = createRepoSeed(this.base);
    this.repo = path.join(this.base, 'repo');
    fs.renameSync(seed.repo, this.repo);
    fs.rmSync(seed.base, { recursive: true, force: true });
    fs.writeFileSync(path.join(this.base, 'gitconfig'), '[user]\n\tname = bench\n\temail = bench@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
    this.state = path.join(this.repo, '.tower-crane');
    this.env = cleanEnv(this.base);
    this.clock = path.join(this.base, 'clock');
    this.now = Date.now();
    this.ago = 0;
  }

  // Later commands run as if it were ms before the fixture's now.
  at(ms) { this.ago = ms; return this; }

  run(args, { agent, input, env = {}, clock = true } = {}) {
    fs.writeFileSync(this.clock, String(this.now - this.ago));
    const e = { ...this.env, ...env, ...(clock ? { HOOK_CLOCK_FILE: this.clock, HOOK_STATE: this.state } : {}) };
    if (agent) e.TOWER_CRANE_AGENT = agent;
    const r = cp.spawnSync(process.execPath, ['--require', HOOKS, this.bin, ...args], { cwd: this.repo, env: e, input, encoding: 'utf8', timeout: 120000 });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  ok(args, opts) {
    const r = this.run(args, opts);
    if (r.code !== 0) throw new Error(`tower-crane ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
    return r.stdout.trim();
  }

  json(args, opts) { return JSON.parse(this.ok([...args, '--json'], opts)); }

  git(args) { return cp.execFileSync('git', args, { cwd: this.repo, env: this.env, encoding: 'utf8' }).trim(); }

  // A commit of its own per submission, so every task has a distinct sha.
  commit(message) {
    this.git(['commit', '--allow-empty', '-q', '-m', message]);
    return this.git(['rev-parse', 'HEAD']);
  }

  read(file) { return JSON.parse(fs.readFileSync(path.join(this.state, file), 'utf8')); }
  events() { return fs.readFileSync(path.join(this.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); }
}

const PROJECT = ['--name', 'webhooks v2', '--goal', 'Webhook delivery v2: retries, signed payloads and a delivery dashboard, behind a flag'];

// Accepted work with recorded usage, the history a tier's median comes from.
// Tokens in millions; the shape follows T70's window W: the 90th percentile is
// about 5.5 times the median.
const HISTORY = [
  ['Signing key format', 'easy', 2.0, 18], ['Payload schema v2', 'medium', 6.1, 52], ['Retry headers', 'easy', 1.5, 14],
  ['Delivery log table', 'medium', 9.4, 75], ['Webhook secrets API', 'easy', 2.4, 21], ['Replay endpoint', 'medium', 3.8, 33],
  ['Backoff schedule', 'easy', 0.8, 9], ['Consumer SDK stub', 'easy', 1.8, 16], ['Signature verify helper', 'easy', 2.0, 15],
  ['Event fan-out', 'hard', 11.0, 96], ['Delivery metrics names', 'easy', 1.2, 10], ['Dead letter format', 'medium', 13.0, 110],
];

function history(s, start, list = HISTORY) {
  const ids = [];
  list.forEach(([title, tier, tokens, minutes], i) => {
    s.at(start - i * 70 * MIN);
    // Docs tasks need only review, so history is accepted without waivers.
    const id = s.ok(['task', 'add', '--title', title, '--acceptance', `${title.toLowerCase()} works end to end`, '--kind', 'docs', '--tier', tier, '--size', tier === 'easy' ? 'S' : 'M']).match(/T\d+/)[0];
    const agent = `worker-${id}-1`;
    s.ok(['claim', id, '--agent', agent]);
    s.at(start - i * 70 * MIN - minutes * MIN);
    const sha = s.commit(`${id} ${title}`);
    s.ok(['submit', id, '--sha', sha, '--summary', `${title}: done, tests added`, '--agent', agent]);
    s.ok(['spend', id, '--tokens', String(Math.round(tokens * 1e6)), '--minutes', String(minutes), '--rung', tier, '--agent', agent]);
    s.ok(['evidence', id, '--type', 'review', '--ok', '--sha', sha, '--summary', 'checked each acceptance line; tests fail without the change', '--agent', `reviewer-${id}`]);
    s.ok(['accept', id]);
    ids.push(id);
  });
  return ids;
}

function base(s, extra = []) {
  s.at(27 * HOUR);
  s.ok(['init', ...PROJECT, ...extra]);
}

// Nothing needs the owner: work is accepted, two agents are busy, one task is ready.
function calm(root, bin) {
  const s = new Scratch(root, 'calm', bin);
  base(s);
  history(s, 20 * HOUR, HISTORY.slice(0, 6));
  s.at(40 * MIN);
  const a = s.ok(['task', 'add', '--title', 'Delivery dashboard filters', '--acceptance', 'filters by endpoint and status', '--tier', 'medium']).match(/T\d+/)[0];
  const b = s.ok(['task', 'add', '--title', 'Retry budget docs', '--acceptance', 'docs name the retry budget', '--kind', 'docs', '--size', 'S']).match(/T\d+/)[0];
  s.ok(['task', 'add', '--title', 'Rollout checklist', '--acceptance', 'checklist reviewed', '--kind', 'docs', '--size', 'S']);
  s.ok(['claim', a, '--agent', `worker-${a}-1`]);
  s.at(20 * MIN);
  s.ok(['claim', b, '--agent', `worker-${b}-1`]);
  s.at(6 * MIN);
  s.ok(['msg', '--to', 'orchestrator', '--task', a, 'filters render; wiring the status query next', '--agent', `worker-${a}-1`]);
  return s;
}

// The busy run of T70 6.1: two decisions, an owner-required approval the
// orchestrator opened, an owner task, five agents, a submitted task whose
// review failed, a waiver, a rework, a stuck claim and messages to the owner.
function busy(root, bin) {
  const s = new Scratch(root, 'busy', bin);
  base(s, ['--workers', '8']);
  s.ok(['project', 'set', '--budget-tokens', '120000000', '--budget-hours', '40']);
  const done = history(s, 24 * HOUR);
  s.at(5 * HOUR);
  const add = (title, args = []) => s.ok(['task', 'add', '--title', title, ...args]).match(/T\d+/)[0];
  const retry = add('Retry API with per-endpoint budgets', ['--acceptance', 'a 429 consumes the retry budget', '--acceptance', 'budgets reset hourly', '--tier', 'medium', '--dep', done[2]]);
  const worker = add('Delivery worker pool', ['--acceptance', 'deliveries run on 8 workers', '--tier', 'hard', '--size', 'L']);
  const store = add('Dashboard store', ['--acceptance', 'delivery history survives a restart', '--tier', 'medium', '--dep', done[3]]);
  const dlq = add('Dead letter queue', ['--acceptance', 'failed deliveries land in the DLQ after 5 tries', '--tier', 'medium']);
  const ui = add('Webhook settings UI', ['--acceptance', 'an endpoint can be paused from the UI', '--kind', 'design', '--tier', 'medium']);
  const metrics = add('Metrics export', ['--acceptance', 'delivery latency is exported', '--tier', 'easy', '--size', 'S']);
  const limiter = add('Per-tenant rate limiter', ['--acceptance', 'a tenant over its limit is delayed, not dropped', '--tier', 'medium']);
  const docs = add('Consumer docs for signatures', ['--acceptance', 'docs show verification in three languages', '--kind', 'docs', '--size', 'S']);
  const load = add('Load test at 2k deliveries/s', ['--acceptance', 'p99 under 400 ms at 2k/s', '--tier', 'medium']);
  const access = add('Grant dashboard access', ['--acceptance', 'the dashboard reads delivery history', '--size', 'S', '--needs-owner', 'grant the bench service account read access to the delivery-history bucket']);
  const flag = add('Rollout flag', ['--acceptance', 'v2 delivery turns on per tenant', '--dep', retry, '--dep', worker]);
  const alerts = add('Delivery alerts', ['--acceptance', 'a stuck endpoint pages after 15 minutes', '--dep', metrics]);
  const jitter = add('Retry jitter', ['--acceptance', 'retries spread over the backoff window', '--tier', 'easy', '--size', 'S']);
  add('Tenant export', ['--acceptance', 'export a tenant\'s deliveries as CSV', '--dep', store]);

  // A submitted task whose review failed, sent back once before.
  s.at(4 * HOUR);
  s.ok(['claim', retry, '--agent', `worker-${retry}-1`]);
  s.at(3 * HOUR);
  let sha = s.commit(`${retry} first try`);
  s.ok(['submit', retry, '--sha', sha, '--summary', 'budgets per endpoint, reset hourly', '--agent', `worker-${retry}-1`]);
  s.ok(['evidence', retry, '--type', 'review', '--fail', '--sha', sha, '--summary', 'the hourly reset is not tested', '--agent', `reviewer-${retry}-1`]);
  s.ok(['rework', retry, '--reason', 'add a test for the hourly budget reset']);
  s.at(2 * HOUR);
  s.ok(['claim', retry, '--agent', `worker-${retry}-2`]);
  s.at(70 * MIN);
  sha = s.commit(`${retry} second try`);
  s.ok(['submit', retry, '--sha', sha, '--summary', 'hourly reset tested; 429 path consumes the budget', '--agent', `worker-${retry}-2`]);
  s.at(52 * MIN);
  s.ok(['evidence', retry, '--type', 'review', '--fail', '--sha', sha, '--summary', 'a 429 from a paused endpoint still consumes budget; acceptance line 1 says it should not when the endpoint is paused. Retry-After is ignored.', '--ref', 'https://example.com/acme/webhooks/pull/41#review', '--agent', `reviewer-${retry}-2`]);

  // An accepted task with a waiver the owner recorded.
  s.at(3 * HOUR);
  s.ok(['claim', limiter, '--agent', `worker-${limiter}-1`]);
  s.at(2 * HOUR + 20 * MIN);
  sha = s.commit(`${limiter} limiter`);
  s.ok(['submit', limiter, '--sha', sha, '--summary', 'token bucket per tenant', '--agent', `worker-${limiter}-1`]);
  s.ok(['evidence', limiter, '--type', 'review', '--ok', '--sha', sha, '--summary', 'delays, never drops; covered by the soak test', '--agent', `reviewer-${limiter}-1`]);
  s.ok(['accept', limiter, '--waive', 'tests', '--waive', 'clean', '--waive', 'ci', '--reason', 'CI runner down; soak test run by hand on the staging box']);

  // Five agents at work, one near the end of its lease, and a stuck one.
  const claims = [[worker, 50, 'pool sized from the queue depth; adding the shutdown drain'], [dlq, 38, 'DLQ writes land; replay from DLQ next'],
    [ui, 57, 'pause toggle in; waiting on the design tokens'], [metrics, 18, 'latency histogram exported'], [load, 9, null]];
  for (const [id, ago, text] of claims) {
    s.at(ago * MIN);
    s.ok(['claim', id, '--agent', `worker-${id}-1`]);
    if (text) {
      s.at(Math.max(1, ago - 7) * MIN);
      s.ok(['msg', '--to', 'orchestrator', '--task', id, text, '--agent', `worker-${id}-1`]);
    }
  }
  s.at(2 * HOUR);
  s.ok(['claim', jitter, '--agent', `worker-${jitter}-1`, '--lease', '45']);

  // Decisions: one blocks ready work, one does not; the orchestrator's request
  // for an owner-required setting becomes an approval.
  s.at(48 * MIN);
  s.ok(['ask', '--question', 'Which store backs the delivery dashboard?', '--option', 'redis', '--option', 'postgres', '--recommend', 'postgres', '--why', 'delivery history must survive a flush; postgres is already in the stack', '--blocks', store], { agent: 'orchestrator' });
  s.at(31 * MIN);
  s.ok(['ask', '--question', 'Ship v2 to the first tenant on Friday?', '--option', 'yes', '--option', 'wait a week', '--why', 'load test is still running', '--blocks', flag], { agent: 'orchestrator' });
  s.at(12 * MIN);
  s.run(['project', 'set', '--merge-admin', 'true'], { agent: 'orchestrator' });
  s.at(9 * MIN);
  s.ok(['msg', '--to', 'owner', '--task', ui, 'the settings UI needs the brand color; which one should the pause toggle use?', '--agent', `worker-${ui}-1`]);
  s.at(4 * MIN);
  s.ok(['task', 'note', worker, 'pool drains on SIGTERM; tests next', '--agent', `worker-${worker}-1`]);
  s.ids = { retry, worker, store, dlq, ui, metrics, limiter, docs, load, access, flag, alerts, jitter };
  return s;
}

// A run whose supervised agent climbs past the runaway rule while the board is
// open. The history gives an easy-tier median of 2M tokens and a project
// multiple of 5.5; the stub harness then writes 1M tokens a step. Spend comes
// only from the live collector: nothing is recorded with spend for the claim.
function runaway(root, bin, { harness = 'claude', variant = 'live' } = {}) {
  const s = new Scratch(root, `runaway-${variant}`, bin);
  base(s);
  history(s, 20 * HOUR);
  s.at(30 * MIN);
  const id = s.ok(['task', 'add', '--title', 'Retry jitter', '--acceptance', 'retries spread over the backoff window', '--tier', 'easy', '--size', 'S']).match(/T\d+/)[0];
  s.ok(['brief', 'set', id, '-'], { input: `Work on ${id}.\n` });
  s.at(0);
  const binDir = path.join(s.base, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, harness), '', { mode: 0o755 });
  if (variant === 'unavailable') {
    const script = "require('node:child_process').execFileSync(process.execPath, [process.argv[1], 'claim', process.argv[2]]); setTimeout(() => {}, 600000);";
    s.ok(['ladder', 'set', 'easy', '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'effort', '--command', JSON.stringify([process.execPath, '-e', script, bin, id, '{prompt}']), '--supervision', JSON.stringify({ usage_ms: 500, stall_ms: 600000 })]);
  } else {
    s.ok(['ladder', 'set', 'easy', '--harness', harness, '--model', 'bench-model', '--clear', 'profile', '--clear', 'effort', '--supervision', JSON.stringify({ usage_ms: 500, stall_ms: 600000 })]);
  }
  s.task = id;
  s.done = path.join(s.base, 'done');
  // Started by the bench once the board is open: the stub writes STEPS steps of
  // PER tokens, one every EVERY ms, then holds. The stale variant writes two
  // steps and then nothing while it stays alive.
  s.spawnAgent = ({ steps = 40, per = 1000000, every = 1000, hold = 600000 } = {}) => {
    const live = variant === 'stale' ? { LIVE_STEPS: '2', LIVE_STEP_TOKENS: String(per), LIVE_EVERY: String(every), LIVE_HOLD: String(hold) }
      : { LIVE_STEPS: String(steps), LIVE_STEP_TOKENS: String(per), LIVE_EVERY: String(every), LIVE_HOLD: String(hold) };
    const env = variant === 'unavailable' ? {} : { PATH: binDir + path.delimiter + (s.env.PATH || ''), NODE_OPTIONS: `--require "${STUB}"`, LIVE_DONE: s.done, ...live };
    return s.json(['spawn', '--task', id], { env, clock: false });
  };
  return s;
}

// A token budget at 92% with one supervised agent running and reporting.
function budget(root, bin) {
  const s = runaway(root, bin, { variant: 'budget' });
  const spent = s.read('tasks.json').tasks.reduce((n, t) => n + ((t.spend && t.spend.tokens) || 0), 0);
  // The stub adds 2.4M while the board is open; 92% of the budget is spent then.
  const target = spent + 2.4e6;
  s.ok(['project', 'set', '--budget-tokens', String(Math.round(target / 0.92))], { clock: false });
  s.spent = spent;
  return s;
}

module.exports = { Scratch, cleanEnv, calm, busy, runaway, budget, HISTORY, MIN, HOUR };
