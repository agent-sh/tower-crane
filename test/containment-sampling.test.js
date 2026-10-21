'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const C = require('../lib/containment');
const { cachedFixture } = require('./helpers');
const probe = require('../scripts/probe-keeper-cpu');

test('keeper CPU probe rejects shared, ancestor, sibling and occupied targets', (t) => {
  const caller = '/sys/fs/cgroup/caller.scope';
  let current;
  let members;
  const writes = [];
  t.mock.method(fs, 'readFileSync', () => members);
  t.mock.method(fs, 'writeFileSync', (file, pid) => {
    writes.push([file, pid]);
    current = path.dirname(file);
  });
  for (const [group, occupied, valid] of [
    [undefined, false, false], [caller, false, false],
    [path.dirname(caller), false, false], ['/sys/fs/cgroup/sibling/keeper-cpu-abc123', false, false],
    [`${caller}/keeper-cpu-abc123`, true, false], [`${caller}/keeper-cpu-abc123`, false, true],
  ]) {
    current = caller;
    members = occupied ? '123\n' : '';
    writes.length = 0;
    const C = { currentGroup: () => current };
    if (valid) {
      probe.enterMeasurementGroup(group, C);
      assert.deepEqual(writes, [[`${group}/cgroup.procs`, String(process.pid)]]);
      assert.equal(current, group);
    } else {
      assert.throws(() => probe.enterMeasurementGroup(group, C));
      assert.deepEqual(writes, []);
    }
  }
});

test('keeper CPU probe removes its private group after success, error and timeout', (t) => {
  const group = '/sys/fs/cgroup/caller.scope/keeper-cpu-abc123';
  const removed = [];
  t.mock.method(C, 'currentGroup', () => path.dirname(group));
  t.mock.method(fs, 'mkdtempSync', prefix => {
    assert.equal(prefix, `${path.dirname(group)}/keeper-cpu-`);
    return group;
  });
  t.mock.method(fs, 'rmdirSync', dir => removed.push(dir));
  let result;
  t.mock.method(cp, 'spawnSync', (file, args, opts) => {
    assert.equal(file, process.execPath);
    assert.equal(args[2], group);
    assert.equal(opts.timeout, 10000);
    return result;
  });
  for (const row of [
    { status: 0, stdout: '{"proc_scans":0}' },
    { status: 1, stderr: 'sample failed' },
    { status: null, error: new Error('timeout'), signal: 'SIGTERM' },
  ]) {
    result = row;
    removed.length = 0;
    if (row.status === 0) assert.deepEqual(probe.measurementRun('after'), { proc_scans: 0 });
    else assert.throws(() => probe.measurementRun('after'));
    assert.deepEqual(removed, [group]);
  }
});

test('watchdog identity maps discard departed and reused pids', (t) => {
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file).startsWith('/proc/')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return read(file, ...args);
  });
  for (const rows of [[], [{ pid: 12, parent: 0, start: 'new', envNames: [] }]]) {
    const identities = new Map([[11, 'gone'], [12, 'old']]);
    assert.deepEqual(C.descendants(rows, null, identities), []);
    assert.equal(identities.size, 0);
  }
  const identities = new Map([[11, 'live'], [12, 'gone']]);
  const live = { pid: 11, parent: 0, start: 'live', envNames: [] };
  assert.deepEqual(C.descendants([live], null, identities), [live]);
  assert.deepEqual([...identities], [[11, 'live']]);
});

test('retained identities discard departed and reused pids without a history map', () => {
  for (const [rows, expected] of [
    [[], []],
    [[{ pid: 12, parent: 0, start: 'new' }], []],
    [[{ pid: 11, parent: 0, start: 'live' }], [{ pid: 11, parent: 0, start: 'live' }]],
  ]) {
    assert.deepEqual(C.managed(rows, [{ pid: 11, start: 'live' }, { pid: 12, start: 'old' }]), expected);
  }
});
test('Windows orphan discovery survives pruning the exited root', (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const known = new Map([[10, 1000]]);
  C.descendants([], 10, known, 1000);
  assert.equal(known.size, 0);
  const row = { pid: 11, parent: 10, start: 1050, group: null };
  assert.deepEqual(C.descendants([row], 10, known, 1000), [row]);
});

test('watchdog failure budget tolerates two failures and resets after success', () => {
  for (const [samples, expected] of [
    [[false], false], [[false, false], false], [[false, false, false], true],
    [[false, false, true, false, false], false], [[true, false, false, false], true],
  ]) {
    const budget = C.sampleFailures();
    let failed;
    for (const good of samples) failed = budget(good);
    assert.equal(failed, expected, JSON.stringify(samples));
  }
});

test('a failed Linux page-size query is retried without caching invalid RSS units', { skip: process.platform !== 'linux' }, async (t) => {
  let queries = 0;
  t.mock.method(cp, 'spawnSync', () => ({ status: ++queries === 1 ? 1 : 0, stdout: queries === 1 ? '' : '4096\n' }));
  const list = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (dir, ...args) => dir === '/proc' ? [] : list(dir, ...args));
  const sampler = C.processSampler();
  await assert.rejects(sampler.sample(), /cannot read host page size/);
  assert.deepEqual(await sampler.sample(), []);
  assert.equal(queries, 2);
  sampler.close();
});

test('cgroup keepers read only cgroup membership, including nested groups', (t) => {
  const group = '/fake-cgroup';
  const files = {
    [`${group}/cgroup.events`]: 'populated 1\n',
    [`${group}/cgroup.procs`]: '11\n',
    [`${group}/runner/cgroup.procs`]: '12\n',
    [`${group}/nested/cgroup.procs`]: '13\n',
    [`${group}/nested/runner/cgroup.procs`]: '14\n',
  };
  let denied = false;
  const read = fs.readFileSync;
  const list = fs.readdirSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (!String(file).startsWith(group) && !String(file).startsWith('/proc')) return read(file, ...args);
    assert.ok(String(file).startsWith(group), `unexpected read ${file}`);
    if (denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    if (!Object.hasOwn(files, file)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return files[file];
  });
  t.mock.method(fs, 'readdirSync', (dir, ...args) => {
    if (!String(dir).startsWith(group) && dir !== '/proc') return list(dir, ...args);
    assert.ok(String(dir).startsWith(group), `unexpected scan ${dir}`);
    return (dir === group ? ['runner', 'nested'] : dir === `${group}/nested` ? ['runner'] : [])
      .map(name => ({ name, isDirectory: () => true }));
  });
  assert.deepEqual(C.groupProcesses(group), { populated: true, rows: [11, 12, 13, 14].map(pid => ({ pid })) });
  files[`${group}/cgroup.events`] = 'populated 0\n';
  assert.deepEqual(C.groupProcesses(group), { populated: false, rows: [] });
  delete files[`${group}/cgroup.events`];
  assert.deepEqual(C.groupProcesses(group), { populated: false, rows: [] });
  denied = true;
  assert.throws(() => C.groupProcesses(group), { code: 'EACCES' });
});

test('Windows sampling reuses one process and closes it on shutdown', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const children = [];
  t.mock.method(cp, 'spawn', (file, args) => {
    assert.equal(file, 'powershell.exe');
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /ReadLine/);
    assert.match(script, /Get-CimInstance/);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  });
  const sampler = C.processSampler();
  t.after(() => sampler.close());
  for (let i = 0; i < 3; i++) {
    const sample = sampler.sample();
    children[0].stdout.write('11 10 1000');
    children[0].stdout.write(' 2048 Y21k\r\nTC_SNAPSHOT_');
    children[0].stdout.write('END\r\n');
    assert.deepEqual(await sample, [{ pid: 11, parent: 10, group: null, start: 1000, rss: 2048, command: 'cmd' }]);
  }
  assert.equal(children.length, 1);
  const bad = sampler.sample();
  children[0].stdout.write('TC_SNAPSHOT_ERROR\n');
  await assert.rejects(bad);
  const malformed = sampler.sample();
  children[0].stdout.write('not a process\nTC_SNAPSHOT_END\n');
  await assert.rejects(malformed, /invalid process snapshot/);
  const recovered = sampler.sample();
  children[0].stdout.write('TC_SNAPSHOT_END\n');
  assert.deepEqual(await recovered, []);
  assert.equal(children.length, 1);
  sampler.close();
  assert.equal(children[0].killed, true);
});

test('Windows sampling recovers from a dead or hung provider within its deadline', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const children = [];
  t.mock.method(cp, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sampler = C.processSampler();
  t.after(() => sampler.close());
  for (const end of ['error', 'exit', 'stdin', 'stdout', 'timeout']) {
    const sample = sampler.sample();
    const rejection = assert.rejects(sample);
    const child = children.at(-1);
    if (end === 'timeout') t.mock.timers.tick(60000);
    else if (end === 'stdin' || end === 'stdout') child[end].emit('error', new Error('stream failed'));
    else child.emit(end, new Error('provider failed'));
    await rejection;
    assert.equal(child.killed, true);
  }
  const sample = sampler.sample();
  children.at(-1).stdout.write('TC_SNAPSHOT_END\n');
  assert.deepEqual(await sample, []);
  assert.equal(children.length, 6);
});

test('process identity lookup closes its sampler on macOS and Windows', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', platform));
  let closed;
  t.mock.method(cp, 'execFile', (file, args, opts, done) => {
    process.nextTick(done, null, '11 10 11 1 Sun Oct 20 00:00:00 2026 node\n');
    return { kill() { closed = true; } };
  });
  t.mock.method(cp, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', () => process.nextTick(() => child.stdout.write('11 10 1000 2048\nTC_SNAPSHOT_END\n')));
    child.kill = () => { closed = true; };
    return child;
  });
  for (const host of ['darwin', 'win32']) {
    Object.defineProperty(process, 'platform', { ...platform, value: host });
    for (const pid of [11, 12]) {
      closed = false;
      assert.deepEqual(await C.processIdentity(pid),
        pid === 12 ? null : { pid: 11, start: host === 'win32' ? 1000 : 'Sun Oct 20 00:00:00 2026' });
      assert.equal(closed, true);
    }
  }
});

test('Windows supervision fixture covers every snapshot consumer', async (t) => {
  const root = require('./tmp-root').tempRoot();
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'windows-sampler-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audit = path.join(dir, 'taskkill.jsonl');
  const script = `
const assert = require('node:assert/strict');
const mode = process.argv[1];
process.argv[1] = 'spawn-monitor.js';
require(${JSON.stringify(path.join(__dirname, 'fixtures', 'windows-supervision.js'))});
const C = require(${JSON.stringify(require.resolve('../lib/containment'))});
const cp = require('node:child_process');
const children = [];
const spawn = cp.spawn;
cp.spawn = (...args) => {
  const child = spawn(...args);
  if (args[0] === 'powershell.exe') children.push(child);
  return child;
};
(async () => {
  if (mode === 'identity') {
    const identity = await C.processIdentity();
    assert.equal(identity.pid, process.pid);
    assert.ok(Number.isSafeInteger(identity.start));
  } else if (mode === 'keeper') {
    await C.guardRemaining({ rows: [], limits: { tasks_max: 64, memory_max_bytes: 512 * 1024 ** 2 } });
  } else if (mode === 'one-shot') {
    const output = await new Promise((resolve, reject) => cp.execFile('powershell.exe', [], {},
      (error, stdout) => error ? reject(error) : resolve(stdout)));
    assert.equal(Number(output.split(' ')[0]), process.pid);
  } else {
    const sampler = C.processSampler();
    try {
      if (mode === 'concurrent') {
        const first = sampler.sample();
        const second = sampler.sample();
        assert.equal(first, second);
        const [a, b] = await Promise.all([first, second]);
        assert.deepEqual(a, b);
      } else {
        const first = await sampler.sample();
        assert.equal(first[0].pid, process.pid);
        assert.deepEqual(await sampler.sample(), first);
        assert.deepEqual(await sampler.sample(), first);
      }
    } finally { sampler.close(); }
  }
  assert.equal(children.length, mode === 'one-shot' ? 0 : 1);
  for (const child of children) assert.equal(child.killed, true);
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
  for (const mode of ['identity', 'repeated', 'concurrent', 'keeper', 'one-shot']) {
    await t.test(mode, () => {
      const result = cp.spawnSync(process.execPath, ['-e', script, mode], {
        encoding: 'utf8', timeout: 10000, // wait-allow: reject an unframed fixture reply before the sampler's 60-second request deadline
        env: { ...process.env, TOWER_CRANE_TEST_TASKKILL: audit },
      });
      assert.equal(result.status, 0, `${mode}: ${result.stderr || result.error}`);
      assert.equal(fs.existsSync(audit), false, mode);
    });
  }
});

test('CLI watchdog survives a failed sample but stops after consecutive failures', { skip: process.platform === 'win32' }, (t) => {
  for (const mode of ['once', 'slow', 'always']) {
    const h = cachedFixture(t, 'sampling-cli', h => {
      h.init(['--tasks-max', '64', '--memory-max-bytes', String(512 * 1024 ** 2)]);
      h.ok(['task', 'add', '--title', 'Sampling failure', '--acceptance', 'bounded', '--tier', 'easy']);
      h.ok(['brief', 'set', 'T1', '-'], { input: 'Finite sampling fixture.\n' });
      h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command',
        JSON.stringify([process.execPath, '-e', 'setTimeout(() => {}, 3000)', '{prompt}']), // wait-allow: keep the finite agent alive across a two-second snapshot timeout
        '--clear', 'profile', '--clear', 'effort']);
    });
    const result = h.run(['spawn', '--task', 'T1', '--wait'], {
      env: {
        TOWER_CRANE_TEST_CONTAINMENT: '1', TC_SAMPLE_MODE: mode,
        NODE_OPTIONS: `${h.env.NODE_OPTIONS || ''} --require=${path.join(__dirname, 'fixtures', 'containment-samples.js')}`,
      },
    });
    if (mode !== 'always') {
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /resource-monitor-failed/);
    } else {
      assert.notEqual(result.code, 0, result.stdout + result.stderr);
      assert.match(h.ok(['status']), /resource-monitor-failed/);
    }
  }
});

test('cgroup keeper ticks use population without any host process scan', async (t) => {
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const group = '/fake-keeper-cgroup';
  const read = fs.readFileSync;
  const list = fs.readdirSync;
  let populated = true;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    assert.ok(!String(file).startsWith('/proc/'), `unexpected process read ${file}`);
    if (!String(file).startsWith(group)) return read(file, ...args);
    if (file === `${group}/cgroup.events`) { reads++; return `populated ${populated ? 1 : 0}\n`; }
    if (file === `${group}/cgroup.procs`) return '';
    return 'max 0\noom_kill 0\n';
  });
  t.mock.method(fs, 'readdirSync', (dir, ...args) => {
    assert.notEqual(dir, '/proc');
    return String(dir).startsWith(group) ? [] : list(dir, ...args);
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  await C.guardRemaining({ group, rows: [], baseline: { tasks: 0, memory: 0 },
    limits: { tasks_max: 64, memory_max_bytes: 512 * 1024 ** 2 } });
  const first = reads;
  t.mock.timers.tick(100);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(reads > first, 'populated cgroup remains guarded even with an empty membership read');
  populated = false;
  t.mock.timers.tick(100);
  await new Promise(resolve => setImmediate(resolve));
  const last = reads;
  t.mock.timers.tick(100);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, last, 'empty cgroup stops the keeper');
});

test('keeper sampling tolerates transient failures and stops on the third failure', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const exitCode = process.exitCode;
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  t.after(() => { Object.defineProperty(process, 'platform', platform); process.exitCode = exitCode; });
  const row = { pid: 999999, parent: 1, group: 999999, rss: 1024, start: 'Sun Oct 20 00:00:00 2026' };
  let samples;
  let kills;
  t.mock.method(cp, 'execFile', (file, args, opts, done) => {
    const good = samples.shift();
    process.nextTick(done, good === false ? new Error('sample failed') : null,
      good === true ? `${row.pid} 1 ${row.group} 1 ${row.start} node\n` : '');
    return { kill() {} };
  });
  t.mock.method(cp, 'spawnSync', () => ({ status: 0, stdout: `${row.pid} ${row.start}\n` }));
  t.mock.method(process, 'kill', pid => { kills.push(pid); });
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const [pattern, failed] of [
    [[false, true, null], false],
    [[true, false, false, true, null], false],
    [[true, false, false, false], true],
    [[false, false, false], true],
  ]) {
    samples = [...pattern];
    kills = [];
    process.exitCode = exitCode;
    await C.guardRemaining({ rows: [row], limits: { tasks_max: 64, memory_max_bytes: 512 * 1024 ** 2 } });
    for (let i = 1; i < pattern.length; i++) {
      t.mock.timers.tick(100);
      await new Promise(resolve => setImmediate(resolve));
      if (!failed) assert.equal(kills.length, 0, JSON.stringify(pattern));
    }
    assert.equal(kills.length > 0, failed, JSON.stringify(pattern));
    assert.equal(process.exitCode, failed ? 1 : exitCode, JSON.stringify(pattern));
  }
});
