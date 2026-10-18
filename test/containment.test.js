'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { gateFixture } = require('./gate-helpers');
const C = require('../lib/containment');
const G = require('../lib/gates/common');
const HARNESS = path.join(__dirname, 'fixtures', 'containment-harness.js');
process.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
const memory = 512 * 1024 * 1024;
const systemd = C.canScope();

function diagnostics(result) {
  return result.stderr + (result.containment?.error || '');
}

function fixture(t) {
  const h = cachedFixture(t, 'containment', (h) => {
    h.init(['--tasks-max', '64', '--memory-max-bytes', String(memory)]);
    h.ok(['task', 'add', '--title', 'Bound fake agent', '--acceptance', 'contained', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Finite fake harness.\n' });
  });
  h.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
  return h;
}

test('resource settings are persisted, validated and operational', (t) => {
  const h = fixture(t);
  assert.deepEqual(h.readState('project.json').resources, { tasks_max: 64, memory_max_bytes: memory });
  assert.match(h.ok(['project', 'show']), /resources: .*"tasks_max":64/);
  const before = h.readState('project.json');
  const refused = h.run(['project', 'set', '--tasks-max', '40', '--agent', 'worker']);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /orchestrator or the owner/);
  assert.deepEqual(h.readState('project.json'), before);
  for (const v of ['0', '-1']) assert.equal(h.run(['project', 'set', '--tasks-max', v]).code, 2);
  h.ok(['project', 'set', '--tasks-max', '40', '--agent', 'orchestrator']);
  assert.equal(h.readState('project.json').resources.tasks_max, 40);
  assert.deepEqual(C.errors({ tasks_max: 0, memory_max_bytes: -1 }).length, 2);
});

test('defaults reserve half the effective slice capacity', () => {
  const d = C.defaults({ memory: 1024 ** 3, tasks: 200 });
  assert.ok(d.memory_max_bytes <= 512 * 1024 * 1024);
  assert.ok(d.tasks_max <= 100);
  assert.ok(d.tasks_max > 0);
});

test('nested attempt caps do not recursively shrink project defaults', () => {
  const slice = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/agents.slice';
  const own = 'tower-crane-123-0123456789abcdef.scope';
  for (const [input, expected] of [
    [`${slice}/${own}/runner`, slice],
    [`${slice}/${own}/nested-${own}/runner`, slice],
    [`${slice}/external.scope/nested-${own}/runner`, `${slice}/external.scope`],
    [`${slice}/external.scope`, `${slice}/external.scope`],
  ]) assert.equal(C.budgetGroup(input), expected);
});

test('scope placement keeps the caller slice, including custom fences', () => {
  for (const [group, slice] of [
    ['/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/agents.slice/session.scope', 'agents.slice'],
    ['/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/test-fence.slice/runner.scope/runner', 'test-fence.slice'],
  ]) assert.equal(C.callerSlice(group), slice);
  assert.throws(() => C.callerSlice('/sys/fs/cgroup/no-slice/runner'), /no systemd slice/);
});

test('ordinary fixture launches preserve hooks and spawn options without containment', async () => {
  const h = fixture();
  const env = { ...h.env };
  delete env.TOWER_CRANE_TEST_CONTAINMENT;
  const child = C.spawn(process.execPath, ['-e', 'console.log("fixture")'], {
    env, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
    resources: { tasks_max: 1, memory_max_bytes: 1 },
  });
  assert.equal(child.containment, undefined);
  const output = [];
  child.stdout.on('data', (data) => output.push(data));
  const status = await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  assert.equal(status, 0);
  assert.equal(Buffer.concat(output).toString(), 'fixture\n');
  await h.cleanup();
});

test('local cgroup events distinguish a child cap from the parent cap', (t) => {
  const h = fixture(t);
  const group = path.join(h.base, 'cgroup-events');
  fs.mkdirSync(group);
  for (const [file, text] of [
    ['pids.events', 'max 1\n'], ['pids.events.local', 'max 0\n'],
    ['memory.events', 'oom_kill 1\n'], ['memory.events.local', 'oom 0\noom_group_kill 0\n'],
  ]) fs.writeFileSync(path.join(group, file), text);
  assert.equal(C.limitReason(group, { tasks: 0, memory: 0 }), null);
  fs.writeFileSync(path.join(group, 'memory.events.local'), 'oom 1\noom_group_kill 1\n');
  assert.equal(C.limitReason(group, { tasks: 0, memory: 0 }), 'resource-memory-max');
});

test('nested cap failures leave the parent running when local events are available', async () => {
  for (const [mode, reason] of [['nested-limit', 'resource-tasks-max'], ['nested-memory', 'resource-memory-max']]) {
    const localEvents = !systemd || fs.existsSync(path.join(C.currentGroup(),
      mode === 'nested-limit' ? 'pids.events.local' : 'memory.events.local'));
    const result = await G.treeExec(process.execPath, [HARNESS, mode, 'unused'], {
      resources: { tasks_max: 128, memory_max_bytes: memory }, timeout: 10000, // wait-allow: finite nested cap probe deadline
    });
    if (!localEvents && result.resource_reason === reason) continue;
    assert.equal(result.status, 0, diagnostics(result));
    assert.equal(result.resource_reason, undefined, result.stderr);
    assert.ok(result.stdout.includes(`child: ${reason}\nparent-survived`), result.stdout + result.stderr);
  }
});

test('fake harness nested launches and detached grandchildren retain containment', async (t) => {
  const h = fixture(t);
  const file = path.join(h.base, 'nested.jsonl');
  const result = await G.treeExec(process.execPath, [HARNESS, 'nested', file], {
    resources: { tasks_max: 64, memory_max_bytes: memory }, timeout: 10000,
  });
  assert.equal(result.status, 0, diagnostics(result));
  assert.equal(result.error, undefined, result.stderr);
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 3);
  if (result.containment.backend === 'cgroup') {
    const parent = C.currentGroup().split('/');
    const slice = parent.findLastIndex((name) => name.endsWith('.slice'));
    const fence = parent.slice(0, slice + 1).join('/') + '/';
    assert.ok(result.containment.group.startsWith(fence), result.containment.group);
    assert.equal(records[0].inherited, result.containment.group);
    assert.ok(records[1].inherited.startsWith(records[0].inherited + path.sep));
    for (const record of records) assert.ok(record.group.startsWith(records[0].inherited + path.sep), JSON.stringify(record));
  } else assert.equal(result.containment.backend, 'watchdog');
});

test('Node preloads run once inside the launched command containment', async (t) => {
  const h = fixture(t);
  const preload = path.join(h.base, 'preload.js');
  const log = path.join(h.base, 'preload.jsonl');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const C = require(${JSON.stringify(require.resolve('../lib/containment'))});
fs.appendFileSync(process.env.CONTAINMENT_PRELOAD_LOG, JSON.stringify({
  group: process.platform === 'linux' ? C.currentGroup() : null,
  inherited: process.env[C.MARK] || null,
  bootstrap: process.env.TOWER_CRANE_CONTAINMENT_NODE_OPTIONS || null,
}) + '\\n');
`);
  const result = await G.treeExec(process.execPath, ['-e', 'console.log("loaded")'], {
    env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, CONTAINMENT_PRELOAD_LOG: log },
    resources: { tasks_max: 64, memory_max_bytes: memory },
  });
  assert.equal(result.status, 0, diagnostics(result));
  const records = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].bootstrap, null);
  if (result.containment.backend === 'cgroup') {
    assert.equal(records[0].inherited, result.containment.group);
    assert.ok(records[0].group.startsWith(result.containment.group + path.sep));
  }
});

test('fast scoped commands preserve stdout-only diagnostics and registration', async () => {
  for (let n = 0; n < 3; n++) {
    const result = await G.treeExec(process.execPath, ['-e', 'console.log("useful diagnostic"); process.exitCode = 1'], {
      resources: { tasks_max: 64, memory_max_bytes: memory },
    });
    assert.equal(result.status, 1, diagnostics(result));
    assert.equal(result.resource_reason, undefined, diagnostics(result));
    assert.equal(result.stderr, '');
    assert.match(G.errText(result), /useful diagnostic/);
  }
});

test('lightweight gate helpers retain cancellation without a separate resource scope', async () => {
  const result = await G.exec({ signal: new AbortController().signal, project: { resources: { tasks_max: 64, memory_max_bytes: memory } } },
    process.execPath, ['-e', 'console.log("auxiliary")'], {});
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.containment, undefined);
});

test('finite nested fork storm fails the gate command and leaves another attempt running', async (t) => {
  const sibling = C.spawn(process.execPath, ['-e', 'console.log("untouched"); setTimeout(() => {}, 3000)'], { // wait-allow: finite isolation probe lifetime
    resources: { tasks_max: 64, memory_max_bytes: memory }, stdio: ['ignore', 'pipe', 'pipe'],
  }); // wait-allow: finite sibling lifetime tests isolation
  t.after(() => sibling.kill('SIGKILL'));
  await new Promise((accept, reject) => {
    sibling.stdout.once('data', accept);
    sibling.once('error', reject);
    sibling.once('exit', () => reject(new Error('sibling exited before starting')));
  });
  const result = await G.exec({ exec: G.treeExec, project: { resources: { tasks_max: systemd ? 32 : 4, memory_max_bytes: memory } } },
    process.execPath, [HARNESS, 'nested-storm', 'unused'], {
    resources: { tasks_max: systemd ? 32 : 4, memory_max_bytes: memory }, timeout: 10000, // wait-allow: finite resource probe deadline
  });
  assert.equal(result.resource_reason, 'resource-tasks-max', result.stderr);
  assert.equal(result.error?.code, 'resource-tasks-max');
  assert.equal(result.ok, false);
  assert.equal(sibling.exitCode, null);
  assert.equal(sibling.signalCode, null);
  assert.equal(sibling.resourceReason, undefined);
});

test('bounded memory growth fails with resource-memory-max', async () => {
  const result = await G.exec({ exec: G.treeExec, project: { resources: { tasks_max: 64, memory_max_bytes: 96 * 1024 * 1024 } } },
    process.execPath, [HARNESS, 'memory', 'unused'], {
    resources: { tasks_max: 64, memory_max_bytes: 96 * 1024 * 1024 }, timeout: 10000, // wait-allow: finite resource probe deadline
  });
  assert.equal(result.resource_reason, 'resource-memory-max', result.stderr);
  assert.equal(result.ok, false);
});

test('CLI spawn records cap failure in events and status', async (t) => {
  const h = fixture(t);
  h.ok(['project', 'set', '--tasks-max', systemd ? '32' : '4']);
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command',
    JSON.stringify([process.execPath, HARNESS, 'storm', 'unused', '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
  const result = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.notEqual(result.code, 0);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const failed = events.findLast((e) => e.cmd === 'spawn phase' && e.detail.reason === 'resource-tasks-max');
  assert.ok(failed, result.stdout + result.stderr);
  assert.equal(failed.detail.phase, 'blocked');
  assert.equal(events.some((e) => e.cmd === 'spawn retry'), false);
  assert.match(h.ok(['status']), /resource-tasks-max/);
});

test('CLI cleanup records a capped gate command and names its failure', (t) => {
  const h = cachedFixture(t, 'contained-gate', (h) => {
    h.init(['--tasks-max', systemd ? '32' : '4', '--memory-max-bytes', String(memory)]);
    const sha = gateFixture(h);
    h.ok(['task', 'add', '--title', 'Gate resource cap', '--acceptance', 'bounded']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
    h.ok(['project', 'set', '--clean-cmd',
      [process.execPath, HARNESS, 'storm', 'unused'].map(G.shellQuote).join(' ')]);
  });
  h.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
  const result = h.run(['check', 'clean', 'T1', '--json'],
    { env: { TOWER_CRANE_CLEAN_CMD: '' } });
  assert.equal(result.code, 1, result.stderr);
  const gate = JSON.parse(result.stdout);
  assert.equal(gate.ok, false);
  assert.match(gate.summary, /resource-tasks-max/);
  assert.equal(gate.resource_reason, 'resource-tasks-max');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.detail.resource_reason === 'resource-tasks-max'));
  assert.match(h.ok(['inbox']), /resource-tasks-max/);
});
