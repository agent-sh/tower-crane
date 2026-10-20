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

test('watchdog identity maps discard departed and reused pids', (t) => {
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file).startsWith('/proc/')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return read(file, ...args);
  });
  for (const select of [
    (rows, known) => C.descendants(rows, null, known),
    (rows, kept) => C.managed(rows, [], kept),
  ]) {
    for (const rows of [[], [{ pid: 12, parent: 0, start: 'new', envNames: [] }]]) {
      const identities = new Map([[11, 'gone'], [12, 'old']]);
      assert.deepEqual(select(rows, identities), []);
      assert.equal(identities.size, 0);
    }
    const identities = new Map([[11, 'live'], [12, 'gone']]);
    const live = { pid: 11, parent: 0, start: 'live', envNames: [] };
    assert.deepEqual(select([live], identities), [live]);
    assert.deepEqual([...identities], [[11, 'live']]);
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
      assert.notEqual(result.code, 0);
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
  t.mock.method(cp, 'spawnSync', () => ({ status: 0, stdout: row.start }));
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
