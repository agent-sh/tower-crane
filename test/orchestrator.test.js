'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeProjectRepo, BIN } = require('./helpers');

test('one orchestrator session holds writes while reads, release, expiry and owner takeover work', (t) => {
  const h = makeProjectRepo(t);
  const first = { env: { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'first' } };
  const second = { env: { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'second' } };
  h.ok(['task', 'add', '--title', 'held task', '--acceptance', 'holds the lease'], first);
  const lease = () => h.readState('tasks.json').orchestrator_lease;
  const held = lease();
  assert.ok(held?.session_id, 'first write must record the session lease');
  assert.ok(held.pid > 0);
  assert.ok(held.host);
  assert.ok(Date.parse(held.heartbeat));
  const before = h.readState('tasks.json');
  const denied = h.run(['task', 'add', '--title', 'duplicate', '--acceptance', 'must refuse'], second);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /orchestrator lease.*first.*pid.*owner.*orchestrator takeover/);
  assert.deepEqual(h.readState('tasks.json'), before);
  h.ok(['task', 'show', 'T1'], second);
  h.ok(['inbox'], second);
  assert.deepEqual(lease(), held, 'another reader cannot renew the holder');
  h.ok(['status'], first);
  assert.ok(Date.parse(lease().heartbeat) > Date.parse(held.heartbeat));
  const releaseDenied = h.run(['orchestrator', 'release'], second);
  assert.equal(releaseDenied.code, 1);
  assert.match(releaseDenied.stderr, /orchestrator lease/);
  const workerDenied = h.run(['orchestrator', 'takeover'], { env: { TOWER_CRANE_AGENT: 'worker' } });
  assert.equal(workerDenied.code, 1);
  assert.match(workerDenied.stderr, /only the owner/);
  const takeoverDenied = h.run(['orchestrator', 'takeover'], second);
  assert.equal(takeoverDenied.code, 1);
  assert.match(takeoverDenied.stderr, /only the owner/);
  h.ok(['orchestrator', 'release'], first);
  assert.equal(lease(), null);
  h.ok(['task', 'note', 'T1', 'second now holds it'], second);
  assert.notEqual(lease().session_id, held.session_id);
  h.ok(['orchestrator', 'takeover']);
  assert.equal(lease(), null);
  h.ok(['task', 'note', 'T1', 'first takes it back'], first);

  const idle = h.readState('project.json').limits.lease_minutes * 60000;
  h.ok(['task', 'note', 'T1', 'stale holder replaced'], { env: {
    ...second.env, TOWER_CRANE_TEST_NOW: String(Date.parse(lease().heartbeat) + idle + 1),
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(__dirname, 'fixtures', 'clock.js'))}`,
  } });
  assert.notEqual(lease().session_id, held.session_id);
  h.ok(['validate'], second);
});

test('two live copies of the same harness session cannot both drive the queue', async (t) => {
  const h = makeProjectRepo(t);
  const env = { ...h.env, TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'resumed-session' };
  const clients = [0, 1].map(() => cp.fork(path.join(__dirname, 'fixtures', 'orchestrator-session.js'),
    [BIN, h.repo], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => clients.forEach((client) => client.kill()));
  const run = (client, args) => new Promise((resolve, reject) => {
    client.once('error', reject);
    client.once('message', resolve);
    client.send(args);
  });
  const first = await run(clients[0], ['task', 'add', '--title', 'first copy', '--acceptance', 'one writer']);
  assert.equal(first.code, 0, first.stderr);
  const lease = h.readState('tasks.json').orchestrator_lease;
  const second = await run(clients[1], ['task', 'add', '--title', 'second copy', '--acceptance', 'refused']);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /orchestrator lease.*resumed-session/);
  assert.equal(h.readState('tasks.json').tasks.length, 1);
  assert.equal((await run(clients[1], ['status'])).code, 0, 'competing process can read');
  assert.equal((await run(clients[0], ['task', 'note', 'T1', 'same live process'])).code, 0);
  assert.equal(h.readState('tasks.json').orchestrator_lease.session_id, lease.session_id);
  assert.equal((await run(clients[0], ['orchestrator', 'release'])).code, 0);
  assert.equal((await run(clients[1], ['task', 'note', 'T1', 'released process replaced'])).code, 0);
});

test('engine lease bindings reject stale work without extending the idle window', () => {
  const O = require('../lib/orchestrator');
  const old = { session_id: 'old', heartbeat: new Date().toISOString() };
  const replacement = { ...old, session_id: 'new' };
  const expired = { ...old, heartbeat: '2000-01-01T00:00:00.000Z' };
  for (const [label, lease, bound, ok] of [
    ['vacant', null, null, true],
    ['idle', expired, null, true],
    ['holder', old, old, true],
    ['released', null, old, false],
    ['taken over', replacement, old, false],
    ['expired during work', expired, old, false],
    ['native writer arrived', old, null, false],
  ]) {
    const st = { events: [], project: { limits: { lease_minutes: 60 } }, tasks: { orchestrator_lease: lease } };
    const before = structuredClone(st);
    const ctx = { agent: 'orchestrator', agentExplicit: true, orchestratorSession: bound,
      env: { TOWER_CRANE_AGENT: 'orchestrator', TOWER_CRANE_VIA: 'automation' } };
    if (ok) assert.doesNotThrow(() => O.guard(ctx, st, true), label);
    else assert.throws(() => O.guard(ctx, st, true), /lease changed during automation/, label);
    assert.deepEqual(st, before, label);
  }
});

test('mutation lease checks preserve the command heartbeat and refuse a released binding', () => {
  const O = require('../lib/orchestrator');
  const session = { session_id: 'caller', heartbeat: '2000-01-01T00:00:00.000Z' };
  const ctx = { agent: 'orchestrator', agentExplicit: true, orchestratorSession: session,
    orchestratorLeaseSession: session.session_id, env: { TOWER_CRANE_AGENT: 'orchestrator' } };
  const st = { events: [], project: { limits: { lease_minutes: 60 } }, tasks: { orchestrator_lease: session } };
  const before = structuredClone(st);
  O.guard(ctx, st, true, false);
  assert.deepEqual(st, before, 'rechecking a mutation cannot wake its own filesystem watcher');
  st.tasks.orchestrator_lease = null;
  assert.throws(() => O.guard(ctx, st, true, false), /lease changed during command/);
  assert.equal(st.tasks.orchestrator_lease, null, 'an old waiter cannot undo release');
});

test('native lease heartbeats preserve archived evidence references', (t) => {
  const h = makeProjectRepo(t);
  h.ok(['task', 'add', '--title', 'Archived note', '--acceptance', 'preserve its payload', '--kind', 'docs']);
  h.ok(['evidence', 'T1', '--type', 'note', '--ok', '--sha', h.git(['rev-parse', 'HEAD']), '--summary', 'x'.repeat(2048)]);
  const entry = () => h.readState('tasks.json').tasks[0].evidence[0];
  const before = entry();
  assert.ok(before.evidence_refs?.summary, 'the fixture must contain an archived payload');
  h.ok(['task', 'note', 'T1', 'take the lease', '--agent', 'orchestrator']);
  h.ok(['status', '--agent', 'orchestrator']);
  assert.deepEqual(entry(), before);
  const payload = path.join(h.state, 'evidence', 'T1', before.evidence_refs.summary.sha256 + '.json');
  assert.equal(JSON.parse(fs.readFileSync(payload, 'utf8')), 'x'.repeat(2048));
});

test('Windows parent discovery stays stable when whole-machine command lines exceed the buffer', () => {
  const script = `
const C = require(${JSON.stringify(path.join(__dirname, '../lib/commands'))});
Object.defineProperty(process, 'platform', { value: 'win32' });
C.execFileSync = (command, args) => {
  if (command !== 'powershell.exe') throw new Error('unexpected command');
  if (process.env.PARENT_QUERY_CASE === 'large' && !args[2].includes('-Filter')) {
    throw Object.assign(new Error('process listing exceeds maxBuffer'), { code: 'ENOBUFS' });
  }
  return JSON.stringify([{ ProcessId: process.ppid, ParentProcessId: 444444, Name: 'node.exe',
    CreationDate: 'stable-start', CommandLine: 'node harness' },
    { ProcessId: 444444, ParentProcessId: 1, Name: 'ancestor.exe',
      CreationDate: process.env.PARENT_QUERY_CASE, CommandLine: 'ancestor display metadata' }]);
};
const O = require(${JSON.stringify(path.join(__dirname, '../lib/orchestrator'))});
console.log(JSON.stringify(O.identity({ env: { CLAUDE_SESSION_ID: 'same-session' }, agent: 'orchestrator' })));
`;
  const identities = ['large', 'small'].map((value) => {
    const result = cp.spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, PARENT_QUERY_CASE: value }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  assert.deepEqual(identities[0], identities[1], 'changing process-list size cannot change the session key');
});
