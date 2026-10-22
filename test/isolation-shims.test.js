'use strict';

// The git and gh shims and pushes inside a spawned agent, task scratch, the
// recorded tool after an upgrade, and a reviewer posting through the broker.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, BIN } = require('./helpers');
const S = require('../lib/state');
const TOML = require('../lib/toml');
const { NO_STUBS, setup, walk, releaseExited, spawn, ALLOW, decide, isolated, commandsRead } = require('./isolation-helpers');

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

test('a live spawn keeps its git, gh, tower-crane, hooks and policy on its recorded tool after a checkout upgrade', { skip: NO_STUBS }, (t) => {
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
const r = cp.spawnSync('git', args, { env: { ...process.env, PATH: ${JSON.stringify(h.env.PATH)} }, stdio: 'inherit' });
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
      [process.execPath, '-e', `
const cp = require('node:child_process');
const version = cp.spawnSync('tower-crane', ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || version.stdout.trim() !== ${JSON.stringify(`${require('../package.json').version} (commit ${toolSha})`)}) throw new Error(version.stderr || version.stdout);
const dispatch = cp.spawnSync('tower-crane', ['ci', 'dispatch', '--help'], { encoding: 'utf8' });
if (dispatch.status !== 0) throw new Error(dispatch.stderr);
`],
    ]) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(u.report().ran.map((r) => [r.code, r.stderr]), [[0, ''],
    [0, `tower-crane: the broker pushes ${h.git(['rev-parse', 'HEAD'], wt).slice(0, 12)} to ${branch} on https://github.com/acme/app.git\n`], [0, ''], [0, ''], [0, '']]);
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
  // snapshot; its sandbox hides hook.json, so they record no hook event.
  const shims = path.join(home, 'home', '.tower-crane-shims');
  const policy = JSON.parse(fs.readFileSync(path.join(shims, 'policy.json'), 'utf8'));
  assert.equal(policy.branch, branch);
  assert.equal(policy.repo, 'acme/app');
  assert.equal(policy.hook, null);
  assert.ok(fs.readFileSync(path.join(shims, 'bin', 'git'), 'utf8').includes(path.join(shims, 'tool', 'lib', 'shim.js')), 'the git shim runs the copy');
  assert.equal(fs.readFileSync(path.join(shims, 'tool', 'lib', 'shim.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'lib', 'shim.js'), 'utf8'));
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.find((e) => e.cmd === 'spawn').detail.tool.sha, toolSha);
  assert.ok(events.some((e) => e.cmd === 'hook report' && e.agent === started.agent), 'hook report');
  for (const cmd of ['hook git-push', 'hook pr-created']) {
    assert.ok(!events.some((e) => e.cmd === cmd && e.agent === started.agent), cmd);
  }
  assert.match(fs.readFileSync(S.progressFile(h.state, started.agent), 'utf8'), /"cmd":"hook progress"/);
});

// Seen 2026-10-20: a codex worker's sandbox bound the dispatching checkout's
// code, and retiring that checkout emptied the live agent's view of it. The
// user's tower-crane on PATH runs that checkout here, as an npm link would.
for (const harness of ['claude', 'codex']) {
  test(`a sandboxed ${harness} agent's policy and tower-crane use its own tool copy, so retiring the dispatching checkout leaves its CLI working`, { skip: NO_STUBS }, (t) => {
    const { h, u } = setup(t);
    isolated(h, 'medium', harness);
    const checkout = path.join(u.home, '.cache', 'tower-crane-tool');
    for (const name of ['bin', 'lib', 'agents', 'skills', 'standards', 'package.json']) {
      fs.cpSync(path.join(ROOT, name), path.join(checkout, name), { recursive: true });
    }
    h.git(['init', '-q', checkout]);
    h.git(['add', '.'], checkout);
    h.git(['commit', '-qm', 'engine checkout'], checkout);
    fs.writeFileSync(path.join(h.base, 'bin', 'tower-crane'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(checkout, 'bin', 'tower-crane.js'))} "$@"\n`, { mode: 0o755 });
    const shown = path.join(h.base, 'shown.json');
    const show = `
const fs = require('node:fs');
const cp = require('node:child_process');
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const r = cp.spawnSync('tower-crane', ['task', 'show', 'T1', '--json'], { env: fakeAgentEnv(process.env), encoding: 'utf8' });
fs.writeFileSync(${JSON.stringify(shown)}, r.stdout);
process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
`;
    const result = cp.spawnSync(process.execPath, [path.join(checkout, 'bin', 'tower-crane.js'), 'spawn', '--task', 'T1', '--wait', '--json'], {
      cwd: h.repo, encoding: 'utf8', timeout: 300000,
      env: { ...u.env, STUB_RUN: JSON.stringify([
        [process.execPath, '-e', `require('node:fs').renameSync(${JSON.stringify(checkout)}, ${JSON.stringify(`${checkout}-retired`)})`],
        [process.execPath, '-e', show],
        ['tower-crane', 'task', 'note', 'T1', 'through-the-broker'],
      ]) },
    });
    assert.equal(result.status, 0, result.stderr);
    const seen = u.report();
    assert.deepEqual(seen.ran.map((r) => [r.code, r.stderr]), [[0, ''], [0, ''], [0, '']]);
    assert.equal(JSON.parse(fs.readFileSync(shown, 'utf8')).id, 'T1', 'tower-crane answers after the checkout is gone');
    const started = JSON.parse(result.stdout);
    const note = h.readState('tasks.json').tasks[0].notes.find((n) => n.text === 'through-the-broker');
    assert.equal(note?.agent, started.agent, 'the broker writes the note after the checkout is gone');
    const home = fs.realpathSync(path.join(h.state, 'homes', started.agent));
    // The policy names no path of the checkout: not the sandbox, the hooks or
    // the credential helper.
    const policy = harness === 'claude' ? JSON.stringify(seen.settings) : fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    assert.ok(!policy.includes(fs.realpathSync(u.home) + path.sep + path.join('.cache', 'tower-crane-tool')), `${harness}: the policy names the checkout`);
    const own = harness === 'claude' ? path.join(home, 'tool') : path.join(home, 'home', '.tower-crane-shims', 'tool');
    assert.equal(commandsRead(seen, path.join(own, 'bin', 'tower-crane.js')), true, `${harness}: the agent's tool copy is readable`);
    assert.equal(commandsRead(seen, path.join(fs.realpathSync(u.home), '.cache', 'tower-crane-tool', 'lib', 'agents.js')), false, `${harness}: the checkout is hidden`);
  });
}

// The agent's socket directory removed outside its sandbox, which still holds
// the old one: the broker cannot listen where the agent looks, so the
// supervisor stops the agent and records why.
test('a sandboxed worker whose broker lost its socket directory is stopped blocked with the broker loss as the reason', { skip: NO_STUBS || (process.platform === 'win32' && 'Windows uses a named pipe') }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'medium', 'claude');
  const remove = "const dir = process.env.TOWER_CRANE_SOCKET_DIR; require('node:fs').renameSync(dir, `${dir}.gone`); process.stdout.write(dir);";
  // Work the supervisor, which checks the broker every second, stops long before it ends.
  const work = 'setTimeout(() => {}, 60000);'; // wait-allow: agent work the supervisor stops, never a wait of this test
  const r = h.run(['spawn', '--role', 'medium', '--task', 'T1', '--wait', '--json'], { env: { ...u.env, STUB_RUN: JSON.stringify([[process.execPath, '-e', remove], [process.execPath, '-e', work]]) } });
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const spawned = events.find((e) => e.cmd === 'spawn' && e.task === 'T1').detail.agent;
  const phase = events.findLast((e) => e.cmd === 'spawn phase' && e.detail.agent === spawned);
  assert.equal(phase?.detail.phase, 'blocked', `${r.stdout}\n${r.stderr}`);
  assert.match(phase.detail.reason, /^state broker lost: its socket directory \/\S+ is gone$/);
  const dir = phase.detail.reason.match(/directory (\S+) is gone/)[1];
  t.after(() => fs.rmSync(`${dir}.gone`, { recursive: true, force: true }));
  assert.match(path.basename(dir), /^tc-[0-9a-f]{12}$/, 'the leaf the spawn granted');
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
test('for every harness the first git, gh and tower-crane on the agent\'s PATH are its pinned shims, and claude and codex sandboxes show them', { skip: NO_STUBS }, (t) => {
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
const cp = require('node:child_process');
const which = (tool) => String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  .map((dir) => path.join(dir, tool)).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } }) || null;
const seen = { git: which('git'), gh: which('gh'), 'tower-crane': which('tower-crane'), home: process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR || null };
for (const tool of ['git', 'gh', 'tower-crane']) seen[tool + 'Text'] = seen[tool] ? fs.readFileSync(seen[tool], 'utf8').slice(0, 4096) : null;
for (const [key, args] of [['version', ['--version']], ['dispatch', ['ci', 'dispatch', '--help']]]) {
  const r = cp.spawnSync('tower-crane', args, { encoding: 'utf8' });
  seen[key] = { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(seen));
if (path.basename(process.argv[1]) === 'codex') process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'probe' }) + '\\n');
`);
  for (const name of ['claude', 'codex', 'opencode', 'agy', 'pi']) {
    fs.writeFileSync(path.join(probe, name), `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(probe, 'tower-crane'), '#!/bin/sh\nif [ "$1" = --version ]; then echo 0.0.1; else echo "unknown command" >&2; exit 2; fi\n', { mode: 0o755 });
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
    const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json'], { env });
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
    const started = JSON.parse(r.stdout);
    assert.equal(seen['tower-crane'], path.join(bin, 'tower-crane'), `${harness}: the pinned CLI precedes the old global install`);
    const cliRoot = harness === 'codex' ? path.join(path.dirname(bin), 'tool') : started.tool.path;
    assert.ok(seen['tower-craneText'].includes(path.join(cliRoot, 'bin', 'tower-crane.js')));
    assert.equal(seen.version.code, 0, seen.version.stderr);
    assert.equal(seen.version.stdout.trim(), `${started.tool.version} (commit ${started.tool.sha || 'unknown'})`);
    assert.equal(seen.dispatch.code, 0, seen.dispatch.stderr);
    assert.match(seen.dispatch.stdout, /ci dispatch/);
    for (const tool of ['git', 'gh', 'tower-crane']) {
      const ran = cp.spawnSync(path.join(bin, tool), tool === 'git' ? ['version'] : tool === 'tower-crane' ? ['--version'] : ['auth', 'status'], { cwd: h.repo, encoding: 'utf8',
        env: { ...env, NODE_OPTIONS: `--require=${evil}`, NODE_PATH: path.join(h.base, 'planted-modules') } });
      assert.doesNotMatch(String(ran.stderr), /require is not defined|ERR_REQUIRE|ES module/, `${harness}: ${tool} runs as CommonJS`);
      if (tool !== 'gh') assert.equal(ran.status, 0, `${harness}: ${tool} version through the shim: ${ran.stderr}`);
      assert.equal(fs.existsSync(injected), false, `${harness}: ${tool} loaded NODE_OPTIONS's file`);
    }
    if (harness === 'codex') {
      const rules = TOML.parse(fs.readFileSync(path.join(seen.home, 'config.toml'), 'utf8')).permissions['tower-crane'].filesystem;
      const tool = path.join(path.dirname(bin), 'tool');
      for (const p of [bin, path.join(bin, 'git'), path.join(bin, 'tower-crane'), path.join(path.dirname(bin), 'policy.json'), path.join(tool, 'lib', 'shim.js'), path.join(tool, 'bin', 'tower-crane.js'), path.join(tool, 'tool.json')]) {
        assert.ok(codexShows(rules, fs.realpathSync(p)), `codex shows ${p}`);
      }
      assert.ok(!codexShows(rules, fs.realpathSync(path.join(h.state, 'homes'))), 'codex hides homes/');
      assert.ok(!codexShows(rules, fs.realpathSync(path.join(seen.home, 'config.toml'))), 'codex hides the rest of the agent home');
    }
    if (harness === 'claude') {
      const fsRules = JSON.parse(fs.readFileSync(path.join(seen.home, 'settings.json'), 'utf8')).sandbox.filesystem;
      for (const p of [path.join(bin, 'git'), path.join(bin, 'tower-crane'), path.join(cliRoot, 'bin', 'tower-crane.js'), path.join(cliRoot, 'tool.json'), path.join(path.dirname(bin), 'policy.json')]) assert.ok(claudeShows(fsRules, fs.realpathSync(p)), `claude shows ${p}`);
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
