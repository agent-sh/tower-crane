'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, run } = require('./helpers');

test('init creates the state files and excludes them from git', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const f of ['project.json', 'tasks.json', 'decisions.json', 'events.jsonl', 'sketch.md', 'sketch.html']) {
    assert.ok(fs.existsSync(path.join(h.state, f)), `${f} exists`);
  }
  assert.ok(fs.statSync(path.join(h.state, 'briefs')).isDirectory());
  const p = h.readState('project.json');
  assert.equal(p.version, 1);
  assert.equal(p.name, 'demo');
  assert.equal(p.base, 'main');
  assert.equal(p.roles, undefined);
  assert.equal(p.owner_config_dir, fs.realpathSync.native(path.dirname(h.userConfig)));
  assert.equal(p.harness, 'codex');
  assert.deepEqual(Object.keys(p.ladder), ['orchestrator', 'easy', 'medium', 'hard', 'research', 'review', 'small']);
  assert.deepEqual(p.limits, { workers: 6, lease_minutes: 60 });
  assert.deepEqual(h.readState('tasks.json'), { version: 1, next: 1, tasks: [] });
  const exclude = fs.readFileSync(path.join(h.repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\.tower-crane\/$/m);
  assert.equal(h.git(['status', '--porcelain']), '');

  const again = h.run(['init', '--name', 'x', '--goal', 'y']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists/);
});

test('a corrupt state file names repairs that work outside git', (t) => {
  const h = makeRepo(t);
  h.init();
  const tasks = path.join(h.state, 'tasks.json');
  const cases = [
    [path.join(h.state, 'project.json'), '{', ['--agent', 'owner'], /project\.json is not valid JSON/],
    [path.join(h.state, 'project.json'), '{', ['--agent', 'orchestrator'], /project\.json is not valid JSON/],
    [tasks, '{"version":1}', ['--agent', 'orchestrator'], /tasks\.json is invalid/],
  ];
  const saved = new Map(cases.map(([file]) => [file, fs.readFileSync(file)]));
  for (const [file, text, agent, problem] of cases) {
    fs.writeFileSync(file, text);
    const broken = h.run(['project', 'show', ...agent]);
    fs.writeFileSync(file, saved.get(file));
    assert.equal(broken.code, 1, broken.stderr);
    assert.match(broken.stderr, problem);
    assert.match(broken.stderr, /events\.jsonl beside it records every change/);
    assert.match(broken.stderr, /git does not track it/);
    assert.doesNotMatch(broken.stderr, /version control|\n\s+at /, 'no git restore and no stack trace');
  }
});

test('init requires name and goal', (t) => {
  const h = makeRepo(t);
  const r = h.run(['init', '--name', 'demo']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--goal/);
});

test('state is found from a subdirectory and from a linked worktree', (t) => {
  const h = makeRepo(t);
  h.init();
  const sub = path.join(h.repo, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(h.ok(['task', 'add', '--title', 'from sub', '--acceptance', 'a'], { cwd: sub }), 'T1');

  const wt = path.join(h.base, 'linked');
  h.git(['worktree', 'add', '-q', '-b', 'side', wt]);
  const list = h.json(['task', 'list'], { cwd: wt });
  assert.deepEqual(list.map((x) => x.title), ['from sub']);
  assert.equal(h.ok(['task', 'add', '--title', 'from worktree', '--acceptance', 'b'], { cwd: wt }), 'T2');
  assert.equal(h.readState('tasks.json').tasks.length, 2);
  assert.ok(!fs.existsSync(path.join(wt, '.tower-crane')), 'no second state in the worktree');
});

test('--state and TOWER_CRANE_STATE override discovery, and outside a repo one is required', (t) => {
  const h = makeRepo(t);
  const outside = path.join(h.base, 'elsewhere');
  fs.mkdirSync(outside);
  const none = run(['status'], { cwd: outside, env: h.env });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /not inside a git repository.*--state/);

  const dir = path.join(h.base, 'state-dir');
  h.ok(['init', '--name', 'n', '--goal', 'g', '--state', dir], { cwd: outside });
  assert.ok(fs.existsSync(path.join(dir, 'project.json')));
  h.ok(['task', 'add', '--title', 'via env', '--acceptance', 'a'], { cwd: outside, env: { TOWER_CRANE_STATE: dir } });
  const viaFlag = h.json(['task', 'list', '--state', dir], { cwd: outside });
  assert.equal(viaFlag[0].title, 'via env');
  assert.ok(!fs.existsSync(h.state), 'the repo default state was never created');
});

test('help lists every command and per-command help works', (t) => {
  const h = makeRepo(t);
  const r = h.run(['--help']);
  assert.equal(r.code, 0);
  for (const c of ['init', 'task add', 'plan import', 'ready', 'claim', 'accept', 'ask', 'status', 'serve', 'spawn', 'check tests', 'merge']) {
    assert.ok(r.stdout.includes(c), `help mentions ${c}`);
  }
  const c = h.run(['task', 'add', '--help']);
  assert.equal(c.code, 0);
  assert.match(c.stdout, /--acceptance A/);
  const bad = h.run(['task', 'add', '--bogus', 'x']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown option --bogus/);
  const unknown = h.run(['frobnicate']);
  assert.equal(unknown.code, 2);
  const version = h.run(['--version']);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), require('../package.json').version);
});

// The home comes from the account, as lib/authority.js reads it, never from
// the HOME and TOWER_CRANE_CONFIG the fixture sets.
const defaultOwnerDir = () => {
  const dir = path.join(fs.realpathSync.native(require('node:os').userInfo().homedir), '.config', 'tower-crane');
  return fs.existsSync(dir) ? fs.realpathSync.native(dir) : dir;
};

test('an init by anyone but the owner records the default owner_config_dir, not the folder TOWER_CRANE_CONFIG names', (t) => {
  const h = makeRepo(t, { builtin: true });
  const evil = path.join(h.base, 'evil');
  fs.mkdirSync(path.join(evil, 'owner'), { recursive: true });
  fs.writeFileSync(path.join(evil, 'owner', 'key'), 'attacker-key\n');
  const config = path.join(evil, 'config.json');
  const r = h.run(['init', '--name', 'demo', '--goal', 'g'], { env: { TOWER_CRANE_AGENT: 'orchestrator', TOWER_CRANE_CONFIG: config } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.readState('project.json').owner_config_dir, defaultOwnerDir());
  assert.match(r.stdout, /notice: owner_config_dir is the default .*only the owner's init records another/);
  // The key the orchestrator planted next to its config file is not the owner's.
  const probe = h.run(['project', 'set', '--merge-admin', 'true'], { env: { TOWER_CRANE_AGENT: 'owner', TOWER_CRANE_OWNER_KEY: 'attacker-key', TOWER_CRANE_CONFIG: config } });
  assert.equal(probe.code, 1, probe.stdout);
  assert.match(probe.stderr, /owner identity needs a process the owner runs/);
  assert.equal(h.readState('project.json').merge?.admin, undefined);
});

test('an orchestrator init leaves out what only the owner grants from the user file; the owner init copies it', (t) => {
  const h = makeRepo(t, { builtin: true });
  const builtin = require('../docs/builtin-ladder.json');
  const as = (agent, extra = []) => h.run(['init', '--name', 'demo', '--goal', 'g', ...extra], { env: { TOWER_CRANE_AGENT: agent } });
  const write = (doc) => {
    fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
    fs.writeFileSync(h.userConfig, JSON.stringify(doc));
  };

  // The owner's ordinary file: personal fallbacks, no grants.
  write({ harness: 'codex', ladder: { hard: { fallbacks: [{ harness: 'codex', profile: 'astra', effort: 'high' }, { harness: 'claude', model: 'fable', effort: 'high' }] } } });
  const plain = as('orchestrator', ['--state', path.join(h.base, 'plain')]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /left out|outside its sandbox|as a command/);

  const grants = {
    medium: { profile: 'sol', effort: 'high', sandbox: { domains: ['*'] }, env: { PROBE: '1' }, env_file: path.join(h.base, 'secrets.env'), scope: { MemoryMax: '8G' } },
    hard: { harness: 'opencode', model: 'x/y' },
    easy: { harness: 'command', command: [process.execPath, '-e', 'process.exit(1)', '{prompt}'] },
    review: { harness: 'claude', model: 'haiku', tools: ['Edit'] },
  };
  write({ harness: 'codex', ladder: grants });
  const r = as('orchestrator');
  assert.equal(r.code, 0, r.stderr);
  const ladder = h.readState('project.json').ladder;
  assert.deepEqual(ladder.medium, { profile: 'sol', effort: 'high' });
  assert.deepEqual(ladder.hard, { ...builtin.ladder.hard });
  assert.deepEqual(ladder.easy, { ...builtin.ladder.easy });
  assert.deepEqual(ladder.review, { harness: 'claude', model: 'haiku' });
  assert.match(r.stdout, /notice: ladder medium: init left out sandbox, env, env_file, scope from the user file/);
  assert.match(r.stdout, /notice: ladder hard: the user file runs it on opencode outside its sandbox/);
  assert.match(r.stdout, /notice: ladder easy: the user file runs it as a command/);
  assert.match(r.stdout, /notice: ladder review: init left out tools Edit/);
  const init = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.cmd === 'init');
  assert.deepEqual(init.detail.withheld.map((w) => w.rung).sort(), ['easy', 'hard', 'medium', 'review']);

  // A default harness outside the sandbox reaches every rung that follows it.
  write({ harness: 'opencode', ladder: { medium: { model: 'x/y' } } });
  const followed = as('orchestrator', ['--state', path.join(h.base, 'followed')]);
  assert.equal(followed.code, 0, followed.stderr);
  const medium = JSON.parse(fs.readFileSync(path.join(h.base, 'followed', 'project.json'), 'utf8')).ladder.medium;
  assert.deepEqual(medium, { harness: builtin.harness, ...builtin.ladder.medium });

  write({ harness: 'codex', ladder: grants });
  const owner = as('owner', ['--state', path.join(h.base, 'owned')]);
  assert.equal(owner.code, 0, owner.stderr);
  assert.doesNotMatch(owner.stdout, /notice:/);
  const owned = JSON.parse(fs.readFileSync(path.join(h.base, 'owned', 'project.json'), 'utf8')).ladder;
  for (const name of Object.keys(grants)) assert.deepEqual(owned[name], grants[name], name);
});
