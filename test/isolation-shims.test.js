'use strict';

// The git and gh shims, pushes and the broker inside a spawned agent, task
// scratch, the recorded tool after an upgrade, rung opt-ins and TOML output.

const { waitUntil, killPid } = require('./signals');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, BIN, detachedAlive } = require('./helpers');
const A = require('../lib/agents');
const S = require('../lib/state');
const TOML = require('../lib/toml');
const { NO_STUBS, SECRET, setup, walk, noSecretsCopied, releaseExited, spawn, ALLOW, decide, isolated, codexTargets, commandsRead } = require('./isolation-helpers');

test('a spawn from a supervisor running in another agent\'s env gets a cache of its own under the user cache root, never nested in the inherited one', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'hard', 'claude');
  // The supervisor's XDG_CACHE_HOME is the cache of a worker, as an automation started from that worker's env has it.
  const root = path.join(u.home, '.cache');
  const inherited = path.join(root, 'tower-crane', 'agents', '22cd04e4ddaf', 'worker-T93-6');
  spawn(h, u, 'hard', { XDG_CACHE_HOME: inherited });
  const real = fs.realpathSync(root);
  const seen = u.report();
  // Besides it, claude writes its own temp directory (claudeTmp).
  const own = seen.settings.sandbox.filesystem.allowWrite.filter((w) => (w === real || w.startsWith(real + path.sep)) && w !== seen.tmpdir);
  assert.equal(own.length, 1, `one directory under the cache root: ${JSON.stringify(own)}`);
  // Worker scratch is keyed by task, whatever the inherited agent cache was.
  assert.equal(path.dirname(path.dirname(own[0])), path.join(real, 'tower-crane', 'tasks'), own[0]);
  assert.equal(path.basename(own[0]), 'T1');
  assert.ok(fs.statSync(own[0]).isDirectory(), 'the granted cache exists');
});

test('a second worker spawn reads and writes the first attempt scratch for the same task', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolated(h, 'hard', 'claude');
  const env = { XDG_CACHE_HOME: '' };
  const write = [process.execPath, '-e', `require('node:fs').writeFileSync(require('node:path').join(process.env.XDG_CACHE_HOME, 'receipt.txt'), 'first attempt\\n')`];
  const first = spawn(h, u, 'hard', { ...env, STUB_RUN: JSON.stringify([write]) });
  const cache = u.report().settings.sandbox.filesystem.allowWrite.find((w) => /[\\/]tower-crane[\\/](?:agents|tasks)[\\/][0-9a-f]{12}[\\/][^\\/]+$/.test(w));
  const file = path.join(cache, 'receipt.txt');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first attempt\n');
  // A finished worker keeps its lease until released, so the builder claims after that.
  h.ok(['release', 'T1', '--agent', first.agent, '--reason', 'first attempt exited']);
  h.ok(['claim', 'T1', '--agent', 'builder']);
  h.ok(['submit', 'T1', '--agent', 'builder', '--sha', h.git(['rev-parse', 'HEAD'], wt)]);
  const probe = [process.execPath, '-e', `const fs = require('node:fs'); const path = require('node:path'); const file = path.join(process.env.XDG_CACHE_HOME, 'receipt.txt'); process.stderr.write(fs.readFileSync(file, 'utf8')); fs.appendFileSync(file, 'second attempt\\n');`];
  const second = spawn(h, u, 'hard', { ...env, STUB_RUN: JSON.stringify([probe]) });
  assert.notEqual(second.agent, first.agent);
  const seen = u.report();
  assert.equal(seen.ran[0].code, 0, seen.ran[0].stderr);
  assert.equal(seen.ran[0].stderr, 'first attempt\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first attempt\nsecond attempt\n');
  assert.ok(seen.settings.sandbox.filesystem.allowWrite.includes(cache));
  assert.ok(seen.prompt.includes(cache), 'the worker brief names the shared scratch');
  assert.equal(h.json(['task', 'show', 'T1']).scratch, cache);
  h.ok(['task', 'add', '--title', 'Another task', '--acceptance', 'separate scratch']);
  h.ok(['brief', 'set', 'T2', '-'], { input: 'another task\n' });
  const other = h.json(['spawn', '--role', 'hard', '--task', 'T2', '--wait'], { env: { ...u.env, XDG_CACHE_HOME: cache } });
  assert.notEqual(other.agent, second.agent);
  const otherCache = h.json(['task', 'show', 'T2']).scratch;
  assert.notEqual(otherCache, cache);
  assert.equal(path.dirname(otherCache), path.dirname(cache), 'an inherited task cache never nests the next task');
  assert.ok(!fs.existsSync(path.join(otherCache, 'receipt.txt')));
  assert.equal(fs.readFileSync(file, 'utf8'), 'first attempt\nsecond attempt\n');
});

test('cancel removes worker task scratch with read-only module trees alongside the worktree', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolated(h, 'medium', 'codex');
  const first = spawn(h, u, 'medium');
  const config = u.report().config;
  const cache = Object.entries(config.permissions['tower-crane'].filesystem)
    .find(([w, v]) => v === 'write' && /[\\/]tower-crane[\\/](?:agents|tasks)[\\/][0-9a-f]{12}[\\/][^\\/]+$/.test(w))[0];
  const mod = path.join(cache, 'go-mod', 'example.com', 'm@v1.0.0');
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, 'go.mod'), 'module example.com/m\n');
  for (const p of [path.join(mod, 'go.mod'), mod, path.dirname(mod)]) fs.chmodSync(p, p === mod || p === path.dirname(mod) ? 0o555 : 0o444);
  t.after(() => {
    for (const p of [path.dirname(mod), mod]) try { fs.chmodSync(p, 0o700); } catch {}
  });
  const settings = fs.readFileSync(path.join(wt, '.claude', 'settings.local.json'), 'utf8');
  h.ok(['task', 'update', 'T1', '--status', 'cancelled'], { env: u.env });
  const saved = h.json(['task', 'show', 'T1']).worktree.saved;
  assert.equal(fs.readFileSync(path.join(saved, 'files', '.claude', 'settings.local.json'), 'utf8'), settings);
  assert.ok(!fs.existsSync(wt));
  assert.ok(!fs.existsSync(cache), `${first.agent}'s task scratch is removed`);
  assert.equal(h.json(['task', 'show', 'T1']).scratch, undefined);
});

test('a live spawn keeps its git, gh, hooks and policy on its recorded tool after a checkout upgrade', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolated(h, 'medium', 'codex');
  h.git(['remote', 'set-url', 'origin', 'https://github.com/acme/app.git']);
  const checkout = path.join(h.base, 'tool-checkout');
  for (const name of ['bin', 'lib', 'agents', 'skills', 'standards', 'package.json']) {
    fs.cpSync(path.join(ROOT, name), path.join(checkout, name), { recursive: true });
  }
  h.git(['init', '-q', checkout]);
  h.git(['add', '.'], checkout);
  h.git(['commit', '-qm', 'stub tool version'], checkout);
  const toolSha = h.git(['rev-parse', 'HEAD'], checkout);
  const pushed = path.join(h.base, 'pushed.json');
  // The broker's git, on the host, reaches GitHub: the fixture records its
  // push and answers its fetch of the remote's branches with none.
  fs.writeFileSync(path.join(h.base, 'bin', 'git'), `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[2] === 'push') {
  fs.writeFileSync(${JSON.stringify(pushed)}, JSON.stringify(args.slice(2)));
  process.exit(0);
}
if (args[2] === 'fetch') process.exit(0);
const r = cp.spawnSync('git', args, { env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} }, stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  const upgrade = `
const fs = require('node:fs');
const cp = require('node:child_process');
for (const file of ['lib/shim.js', 'lib/hook-bridge.js', 'bin/tower-crane.js']) {
  fs.writeFileSync(${JSON.stringify(checkout)} + '/' + file, 'throw new Error("upgraded tool cannot read the old policy");\\n');
}
for (const args of [['add', '.'], ['commit', '-qm', 'upgraded stub tool']]) {
  const r = cp.spawnSync('git', ['-C', ${JSON.stringify(checkout)}, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}
`;
  const hooks = `
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const toml = require(${JSON.stringify(path.join(ROOT, 'lib', 'toml.js'))});
const config = toml.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'));
const calls = [
  [config.notify[0], [...config.notify.slice(1), JSON.stringify({ 'last-assistant-message': 'survived the upgrade' })], {}],
  [config.hooks.PostToolUse[0].hooks[0].command, [], { shell: true, input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }) }],
];
for (const [command, args, opts] of calls) {
  const r = cp.spawnSync(command, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(r.stderr);
}
`;
  const branch = h.git(['branch', '--show-current'], wt);
  const result = cp.spawnSync(process.execPath, [
    path.join(checkout, 'bin', 'tower-crane.js'), 'spawn', '--task', 'T1', '--wait', '--json',
  ], {
    cwd: h.repo, encoding: 'utf8', timeout: 300000,
    env: { ...u.env, STUB_RUN: JSON.stringify([
      [process.execPath, '-e', upgrade],
      ['git', 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`],
      ['gh', 'pr', 'create'],
      [process.execPath, '-e', hooks],
    ]) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(u.report().ran.map((r) => [r.code, r.stderr]), [[0, ''],
    [0, `tower-crane: the broker pushes ${h.git(['rev-parse', 'HEAD'], wt).slice(0, 12)} to ${branch} on https://github.com/acme/app.git\n`], [0, ''], [0, '']]);
  const started = JSON.parse(result.stdout);
  assert.equal(started.tool.sha, toolSha);
  assert.notEqual(h.git(['rev-parse', 'HEAD'], checkout), toolSha);
  const home = path.join(h.state, 'homes', started.agent);
  assert.equal(started.tool.path, path.join(home, 'tool'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'tool.json'), 'utf8')), started.tool);
  assert.deepEqual(JSON.parse(fs.readFileSync(pushed, 'utf8')), [
    'push', '--progress', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', 'https://github.com/acme/app.git', `${h.git(['rev-parse', 'HEAD'], wt)}:refs/heads/${branch}`,
  ]);
  // A sandboxed codex agent runs the shims in its HOME, with a copy of the
  // snapshot's lib; its sandbox hides hook.json, so they record no hook event.
  const shims = path.join(home, 'home', '.tower-crane-shims');
  const policy = JSON.parse(fs.readFileSync(path.join(shims, 'policy.json'), 'utf8'));
  assert.equal(policy.branch, branch);
  assert.equal(policy.repo, 'acme/app');
  assert.equal(policy.hook, null);
  assert.ok(fs.readFileSync(path.join(shims, 'bin', 'git'), 'utf8').includes(path.join(shims, 'lib', 'shim.js')), 'the git shim runs the copy');
  assert.equal(fs.readFileSync(path.join(shims, 'lib', 'shim.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'lib', 'shim.js'), 'utf8'));
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.find((e) => e.cmd === 'spawn').detail.tool.sha, toolSha);
  assert.ok(events.some((e) => e.cmd === 'hook report' && e.agent === started.agent), 'hook report');
  for (const cmd of ['hook git-push', 'hook pr-created']) {
    assert.ok(!events.some((e) => e.cmd === cmd && e.agent === started.agent), cmd);
  }
  assert.match(fs.readFileSync(S.progressFile(h.state, started.agent), 'utf8'), /"cmd":"hook progress"/);
});

test('a claude sandboxed worker has policy masks, so its shim plumbs merges of the paths the sandbox masks', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'medium', 'claude');
  spawn(h, u, 'medium');
  const policy = JSON.parse(fs.readFileSync(path.join(h.state, 'homes', 'worker-T1-1', 'policy.json'), 'utf8'));
  assert.equal(policy.masks, true);
});

test('a codex sandboxed worker has no policy masks: the mask list is claude\'s', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'medium', 'codex');
  spawn(h, u, 'medium');
  const policy = JSON.parse(fs.readFileSync(path.join(h.state, 'homes', 'worker-T1-1', 'policy.json'), 'utf8'));
  assert.equal(policy.masks, false);
});

test('the shim migrates a pre-T112 policy using recorded state and refuses unbound migrations', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolated(h, 'medium', 'codex');
  spawn(h, u, 'medium');
  h.git(['remote', 'set-url', 'origin', 'https://github.com/acme/app.git']);
  const home = path.join(h.state, 'homes', 'worker-T1-1');
  // Generated by policy() and worker frontmatter at e034a4325677ada9d0752a1acee60483acfd8849, the parent of T112.
  const historical = fs.readFileSync(path.join(__dirname, 'fixtures', 'policy-pre-T112.json'), 'utf8').replace('@HOME@/hook.json', path.join(home, 'hook.json').replaceAll('\\', '\\\\'));
  const policyFile = path.join(home, 'policy.json');
  fs.writeFileSync(policyFile, historical);
  const branch = h.git(['branch', '--show-current'], wt);
  const env = {
    ...u.env, PATH: `${path.join(home, 'bin')}${path.delimiter}${u.env.PATH}`,
    TOWER_CRANE_STATE: h.state, TOWER_CRANE_TASK: 'T1', TOWER_CRANE_AGENT: 'worker-T1-1',
  };
  const run = (args, extra = {}) => cp.spawnSync('git', args, { cwd: wt, env: { ...env, ...extra }, encoding: 'utf8', timeout: 300000 });
  const allowed = run(['push', '-u', 'origin', `HEAD:refs/heads/${branch}`]);
  assert.equal(allowed.status, 1, allowed.stderr);
  assert.match(allowed.stderr, /fixture remote unavailable/);
  assert.equal(run(['push', 'origin', 'HEAD:refs/heads/main']).status, 126);
  assert.equal(run(['push', 'origin', `HEAD:refs/heads/${branch}`, '--force']).status, 126);
  assert.equal(run(['push', 'origin', `HEAD:refs/heads/${branch}`], { TOWER_CRANE_AGENT: 'another-worker' }).status, 126);
  assert.equal(fs.readFileSync(policyFile, 'utf8'), historical, 'migration does not write the protected policy');
  const tasks = h.readState('tasks.json');
  const recordedBranch = tasks.tasks[0].branch;
  tasks.tasks[0].branch = null;
  h.writeState('tasks.json', tasks);
  const missing = run(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  assert.equal(missing.status, 126);
  assert.match(missing.stderr, /git push without a task branch/);
  tasks.tasks[0].branch = recordedBranch;
  h.writeState('tasks.json', tasks);
  // init without a GitHub origin or --repo records repo null: only remote pushes lose their binding.
  const project = h.readState('project.json');
  project.repo = null;
  h.writeState('project.json', project);
  const local = path.join(h.base, 'local-T116.git');
  h.git(['init', '-q', '--bare', local]);
  const status = run(['status']);
  assert.equal(status.status, 0, status.stderr);
  const commit = run(['commit', '--allow-empty', '-q', '-m', 'probe']);
  assert.equal(commit.status, 0, commit.stderr);
  const localPush = run(['push', local, 'HEAD:refs/heads/fixture']);
  assert.equal(localPush.status, 0, localPush.stderr);
  const remote = run(['push', '-u', 'origin', `HEAD:refs/heads/${branch}`]);
  assert.equal(remote.status, 126);
  assert.match(remote.stderr, /git push outside the recorded origin repository/);
  const read = cp.spawnSync('gh', ['pr', 'view'], { cwd: wt, env, encoding: 'utf8', timeout: 300000 });
  assert.notEqual(read.status, 126, read.stderr);
  assert.doesNotMatch(read.stderr, /tower-crane:/);
  fs.writeFileSync(policyFile, '{}\n');
  assert.equal(run(['push', '-u', 'origin', `HEAD:refs/heads/${branch}`]).status, 126, 'missing permissions default to deny');
  const gh = cp.spawnSync('gh', ['pr', 'create'], { cwd: wt, env, encoding: 'utf8', timeout: 300000 });
  assert.equal(gh.status, 126, gh.stderr);
});

test('git and gh allow git commands, local pushes and the role\'s own writes, and refuse everything else', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const branch = h.git(['branch', '--show-current'], wt);
  const own = `HEAD:refs/heads/${branch}`;
  const local = path.join(h.base, 'local.git');
  h.git(['init', '-q', '--bare', local]);
  // A remote on another machine; nothing listens there, so a push the shim
  // lets through fails in git itself, not with the shim's 126.
  h.git(['remote', 'set-url', 'origin', 'https://github.com/acme/app.git']);
  const NET = 'net';
  const cases = [
    [['git', 'status'], 0, 0],
    [['git', '-C', wt, 'log', '-1'], 0, 0],
    [['git', 'commit', '--allow-empty', '-q', '-m', 'probe'], 0, 0],
    [['git', 'push', local, '+HEAD:refs/heads/fixture'], ALLOW, ALLOW],
    [['git', 'push', '--force', local, 'HEAD:refs/heads/fixture'], 126, 126],
    [['git', 'push', local, ':refs/heads/fixture'], ALLOW, ALLOW],
    [['git', 'push', 'origin', ':refs/heads/gone'], 126, 126],
    [['git', 'push', 'origin', '--delete', 'gone'], 126, 126],
    [['git', 'push', '-d', 'origin', 'gone'], 126, 126],
    [['git', 'push', '--prune', 'origin', 'refs/heads/*:refs/heads/*'], 126, 126],
    // git takes abbreviated options; a push to another machine may use only
    // exact, harmless ones.
    ...['--del', '--pru', '--forc', '--mir', '--all', '--tags', '--no-verify'].map((o) => [['git', 'push', o, 'origin', 'HEAD:refs/heads/x'], 126, 126]),
    [['git', 'push', '-o', 'x', 'origin', 'HEAD:refs/heads/x'], 126, 126],
    [['git', 'push', 'origin', '--del', 'x'], 126, 126],
    [['git', 'push', '-u', 'origin', own], ALLOW, 126],
    [['git', 'push', '--set-upstream', '-q', 'origin', own], ALLOW, 126],
    // Configuration that turns a plain push into a mirror.
    ...['true', 'yes', 'on', '1'].flatMap((v) => [
      [['git', 'config', 'remote.origin.mirror', v], 0, 0],
      [['git', 'push', 'origin', own], 126, 126],
      [['git', 'config', '--unset', 'remote.origin.mirror'], 0, 0],
    ]),
    [['git', 'push', 'origin', own], ALLOW, 126],
    [['git', 'push', 'origin', 'HEAD:refs/heads/forced', '--force'], 126, 126],
    [['git', '-C', wt, 'push', '--force-with-lease', 'origin', 'HEAD:refs/heads/forced'], 126, 126],
    [['git', 'push', 'origin', '+HEAD:refs/heads/forced'], 126, 126],
    [['git', '-c', 'alias.p=push', 'p', 'origin', 'HEAD:refs/heads/alias'], 126, 126],
    [['git', 'p'], 126, 126],
    [['gh', 'pr', 'view', '1'], ALLOW, ALLOW],
    [['gh', 'pr', 'create', '--fill'], ALLOW, 126],
    [['gh', '--repo', 'o/r', 'pr', 'merge', '1'], 126, 126],
    [['gh', 'pr', '-R', 'o/r', 'merge', '1'], 126, 126],
    [['gh', 'pr', 'lock', '1'], 126, 126],
    [['gh', 'pr', 'update-branch', '1'], 126, 126],
    [['gh', 'cache', 'delete', 'x'], 126, 126],
    [['gh', 'co', '1'], 126, 126],
  ];
  const decided = decide(h, wt, ['worker', 'small'], branch, cases.map((c) => c[0]));
  for (const [column, job] of [[1, 'worker'], [2, 'small']]) {
    const ran = decided.map((r) => r[column - 1]);
    assert.deepEqual(ran.map((r) => r.code), cases.map((c) => c[column]), `${job}: ${JSON.stringify(ran.map((r) => [r.argv, r.why]))}`);
  }
  // A mirror key with no value, which git reads as true.
  const config = path.join(h.repo, '.git', 'config');
  const before = fs.readFileSync(config, 'utf8');
  fs.appendFileSync(config, '[remote "origin"]\n\tmirror\n');
  assert.deepEqual(decide(h, wt, ['worker'], branch, [['git', 'push', 'origin', 'HEAD:refs/heads/ok']])[0].map((r) => r.code), [126], 'a valueless mirror key');
  fs.writeFileSync(config, before);
  // Each harness and rung reaches git and gh through the shim with its job's
  // policy, and an allowed call runs the real program.
  const probes = [
    [['git', 'status'], 0, 0],
    [['git', 'push', local, '+HEAD:refs/heads/fixture'], 0, 0],
    [['git', 'push', '--force', local, 'HEAD:refs/heads/fixture'], 126, 126],
    [['git', 'push', '-u', 'origin', own], NET, 126],
    [['gh', 'pr', 'view', '1'], 0, 0],
    [['gh', 'pr', 'create', '--fill'], 0, 126],
  ];
  for (const harness of ['claude', 'codex']) {
    for (const [rung, column] of [['hard', 1], ['small', 2]]) {
      isolated(h, rung, harness);
      spawn(h, u, rung, { STUB_RUN: JSON.stringify(probes.map((c) => c[0])) });
      const ran = u.report().ran;
      const codes = ran.map((r, i) => (probes[i][column] === NET && r.code !== 126 && r.code !== 0 ? NET : r.code));
      assert.deepEqual(codes, probes.map((c) => c[column]), `${harness} ${rung}: ${JSON.stringify(ran.map((r) => r.stderr))}`);
    }
  }
});

// What codex's Linux sandbox shows of a path under a permission profile, as
// measured with codex-cli 0.162.1 and as codex-rs/linux-sandbox/src/bwrap.rs
// builds it: every readable path is mounted, then each hidden directory is
// masked, then each writable path is bound with the readable paths inside it.
// So a readable path inside a hidden one stays hidden in any rule order, and
// a writable path inside one shows with what it holds.
function codexShows(rules, p) {
  const deepest = (mode) => Object.keys(rules)
    .filter((q) => !q.startsWith(':') && rules[q] === mode && (p === q || p.startsWith(q + path.sep)))
    .sort((a, b) => b.length - a.length)[0];
  const [hidden, writable] = [deepest('none'), deepest('write')];
  if (writable && (!hidden || writable.length > hidden.length)) return true;
  return !hidden && Boolean(deepest('read'));
}

// claude's sandbox mounts each denied directory empty, shallowest first, and
// remounts the allowed paths inside it.
function claudeShows(fsRules, p) {
  const deepest = (list) => (list || []).filter((q) => p === q || p.startsWith(q + path.sep)).sort((a, b) => b.length - a.length)[0];
  const [denied, allowed] = [deepest(fsRules.denyRead), deepest(fsRules.allowRead)];
  return !denied || Boolean(allowed && allowed.length > denied.length);
}

// Found 2026-10-14: codex agents ran the host's git and gh, since the codex
// profile hid homes/ and the shims in homes/<agent>/bin with it. Every
// harness's agent finds its shims first on PATH, and a sandboxed one's
// sandbox shows them. The stubs run outside any sandbox, so the sandbox check
// models each one's mount order (codexShows, claudeShows); the live probes in
// live-sandbox.test.js are the evidence from the real sandboxes. Each shim
// runs in a project whose package.json says "type": "module", and with
// NODE_OPTIONS asking node to require a file first: the shim still runs as
// CommonJS and never loads the file.
test('for every harness the first git and gh on the agent\'s PATH are its shims, and claude and codex sandboxes show them', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  fs.writeFileSync(path.join(h.repo, 'package.json'), '{"type":"module"}\n');
  h.git(['add', 'package.json']);
  h.git(['commit', '-q', '-m', 'an ES module project']);
  const injected = path.join(h.base, 'injected');
  const evil = path.join(h.base, 'evil.cjs');
  fs.writeFileSync(evil, `require('node:fs').writeFileSync(${JSON.stringify(injected)}, process.argv.join(' '));\n`);
  const probe = path.join(h.base, 'probe');
  fs.mkdirSync(probe);
  const script = path.join(probe, 'probe.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const which = (tool) => String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  .map((dir) => path.join(dir, tool)).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } }) || null;
const seen = { git: which('git'), gh: which('gh'), home: process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR || null };
for (const tool of ['git', 'gh']) seen[tool + 'Text'] = seen[tool] ? fs.readFileSync(seen[tool], 'utf8').slice(0, 4096) : null;
fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(seen));
if (path.basename(process.argv[1]) === 'codex') process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'probe' }) + '\\n');
`);
  for (const name of ['claude', 'codex', 'opencode', 'agy', 'pi']) {
    fs.writeFileSync(path.join(probe, name), `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  }
  const out = path.join(h.base, 'probe.json');
  const env = { ...u.env, PATH: `${probe}${path.delimiter}${u.env.PATH}`, PROBE_OUT: out };
  const rungs = {
    claude: ['--harness', 'claude', '--model', 'probe'],
    codex: ['--harness', 'codex', '--model', 'probe'],
    opencode: ['--harness', 'opencode', '--model', 'fixture/probe'],
    agy: ['--harness', 'agy', '--model', 'gemini-3-pro'],
    pi: ['--harness', 'pi', '--model', 'probe'],
    command: ['--harness', 'command', '--clear', 'model', '--command', JSON.stringify([process.execPath, script, '{prompt}'])],
  };
  for (const [harness, args] of Object.entries(rungs)) {
    h.ok(['ladder', 'set', 'small', ...args, '--clear', 'profile', '--clear', 'effort', '--clear', 'args']);
    fs.rmSync(out, { force: true });
    const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { env });
    assert.equal(r.code, 0, `${harness}: ${r.stderr}`);
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    for (const tool of ['git', 'gh']) {
      assert.ok(seen[tool] && seen[tool].startsWith(path.join(h.state, 'homes') + path.sep), `${harness}: the first ${tool} on PATH is ${seen[tool]}`);
      assert.match(seen[`${tool}Text`], /shim\.js/, `${harness}: ${seen[tool]} runs the shim`);
      const policy = /'([^']*policy\.json)'/.exec(seen[`${tool}Text`])?.[1];
      assert.ok(policy && fs.existsSync(policy), `${harness}: ${tool} names its policy`);
    }
    assert.equal(path.dirname(seen.git), path.dirname(seen.gh));
    const bin = path.dirname(seen.git);
    for (const tool of ['git', 'gh']) {
      const ran = cp.spawnSync(path.join(bin, tool), tool === 'git' ? ['version'] : ['auth', 'status'], { cwd: h.repo, encoding: 'utf8',
        env: { ...env, NODE_OPTIONS: `--require=${evil}`, NODE_PATH: path.join(h.base, 'planted-modules') } });
      assert.doesNotMatch(String(ran.stderr), /require is not defined|ERR_REQUIRE|ES module/, `${harness}: ${tool} runs as CommonJS`);
      if (tool === 'git') assert.equal(ran.status, 0, `${harness}: git version through the shim: ${ran.stderr}`);
      assert.equal(fs.existsSync(injected), false, `${harness}: ${tool} loaded NODE_OPTIONS's file`);
    }
    if (harness === 'codex') {
      const rules = TOML.parse(fs.readFileSync(path.join(seen.home, 'config.toml'), 'utf8')).permissions['tower-crane'].filesystem;
      for (const p of [bin, path.join(bin, 'git'), path.join(path.dirname(bin), 'policy.json'), path.join(path.dirname(bin), 'lib', 'shim.js')]) {
        assert.ok(codexShows(rules, fs.realpathSync(p)), `codex shows ${p}`);
      }
      assert.ok(!codexShows(rules, fs.realpathSync(path.join(h.state, 'homes'))), 'codex hides homes/');
      assert.ok(!codexShows(rules, fs.realpathSync(path.join(seen.home, 'config.toml'))), 'codex hides the rest of the agent home');
    }
    if (harness === 'claude') {
      const fsRules = JSON.parse(fs.readFileSync(path.join(seen.home, 'settings.json'), 'utf8')).sandbox.filesystem;
      for (const p of [path.join(bin, 'git'), path.join(path.dirname(bin), 'policy.json')]) assert.ok(claudeShows(fsRules, fs.realpathSync(p)), `claude shows ${p}`);
    }
  }
});

test('remote pushes publish only the task branch, including configured and implicit destinations', (t) => {
  const h = makeRepo(t);
  h.init(['--repo', 'acme/app']);
  h.ok(['task', 'add', '--title', 'Publish', '--acceptance', 'only this branch']);
  const { path: wt, branch } = h.json(['worktree', 'T1']);
  const own = `refs/heads/${branch}`;
  h.git(['remote', 'set-url', 'origin', 'https://github.com/acme/app.git']);
  h.git(['remote', 'add', 'elsewhere', 'https://github.com/acme/app.git']);
  h.git(['config', `branch.${branch}.remote`, 'origin']);
  h.git(['config', `branch.${branch}.merge`, own]);
  const cases = [];
  const push = (args, code) => cases.push([['git', 'push', ...args], code]);
  const config = (key, value) => cases.push([['git', 'config', key, value], 0]);
  const unset = (key) => cases.push([['git', 'config', '--unset-all', key], 0]);
  push(['elsewhere', `HEAD:${own}`], 126);
  push(['https://github.com/acme/app.git', `HEAD:${own}`], 126);
  config('remote.origin.pushurl', 'https://github.com/acme/another.git');
  push(['origin', `HEAD:${own}`], 126);
  unset('remote.origin.pushurl');
  config('remote.origin.pushurl', 'https://github.com/acme/app.git');
  push(['origin', `HEAD:${own}`], ALLOW);
  cases.push([['git', 'config', '--add', 'remote.origin.pushurl', 'https://github.com/acme/another.git'], 0]);
  push(['origin', `HEAD:${own}`], 126);
  unset('remote.origin.pushurl');
  config('remote.origin.url', 'https://github.com/acme/another.git');
  push(['origin', `HEAD:${own}`], 126);
  config('remote.origin.url', 'https://github.com.evil.invalid/acme/app.git');
  push(['origin', `HEAD:${own}`], 126);
  config('remote.origin.url', 'git@github.com:acme/app.git');
  push(['origin', `HEAD:${own}`], ALLOW);
  config('remote.origin.url', 'https://github.com/acme/app.git');
  config('remote.pushDefault', 'elsewhere');
  push([], 126);
  unset('remote.pushDefault');
  config(`branch.${branch}.pushRemote`, 'elsewhere');
  push([], 126);
  push(['origin', `HEAD:${own}`], ALLOW);
  unset(`branch.${branch}.pushRemote`);
  config('url.https://github.com/acme/another.git.pushInsteadOf', 'https://github.com/acme/app.git');
  push(['origin', `HEAD:${own}`], 126);
  unset('url.https://github.com/acme/another.git.pushInsteadOf');
  // X1 and X2 reached Git instead of being refused by the shim.
  push(['origin', 'HEAD:main'], 126);
  push(['origin', 'HEAD:refs/tags/v9.9.9'], 126);
  push(['origin', 'HEAD:refs/heads/another-task'], 126);
  push(['origin', `HEAD:${own}`, 'HEAD:main'], 126);
  push(['origin', 'refs/heads/*:refs/heads/*'], 126);
  push(['origin', 'main'], 126);
  cases.push([['git', 'tag', '-f', 'v9.9.9'], 0]);
  push(['origin', 'v9.9.9'], 126);
  push(['origin', ':'], 126);
  for (const ref of ['HEAD', branch, own, `HEAD:${branch}`, `HEAD:${own}`, `main:${own}`]) {
    push(['-u', 'origin', ref], ALLOW);
  }
  push(['origin', `HEAD:${own}`, `${branch}:${own}`], ALLOW);
  push(['origin'], ALLOW);
  push([], ALLOW);
  config('remote.origin.push', 'HEAD:main');
  push(['origin'], 126);
  push([], 126);
  push(['origin', `HEAD:${own}`], ALLOW);
  unset('remote.origin.push');
  config('remote.origin.push', `HEAD:${own}`);
  push(['origin'], ALLOW);
  cases.push([['git', 'config', '--add', 'remote.origin.push', 'HEAD:refs/tags/v9.9.9'], 0]);
  push(['origin'], 126);
  unset('remote.origin.push');
  config('push.followTags', 'true');
  push(['origin', `HEAD:${own}`], 126);
  unset('push.followTags');
  config('push.recurseSubmodules', 'on-demand');
  push(['origin', `HEAD:${own}`], 126);
  unset('push.recurseSubmodules');
  cases.push([['git', '--namespace', 'other', 'push', 'origin', `HEAD:${own}`], 126]);
  config(`branch.${branch}.merge`, 'refs/heads/main');
  config('push.default', 'upstream');
  push(['origin'], 126);
  config('push.default', 'current');
  push(['origin'], ALLOW);
  config('push.default', 'matching');
  push(['origin'], 126);
  unset('push.default');
  config(`branch.${branch}.merge`, own);
  cases.push([['git', 'checkout', '-q', '-B', 'another-task'], 0]);
  push(['origin', 'HEAD'], 126);
  push(['origin', `HEAD:${own}`], ALLOW);
  cases.push([['git', 'checkout', '-q', branch], 0]);
  const ran = decide(h, wt, ['worker'], branch, cases.map(([args]) => args)).map(([r]) => r);
  assert.deepEqual(ran.map((r) => r.code), cases.map(([, code]) => code),
    JSON.stringify(ran.map((r) => ({ args: r.argv, code: r.code, why: r.why }))));
  // What the shim hands on names only the task branch as a destination.
  for (const r of ran.filter((x) => x.code === ALLOW)) {
    const words = r.pushArgs.slice(r.pushArgs.indexOf('push') + 1).filter((a) => !a.startsWith('-'));
    assert.ok(words.length > 1 && words.slice(1).every((ref) => ref.endsWith(`:${own}`)), JSON.stringify(r));
  }
});

test('push destinations are qualified with the recorded task branch without shebang harnesses', (t) => {
  const h = makeRepo(t);
  h.init(['--repo', 'acme/app']);
  h.ok(['task', 'add', '--title', 'Publish', '--acceptance', 'only this branch']);
  const { path: wt, branch } = h.json(['worktree', 'T1']);
  h.git(['remote', 'set-url', 'origin', 'https://github.com/acme/app.git']);
  const script = `
const { gitDenied } = require(process.argv[1]);
const cp = require('node:child_process');
const branch = process.argv[2];
const policy = { gitPush: 'branch', branch, repo: 'acme/app' };
const probes = ['HEAD:main', 'HEAD:refs/tags/v9.9.9', 'HEAD:' + branch, 'HEAD:refs/heads/' + branch, 'HEAD'];
const results = probes.map(ref => {
  const args = [];
  return { why: gitDenied(['push', 'origin', ref], policy, 'git', args), args };
});
results.push({ why: gitDenied(['push', 'origin', 'HEAD'], { gitPush: 'branch' }, 'git') });
results.push({ why: gitDenied(['push', 'elsewhere', 'HEAD'], policy, 'git') });
results.push({ why: gitDenied(['push', 'https://github.com/acme/app.git', 'HEAD'], policy, 'git') });
results.push({ why: gitDenied(['push', 'origin', 'HEAD'], { ...policy, repo: 'acme/another' }, 'git') });
results.push({ why: gitDenied(['push', 'origin', 'HEAD'], { gitPush: 'branch', branch }, 'git') });
const changed = cp.spawnSync('git', ['config', 'remote.origin.pushurl', 'https://github.com/acme/another.git']);
if (changed.status !== 0) throw new Error('fixture pushurl could not be configured');
results.push({ why: gitDenied(['push', 'origin', 'HEAD'], policy, 'git') });
process.stdout.write(JSON.stringify(results));
`;
  const result = cp.spawnSync(process.execPath, ['-e', script, path.join(ROOT, 'lib', 'shim.js'), branch],
    { cwd: wt, env: h.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const probes = JSON.parse(result.stdout);
  for (const index of [0, 1, 5, 6, 7, 8, 9, 10]) assert.ok(probes[index].why, `probe ${index} must be refused`);
  for (const index of [2, 3, 4]) {
    assert.equal(probes[index].why, null);
    assert.deepEqual(probes[index].args, ['push', '--no-follow-tags', '--recurse-submodules=no', 'origin', `HEAD:refs/heads/${branch}`]);
  }
});

test('an isolated Codex worker can publish its task branch with an allow rule and guarded git', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const remote = path.join(h.base, 'publish.git');
  h.git(['init', '-q', '--bare', remote]);
  // origin is the recorded GitHub repository; the user's own git config
  // rewrites it to the bare repository here, as the user's credentials would
  // reach GitHub. The broker pushes with the user's config.
  h.git(['remote', 'set-url', 'origin', 'https://github.com/acme/app.git']);
  fs.appendFileSync(u.env.GIT_CONFIG_GLOBAL, `[url "${remote}"]\n\tinsteadOf = https://github.com/acme/app.git\n`);
  const branch = h.git(['branch', '--show-current'], wt);
  isolated(h, 'hard', 'codex');
  spawn(h, u, 'hard', { STUB_RUN: JSON.stringify([
    ['git', 'push', '-u', 'origin', branch],
    ['git', 'push', '--force', 'origin', branch],
  ]) });
  const seen = u.report();
  assert.match(seen.rules.join('\n'), /pattern = \["git", "push"\],\n {4}decision = "allow"/);
  assert.match(seen.rules.join('\n'), /pattern = \["git", "push", "--force"\],\n {4}decision = "forbidden"/);
  assert.deepEqual(seen.ran.map((r) => r.code), [0, 126], JSON.stringify(seen.ran.map((r) => r.stderr)));
  assert.match(seen.ran[0].stderr, /the broker pushes/);
  assert.equal(h.git(['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`]), h.git(['rev-parse', 'HEAD'], wt));
  spawn(h, u, 'review');
  assert.doesNotMatch(u.report().rules.join('\n'), /decision = "allow"/);
});

test('the orchestrator can run gh-stack atomic pushes while direct forced pushes and worker stack commands stay refused', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const bin = path.join(h.base, 'bin');
  const git = path.join(bin, 'git');
  const text = fs.readFileSync(git, 'utf8');
  fs.writeFileSync(git, text.replace('const args = process.argv.slice(2);',
    `const args = process.argv.slice(2);
if (args[0] === 'push' && args.includes('--atomic')) process.exit(0);`));
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log('stub-gh-token'); process.exit(0); }
const r = cp.spawnSync('git', ['push', '--atomic', '--force-with-lease', 'origin', 'HEAD:refs/heads/stack'], {stdio: 'inherit'});
process.exit(r.status ?? 1);
`);
  for (const [rung, allowed] of [['orchestrator', true], ['hard', false]]) {
    isolated(h, rung, 'codex');
    spawn(h, u, rung, { STUB_RUN: JSON.stringify([
      ['git', 'push', '--force-with-lease', 'origin', 'HEAD:refs/heads/stack'],
      ['gh', 'stack', 'sync'],
    ]) });
    assert.deepEqual(u.report().ran.map((r) => r.code), [126, allowed ? 0 : 126]);
  }
});

test('an isolated reviewer posts through gh, records evidence in a symlinked state dir and runs a git fixture', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  // The state directory reached through a symlink, as .tower-crane -> .gishra was.
  const realState = path.join(h.base, 'real-state');
  fs.renameSync(h.state, realState);
  fs.symlinkSync(realState, h.state);
  releaseExited(h);
  h.ok(['task', 'update', 'T1', '--kind', 'docs']);
  for (const name of ['easy', 'medium', 'hard', 'research']) {
    h.ok(['ladder', 'set', name, '--model', 'builder', '--clear', 'profile']);
  }
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker-T1-1']);
  const fixture = path.join(h.base, 'fixture');
  const run = [
    ['gh', 'pr', 'comment', '1', '--body', 'Review (tower-crane, clean context)'],
    [process.execPath, BIN, 'evidence', 'T1', '--type', 'review', '--ok', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--revision', '1', '--summary', 'nothing blocks'],
    ['git', 'init', '-q', fixture],
    ['git', '-C', fixture, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'fixture'],
    ['git', 'init', '-q', '--bare', `${fixture}.git`],
    ['git', '-C', fixture, 'push', `${fixture}.git`, 'HEAD:refs/heads/main'],
  ];
  const real = fs.realpathSync(realState);
  for (const harness of ['claude', 'codex']) {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(`${fixture}.git`, { recursive: true, force: true });
    isolated(h, 'medium', harness);
    const dry = h.json(['spawn', '--role', 'review', '--task', 'T1', '--dry-run'], { env: u.env });
    assert.ok(!JSON.stringify(dry).includes('stub-gh-token'), 'the token is not in the command or its shown env');
    spawn(h, u, 'review', { STUB_RUN: JSON.stringify(run) });
    const seen = u.report();
    assert.deepEqual(seen.ran.map((r) => r.code), run.map(() => 0), `${harness}: ${JSON.stringify(seen.ran.map((r) => r.stderr))}`);
    if (harness === 'claude') assert.ok(seen.settings.sandbox.filesystem.denyWrite.includes(real), 'claude reads the real state dir only');
    else assert.equal(seen.config.permissions['tower-crane'].filesystem[real], 'read', 'codex reads the real state dir only');
  }
  const reviews = h.json(['task', 'show', 'T1']).evidence.filter((e) => e.type === 'review');
  assert.deepEqual(reviews.map((e) => [e.agent, e.via]), [['reviewer-T1-1', 'broker'], ['reviewer-T1-2', 'broker']], 'the broker recorded each as the reviewer it started');
  for (const f of walk(realState)) assert.ok(!fs.readFileSync(f, 'utf8').includes('stub-gh-token'), `${f} holds the gh token`);
});

test('a sandboxed agent changes the state only through its spawn\'s broker: as itself, on its own task, with its role\'s commands', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'untouched']);
  const tests = h.readState('project.json').tests;
  const fixture = path.join(h.base, 'fixture-state');
  const cli = (...args) => [process.execPath, BIN, ...args];
  const envOwner = [
    process.execPath, '-e',
    `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const cp=require("node:child_process");const r=cp.spawnSync(process.execPath,${JSON.stringify([BIN, 'task', 'note', 'T1', 'as env owner'])},{env: fakeAgentEnv({...process.env,TOWER_CRANE_AGENT:'owner'}),encoding:'utf8'});process.stderr.write(r.stderr||'');process.exit(r.status??1);`,
  ];
  // Reaches the broker named in broker.json, but with a token of its own.
  const forged = `const f=require("fs"),n=require("net");const b=JSON.parse(f.readFileSync(process.env.TOWER_CRANE_BROKER,"utf8"));const s=n.connect(b.socket||{host:b.host,port:b.port},()=>s.write(JSON.stringify({token:"0".repeat(64),argv:["task","note","T1","forged"]})+"\\n"));let o="";s.on("data",d=>o+=d).on("end",()=>{process.stderr.write(o);process.exit(JSON.parse(o).code)})`;
  const cases = [
    [cli('task', 'note', 'T1', 'through the broker'), 0],
    [cli('task', 'note', 'T1', 'as the owner', '--agent', 'owner'), 1],
    [cli('task', 'note', 'T2', 'another task'), 1],
    [cli('task', 'add', '--title', 'X', '--acceptance', 'Y'), 1],
    [cli('project', 'set', '--tests-mode', 'none', '--agent', 'owner'), 1],
    [cli('evidence', 'T1', '--type', 'note', '--ok'), 1],
    [cli('task', 'show', 'T1'), 0],
    [[process.execPath, '-e', forged], 1],
    // A test fixture's own state is not the broker's; it runs in the agent.
    [cli('init', '--name', 'fixture', '--goal', 'own state', '--state', fixture), 0],
    [[process.execPath, '-e', 'process.stderr.write(require("fs").readFileSync(process.env.TOWER_CRANE_BROKER, "utf8"))'], 0],
    // Harness hooks write through the broker too, their payload from stdin,
    // with the agent's own binding and no other.
    [[process.execPath, '-e', `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
require("child_process").execFileSync(process.execPath, [${JSON.stringify(BIN)}, "hook", "report", "--binding", require("path").join(process.env.TOWER_CRANE_STATE, "homes", process.env.TOWER_CRANE_AGENT, "hook.json"), "--payload", "-"], { env: fakeAgentEnv(process.env), input: JSON.stringify({ report: "hooked" }), stdio: ["pipe", "ignore", "inherit"] })`], 0],
    [cli('hook', 'report', '--binding', path.join(h.state, 'homes', 'worker-T1-1', 'hook.json'), '--payload', '{"report":"as another"}'), 1],
    [envOwner, 1],
  ];
  const noted = [];
  for (const [n, harness] of ['claude', 'codex'].entries()) {
    isolated(h, 'small', harness);
    // The skills name the agent on every call, as itself.
    const named = [cli('task', 'note', 'T1', 'named', '--agent', `small-T1-${n + 1}`), 0];
    const agent = spawn(h, u, 'small', { STUB_RUN: JSON.stringify([...cases, named].map((c) => c[0])) }).agent;
    noted.push(agent);
    const ran = u.report().ran;
    assert.deepEqual(ran.map((r) => r.code), [...cases, named].map((c) => c[1]), `${harness}: ${JSON.stringify(ran.map((r) => r.stderr))}`);
    assert.match(ran[1].stderr, /a task process never acts as owner/);
    assert.match(ran[2].stderr, /works on T1 only, not T2/);
    assert.match(ran[3].stderr, /sandboxed small; it changes state only with task note, answer, hook, not task add/);
    assert.match(ran[11].stderr, /uses its own hook binding only/);
    assert.match(ran[7].stderr, /without its token/);
    assert.match(ran[12].stderr, /a task process never acts as owner/);
    // Codex's sandbox refuses connecting to a Unix socket; claude's has no
    // host loopback.
    const address = JSON.parse(ran[9].stderr);
    if (harness === 'codex') assert.deepEqual([address.socket, address.host, Number.isInteger(address.port) && address.port > 0], [undefined, '127.0.0.1', true]);
    else assert.deepEqual([typeof address.socket, address.host], ['string', undefined]);
    assert.ok(fs.existsSync(path.join(fixture, 'project.json')), `${harness}: the fixture got its own state`);
    assert.ok(!fs.existsSync(path.join(h.state, 'brokers', agent)), `${harness}: the broker closes with its agent`);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  isolated(h, 'hard', 'claude');
  const worker = spawn(h, u, 'hard', { STUB_RUN: JSON.stringify([cli('claim', 'T1'), cli('evidence', 'T1', '--type', 'review', '--ok', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736')]) }).agent;
  assert.deepEqual(u.report().ran.map((r) => r.code), [0, 1], JSON.stringify(u.report().ran.map((r) => r.stderr)));
  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(t1.claim.agent, worker, 'the worker claimed as itself');
  assert.deepEqual(t1.notes.map((n) => [n.agent, n.text]), noted.flatMap((a) => [[a, 'through the broker'], [a, 'named']]));
  assert.deepEqual(t1.evidence, []);
  assert.deepEqual(t2.notes, []);
  assert.deepEqual(h.readState('project.json').tests, tests);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.filter((e) => e.via === 'broker').map((e) => [e.cmd, e.agent, e.task]),
    [...noted.flatMap((a) => [['task note', a, 'T1'], ['hook report', a, 'T1'], ['task note', a, 'T1']]), ['claim', worker, 'T1']], 'only brokered changes, each as its agent');
  assert.deepEqual(events.filter((e) => e.via === 'automation' && ['hook stop', 'msg'].includes(e.cmd))
    .map((e) => [e.cmd, e.agent, e.task]), [...noted, worker].flatMap((agent) =>
      [['hook stop', agent, 'T1'], ['msg', agent, 'T1']]), 'supervisor notifications retain their engine provenance and agent');
  assert.deepEqual(events.filter((e) => e.cmd === 'hook report').map((e) => e.detail.report), noted.map(() => 'hooked'), 'the hook payload came through stdin');
});

test('a brokered command still running when its agent exits is killed, and spawn --wait returns', { skip: NO_STUBS, timeout: 300000 }, async (t) => {
  const { h, u } = setup(t);
  // Stands in for a slow brokered command: preloaded into every node process
  // the spawn starts, it holds only the CLI the broker runs for the note
  // "late", before it writes anything. The agent's own code never runs there.
  const preload = path.join(h.base, 'slow-broker.js');
  fs.writeFileSync(preload, `
if (process.env.TOWER_CRANE_VIA === 'broker' && process.argv.includes('late')) {
  require('node:fs').writeFileSync(process.env.SLOW_BROKER_PID, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
`);
  for (const harness of ['claude', 'codex']) {
    const pidFile = path.join(h.base, `${harness}-late.pid`);
    // The agent leaves the note waiting in the background and exits once the
    // broker is running it.
    const background = `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const cp=require("child_process"),f=require("fs");cp.spawn(process.execPath,${JSON.stringify([BIN, 'task', 'note', 'T1', 'late'])},{ env: fakeAgentEnv(process.env),detached:true,stdio:"ignore"}).unref();const end=Date.now()+300000;while(!f.existsSync(${JSON.stringify(pidFile)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50)`;
    let pid = null;
    t.after(() => {
      if (pid && detachedAlive({ pid })) killPid(pid, 'SIGKILL');
    });
    isolated(h, 'hard', harness);
    const run = [[process.execPath, BIN, 'task', 'note', 'T1', 'early'], [process.execPath, '-e', background]];
    const env = { ...u.env, STUB_RUN: JSON.stringify(run), NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, SLOW_BROKER_PID: pidFile };
    const started = Date.now();
    releaseExited(h);
    const r = await h.runAsync(['spawn', '--role', 'hard', '--task', 'T1', '--wait', '--json'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - started < 60000, `${harness}: spawn --wait returned`); // wait-allow: verify broker shutdown stops a held subprocess promptly
    assert.deepEqual(u.report().ran.map((x) => x.code), [0, 0], JSON.stringify(u.report().ran.map((x) => x.stderr)));
    assert.ok(fs.existsSync(pidFile), `${harness}: the broker ran the late note`);
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await waitUntil(() => !detachedAlive({ pid }), { signal: t.signal });
    assert.ok(!detachedAlive({ pid }), `${harness}: the brokered command stopped with the broker`);
  }
  const notes = h.readState('tasks.json').tasks[0].notes.map((n) => n.text).filter((text) => ['early', 'late'].includes(text));
  assert.deepEqual(notes, ['early', 'early'], 'nothing the broker was still running wrote after its spawn ended');
});

test('a sandboxed role cannot write the state directory itself', () => {
  // A Windows checkout has CRLF line ends.
  const text = fs.readFileSync(A.file('worker'), 'utf8').replace(/^writeOutside:(\r?\n)/m, 'writeOutside:$1  - state$1');
  assert.match(text, /- state/);
  assert.throws(() => A.parse(text, 'worker.md'), /state needs sandbox: false/);
  for (const job of ['worker', 'researcher', 'reviewer', 'small']) assert.ok(!A.load(job).writeOutside.includes('state'), job);
});

test('a sandboxed role cannot write the worktrees root, which holds the admin directories', () => {
  const text = fs.readFileSync(A.file('worker'), 'utf8').replace(/^writeOutside:(\r?\n)/m, 'writeOutside:$1  - worktrees$1');
  assert.match(text, /- worktrees/);
  assert.throws(() => A.parse(text, 'worker.md'), /worktrees needs sandbox: false/);
  for (const job of ['worker', 'researcher', 'reviewer', 'small']) assert.ok(!A.load(job).writeOutside.includes('worktrees'), job);
  assert.ok(A.load('orchestrator').writeOutside.includes('worktrees') && !A.load('orchestrator').sandbox);
});

// A project's sandbox.write would reopen the worktree lock in the state
// directory, or every admin directory in the worktrees root.
test('spawn refuses a sandbox.write path over the state directory or the worktrees root', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const root = path.dirname(wt);
  const cases = [
    // Holding the state directory, it holds the agent homes too, which an earlier check names.
    [h.base, /sandbox\.write path .* holds /],
    [path.join(h.state, 'worktree'), /is inside the state directory/],
    [root, /holds the worktrees root/],
  ];
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    for (const [dir, why] of cases) {
      h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [dir] })]);
      const r = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--dry-run'], { env: u.env });
      assert.notEqual(r.code, 0, `${harness} ${dir}`);
      assert.match(r.stderr, why, `${harness} ${dir}`);
    }
    h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [path.join(h.base, 'elsewhere')] })]);
    const r = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--dry-run'], { env: u.env });
    assert.equal(r.code, 0, `${harness}: ${r.stderr}`);
  }
});

// Whether a sandboxed command may write file under the rendered rules. claude
// writes its working directory, the common directory of a linked worktree and
// allowWrite, and denyWrite wins over each. codex writes where the nearest
// rule above the file says write, its workspace root included.
function commandsWrite(seen, cwd, common, file) {
  const under = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
  if (seen.harness === 'claude') {
    const box = seen.settings.sandbox.filesystem;
    return [cwd, common, ...box.allowWrite].some((p) => under(file, p)) && !box.denyWrite.some((p) => under(file, p));
  }
  const profile = seen.config.permissions['tower-crane'].filesystem;
  const rules = Object.entries(profile).filter(([, access]) => typeof access === 'string')
    .flatMap(([p, access]) => codexTargets(seen, p).map((target) => [target, access]));
  rules.push([cwd, profile[':workspace_roots']['.']]);
  const nearest = rules.filter(([p]) => under(file, p)).sort((a, b) => b[0].length - a[0].length)[0];
  return nearest?.[1] === 'write';
}

// The worktree lock (lib/worktree.js underWorktreeLock) moved out of the git
// directory, which a sandboxed worker writes, to the state directory.
test('no sandboxed claude or codex role can write the worktree lock, as every worker could write its old place', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const real = (p) => fs.realpathSync.native(p);
  const common = real(path.join(h.repo, '.git'));
  const lock = path.join(real(h.state), 'worktree', 'lock');
  const legacy = path.join(common, 'tower-crane-worktree.lock');
  for (const harness of ['claude', 'codex']) {
    for (const rung of ['hard', 'review', 'research', 'small']) {
      isolated(h, rung, harness);
      spawn(h, u, rung);
      const seen = u.report();
      assert.equal(commandsWrite(seen, real(wt), common, lock), false, `${harness} ${rung}: the lock is read-only`);
      assert.equal(commandsWrite(seen, real(wt), common, path.join(real(path.dirname(wt)), '.git-admin', 'other')), false, `${harness} ${rung}: other admin directories are read-only`);
      if (rung === 'hard') assert.equal(commandsWrite(seen, real(wt), common, legacy), true, `${harness}: a worker writes the old lock path`);
    }
  }
});

test('a sandboxed agent gets no gh token, from the keyring or the spawning environment, and its gh runs on the host with the user\'s config', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'medium', harness);
    spawn(h, u, 'review');
    assert.equal(u.report().ghToken, null, `${harness}: no token from the keyring`);
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
      spawn(h, u, 'review', { [name]: 'spawner-token' });
      assert.deepEqual(u.report().tokens, [], `${harness}: no ${name} from the spawner`);
    }
    // Nor from the project's env, which the owner sets for every agent.
    h.ok(['project', 'set', '--env', JSON.stringify({ GH_TOKEN: 'project-token' })]);
    spawn(h, u, 'review');
    assert.deepEqual(u.report().tokens, [], `${harness}: no token from the project env`);
    h.ok(['project', 'set', '--env', '{}']);
  }
});

test('sandboxed gh runs on the host with the user\'s custom config directory, which the agent cannot read', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const custom = path.join(u.home, 'custom-config');
  fs.mkdirSync(path.join(custom, 'gh'), { recursive: true });
  fs.writeFileSync(path.join(h.base, 'bin', 'gh'), `#!${process.execPath}
const path = require('node:path');
const env = process.env;
const config = env.GH_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(env.HOME, '.config'), 'gh');
if (!config.startsWith(${JSON.stringify(custom)} + path.sep) || env.GH_TOKEN) {
  process.stderr.write('not the gh login of the user');
  process.exit(1);
}
`);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    for (const customEnv of [{ GH_CONFIG_DIR: path.join(custom, 'gh'), XDG_CONFIG_HOME: '' }, { GH_CONFIG_DIR: '', XDG_CONFIG_HOME: custom }]) {
      spawn(h, u, 'hard', { ...customEnv, STUB_RUN: JSON.stringify([['gh', 'pr', 'view', '1']]) });
      const seen = u.report();
      assert.equal(seen.ran[0].code, 0, `${harness}: ${seen.ran[0].stderr}`);
      assert.equal(seen.ghToken, null, `${harness}: the agent holds no token`);
      assert.equal(commandsRead(seen, path.join(custom, 'gh')), false, `${harness}: the original gh config stays hidden`);
    }
  }
});

test('a push counts as local only when every URL git would use is local, so rewriting cannot reach another machine', (t) => {
  const h = makeRepo(t);
  const local = path.join(h.base, 'local.git');
  h.git(['init', '-q', '--bare', local]);
  const away = 'https://127.0.0.1:9/away.git';
  // A fixture repo the agent may write, with a rewrite rule and a remote
  // whose second push URL is on another machine.
  const fx = path.join(h.base, 'fx');
  h.git(['init', '-q', fx]);
  h.git(['-C', fx, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  h.git(['-C', fx, 'remote', 'add', 'two', local]);
  h.git(['-C', fx, 'remote', 'set-url', '--add', '--push', 'two', local]);
  h.git(['-C', fx, 'remote', 'set-url', '--add', '--push', 'two', away]);
  h.git(['-C', fx, 'remote', 'add', 'loc', local]);
  h.git(['-C', fx, 'remote', 'add', 'up', away]);
  const rewritten = path.join(h.base, 'rewritten.git');
  const cases = [
    [['git', '-C', fx, 'push', local, '+HEAD:refs/heads/plain'], ALLOW],
    [['git', '-C', fx, 'push', 'loc', 'HEAD:refs/heads/named'], ALLOW],
    // An abbreviated option takes the next argument as its value; any option
    // voids the local exception, so `loc` cannot vouch for `up`.
    [['git', '-C', fx, 'push', '--push-opt', 'loc', 'up', 'HEAD:refs/heads/x', '--force'], 126],
    [['git', '-C', fx, '-c', `url.${away}.insteadOf=${rewritten}`, 'push', rewritten, 'HEAD:refs/heads/x'], 126],
    [['git', '-C', fx, '-c', 'remote.two.pushurl=' + away, 'push', 'two', 'HEAD'], 126],
    [['git', '-C', fx, 'config', `url.${away}.insteadOf`, rewritten], 0],
    [['git', '-C', fx, 'push', rewritten, '+HEAD:refs/heads/x'], 126],
    [['git', '-C', fx, 'push', 'two', '+HEAD:refs/heads/x'], 126],
    [['git', '-C', fx, 'config', '--unset', `url.${away}.insteadOf`], 0],
    [['git', '-C', fx, 'config', `url.${away}.pushInsteadOf`, local], 0],
    [['git', '-C', fx, 'push', local, '+HEAD:refs/heads/x'], 126],
  ];
  // Both a job that may push its branch and one that may not.
  const decided = decide(h, h.base, ['worker', 'small'], 'tower-crane/T1-probe', cases.map((c) => c[0]));
  for (const [n, job] of ['worker', 'small'].entries()) {
    const ran = decided.map((r) => r[n]);
    assert.deepEqual(ran.map((r) => r.code), cases.map((c) => c[1]), `${job}: ${JSON.stringify(ran.map((r) => [r.argv, r.why]))}`);
  }
});

test('a codex rework resumes in a fresh isolated home and finds its first session', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'medium', 'codex');
  const first = spawn(h, u, 'medium');
  const home = path.join(h.state, 'homes', first.agent);
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'PLANTED-BY-AGENT\n');
  h.ok(['claim', 'T1', '--agent', first.agent]);
  h.ok(['submit', 'T1', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--agent', first.agent]);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--revision', h.revision('T1'), '--agent', 'reviewer-T1-1', '--summary', 'redo']);
  h.ok(['rework', 'T1', '--reason', 'redo']);
  const next = spawn(h, u, 'medium');
  assert.equal(next.resumed, true);
  assert.equal(next.agent, first.agent);
  const seen = u.report();
  assert.ok(seen.resumed, 'codex runs exec resume');
  assert.equal(seen.home, path.join(home, 'home'), 'the resume runs in the agent\'s isolated home');
  assert.deepEqual(seen.sessions, [`rollout-${first.agent}-stub-thread.jsonl`], 'the first session is there');
  assert.ok(!seen.memory.join('\n').includes('PLANTED'), 'the home was rebuilt');
});

test('a spawn started inside another agent links to the user\'s own files, so removing the parent home breaks nothing', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'small', 'claude');
  const parent = path.join(h.state, 'homes', spawn(h, u, 'small').agent);
  // A spawned orchestrator runs with its own home in these variables.
  const inside = { CLAUDE_CONFIG_DIR: parent, HOME: path.join(parent, 'home'), USERPROFILE: path.join(parent, 'home') };
  const child = path.join(h.state, 'homes', spawn(h, u, 'small', inside).agent);
  for (const f of ['.credentials.json']) assert.equal(fs.readlinkSync(path.join(child, f)), path.join(u.home, '.claude', f), f);
  assert.ok(!fs.lstatSync(path.join(child, 'home', '.gitconfig')).isSymbolicLink(), 'git config is the home\'s own file');
  const helper = JSON.parse(fs.readFileSync(path.join(child, 'settings.json'), 'utf8')).apiKeyHelper;
  assert.ok(helper.includes(path.join(u.home, '.claude', 'settings.json')), 'the helper reads the user\'s settings');
  fs.rmSync(parent, { recursive: true, force: true });
  assert.equal(fs.readFileSync(path.join(child, '.credentials.json'), 'utf8'), `{"token":"${SECRET}-CRED"}`, 'auth still resolves');
  assert.equal(cp.execSync(helper, { encoding: 'utf8', env: u.env }).trim(), `${SECRET}-HELPER`);
});

test('a rung opts back in to a named tool and MCP server, shown by spawn --dry-run', (t) => {
  const { h, u } = setup(t);
  h.ok(['ladder', 'set', 'small', '--harness', 'claude', '--model', 'fixture-large', '--clear', 'profile', '--clear', 'effort', '--tools', '["WebFetch"]', '--mcp', '["planted"]']);
  let dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.equal(dry.argv[dry.argv.indexOf('--tools') + 1], 'Bash,Read,Grep,Glob,WebFetch');
  assert.ok(!dry.argv.includes('WebFetch'), 'no longer denied');
  assert.equal(dry.argv[dry.argv.indexOf('--allowedTools') + 1], 'Bash,Read,Grep,Glob,WebFetch,mcp__planted');
  assert.deepEqual([dry.home.tools, dry.home.mcp], [['WebFetch'], ['planted']]);
  const text = h.ok(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.match(text, /^# agent file .*tower-crane-small\.md; home .*small-T1-1; MCP servers: planted; opted-in tools: WebFetch$/m);
  if (!NO_STUBS) {
    spawn(h, u, 'small');
    assert.deepEqual(u.report().mcp, { planted: { command: 'planted-mcp', args: ['x'] } }, 'the server, without its env');
  }

  h.ok(['ladder', 'set', 'small', '--harness', 'codex', '--profile', 'fixture-main', '--clear', 'model', '--tools', '["web_search","multi_agent"]', '--mcp', '["planted"]']);
  dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.ok(!dry.argv.includes('web_search="disabled"'));
  assert.ok(!dry.argv.join(' ').includes('--disable multi_agent'));
  assert.ok(dry.argv.join(' ').includes('--enable multi_agent'));
  assert.deepEqual(dry.home.mcp, ['planted']);
  if (!NO_STUBS) {
    spawn(h, u, 'small');
    const seen = u.report();
    assert.deepEqual(seen.mcp, { planted: true });
    assert.ok(!seen.configText.includes(SECRET), 'the server env stays out');
    noSecretsCopied(h);
  }

  h.ok(['ladder', 'set', 'small', '--mcp', '["missing"]']);
  const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /opts in MCP server missing, but .*config\.toml defines no \[mcp_servers\.missing\]/);
  // Moving to pi drops the codex opt-ins; named on pi, they are refused.
  const pi = h.ok(['ladder', 'set', 'small', '--harness', 'pi', '--model', 'x', '--clear', 'profile']);
  assert.match(pi, /^ladder small: moving from codex to pi dropped tools \["web_search","multi_agent"\], mcp \["missing"\], which do not fit pi$/m);
  const named = h.run(['ladder', 'set', 'small', '--tools', '["web_search"]', '--mcp', '["planted"]']);
  assert.equal(named.code, 1);
  assert.match(named.stderr, /MCP opt-ins are unsupported on pi/);
  assert.match(named.stderr, /pi tools must be built-ins/);
});

test('only the orchestrator or the owner widens a rung, a command needs the owner, and args hold only allowlisted flags', (t) => {
  const { h } = setup(t);
  isolated(h, 'small', 'claude');
  const as = (agent, flags) => h.run(['ladder', 'set', 'small', ...flags, '--agent', agent]);
  for (const flags of [['--tools', '["Agent"]'], ['--mcp', '["planted"]'], ['--args', '["--verbose"]'], ['--harness', 'command', '--command', '["sh"]', '--clear', 'model']]) {
    const r = as('worker-T1-1', flags);
    assert.equal(r.code, 1, flags.join(' '));
    assert.match(r.stderr, flags.includes('--command') ? /only the owner with an explicit identity can change ladder\.command/ : /operational: only the orchestrator or the owner/);
  }
  const command = as('orchestrator', ['--harness', 'command', '--command', '["sh"]', '--clear', 'model']);
  assert.equal(command.code, 1);
  assert.match(command.stderr, /ladder\.command, ladder\.reach are owner-required; opened D1/);
  h.ok(['ladder', 'set', 'small', '--model', 'fixture-other', '--agent', 'orchestrator']);
  assert.equal(as('orchestrator', ['--tools', '["Agent"]']).code, 0);
  assert.equal(as('owner', ['--args', '["--verbose","--max-turns","40"]']).code, 0);
  const refused = [
    ['claude', '["--dangerously-skip-permissions"]'], ['claude', '["--settings","{}"]'], ['claude', '["--setting-sources=user,project"]'],
    ['codex', '["--sandbox","danger-full-access"]'], ['codex', '["-s","danger-full-access"]'], ['codex', '["-cmodel_verbosity=low"]'],
    ['codex', '["-c","sandbox_mode=\\"danger-full-access\\""]'], ['codex', '["--ignore-rules"]'], ['codex', '["--enable","x"]'],
  ];
  for (const [harness, args] of refused) {
    if (harness === 'codex') isolated(h, 'small', 'codex');
    const r = as('owner', ['--args', args]);
    assert.equal(r.code, 1, args);
    assert.match(r.stderr, /args may only use .*; refused /, args);
  }
  assert.equal(as('owner', ['--args', '["-c","model_reasoning_effort=\\"high\\"","--disable","memories","--skip-git-repo-check"]']).code, 0);
});

test('TOML tables have no prototype, so __proto__ and inherited names are plain keys', () => {
  const doc = TOML.parse('a.__proto__.polluted = true\nconstructor = 1\ntoString = 2\n[__proto__]\nx = 1\n[[b]]\n__proto__ = 3\n');
  assert.equal(({}).polluted, undefined, 'Object.prototype is untouched');
  assert.deepEqual(Object.keys(doc), ['a', 'constructor', 'toString', '__proto__', 'b']);
  assert.equal(doc.constructor, 1);
  assert.equal(Object.getPrototypeOf(doc), null);
  assert.equal(doc.a.__proto__.polluted, true);
});

test('claude, codex, opencode, agy and pi rungs dispatch through spawn, never as native subagents', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'tower-crane', 'SKILL.md'), 'utf8');
  const ladder = fs.readFileSync(path.join(ROOT, 'docs', 'ladder.md'), 'utf8');
  for (const text of [skill, ladder]) {
    assert.match(text, /A rung on claude, codex, opencode, agy or pi always runs through `tower-crane spawn`/);
    assert.doesNotMatch(text, /dispatch natively with (that|the) rung's model/);
  }
});

test('each role has an agent file that states its tools, MCP servers, skills, web, git push, gh writes and outside paths', () => {
  const components = JSON.parse(fs.readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
  for (const job of ['worker', 'reviewer', 'small', 'orchestrator']) {
    assert.ok(components.agents.includes(`tower-crane-${job}`), `components.json registers tower-crane-${job}`);
    const a = A.load(job);
    assert.deepEqual(a.mcpServers, [], `${job}: no MCP servers by default`);
    assert.deepEqual(a.tools.filter((x) => a.disallowedTools.includes(x)), [], `${job}: a tool is not both allowed and denied`);
    // Claude Code reads disallowedTools directly for native agents, so it
    // has to spell out every denial the other fields state.
    const derived = [
      ...(a.web ? [] : ['WebFetch', 'WebSearch']),
      ...(a.gitPush === 'none' ? ['Bash(git push:*)'] : ['Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)']),
    ];
    for (const d of derived) assert.ok(a.disallowedTools.includes(d), `${job}: disallowedTools lacks ${d}`);
    for (const g of a.ghWrite) assert.ok(!a.disallowedTools.includes(`Bash(gh ${g}:*)`), `${job}: ${g} is both allowed and denied`);
    assert.ok(A.policy(a).gh.includes('pr view') && a.ghWrite.every((g) => A.policy(a).gh.includes(g)), `${job}: the gh allowlist is reads plus ghWrite`);
  }
  // The parsed config the codex filter works on survives a round trip.
  const doc = TOML.parse('a = 1\n[b]\nc = { d = [1, "x"] }\n');
  assert.deepEqual(TOML.parse(TOML.stringify(doc)), doc);
  // Prefixed integers keep their base.
  assert.deepEqual({ ...TOML.parse('o = 0o17\nx = 0x1F\nb = 0b101\nd = 1_000\n') }, { o: 15, x: 31, b: 5, d: 1000 });
});

// TOML forbids every control character raw in a basic string but tab, DEL
// included. A path codex's profile names can hold any of them, and one raw
// DEL made codex reject the whole config.
test('TOML strings and keys escape every control character TOML forbids raw, DEL included', () => {
  const forbidden = /[\x00-\x08\x0a-\x1f\x7f]/;
  for (let c = 0; c < 0x80; c++) {
    if (c >= 0x20 && c < 0x7f) continue;
    const ch = String.fromCharCode(c);
    const doc = { [`/var/tmp/a${ch}b`]: `v${ch}w` };
    const text = TOML.stringify({ t: doc });
    for (const line of text.split('\n')) assert.doesNotMatch(line, forbidden, `U+${c.toString(16).padStart(4, '0')} stays escaped`);
    assert.deepEqual({ ...TOML.parse(text).t }, doc, `U+${c.toString(16).padStart(4, '0')} reads back`);
  }
  assert.throws(() => TOML.stringify({ k: 'a\ud800b' }), /lone surrogate/);
  assert.deepEqual({ ...TOML.parse(TOML.stringify({ k: 'a\u{1f600}b' })) }, { k: 'a\u{1f600}b' });
});

// readAround lists the entries of the directories on the way to a runtime
// directory, and codex binds each again for every command, following a link.
// An entry stays listed only when nobody but root and the user can swap it.
test('the codex profile lists an entry beside the runtime directory only when nobody else can turn it into a link', () => {
  const me = 1000;
  const st = (uid, mode, link = false) => ({ uid, mode, isSymbolicLink: () => link });
  const dir = 0o40755, sticky = 0o41777, open = 0o40777, group = 0o40775, file = 0o100644;
  const cases = [
    ['root directory, root entry', st(0, dir), st(0, file), true],
    ['root directory, own entry', st(0, dir), st(me, file), true],
    ['sticky world-writable directory, own entry', st(0, sticky), st(me, dir), true],
    ['sticky world-writable directory, root entry', st(0, sticky), st(0, dir), true],
    ['sticky world-writable directory, another user\'s entry', st(0, sticky), st(1001, dir), false],
    ['root directory, another user\'s entry', st(0, dir), st(1001, file), false],
    ['world-writable directory without the sticky bit', st(0, open), st(0, file), false],
    ['group-writable directory without the sticky bit', st(0, group), st(me, file), false],
    ['another user\'s directory', st(1001, dir), st(me, file), false],
    ['a link', st(0, dir), st(me, 0o120777, true), false],
    ['an unreadable directory', null, st(me, file), false],
  ];
  for (const [what, parent, entry, listed] of cases) assert.equal(A.steadyEntry(parent, entry, me), listed, what);
});
