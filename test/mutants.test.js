'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');
const { readText } = require('../scripts/text');
const { runContained } = require('../scripts/mutants');
const { detachedAlive } = require('./helpers');
const { killPid, waitUntil } = require('./signals');
const { readPublished } = require('./atomic-file');

test('check:shared rejects missing and duplicate mutant targets without running tests', (t) => {
  const h = makeRepo(t);
  for (const name of ['bin', 'lib', 'scripts', 'docs', 'changelog.d', '.github']) {
    fs.cpSync(path.join(ROOT, name), path.join(h.repo, name), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(h.repo, 'CHANGELOG.md'));
  const { scripts } = require('../package.json');
  assert.equal(scripts['check:shared'], 'node scripts/check-shared-files.js --mutants');
  const script = (name, args) => cp.spawnSync(process.execPath,
    [path.join(h.repo, 'scripts', name), ...args],
    { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 300000 });
  const check = () => script('check-shared-files.js', ['--mutants']);
  const file = path.join(h.repo, 'lib/gates/tests.js');
  const source = readText(file);
  const anchor = 'if (without.ok) {';
  assert.equal(check().status, 0, 'a fixture without a test tree still validates every target');
  const targets = script('mutants.js', ['--check', '--root', h.repo]);
  assert.equal(targets.status, 0, targets.stderr);
  assert.match(targets.stdout, /^\d+ mutant targets match once\n$/);
  for (const [text, occurrences] of [
    [source.replace(anchor, 'if (false) {'), 0],
    [source + `\n// ${anchor}\n`, 2],
  ]) {
    fs.writeFileSync(file, text);
    const drift = check();
    assert.equal(drift.status, 1, drift.stderr);
    assert.match(drift.stderr, new RegExp(`tests-pass-without-change:.*once in lib/gates/tests\\.js.*found ${occurrences}`));
    const selected = script('mutants.js', ['--check', '--only', 'tests-pass-without-change']);
    assert.equal(selected.status, 1);
    assert.match(selected.stderr, new RegExp(`tests-pass-without-change:.*found ${occurrences}`));
  }
  fs.writeFileSync(file, source.replace(/\n/g, '\r\n'));
  const tasks = path.join(h.repo, 'lib/tasks.js');
  fs.writeFileSync(tasks, readText(tasks).replace(/\n/g, '\r\n'));
  assert.equal(check().status, 0, 'multiline anchors match Windows line endings');
  fs.rmSync(file);
  const missing = check();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /tests-pass-without-change:.*lib\/gates\/tests\.js/);
});

test('mutation runner catches an unbounded spawn at the process cap and removes detached children', async (t) => {
  const h = makeRepo(t);
  const write = (file, text) => {
    const target = path.join(h.repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const pids = path.join(h.base, 'spawned.jsonl');
  write('lib/gates/merge.js', `module.exports = (t, ctx) => {
    if (t.status !== 'accepted' || (!ctx.mergedIds?.includes(t.id))) return false;
    return true;
  };\n`);
  write('test/run.js', `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    if (require('../lib/gates/merge')({ id: 'T1', status: 'submitted' }, { mergedIds: ['T1'] })) {
      setInterval(() => {
        const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: process.platform !== 'win32', stdio: 'ignore',
        });
        child.on('error', () => {});
        if (child.pid) fs.appendFileSync(${JSON.stringify(pids)}, JSON.stringify({ pid: child.pid }) + '\\n');
      }, process.platform === 'win32' ? 500 : 50);
    }
  `);
  // The outer watchdog bounds the regression itself if the inner cap breaks.
  assert.equal(typeof runContained, 'function');
  t.after(() => {
    if (!fs.existsSync(pids)) return;
    for (const { pid } of fs.readFileSync(pids, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)) {
      killPid(pid, 'SIGKILL');
    }
  });
  const result = await runContained(process.execPath, [
    path.join(ROOT, 'scripts/mutants.js'), '--root', h.repo, '--jobs', '1',
    '--only', 'stack-merge-unaccepted-lower', '--no-full', '--process-limit', '32',
  ], { env: { ...h.env, TOWER_CRANE_TEST_TMP: h.base }, limit: 48, timeout: 60000 });
  assert.equal(result.reason, null, result.output);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /caught.*stack-merge-unaccepted-lower \(process cap \(32\)/);
  assert.match(result.output, /1\/1 mutants caught/);
  const children = fs.readFileSync(pids, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(children.length > 0, 'the planted bug spawned real processes');
  assert.ok(children.length < 48, `the runaway stayed below the outer cap: ${children.length}`);
  assert.ok(result.peak < 48, `the regression never hit its emergency cap: ${result.peak}`);
  t.diagnostic(`spawned ${children.length}; peak ${result.peak}; emergency limit 48`);
  await waitUntil(() => children.every(child => !detachedAlive(child)), { what: 'mutant descendants stopped' });
});

test('containment aborts a capped baseline and refuses invalid process limits', async (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib/gates'), { recursive: true });
  fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'lib/gates/merge.js'),
    "if (t.status !== 'accepted' || (!ctx.mergedIds?.includes(t.id))) return false;\n");
  fs.writeFileSync(path.join(h.repo, 'test/run.js'),
    "setInterval(() => { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.on('error', () => {}); }, process.platform === 'win32' ? 500 : 50);\n");
  const capped = await runContained(process.execPath, [
    path.join(ROOT, 'scripts/mutants.js'), '--root', h.repo,
    '--only', 'stack-merge-unaccepted-lower', '--no-full', '--process-limit', '16',
  ], { env: { ...h.env, TOWER_CRANE_TEST_TMP: h.base }, limit: 48, timeout: 60000 });
  assert.equal(capped.status, 1, capped.output);
  assert.match(capped.output, /the unmutated tests fail:[\s\S]*process cap \(16\)/);
  assert.doesNotMatch(capped.output, /caught.*stack-merge-unaccepted-lower/);
  for (const limit of [1, 513, NaN]) {
    await assert.rejects(runContained(process.execPath, ['-e', ''], { limit }), /process limit/);
  }
  await assert.rejects(runContained(path.join(h.base, 'missing-executable'), [], { limit: 48 }),
    { code: 'ENOENT' });
});

test('watchdog removes a Linux detached child even when its parent exits between inspections', { skip: process.platform !== 'linux' }, async (t) => {
  const h = makeRepo(t);
  const file = path.join(h.base, 'orphan-pid');
  t.after(() => { if (fs.existsSync(file)) killPid(Number(readPublished(file, 'utf8')), 'SIGKILL'); });
  const result = await runContained(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(file)}, String(child.pid));
    process.exit(0);
  `], { cwd: h.repo, limit: 48, timeout: 5000 });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.reason, null, result.output);
  const pid = Number(readPublished(file, 'utf8'));
  assert.equal(detachedAlive({ pid }), false, 'an orphan cannot outlive its mutation run');
});

test('an unavailable systemd manager is an infrastructure failure rather than a mutant kill', { skip: process.platform !== 'linux' }, async (t) => {
  const h = makeRepo(t);
  await assert.rejects(runContained(process.execPath, ['-e', ''], {
    cwd: h.repo, limit: 48, scope: true, timeout: 5000,
    env: { ...h.env, XDG_RUNTIME_DIR: path.join(h.base, 'no-runtime'),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(h.base, 'no-bus')}` },
  }), error => error.code === 'ENOENT' || /cannot launch mutant systemd scope/.test(error.message));
});

function scopedFixture(t, scopeRead) {
  const h = makeRepo(t);
  const spawn = cp.spawn;
  const read = fs.readFileSync;
  const list = fs.readdirSync;
  let child;
  let scopeArgs;
  let reads = 0;
  t.mock.method(cp, 'spawn', (command, args, options) => {
    assert.equal(command, 'systemd-run');
    scopeArgs = args;
    child = spawn(process.execPath, ['-e', "console.log('scoped fixture'); setTimeout(() => {}, 200)"], options); // wait-allow: keep a bounded scope fixture alive for watchdog inspections
    return child;
  });
  t.after(() => child?.kill());
  t.mock.method(cp, 'spawnSync', (command, args) => {
    assert.equal(command, 'systemctl');
    if (args.includes('show')) return { status: 0, stdout: '/fixture.scope\n' };
    return { status: 0, stdout: '' };
  });
  t.mock.method(fs, 'readdirSync', (file, ...args) => {
    assert.notEqual(file, '/proc', 'a systemd scope must never enumerate host processes');
    return list.call(fs, file, ...args);
  });
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const value = scopeRead?.(file, child);
    if (value !== undefined) return value;
    if (file === '/proc/self/cgroup') return '0::/user.slice/user-1000.slice/user@1000.service/agents.slice/worker.scope\n';
    if (file === '/sys/fs/cgroup/fixture.scope/cgroup.procs') { reads++; return `${child.pid}\n`; }
    if (file === '/sys/fs/cgroup/fixture.scope/pids.current') return '1\n';
    if (file === '/sys/fs/cgroup/fixture.scope/pids.events') return 'max 0\n';
    if (file === '/sys/fs/cgroup/fixture.scope/memory.events') return 'max 0\noom_kill 0\n';
    return read.call(fs, file, ...args);
  });
  return {
    run: () => runContained(process.execPath, ['-e', ''], { cwd: h.repo, scope: true, limit: 48, timeout: 5000 }),
    get args() { return scopeArgs; },
    get reads() { return reads; },
  };
}

test('scoped containment inherits the caller slice and inspects only its cgroup', { skip: process.platform !== 'linux' }, async (t) => {
  const fixture = scopedFixture(t);
  const result = await fixture.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.reason, null, result.output);
  assert.ok(fixture.args.includes('--slice=agents.slice'), fixture.args.join(' '));
  assert.ok(fixture.reads > 0, 'the watchdog reads scoped process membership');
});

test('scoped containment tolerates cgroup removal during final reads and rejects inspection errors', { skip: process.platform !== 'linux' }, async (t) => {
  for (const file of ['pids.current', 'cgroup.procs', 'pids.events', 'memory.events']) {
    for (const code of ['ENOENT', 'ENODEV', 'EACCES', 'EIO']) {
      await t.test(`${file}: ${code}`, async (t) => {
        let failed = false;
        const fixture = scopedFixture(t, (target, child) => {
          if (target === `/sys/fs/cgroup/fixture.scope/${file}` && child?.exitCode === 0) {
            failed = true;
            throw Object.assign(new Error('scope read failed'), { code });
          }
        });
        if (['ENOENT', 'ENODEV'].includes(code)) {
          const result = await fixture.run();
          assert.equal(result.status, 0, result.output);
          assert.equal(result.reason, null, 'cgroup removal cannot falsely score a mutant kill');
        } else {
          await assert.rejects(fixture.run(), { code });
        }
        assert.equal(failed, true, 'the final inspection hit the planted read error');
      });
    }
  }
});

test('scoped containment forgets exited PIDs after one failed stat read', { skip: process.platform !== 'linux' }, async (t) => {
  for (const code of ['ENOENT', 'ESRCH']) {
    await t.test(code, async (t) => {
      const pids = Array.from({ length: 20 }, (_, index) => 2147483647 - index);
      const first = new Set();
      const gone = new Map();
      let listed = false;
      const fixture = scopedFixture(t, (file, child) => {
        if (file === '/sys/fs/cgroup/fixture.scope/cgroup.procs' && !listed) {
          listed = true;
          return [child.pid, ...pids].join('\n') + '\n';
        }
        const pid = /^\/proc\/(\d+)\/stat$/.exec(String(file))?.[1];
        if (!pid || !pids.includes(Number(pid))) return;
        if (!first.has(pid)) {
          first.add(pid);
          // An already-exiting member is tracked but cannot be signalled by the fixture.
          const fields = Array(22).fill('0');
          fields[0] = 'Z';
          fields[19] = '10';
          return `${pid} (exited fixture) ${fields.join(' ')}`;
        }
        gone.set(pid, (gone.get(pid) || 0) + 1);
        throw Object.assign(new Error('process exited'), { code });
      });
      const result = await fixture.run();
      assert.equal(result.status, 0, result.output);
      assert.equal(result.reason, null, result.output);
      assert.equal(gone.size, pids.length, 'every observed PID was later found gone');
      assert.deepEqual([...gone.values()], pids.map(() => 1), 'exited PIDs cost only one failed read');
    });
  }
});

test('mutation timeouts use measured file baselines with a startup floor', () => {
  const { mutationTimeout } = require('../scripts/mutants');
  assert.equal(typeof mutationTimeout, 'function');
  const times = new Map([['fast', 100], ['slow', 20000]]);
  assert.equal(mutationTimeout(['fast'], times), 30000);
  assert.equal(mutationTimeout(['slow'], times), 100000);
  assert.equal(mutationTimeout(['fast', 'slow'], times), 100500);
  assert.throws(() => mutationTimeout(['unmeasured'], times), /missing baseline/);
});

test('a hung planted bug is caught by its baseline-derived timeout', async (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib/gates'), { recursive: true });
  fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'lib/gates/merge.js'), `module.exports = (t, ctx) => {
    if (t.status !== 'accepted' || (!ctx.mergedIds?.includes(t.id))) return false;
    return true;
  };\n`);
  fs.writeFileSync(path.join(h.repo, 'test/run.js'), `
    if (require('../lib/gates/merge')({ id: 'T1', status: 'submitted' }, { mergedIds: ['T1'] })) {
      setInterval(() => {}, 1000);
    }
  `);
  const result = await runContained(process.execPath, [
    path.join(ROOT, 'scripts/mutants.js'), '--root', h.repo,
    '--only', 'stack-merge-unaccepted-lower', '--no-full', '--jobs', '1',
  ], { env: { ...h.env, TOWER_CRANE_TEST_TMP: h.base }, limit: 48, timeout: 60000 }); // wait-allow: outer emergency deadline must fail a broken adaptive mutation timeout
  assert.equal(result.reason, null, result.output);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /caught.*stack-merge-unaccepted-lower \(caught-by-timeout \(30000 ms\)\)/);
});
