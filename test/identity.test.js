'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeRepo, cachedFixture, runPty, PTY_AVAILABLE, BIN, HOOKS } = require('./helpers');

const noAgent = { TOWER_CRANE_AGENT: undefined };
const message = 'tower-crane: no agent: pass --agent NAME or set TOWER_CRANE_AGENT\n';
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
const withoutTowerCrane = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('TOWER_CRANE_')));
const terminal = (h, args, env = {}) => runPty([...args, '--state', h.state], { cwd: h.repo, env: { ...withoutTowerCrane(h.env), ...env } });

function assertOwnerRequest(output) {
  assert.match(output, /tower-crane (ask|msg --to orchestrator).*task note/);
  assert.doesNotMatch(output, /--agent owner|TOWER_CRANE_AGENT=owner/);
}

function setup(t) {
  return cachedFixture(t, 'owner task', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Owner action', '--acceptance', 'approved', '--needs-owner', 'approve access']);
  });
}

test('a non-TTY command without an agent exits 2 and writes nothing', (t) => {
  const h = setup(t);
  const before = events(h);
  const r = h.run(['task', 'note', 'T1', 'lost identity'], { env: noAgent });
  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stderr, message);
  assert.equal(r.stdout, '');
  assert.equal(events(h), before);
  assert.deepEqual(h.readState('tasks.json').tasks[0].notes, []);
});

test('a task environment without an agent is refused on a non-TTY run', (t) => {
  const h = setup(t);
  const before = events(h);
  const r = h.run(['owner-done', 'T1'], { env: { ...noAgent, TOWER_CRANE_TASK: 'T1' } });
  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stderr, message);
  assert.equal(events(h), before);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
});

test('empty agent identity names both ways to supply it', (t) => {
  const h = setup(t);
  const before = events(h);
  for (const agent of ['', '   ']) {
    const r = h.run(['owner-done', 'T1'], { env: { TOWER_CRANE_AGENT: agent } });
    assert.equal(r.code, 2, r.stderr);
    assert.equal(r.stderr, message);
    assert.equal(events(h), before);
  }
});

test('terminal fallback records owner only outside a task', { skip: !PTY_AVAILABLE }, (t) => {
  const h = setup(t);
  const r = terminal(h, ['task', 'note', 'T1', 'person at a terminal']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(h.readState('tasks.json').tasks[0].notes[0].agent, 'owner');
  const before = events(h);
  for (const task of ['T1', '']) {
    const blocked = terminal(h, ['task', 'note', 'T1', 'lost identity'], { TOWER_CRANE_TASK: task });
    assert.equal(blocked.code, 2, blocked.stdout + blocked.stderr);
    assert.ok(blocked.stdout.includes(message.trim()));
    assert.equal(events(h), before);
  }
});

test('terminal fallback cannot clear owner work without explicit owner identity', { skip: !PTY_AVAILABLE }, (t) => {
  for (const identity of ['flag', 'env']) {
    const h = setup(t);
    const before = events(h);
    const blocked = terminal(h, ['owner-done', 'T1']);
    assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout, /only the (orchestrator or the )?owner/);
    assertOwnerRequest(blocked.stdout);
    assert.equal(events(h), before);
    assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
    const done = terminal(h, ['owner-done', 'T1', ...(identity === 'flag' ? ['--agent', 'owner'] : [])],
      identity === 'env' ? { TOWER_CRANE_AGENT: 'owner' } : {});
    assert.equal(done.code, 0, done.stdout + done.stderr);
    assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null);
  }
});

test('agents cannot clear or replace an existing owner request through task update', (t) => {
  const h = setup(t);
  const before = events(h);
  const tasksBefore = h.readState('tasks.json');
  for (const agent of ['reviewer', 'Owner']) {
    for (const reason of ['', '   ', 'approve funding']) {
      const blocked = h.run(['task', 'update', 'T1', '--title', 'Changed', '--needs-owner', reason, '--agent', agent]);
      assert.equal(blocked.code, 1, blocked.stderr);
      assert.match(blocked.stderr, /only the (orchestrator or the )?owner/);
      assertOwnerRequest(blocked.stderr);
      assert.equal(events(h), before);
      assert.deepEqual(h.readState('tasks.json'), tasksBefore);
    }
  }
  h.ok(['task', 'update', 'T1', '--title', 'Renamed', '--needs-owner', ' approve access ', '--agent', 'reviewer']);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
  h.ok(['task', 'add', '--title', 'New request', '--acceptance', 'approved', '--agent', 'reviewer']);
  h.ok(['task', 'update', 'T2', '--needs-owner', 'approve funding', '--agent', 'reviewer']);
  assert.equal(h.readState('tasks.json').tasks[1].needs_owner, 'approve funding');
});

test('task add trims needs_owner so an agent can restate it', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Owner request', '--acceptance', 'approved', '--needs-owner', ' approve access ']);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
  h.ok(['task', 'update', 'T1', '--needs-owner', ' approve access ', '--agent', 'reviewer']);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
  h.ok(['task', 'add', '--title', 'Blank owner request', '--acceptance', 'approved', '--needs-owner', ' \t ']);
  assert.equal(h.readState('tasks.json').tasks[1].needs_owner, null);
});

test('terminal task update needs explicit owner to clear or replace owner work', { skip: !PTY_AVAILABLE }, (t) => {
  for (const identity of ['flag', 'env']) {
    const h = setup(t);
    const before = events(h);
    const tasksBefore = h.readState('tasks.json');
    for (const reason of ['', '   ', 'approve funding']) {
      const blocked = terminal(h, ['task', 'update', 'T1', '--title', 'Changed', '--needs-owner', reason]);
      assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
      assert.match(blocked.stdout, /only the (orchestrator or the )?owner/);
      assertOwnerRequest(blocked.stdout);
      assert.equal(events(h), before);
      assert.deepEqual(h.readState('tasks.json'), tasksBefore);
    }
    h.ok(['task', 'add', '--title', 'New request', '--acceptance', 'approved']);
    const requested = terminal(h, ['task', 'update', 'T2', '--needs-owner', 'approve funding']);
    assert.equal(requested.code, 0, requested.stdout + requested.stderr);
    assert.equal(h.readState('tasks.json').tasks[1].needs_owner, 'approve funding');
    for (const reason of ['approve funding', '']) {
      const updated = terminal(h, ['task', 'update', 'T1', '--needs-owner', reason,
        ...(identity === 'flag' ? ['--agent', 'owner'] : [])], identity === 'env' ? { TOWER_CRANE_AGENT: 'owner' } : {});
      assert.equal(updated.code, 0, updated.stdout + updated.stderr);
      assert.equal(h.readState('tasks.json').tasks[0].needs_owner, reason || null);
      assert.equal(JSON.parse(events(h).trim().split('\n').at(-1)).agent, 'owner');
    }
  }
});

test('terminal fallback cannot waive gates without explicit owner identity', { skip: !PTY_AVAILABLE }, (t) => {
  for (const identity of ['flag', 'env']) {
    const h = setup(t);
    h.ok(['owner-done', 'T1']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', 'abcdef1', '--pr', '1', '--agent', 'worker']);
    const waive = ['accept', 'T1', '--waive', 'tests', '--waive', 'clean', '--waive', 'review', '--waive', 'ci', '--reason', 'approved'];
    const before = events(h);
    const blocked = terminal(h, waive);
    assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout, /only the owner with an explicit identity can change waive\./);
    assertOwnerRequest(blocked.stdout);
    assert.equal(events(h), before);
    assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
    assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
    const accepted = terminal(h, [...waive, ...(identity === 'flag' ? ['--agent', 'owner'] : [])],
      identity === 'env' ? { TOWER_CRANE_AGENT: 'owner' } : {});
    assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
    const task = h.readState('tasks.json').tasks[0];
    assert.equal(task.status, 'accepted');
    assert.ok(task.evidence.every((e) => e.waived && e.agent === 'owner'));
  }
});

test('terminal fallback cannot release another agent claim without explicit owner identity', { skip: !PTY_AVAILABLE }, (t) => {
  for (const identity of ['flag', 'env']) {
    const h = setup(t);
    h.ok(['owner-done', 'T1']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    const release = ['release', 'T1', '--reason', 'handoff'];
    const before = events(h);
    const blocked = terminal(h, release);
    assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout, /only the claimant/);
    assertOwnerRequest(blocked.stdout);
    assert.equal(events(h), before);
    assert.equal(h.readState('tasks.json').tasks[0].claim.agent, 'worker');
    const released = terminal(h, [...release, ...(identity === 'flag' ? ['--agent', 'owner'] : [])],
      identity === 'env' ? { TOWER_CRANE_AGENT: 'owner' } : {});
    assert.equal(released.code, 0, released.stdout + released.stderr);
    assert.equal(h.readState('tasks.json').tasks[0].claim, null);
    assert.equal(h.readState('tasks.json').tasks[0].status, 'todo');
  }
});

test('terminal fallback cannot set owner policies on init or project set', { skip: !PTY_AVAILABLE }, (t) => {
  for (const [flag, value] of [
    ['--tests-mode', 'none'], ['--tests-by-kind', '{"code":"run-only"}'], ['--tests-expensive', 'true'],
    ['--tests-paths', '["src/**"]'], ['--tests-keep', '["lib/**"]'],
    ['--decision-delegation', '{"orchestrator_technical":true}'],
  ]) {
    const h = makeRepo(t);
    const deniedInit = terminal(h, ['init', '--name', 'demo', '--goal', 'owner policy', flag, value]);
    assert.equal(deniedInit.code, 1, deniedInit.stdout + deniedInit.stderr);
    assert.match(deniedInit.stdout, /only the (orchestrator or the )?owner/);
    assert.ok(!fs.existsSync(h.state));
    h.init();
    const project = h.readState('project.json');
    const before = events(h);
    const deniedSet = terminal(h, ['project', 'set', flag, value]);
    assert.equal(deniedSet.code, 1, deniedSet.stdout + deniedSet.stderr);
    assert.match(deniedSet.stdout, /only the (orchestrator or the )?owner/);
    assert.deepEqual(h.readState('project.json'), project);
    assert.equal(events(h), before);
    assertOwnerRequest(deniedSet.stdout);
  }
});

test('terminal fallback cannot answer or delegate a decision as the owner', { skip: !PTY_AVAILABLE }, (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ask', '--question', 'Which?', '--option', 'a', '--option', 'b']);
  const before = events(h);
  for (const args of [
    ['answer', 'D1', '--choice', 'a'],
    ['decision', 'delegate', 'D1', '--answerers', '["worker"]'],
  ]) {
    const denied = terminal(h, args);
    assert.equal(denied.code, 1, denied.stdout + denied.stderr);
    assert.match(denied.stdout, /explicit identity/);
    assert.equal(events(h), before);
  }
});

test('--agent owner is refused when TOWER_CRANE_TASK is set', (t) => {
  const h = setup(t);
  const before = events(h);
  const r = h.run(['owner-done', 'T1', '--agent', 'owner'], {
    env: { TOWER_CRANE_AGENT: 'reviewer', TOWER_CRANE_TASK: 'T1' },
  });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /a task process never acts as owner/);
  assert.equal(events(h), before);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
});

test('TOWER_CRANE_AGENT=owner is refused when TOWER_CRANE_TASK is set', (t) => {
  const h = setup(t);
  const before = events(h);
  const r = h.run(['owner-done', 'T1'], {
    env: { TOWER_CRANE_AGENT: 'owner', TOWER_CRANE_TASK: 'T1' },
  });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /a task process never acts as owner/);
  assert.equal(events(h), before);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
});

test('--agent owner is refused when TOWER_CRANE_AGENT names another identity (I1, I3)', (t) => {
  const h = setup(t);
  const before = events(h);
  const project = h.readState('project.json');
  // I1: the orchestrator, no terminal, no task variable, the owner key in reach.
  const i1 = h.run(['project', 'set', '--merge-admin', 'true', '--agent', 'owner'], { env: { TOWER_CRANE_AGENT: 'orchestrator' } });
  assert.equal(i1.code, 1, i1.stderr);
  assert.match(i1.stderr, /owner identity needs a process the owner runs \(docs\/state\.md#agent-identity\): TOWER_CRANE_AGENT names orchestrator/);
  // I3: an unsandboxed worker that lost TOWER_CRANE_TASK.
  const i3 = h.run(['project', 'set', '--workers', '4', '--agent', 'owner'], { env: { TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: undefined } });
  assert.equal(i3.code, 1, i3.stderr);
  assert.match(i3.stderr, /TOWER_CRANE_AGENT names worker-T1-1, and a process started as another identity never acts as owner/);
  assert.deepEqual(h.readState('project.json'), project);
  assert.equal(events(h), before);
  h.ok(['project', 'set', '--workers', '4', '--agent', 'owner']);
  assert.equal(h.readState('project.json').limits.workers, 4);
});

test('owner without a terminal needs the owner key', (t) => {
  const h = setup(t);
  const before = events(h);
  const cases = [
    [{ TOWER_CRANE_OWNER_KEY: undefined }, /stdin and stdout are not a terminal and TOWER_CRANE_OWNER_KEY is unset/],
    [{ TOWER_CRANE_OWNER_KEY: 'guessed' }, /TOWER_CRANE_OWNER_KEY does not match the key in /],
  ];
  for (const [env, refusal] of cases) {
    for (const agent of [['--agent', 'owner'], []]) {
      const r = h.run(['owner-done', 'T1', ...agent], { env });
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /owner identity needs a process the owner runs \(docs\/state\.md#agent-identity\)/);
      assert.match(r.stderr, refusal);
    }
  }
  assert.equal(events(h), before);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
  h.ok(['owner-done', 'T1']);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null);
});

test('automatic state discovery never passes the owner key to a Git child', (t) => {
  const h = setup(t);
  const report = path.join(h.base, 'git-environment.jsonl');
  assert.ok(h.env.TOWER_CRANE_OWNER_KEY);
  const result = h.run(['project', 'set', '--merge-admin', 'true'], {
    env: { TOWER_CRANE_STATE: undefined },
    hooks: { HOOK_GIT_ENV_REPORT: report },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.readState('project.json').merge.admin, true);
  const calls = fs.readFileSync(report, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0].args, ['rev-parse', '--git-common-dir']);
  assert.ok(calls.every((call) => !call.ownerKeyPresent), 'discovery and later Git children receive no owner key');
});

test('identity checks preserve delayed hook input on stdin', async (t) => {
  const h = setup(t);
  const agent = 'worker-stdin';
  const binding = path.join(h.state, 'homes', agent, 'hook.json');
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  fs.writeFileSync(binding, JSON.stringify({ agent, task: 'T1', state: h.state, harness: 'codex', attempt: 1 }));
  const ready = path.join(h.base, 'stdin-ready');
  const child = spawn(process.execPath, ['--require', HOOKS, BIN, 'hook', 'report', '--binding', binding, '--payload', '-', '--state', h.state], {
    cwd: h.repo,
    env: { ...h.env, TOWER_CRANE_AGENT: agent, TOWER_CRANE_TASK: 'T1', HOOK_STATE: h.state, HOOK_STDIN_READY: ready },
    timeout: 15000,
  });
  let stderr = '';
  let exited = false;
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', (error) => assert.equal(error.code, 'EPIPE'));
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => { exited = true; resolve(code); });
  });
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready) && !exited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(ready), stderr || 'CLI never attempted to read stdin');
    // Keep the pipe empty while the child begins its synchronous read.
    await new Promise((resolve) => setTimeout(resolve, 50));
    child.stdin.end(JSON.stringify({ report: 'Delayed input' }));
    assert.equal(await done, 0, stderr);
    const rows = events(h).trim().split('\n').map(JSON.parse);
    assert.equal(rows.findLast((event) => event.cmd === 'hook report').detail.report, 'Delayed input');
  } finally {
    child.kill();
    await done;
  }
});

test('caller config and home cannot redirect an initialized project owner credential', (t) => {
  const h = setup(t);
  const callerHome = path.join(h.base, 'caller-home');
  const callerConfig = path.join(callerHome, '.config', 'tower-crane');
  fs.mkdirSync(path.join(callerConfig, 'owner'), { recursive: true });
  fs.writeFileSync(path.join(callerConfig, 'owner', 'key'), 'caller-created-key\n');
  const project = h.readState('project.json');
  const before = events(h);
  for (const redirect of [
    { TOWER_CRANE_CONFIG: path.join(callerConfig, 'config.json') },
    { TOWER_CRANE_CONFIG: undefined, HOME: callerHome, USERPROFILE: callerHome },
  ]) {
    const forged = { ...redirect, TOWER_CRANE_AGENT: undefined, TOWER_CRANE_TASK: undefined, TOWER_CRANE_OWNER_KEY: 'caller-created-key' };
    for (const args of [
      ['project', 'set', '--merge-admin', 'true', '--agent', 'owner'],
      ['owner-key', '--agent', 'owner'],
      ['init', '--name', 'replacement', '--goal', 'replace binding', '--agent', 'owner'],
    ]) {
      const denied = h.run(args, { env: forged });
      assert.equal(denied.code, 1, denied.stderr);
      assert.match(denied.stderr, /TOWER_CRANE_OWNER_KEY does not match/);
    }
    assert.deepEqual(h.readState('project.json'), project);
    assert.equal(events(h), before);
    h.ok(['project', 'show', '--agent', 'owner'], { env: redirect });
  }
});

test('a missing recorded owner key cannot be replaced by a caller-selected key', (t) => {
  const h = setup(t);
  fs.rmSync(path.join(path.dirname(h.userConfig), 'owner', 'key'));
  const callerConfig = path.join(h.base, 'caller-config');
  fs.mkdirSync(path.join(callerConfig, 'owner'), { recursive: true });
  fs.writeFileSync(path.join(callerConfig, 'owner', 'key'), 'caller-created-key\n');
  const before = events(h);
  const denied = h.run(['project', 'set', '--merge-admin', 'true'], {
    env: { TOWER_CRANE_CONFIG: path.join(callerConfig, 'config.json'), TOWER_CRANE_OWNER_KEY: 'caller-created-key' },
  });
  assert.equal(denied.code, 1, denied.stderr);
  assert.match(denied.stderr, /TOWER_CRANE_OWNER_KEY is set but .* does not exist; create it with tower-crane owner-key/);
  assert.equal(events(h), before);
});

test('only a terminal owner can bind an unbound project, and later config changes cannot rebind it', { skip: !PTY_AVAILABLE }, (t) => {
  const h = setup(t);
  const project = h.readState('project.json');
  delete project.owner_config_dir;
  h.writeState('project.json', project);
  const before = events(h);
  for (const args of [
    ['project', 'set', '--merge-admin', 'true'],
    ['owner-key'],
    ['init', '--name', 'replacement', '--goal', 'replace binding'],
  ]) {
    const denied = h.run(args);
    assert.equal(denied.code, 1, denied.stderr);
    assert.match(denied.stderr, /project.json has no valid owner_config_dir/);
  }
  assert.deepEqual(h.readState('project.json'), project);
  assert.equal(events(h), before);
  const config = { TOWER_CRANE_CONFIG: h.userConfig };
  const bound = terminal(h, ['owner-key', '--agent', 'owner'], config);
  assert.equal(bound.code, 0, bound.stdout + bound.stderr);
  const dir = fs.realpathSync.native(path.dirname(h.userConfig));
  assert.equal(h.readState('project.json').owner_config_dir, dir);
  const redirected = terminal(h, ['owner-key', '--agent', 'owner'], {
    TOWER_CRANE_CONFIG: path.join(h.base, 'redirected', 'config.json'),
  });
  assert.equal(redirected.code, 0, redirected.stdout + redirected.stderr);
  assert.ok(redirected.stdout.includes(path.join(dir, 'owner', 'key')));
  assert.equal(h.readState('project.json').owner_config_dir, dir);
  h.ok(['owner-done', 'T1']);
});

test('a terminal is refused owner when TOWER_CRANE_AGENT names another identity', { skip: !PTY_AVAILABLE }, (t) => {
  const h = setup(t);
  const before = events(h);
  const r = terminal(h, ['owner-done', 'T1', '--agent', 'owner'], { TOWER_CRANE_AGENT: 'orchestrator' });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /TOWER_CRANE_AGENT names orchestrator/);
  assert.equal(events(h), before);
});

test('owner-key at a terminal creates the key that later stands in for one', { skip: !PTY_AVAILABLE }, (t) => {
  const h = setup(t);
  const file = path.join(path.dirname(h.userConfig), 'owner', 'key');
  fs.rmSync(file);
  const config = { TOWER_CRANE_CONFIG: h.userConfig };
  assert.equal(terminal(h, ['owner-key'], config).code, 1);
  assert.throws(() => fs.readFileSync(file, 'utf8'), { code: 'ENOENT' });
  const made = terminal(h, ['owner-key', '--agent', 'owner'], config);
  assert.equal(made.code, 0, made.stdout);
  // One descriptor for mode and content, so both describe the same file.
  const fd = fs.openSync(file, 'r');
  let mode, key;
  try {
    key = fs.readFileSync(fd, 'utf8').trim();
    mode = fs.fstatSync(fd).mode & 0o777;
  } finally {
    fs.closeSync(fd);
  }
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(made.stdout.includes(`created ${file}`));
  assert.ok(!made.stdout.includes(key));
  assert.equal(mode, 0o600);
  const again = terminal(h, ['owner-key', '--agent', 'owner'], config);
  assert.ok(again.stdout.includes(`exists ${file}`));
  assert.equal(h.run(['owner-done', 'T1']).code, 1);
  // Authentication with the original key proves a second creation kept it.
  h.ok(['owner-done', 'T1'], { env: { TOWER_CRANE_OWNER_KEY: key } });
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null);
});

test('TOWER_CRANE_AGENT supplies the recorded identity when --agent is absent', (t) => {
  const h = setup(t);
  assert.equal(h.run(['task', 'note', 'T1', 'missing'], { env: noAgent }).code, 2);
  h.ok(['task', 'note', 'T1', 'named reviewer'], { env: { TOWER_CRANE_AGENT: 'reviewer', TOWER_CRANE_TASK: 'T1' } });
  assert.equal(h.readState('tasks.json').tasks[0].notes[0].agent, 'reviewer');
});

test('owner-done and waivers require the resolved name owner exactly', (t) => {
  const h = setup(t);
  for (const agent of ['reviewer', 'Owner']) {
    const r = h.run(['owner-done', 'T1', '--agent', agent]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /only the (orchestrator or the )?owner/);
    assertOwnerRequest(r.stderr);
    assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
  }
  h.ok(['owner-done', 'T1', '--agent', 'owner']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', 'abcdef1', '--agent', 'worker']);
  const waive = ['accept', 'T1', '--waive', 'tests', '--waive', 'clean', '--waive', 'review', '--reason', 'owner approved'];
  for (const agent of ['reviewer', 'Owner']) {
    const r = h.run([...waive, '--agent', agent]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /only the owner with an explicit identity can change waive\./);
    assertOwnerRequest(r.stderr);
    assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
  }
  const task = h.json([...waive, '--agent', 'owner'], { env: noAgent });
  assert.equal(task.status, 'accepted');
  assert.ok(task.evidence.every((e) => e.waived && e.agent === 'owner'));
});
