'use strict';

const { fileWritten, waitUntil } = require('./signals');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { spawn } = cp;
const { makeRepo, HOOKS } = require('./helpers');
// Timeout tests use the real CLI with a one-second lock wait (lib/intervals.js).
const SHORT_WAIT = JSON.stringify({ lock_wait: 1000 });
const S = require('../lib/state');
const B = require('../lib/broker');

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

for (const kind of ['stale', 'empty']) {
  test(`continuous ${kind} lock reclaims respect the deadline and backoff`, (t) => {
    const h = makeRepo(t);
    h.init();
    const attempts = path.join(h.base, 'reclaim-attempts');
    const fixture = path.join(__dirname, 'fixtures', 'lock-reclaim-race.js');
    const result = h.run(['task', 'add', '--title', 'must remain unwritten', '--acceptance', 'bounded'], {
      env: {
        TOWER_CRANE_INTERVALS: SHORT_WAIT, NODE_OPTIONS: `--require=${JSON.stringify(fixture)}`,
        HOOK_STATE: h.state, LOCK_RECLAIM_KIND: kind, LOCK_RECLAIM_ATTEMPTS: attempts,
      },
    });
    assert.equal(result.code, 3, result.stderr);
    const count = fs.readFileSync(attempts, 'utf8').length;
    assert.ok(count >= 5 && count <= 50, `${count} attempts must back off within the one-second budget`);
    assert.equal(h.readState('tasks.json').tasks.length, 0);
  });
}

test('20 concurrent CLI writers survive a lock held beyond 10 seconds', { timeout: 300000 }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Concurrent startup', '--acceptance', 'all writes survive']);
  const lock = S.acquireLock(h.state);
  const signals = Array.from({ length: 20 }, (_, i) => path.join(h.base, `writer-${i}`));
  const writers = signals.map((signal, i) => h.runAsync(['task', 'note', 'T1', `writer ${i}`], {
    hooks: { HOOK_STOP_LOCK_READ: signal },
  }));
  try {
    await Promise.all(signals.map((signal) => waitForFile(signal)));
    // All writers have encountered the same live holder before its release.
    await new Promise((resolve) => setTimeout(resolve, 11000)); // wait-allow: hold lock contention beyond the former production lock timeout
  } finally {
    S.releaseLock(lock);
    for (const signal of signals) fs.writeFileSync(`${signal}.go`, '');
  }
  const results = await Promise.all(writers);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const notes = h.readState('tasks.json').tasks[0].notes;
  assert.equal(notes.length, 20);
  assert.equal(new Set(notes.map((note) => note.text)).size, 20);
  assert.equal(events(h).filter((event) => event.cmd === 'task note').length, 20);
  assert.deepEqual(fs.readdirSync(h.state).filter((name) => name.startsWith('lock')), []);
});

const waitForFile = (file) => fileWritten(file, { check: (text) => text.length > 0 });

// A write that is killed while it holds the lock, leaving the lock to a dead pid.
function killHolder(h) {
  const r = h.run(['task', 'add', '--title', 'never written', '--acceptance', 'x'], { hooks: { HOOK_DIE_LOCKED: '1' } });
  assert.notEqual(r.code, 0, 'the holder was killed');
  assert.ok(fs.existsSync(path.join(h.state, 'lock')), 'the dead holder left its lock');
}

for (const field of ['start_ticks', 'boot_id']) {
  test(`a reused PID with mismatched ${field} is reclaimed`, { skip: process.platform !== 'linux' }, (t) => {
    const h = makeRepo(t);
    h.init();
    const lock = S.acquireLock(h.state);
    try {
      const marker = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
      marker[field] = field === 'start_ticks' ? '0' : '00000000-0000-0000-0000-000000000000';
      if (field === 'boot_id') marker.pidns = 'pid:[0]';
      fs.writeFileSync(lock.file, JSON.stringify(marker));
      const result = h.run(['task', 'add', '--title', 'reclaimed PID', '--acceptance', 'write survives'], {
        env: { TOWER_CRANE_INTERVALS: SHORT_WAIT },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(h.readState('tasks.json').tasks.map((task) => task.title), ['reclaimed PID']);
      assert.deepEqual(fs.readdirSync(h.state).filter((name) => name.startsWith('lock')), []);
    } finally {
      S.releaseLock(lock);
    }
  });
}

test('an old marker without process identity cannot be kept alive by a reused PID', (t) => {
  const h = makeRepo(t);
  h.init();
  const lock = S.acquireLock(h.state);
  try {
    const marker = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
    delete marker.start_ticks;
    delete marker.boot_id;
    fs.writeFileSync(lock.file, JSON.stringify(marker));
    const old = new Date(Date.now() - 120000); // wait-allow: verify stale or dead locks are broken without waiting for the live-holder timeout
    fs.utimesSync(lock.file, old, old);
    const result = h.run(['task', 'add', '--title', 'legacy reclaim', '--acceptance', 'age fallback'], {
      env: { TOWER_CRANE_INTERVALS: SHORT_WAIT },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(h.readState('tasks.json').tasks.map((task) => task.title), ['legacy reclaim']);
  } finally {
    S.releaseLock(lock);
  }
});

test('a known live holder keeps an old marker until the waiter times out', { skip: process.platform !== 'linux' }, (t) => {
  const h = makeRepo(t);
  h.init();
  const lock = S.acquireLock(h.state);
  try {
    const marker = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
    assert.equal(marker.start_ticks, require('../lib/processes').identity(process.pid).start_ticks);
    assert.equal(marker.boot_id, fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
    const old = new Date(Date.now() - 120000); // wait-allow: verify stale or dead locks are broken without waiting for the live-holder timeout
    fs.utimesSync(lock.file, old, old);
    const result = h.run(['task', 'add', '--title', 'must wait', '--acceptance', 'holder protected'], {
      env: { TOWER_CRANE_INTERVALS: SHORT_WAIT },
    });
    assert.equal(result.code, 3, result.stderr);
    assert.ok(fs.existsSync(lock.file), 'a live holder is never reclaimed by age');
    assert.equal(h.readState('tasks.json').tasks.length, 0);
  } finally {
    S.releaseLock(lock);
  }
});

test('a fresh foreign-namespace marker ignores a local PID with a different start identity', { skip: process.platform !== 'linux' }, (t) => {
  const h = makeRepo(t);
  h.init();
  const lock = S.acquireLock(h.state);
  try {
    const marker = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
    marker.pidns = 'pid:[0]';
    marker.start_ticks = '0';
    fs.writeFileSync(lock.file, JSON.stringify(marker));
    const result = h.run(['task', 'add', '--title', 'must remain unwritten', '--acceptance', 'foreign holder protected'], {
      env: { TOWER_CRANE_INTERVALS: SHORT_WAIT },
    });
    assert.equal(result.code, 3, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(lock.file, 'utf8')), marker, 'the foreign marker stays intact');
    assert.equal(h.readState('tasks.json').tasks.length, 0);
  } finally {
    S.releaseLock(lock);
  }
});

test('a dead holder reclaimed at the deadline permits the waiting write', async (t) => {
  const h = makeRepo(t);
  h.init();
  killHolder(h);
  const signal = path.join(h.base, 'reclaimed');
  const writer = h.runAsync(['task', 'add', '--title', 'after reclaim', '--acceptance', 'write succeeds'], {
    env: { TOWER_CRANE_INTERVALS: SHORT_WAIT },
    hooks: { HOOK_STOP_LOCK_CHANGE: signal },
  });
  try {
    await waitForFile(signal);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // wait-allow: hold lock contention beyond the former production lock timeout
  } finally {
    fs.writeFileSync(`${signal}.go`, '');
  }
  const result = await writer;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks.map((task) => task.title), ['after reclaim']);
});

test('a prompt hook returns at once and broker writes survive contention beyond the old bridge timeout', { timeout: 300000 }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Starting agent', '--acceptance', 'prompt and note survive']);
  const agent = 'worker-T1-1';
  const home = path.join(h.state, 'homes', agent);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'hook.json'), JSON.stringify({ agent, task: 'T1', state: h.state, harness: 'claude', attempt: 0 }));
  h.ok(['msg', '--to', agent, '--task', 'T1', 'startup context']);
  const job = { state: h.state, task: 'T1', agent, role: 'worker', cwd: h.repo,
    harness: 'codex', broker: path.join(h.base, 'brokers', agent, B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const brokerSignal = path.join(h.base, 'broker-waits');
  const env = { NODE_OPTIONS: `--require=${JSON.stringify(HOOKS)}`, HOOK_STATE: h.state, HOOK_STOP_LOCK_READ: brokerSignal };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const prompt = () => cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'hook-bridge.js'), 'hook'], {
    cwd: h.repo, timeout: 300000, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
    env: { ...h.env, TOWER_CRANE_AGENT: agent, TOWER_CRANE_STATE: h.state },
  });
  const lock = S.acquireLock(h.state);
  const brokered = B.forward(job.broker, ['task', 'note', 'T1', 'broker waited'], h.state);
  let held;
  try {
    await waitForFile(brokerSignal);
    // The prompt leaves its message unread rather than wait for the writer.
    held = prompt();
    await new Promise((resolve) => setTimeout(resolve, 16000)); // wait-allow: hold contention beyond the former production lock timeout
  } finally {
    S.releaseLock(lock);
    fs.writeFileSync(`${brokerSignal}.go`, '');
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(held.status, 0, held.stderr);
  assert.equal(held.stdout, '');
  const note = await brokered;
  assert.equal(note.code, 0, note.stderr);
  const next = prompt();
  assert.equal(next.status, 0, next.stderr);
  const output = JSON.parse(next.stdout);
  assert.equal(output.decision, undefined);
  assert.match(output.hookSpecificOutput.additionalContext, /startup context/);
  assert.deepEqual(h.readState('tasks.json').tasks[0].notes.map((entry) => entry.text), ['broker waited']);
  assert.ok(events(h).some((event) => event.cmd === 'hook inbox' && event.agent === agent));
  assert.ok(events(h).some((event) => event.cmd === 'task note' && event.via === 'broker'));
});

test('a held lock makes a write wait its bound, then exit 3 without writing', async (t) => {
  const h = makeRepo(t);
  h.init();
  const pausedFile = path.join(h.base, 'paused');
  const go = `${pausedFile}.go`;
  const holder = h.runAsync(['task', 'add', '--title', 'holder', '--acceptance', 'a'], {
    hooks: { HOOK_PAUSE_LOCKED: pausedFile },
  });
  await waitForFile(pausedFile);
  const holderPid = fs.readFileSync(pausedFile, 'utf8');
  try {
    const started = Date.now();
    const r = h.run(['task', 'add', '--title', 'waiter', '--acceptance', 'a'], {
      env: { TOWER_CRANE_INTERVALS: SHORT_WAIT },
    });
    const waited = Date.now() - started; // wait-allow: verify stale or dead locks are broken without waiting for the live-holder timeout
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, new RegExp(`locked by pid ${holderPid} `));
    assert.ok(waited >= 950 && waited < 5000, `waited ${waited} ms`); // wait-allow: verify the configured one-second lock timeout
    assert.equal(h.readState('tasks.json').tasks.length, 0);
    assert.deepEqual(h.json(['task', 'list']), [], 'reads do not need the lock');
  } finally {
    fs.writeFileSync(go, '');
  }
  const done = await holder;
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks.map((x) => x.title), ['holder'], 'the holder kept its lock and wrote');
  assert.ok(!fs.existsSync(path.join(h.state, 'lock')), 'the lock is released after the write');
});

test('a write reads under the lock only the events appended since its own read, and renders outside it', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'first', '--acceptance', 'a']);
  const log = path.join(h.state, 'events.jsonl');
  const line = JSON.stringify({ at: new Date().toISOString(), agent: 'owner', cmd: 'task note', task: 'T1', detail: { text: 'x'.repeat(1024) } }) + '\n';
  fs.appendFileSync(log, line.repeat(2048));
  const size = fs.statSync(log).size;
  const meter = path.join(h.base, 'locked-reads.json');
  h.ok(['task', 'note', 'T1', 'one more note'], {
    env: { LOCKED_READS: meter, NODE_OPTIONS: `--require=${JSON.stringify(path.join(__dirname, 'fixtures', 'locked-reads.js'))}` },
  });
  const reads = JSON.parse(fs.readFileSync(meter, 'utf8'));
  assert.ok(reads.holdings >= 1, 'the write took the lock');
  assert.ok(reads.lockedBytes < 4096, `read ${reads.lockedBytes} of ${size} log bytes under the lock`);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.md'), 'utf8'), /first/);
});

test('without a start-ticks identity, a waiter keeps a live holder\'s lock and writes as soon as it is released', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'first', '--acceptance', 'a']);
  const paused = path.join(h.base, 'holder');
  // As on Windows and macOS: the holder's marker has no start ticks.
  const holder = h.runAsync(['task', 'note', 'T1', 'holder'], { hooks: { HOOK_PAUSE_LOCKED: paused, HOOK_NO_START_TICKS: '1' } });
  await waitForFile(paused);
  const waiter = h.runAsync(['task', 'note', 'T1', 'waiter']);
  await new Promise((resolve) => setTimeout(resolve, 500)); // wait-allow: give the waiter time to try the live lock before checking it held
  assert.ok(fs.existsSync(path.join(h.state, 'lock')), 'the waiter did not break the live lock');
  const released = Date.now();
  fs.writeFileSync(`${paused}.go`, '');
  const [a, b] = await Promise.all([holder, waiter]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.ok(Date.now() - released < 20000, 'the waiter wrote after the release, within its bound'); // wait-allow: verify the production lock-retry bound
  assert.deepEqual(h.readState('tasks.json').tasks[0].notes.map((n) => n.text), ['holder', 'waiter']);
});

test('a stale lock is broken: its holder is gone, or it is older than 60 s', (t) => {
  const h = makeRepo(t);
  h.init();
  const lock = path.join(h.state, 'lock');
  killHolder(h);
  let started = Date.now();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  assert.ok(Date.now() - started < 5000, 'a dead holder is not waited for'); // wait-allow: verify stale or dead locks are broken without waiting for the live-holder timeout
  assert.ok(!fs.existsSync(lock));

  // A holder on another host cannot be checked, so only age makes it stale.
  fs.mkdirSync(lock);
  const marker = path.join(lock, '00112233aabbccdd');
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, host: 'some-other-host', at: new Date().toISOString(), nonce: '00112233aabbccdd' }));
  const old = new Date(Date.now() - 120000); // wait-allow: verify stale or dead locks are broken without waiting for the live-holder timeout
  fs.utimesSync(marker, old, old);
  started = Date.now();
  h.ok(['task', 'add', '--title', 'B', '--acceptance', 'b']);
  assert.ok(Date.now() - started < 5000, 'an old lock is not waited for'); // wait-allow: verify stale or dead locks are broken without waiting for the live-holder timeout
  assert.deepEqual(h.readState('tasks.json').tasks.map((x) => x.title), ['A', 'B']);
  assert.ok(!fs.existsSync(lock), 'the lock is released after the write');
  assert.deepEqual(fs.readdirSync(h.state).filter((f) => f.startsWith('lock')), [], 'no prepared lock is left behind');
});

test('a writer that saw a dead lock before another broke it cannot share the lock with the new holder', async (t) => {
  const h = makeRepo(t);
  h.init();
  killHolder(h);
  const lock = path.join(h.state, 'lock');
  // Windows can reuse the dead holder's PID while X waits with its snapshot.
  // Age only the original marker, so a live replacement with that PID is safe.
  const old = new Date(Date.now() - 120000); // wait-allow: verify stale or dead locks are broken without waiting for the live-holder timeout
  fs.utimesSync(path.join(lock, fs.readdirSync(lock)[0]), old, old);
  const signal = (name) => path.join(h.base, name);
  const go = (name) => fs.writeFileSync(`${signal(name)}.go`, '');
  // X reads who holds the dead lock, and stops before acting on it.
  const x = h.runAsync(['task', 'add', '--title', 'X', '--acceptance', 'a'], {
    hooks: { HOOK_STOP_LOCK_READ: signal('x-read'), HOOK_STOP_LOCK_CHANGE: signal('x-change') },
  });
  await waitForFile(signal('x-read'));
  // Y breaks the dead lock, takes it, and stops as soon as it holds it.
  const y = h.runAsync(['task', 'add', '--title', 'Y', '--acceptance', 'a'], { hooks: { HOOK_PAUSE_LOCKED: signal('y-holds') } });
  let z;
  try {
    await waitForFile(signal('y-holds'));
    // X acts on the dead holder it saw, and stops again right after.
    go('x-read');
    await waitForFile(signal('x-change'));
    // Z must observe Y's lock before either paused writer is released.
    z = h.runAsync(['task', 'add', '--title', 'Z', '--acceptance', 'a'], {
      hooks: { HOOK_STOP_LOCK_READ: signal('z-read') },
    });
    await waitForFile(signal('z-read'));
    const holder = JSON.parse(fs.readFileSync(path.join(lock, fs.readdirSync(lock)[0]), 'utf8'));
    assert.equal(holder.pid, Number(fs.readFileSync(signal('y-holds'), 'utf8')), 'Y still holds the lock Z observed');
    assert.equal(h.readState('tasks.json').tasks.length, 0, 'Z cannot write while Y holds the lock');
  } finally {
    for (const name of ['x-read', 'x-change', 'y-holds', 'z-read']) go(name);
  }
  const results = await Promise.all([x, y, ...(z ? [z] : [])]);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const ids = results.map((r) => r.stdout.trim());
  assert.equal(new Set(ids).size, 3, `X, Y and Z each got their own id: ${ids.join(' ')}`);
  assert.deepEqual(h.readState('tasks.json').tasks.map((task) => task.title).sort(), ['X', 'Y', 'Z'], 'no write was lost');
  assert.ok(!fs.existsSync(path.join(h.state, 'lock')), 'the lock is released');
});

// A sandboxed worker's note holds the lock in a pid namespace of its own, so to
// the orchestrator's task add its pid looks gone. Breaking the lock let the add
// write, then the note saved the tasks.json it had read before the add: the add
// stayed in events.jsonl, vanished from tasks.json, and the next add reused its id.
test('a holder in another pid namespace keeps its lock, so no write is lost and no id is reused', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'worker task', '--acceptance', 'a']);
  const paused = path.join(h.base, 'note-holds');
  const note = h.runAsync(['task', 'note', 'T1', 'worker progress'], {
    hooks: { HOOK_PAUSE_LOCKED: paused, HOOK_PIDNS: 'pid:[4026500001]' },
  });
  let add;
  try {
    await waitForFile(paused);
    const holderPid = fs.readFileSync(paused, 'utf8');
    add = h.runAsync(['task', 'add', '--title', 'orchestrator task', '--acceptance', 'a'], { hooks: { HOOK_DEAD_PID: holderPid } });
    // Give the add time to break the lock if it would.
    await Promise.race([add, new Promise((r) => setTimeout(r, 1500))]); // wait-allow: hold lock contention beyond the former production lock timeout
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
  }
  const [noted, added] = await Promise.all([note, add]);
  assert.equal(noted.code, 0, noted.stderr);
  assert.equal(added.code, 0, added.stderr);
  assert.equal(added.stdout.trim(), 'T2');
  const tasks = h.readState('tasks.json').tasks;
  assert.deepEqual(tasks.map((x) => x.title), ['worker task', 'orchestrator task'], 'the add survived the note');
  assert.deepEqual(tasks[0].notes.map((n) => n.text), ['worker progress'], 'the note survived the add');
  assert.equal(h.ok(['task', 'add', '--title', 'next', '--acceptance', 'a']), 'T3');
  assert.equal(h.run(['validate']).code, 0);
});

test('ids continue past the event log, and validate reports tasks.json drift from it', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const title of ['one', 'two', 'three']) h.ok(['task', 'add', '--title', title, '--acceptance', 'a']);
  h.ok(['task', 'note', 'T1', 'kept in the log']);
  // tasks.json as a writer outside the lock would leave it: T2, T3 and the note lost, next rolled back.
  const doc = h.readState('tasks.json');
  doc.tasks = doc.tasks.filter((x) => x.id === 'T1');
  doc.tasks[0].notes = [];
  doc.next = 2;
  h.writeState('tasks.json', doc);
  const r = h.run(['validate', '--json']);
  assert.equal(r.code, 1, r.stderr);
  const drift = JSON.parse(r.stdout).issues.filter((i) => i.kind === 'log-drift');
  assert.deepEqual(drift.map((i) => i.task), ['T1', 'T2', 'T3', null]);
  assert.match(drift[1].message, /T2 "two" is in events\.jsonl \(task add by owner at .*\) but missing from tasks\.json/);
  assert.match(drift[3].message, /next is 2, but events\.jsonl already used T3/);
  assert.equal(h.ok(['task', 'add', '--title', 'four', '--acceptance', 'a']), 'T4', 'a logged id is never reused');
});

// validate reads without the lock; a commit landing between its reads of
// tasks.json and events.jsonl must not look like a lost write.
test('a commit while validate reads the state is not reported as drift', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'one', '--acceptance', 'a']);
  const paused = path.join(h.base, 'validate-read');
  const check = h.runAsync(['validate', '--json'], { hooks: { HOOK_PAUSE_ON: 'tasks.json', HOOK_PAUSED: paused } });
  try {
    await waitForFile(paused);
    assert.equal(h.ok(['task', 'add', '--title', 'two', '--acceptance', 'a']), 'T2');
    h.ok(['task', 'note', 'T1', 'written mid-read']);
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
  }
  const r = await check;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).issues, []);
});

test('many writers breaking one dead lock at once all write, once each', async (t) => {
  const h = makeRepo(t);
  h.init();
  const writers = 6;
  const added = [];
  for (let round = 1; round <= 2; round++) {
    killHolder(h);
    // Each writer first finds the dead lock taken and waits for the others,
    // so all of them break it together; jitter shuffles their steps.
    const barrier = path.join(h.base, `barrier-${round}`);
    fs.mkdirSync(barrier);
    const titles = Array.from({ length: writers }, (_, i) => `round ${round} writer ${i + 1}`);
    const hooks = { HOOK_BARRIER: barrier, HOOK_BARRIER_N: String(writers), HOOK_JITTER_MS: '6' };
    const results = await Promise.all(titles.map((title) => h.runAsync(['task', 'add', '--title', title, '--acceptance', 'a'], { hooks })));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const ids = results.map((r) => r.stdout.trim());
    assert.equal(new Set(ids).size, writers, `round ${round}: every write got its own id: ${ids.join(' ')}`);
    added.push(...titles);
    assert.deepEqual(h.readState('tasks.json').tasks.map((task) => task.title).sort(), [...added].sort(), `round ${round}: no write was lost`);
    assert.equal(events(h).filter((e) => e.cmd === 'task add').length, added.length);
    assert.ok(!fs.existsSync(path.join(h.state, 'lock')), `round ${round}: the lock is released`);
  }
  assert.deepEqual(fs.readdirSync(h.state).filter((f) => f.startsWith('lock')), [], 'no prepared lock is left behind');
});

for (const aged of [false, true]) {
  test(`concurrent processes acquire and release for seconds${aged ? ' while live staging looks old' : ''}`, async (t) => {
    const h = makeRepo(t);
    h.init();
    h.ok(['task', 'add', '--title', 'Concurrent notes', '--acceptance', 'no lost writes']);
    const barrier = path.join(h.base, 'stress-barrier');
    fs.mkdirSync(barrier);
    const children = Array.from({ length: 6 }, () => {
      const child = spawn(process.execPath, ['--require', HOOKS, path.join(__dirname, 'fixtures', 'lock-stress.js')], {
        cwd: h.repo,
        env: {
          ...h.env, HOOK_STATE: h.state, HOOK_JITTER_MS: '2',
          TOWER_CRANE_AGENT: 'worker-lock-stress', TOWER_CRANE_OWNER_KEY: '',
          LOCK_STRESS_BARRIER: barrier, LOCK_STRESS_AGE_STAGING: aged ? '1' : '',
        },
        timeout: 300000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      const done = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
      });
      return { child, done };
    });
    let results;
    try {
      await Promise.all(children.map(({ child }) => fileWritten(path.join(barrier, String(child.pid)))));
      fs.writeFileSync(path.join(barrier, 'go'), '');
      results = await Promise.all(children.map(({ done }) => done));
    } finally {
      for (const { child } of children) child.kill();
      await Promise.allSettled(children.map(({ done }) => done));
    }
    let writes = 0;
    for (const result of results) {
      assert.equal(result.code, 0, `signal ${result.signal}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /ENOENT/);
      const count = JSON.parse(result.stdout.trim().split('\n').at(-1)).writes;
      assert.ok(count > 0, 'every process acquired and released the lock');
      writes += count;
    }
    const notes = h.readState('tasks.json').tasks[0].notes;
    assert.equal(notes.length, writes, 'every successful CLI write survived');
    assert.ok(notes.every((note) => note.agent === 'worker-lock-stress'), 'task notes need no owner authority');
    assert.equal(new Set(notes.map((note) => note.text)).size, writes, 'no note was written twice');
    assert.equal(h.run(['validate']).code, 0);
    assert.deepEqual(fs.readdirSync(h.state).filter((name) => name.startsWith('lock')), [], 'no lock or staging directory was left');
  });
}

for (const point of ['mkdir', 'write', 'rename']) {
  test(`a cleanup race during staging ${point} retries with a private directory`, (t) => {
    const h = makeRepo(t);
    h.init();
    h.ok(['task', 'add', '--title', 'Retry cleanup', '--acceptance', 'note survives']);
    const attempts = path.join(h.base, 'attempts');
    const hook = path.join(__dirname, 'fixtures', 'lock-cleanup-race.js');
    h.ok(['task', 'note', 'T1', 'after cleanup'], { env: {
      NODE_OPTIONS: `--require=${JSON.stringify(hook)}`,
      LOCK_RACE_POINT: point, LOCK_RACE_ATTEMPTS: attempts,
    } });
    assert.equal(fs.readFileSync(attempts, 'utf8').trim().split('\n').length, 1, 'the cleanup race was exercised');
    assert.deepEqual(h.readState('tasks.json').tasks[0].notes.map((note) => note.text), ['after cleanup']);
    assert.deepEqual(fs.readdirSync(h.state).filter((name) => name.startsWith('lock')), []);
  });
}

test('continuous staging cleanup times out with exit 3 and bounded backoff', (t) => {
  const h = makeRepo(t);
  h.init();
  const attempts = path.join(h.base, 'attempts');
  const hook = path.join(__dirname, 'fixtures', 'lock-cleanup-race.js');
  const started = Date.now();
  const result = h.run(['task', 'add', '--title', 'Never staged', '--acceptance', 'bounded'], {
    env: {
      TOWER_CRANE_INTERVALS: SHORT_WAIT, NODE_OPTIONS: `--require=${JSON.stringify(hook)}`,
      LOCK_RACE_POINT: 'write', LOCK_RACE_ATTEMPTS: attempts, LOCK_RACE_ALWAYS: '1',
    },
  });
  const waited = Date.now() - started; // wait-allow: verify stale or dead locks are broken without waiting for the live-holder timeout
  assert.equal(result.code, 3, result.stderr);
  assert.ok(waited >= 950 && waited < 5000, `waited ${waited} ms`); // wait-allow: verify the configured one-second lock timeout
  assert.doesNotMatch(result.stderr, /ENOENT/);
  const names = fs.readFileSync(attempts, 'utf8').trim().split('\n');
  assert.ok(names.length >= 5 && names.length <= 400, `${names.length} attempts: cleanup retries back off`);
  assert.equal(new Set(names).size, names.length, 'each retry used a fresh directory');
  for (const name of names) assert.match(name, /^lock\.\d+\.[0-9a-f]{16}\.new$/);
  assert.equal(h.readState('tasks.json').tasks.length, 0);
  assert.deepEqual(fs.readdirSync(h.state).filter((name) => name.startsWith('lock')), []);
});

test('a stale lock that cannot be removed still times out with exit 3', (t) => {
  const h = makeRepo(t);
  h.init();
  killHolder(h);
  // Windows can reuse the killed holder's PID during the removal wait.
  const lock = path.join(h.state, 'lock');
  const marker = JSON.parse(fs.readFileSync(path.join(lock, fs.readdirSync(lock)[0]), 'utf8'));
  const attempts = path.join(h.base, 'attempts');
  fs.writeFileSync(attempts, '');
  const started = Date.now();
  const r = h.run(['task', 'add', '--title', 'A', '--acceptance', 'a'], {
    env: { TOWER_CRANE_INTERVALS: SHORT_WAIT },
    hooks: { HOOK_FAIL_LOCK: attempts, HOOK_DEAD_PID: String(marker.pid) },
  });
  const waited = Date.now() - started; // wait-allow: verify stale or dead locks are broken without waiting for the live-holder timeout
  assert.equal(r.code, 3, `exit ${r.code} (signal ${r.signal}) after ${waited} ms: ${r.stderr}`);
  assert.ok(waited >= 950 && waited < 5000, `waited ${waited} ms`); // wait-allow: verify the configured one-second lock timeout
  assert.match(r.stderr, /locked by pid \d+ .*which is gone, but its lock could not be removed \(EPERM\); remove .*lock by hand/);
  const tries = fs.readFileSync(attempts, 'utf8').length;
  assert.ok(tries >= 5 && tries <= 400, `${tries} removal attempts: it backs off between them`);
  assert.equal(h.readState('tasks.json').tasks.length, 0);
});

// Windows refuses to delete a file a scanner holds open. A holder whose own
// marker outlives its release must not keep the lock for as long as it runs,
// as a live holder on this host otherwise does.
test('a marked lock whose marker its holder could not delete is freed by that holder\'s next look', (t) => {
  const h = makeRepo(t);
  const dir = path.join(h.base, 'locks', 'lock');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const lock = S.tryMarkedLock(dir, { keepLive: true });
  assert.ok(lock);
  const unlink = fs.unlinkSync;
  let busy = true;
  fs.unlinkSync = (file) => {
    if (busy && file === lock.file) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${file}'`), { code: 'EPERM' });
    return unlink(file);
  };
  t.after(() => { fs.unlinkSync = unlink; });
  S.releaseMarkedLock(lock);
  assert.ok(fs.existsSync(lock.file), 'the deletion failed');
  // Still undeletable: reported as a gone holder's marker, not a live holder.
  const seen = S.clearStaleLock(dir, true);
  assert.equal(seen.holder, null);
  assert.equal(seen.stuck.code, 'EPERM');
  busy = false;
  const again = S.tryMarkedLock(dir, { keepLive: true }) || S.tryMarkedLock(dir, { keepLive: true });
  assert.ok(again, 'the released marker is deleted and the lock taken');
  S.releaseMarkedLock(again);
  assert.equal(fs.existsSync(dir), false);
});

// Windows records no start ticks and gives a killed holder's pid to a new
// process within seconds; the creation time in the marker tells them apart.
// This plays Windows: the platform reads win32, a table stands in for the
// PowerShell read, and a live child's pid is the holder's.
function windowsLock(t) {
  const P = require('../lib/processes');
  const h = makeRepo(t);
  const dir = path.join(h.base, 'locks', 'lock');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // Alive until its stdin closes or it is killed.
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const windowsCreated = P.windowsCreated;
  const times = new Map([[process.pid, 5]]);
  const w = { dir, pid: child.pid, times, reads: 0 };
  const forget = () => { S.processCreated?.cache.clear(); S.processCreated?.gone?.clear(); };
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  P.windowsCreated = (pids) => {
    w.reads++;
    return new Map(pids.filter((pid) => Number.isFinite(times.get(pid))).map((pid) => [pid, times.get(pid)]));
  };
  forget();
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    P.windowsCreated = windowsCreated;
    forget();
    child.kill();
  });
  w.take = () => S.tryMarkedLock(dir, { keepLive: true }) || S.tryMarkedLock(dir, { keepLive: true });
  // The marker now names the child as a holder created at `created`.
  w.hold = (lock, created) => {
    const m = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
    fs.writeFileSync(lock.file, JSON.stringify({ ...m, pid: child.pid, created }));
  };
  // A waiter's look; `fresh` is a waiter that has read no times yet.
  w.look = (fresh = false) => {
    if (fresh) forget();
    return S.clearStaleLock(dir, true).holder?.pid ?? null;
  };
  return w;
}

test('a marked lock whose holder\'s pid now belongs to a process created at another time is freed', (t) => {
  const w = windowsLock(t);
  const lock = w.take();
  assert.ok(lock);
  assert.equal(JSON.parse(fs.readFileSync(lock.file, 'utf8')).created, 5, 'the marker records the holder\'s creation time');
  w.hold(lock, 1000);
  w.times.set(w.pid, 1000);
  // Same time: the holder itself, kept; a waiter's further looks read it once.
  assert.equal(w.look(true), w.pid);
  const reads = w.reads;
  assert.equal(w.look(), w.pid);
  assert.equal(w.look(), w.pid);
  assert.equal(w.reads, reads, 'a waiter reads a kept holder\'s time once');
  // Unreadable: kept, as a live holder was before markers carried the time.
  w.times.delete(w.pid);
  assert.equal(w.look(true), w.pid);
  // Another time: the pid went to a new process, and the lock is free.
  w.times.set(w.pid, 2000);
  assert.equal(w.look(true), null);
  assert.equal(fs.existsSync(w.dir), false, 'the gone holder\'s lock is removed');
  const again = w.take();
  assert.ok(again, 'the next taker gets it');
  S.releaseMarkedLock(again);
});

// A waiter read the holder's time; the holder died, and the process Windows
// gave its pid to took the same lock and wrote its own time. The waiter's
// earlier read is of the dead holder and must not free the new one's lock.
test('a waiter\'s earlier read of a dead holder\'s time does not free the lock of the process that took its pid', (t) => {
  const w = windowsLock(t);
  const lock = w.take();
  assert.ok(lock);
  w.hold(lock, 1000);
  w.times.set(w.pid, 1000);
  assert.equal(w.look(true), w.pid, 'the first holder is kept');
  w.times.set(w.pid, 2000);
  w.hold(lock, 2000);
  assert.equal(w.look(), w.pid, 'the new holder is kept');
  assert.ok(fs.existsSync(lock.file), 'its marker is still there');
  w.hold(lock, 1000);
  assert.equal(w.look(), null, 'a marker of the dead holder is freed');
});

// Hooks run inside every synchronous wait, so one must not fail or recurse
// into the wait it runs in.
test('a failing or sleeping sleep hook does not break the wait it runs in', () => {
  const U = require('../lib/util');
  let calls = 0;
  const failing = () => { throw new Error('hook failed'); };
  const sleeping = () => { calls++; U.sleepSync(1); };
  U.sleepHooks.add(failing);
  U.sleepHooks.add(sleeping);
  try {
    U.sleepSync(1);
  } finally {
    U.sleepHooks.delete(failing);
    U.sleepHooks.delete(sleeping);
  }
  assert.equal(calls, 1, 'a sleep inside a hook runs no hooks');
});

// The production refresh on the real clock; the dispatch test in
// test/automation-dispatch.test.js drives the same refresh at one second.
test('a marked lock kept fresh touches its marker once the production refresh interval has passed', async (t) => {
  const Intervals = require('../lib/intervals');
  assert.equal(Intervals.ms('lock_refresh'), Intervals.DEFAULTS.lock_refresh, 'this process runs the production interval');
  const h = makeRepo(t);
  const lock = S.tryMarkedLock(path.join(h.base, 'fresh-lock'), { keepLive: true });
  assert.ok(lock);
  t.after(() => S.releaseMarkedLock(lock));
  const old = new Date(Date.now() - 300000); // wait-allow: an old marker shows the touch apart from the taking
  fs.utimesSync(lock.file, old, old);
  const kept = Date.now();
  S.keepMarkedLockFresh(lock);
  const touchedAt = () => fs.statSync(lock.file).mtimeMs;
  await waitUntil(() => touchedAt() > kept - 1000, { what: 'the held lock touches its marker' }); // wait-allow: the refresh is newer than the marker's old time
  // File times may round down to the second on some file systems.
  assert.ok(touchedAt() >= kept + Intervals.DEFAULTS.lock_refresh - 1000, `touched ${touchedAt() - kept} ms after it was kept fresh`); // wait-allow: the touch waits the production interval
});
