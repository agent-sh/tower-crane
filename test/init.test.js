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
});
