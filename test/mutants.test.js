'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');
const { readText } = require('../scripts/text');
const { runContained, windowsCommandLine } = require('../scripts/mutants');
const { detachedAlive } = require('./helpers');
const { killPid } = require('./signals');
const { readPublished } = require('./atomic-file');
const { makeDocsRepo } = require('./docs-fixture');

const SYSTEMD_ONLY = 'systemd scopes exist only on Linux';

// A fixture line that records a pid with the time it saw it, so a later check can
// tell the process from a reuse of its pid.
const recordPid = (file, pid) => `require('node:fs').appendFileSync(${JSON.stringify(file)}, JSON.stringify({ pid: ${pid}, recordedAt: Date.now() }) + '\\n')`;

function recorded(file) {
  return fs.existsSync(file) ? readPublished(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

// The recorded processes still running. Windows reads every creation time in one
// PowerShell query; a process created after its record is a reused pid.
function survivors(file) {
  const rows = recorded(file);
  if (process.platform !== 'win32' || !rows.length) return rows.filter(detachedAlive);
  const script = `
foreach ($entry in (ConvertFrom-Json '${JSON.stringify(rows)}')) {
  try {
    $process = [System.Diagnostics.Process]::GetProcessById($entry.pid)
    $started = $process.StartTime
    if ($null -ne $started -and !$process.HasExited -and $started.ToUniversalTime() -le [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$entry.recordedAt + 100).UtcDateTime) {
      [Console]::Out.WriteLine($entry.pid)
    }
  } catch [System.ArgumentException] { } catch [System.InvalidOperationException] { } catch [System.ComponentModel.Win32Exception] { }
}
exit 0
`;
  const out = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  const alive = new Set(out.split(/\r?\n/).filter(Boolean).map(Number));
  return rows.filter(row => alive.has(row.pid));
}

function assertNoneLeft(file) {
  assert.deepEqual(survivors(file), [], 'every process the mutant run started stopped before it returned');
}

test('check:shared rejects missing and duplicate mutant targets without running tests', (t) => {
  const h = makeDocsRepo(t);
  const { scripts } = require('../package.json');
  assert.equal(scripts['check:shared'], 'node scripts/check-shared-files.js --mutants');
  const script = (name, args) => cp.spawnSync(process.execPath,
    [path.join(h.repo, 'scripts', name), ...args],
    { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 300000 });
  const check = () => script('check-shared-files.js', ['--mutants']);
  const file = path.join(h.repo, 'lib/gates/tests.js');
  const source = readText(file);
  const anchor = 'if (without.ok) {';
  const clean = check();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  const targets = script('mutants.js', ['--check', '--root', h.repo]);
  assert.equal(targets.status, 0, targets.stderr);
  assert.match(targets.stdout, /^\d+ mutant targets match once\n$/);
  const tasks = path.join(h.repo, 'lib/tasks.js');
  fs.writeFileSync(tasks, readText(tasks).replace(/\n/g, '\r\n'));
  for (const [name, text, occurrences] of [
    ['unchanged LF', source, 1],
    ['missing anchor', source.replace(anchor, 'if (false) {'), 0],
    ['duplicate anchor', source + `\n// ${anchor}\n`, 2],
    ['unchanged CRLF', source.replace(/\n/g, '\r\n'), 1],
  ]) {
    fs.writeFileSync(file, text);
    const drift = check();
    if (occurrences === 1) {
      assert.equal(drift.status, 0, name + '\n' + drift.stdout + drift.stderr);
      continue;
    }
    assert.equal(drift.status, 1, drift.stderr);
    assert.match(drift.stderr, new RegExp(`tests-pass-without-change:.*once in lib/gates/tests\\.js.*found ${occurrences}`));
    const selected = script('mutants.js', ['--check', '--only', 'tests-pass-without-change']);
    assert.equal(selected.status, 1);
    assert.match(selected.stderr, new RegExp(`tests-pass-without-change:.*found ${occurrences}`));
  }
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
    ${recordPid(pids, 'process.pid')};
    if (require('../lib/gates/merge')({ id: 'T1', status: 'submitted' }, { mergedIds: ['T1'] })) {
      setInterval(() => {
        const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true, stdio: 'ignore',
        });
        child.on('error', () => {});
        if (child.pid) ${recordPid(pids, 'child.pid')};
      }, process.platform === 'win32' ? 500 : 50);
    }
  `);
  // The outer watchdog bounds the regression itself if the inner cap breaks.
  assert.equal(typeof runContained, 'function');
  t.after(() => {
    if (!fs.existsSync(pids)) return;
    for (const row of survivors(pids)) killPid(row.pid, 'SIGKILL');
  });
  const result = await runContained(process.execPath, [
    path.join(ROOT, 'scripts/mutants.js'), '--root', h.repo, '--jobs', '1',
    '--only', 'stack-merge-unaccepted-lower', '--no-full', '--process-limit', '32',
  ], { env: { ...h.env, TOWER_CRANE_TEST_TMP: h.base }, limit: 48, timeout: 60000 });
  assert.equal(result.reason, null, result.output);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /caught.*stack-merge-unaccepted-lower \(process cap \(32\)/);
  assert.match(result.output, /1\/1 mutants caught/);
  assert.match(result.output, /1\/1 mutants caught \(0 by tests, 0 by timeout, 1 by caps\)/);
  // The baseline and the mutant run each record their runner; the rest are detached children.
  const children = recorded(pids).length - 2;
  assert.ok(children > 0, 'the planted bug spawned real processes');
  assert.ok(children < 48, `the runaway stayed below the outer cap: ${children}`);
  assert.ok(result.peak < 48, `the regression never hit its emergency cap: ${result.peak}`);
  t.diagnostic(`spawned ${children}; peak ${result.peak}; emergency limit 48`);
  assertNoneLeft(pids);
});

test('containment aborts a capped baseline and refuses invalid process limits', async (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib/gates'), { recursive: true });
  fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'lib/gates/merge.js'),
    "if (t.status !== 'accepted' || (!ctx.mergedIds?.includes(t.id))) return false;\n");
  const pids = path.join(h.base, 'spawned.jsonl');
  fs.writeFileSync(path.join(h.repo, 'test/run.js'), `${recordPid(pids, 'process.pid')};
    setInterval(() => {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      child.on('error', () => {});
      if (child.pid) ${recordPid(pids, 'child.pid')};
    }, process.platform === 'win32' ? 500 : 50);\n`);
  const capped = await runContained(process.execPath, [
    path.join(ROOT, 'scripts/mutants.js'), '--root', h.repo,
    '--only', 'stack-merge-unaccepted-lower', '--no-full', '--process-limit', '16',
  ], { env: { ...h.env, TOWER_CRANE_TEST_TMP: h.base }, limit: 48, timeout: 60000 });
  assert.equal(capped.status, 1, capped.output);
  assert.match(capped.output, /the unmutated tests fail:[\s\S]*process cap \(16\)/);
  assert.doesNotMatch(capped.output, /caught.*stack-merge-unaccepted-lower/);
  assert.ok(recorded(pids).length > 1, 'the baseline spawned real processes');
  assertNoneLeft(pids);
  for (const limit of [1, 513, NaN]) {
    await assert.rejects(runContained(process.execPath, ['-e', ''], { limit }), /process limit/);
  }
  await assert.rejects(runContained(path.join(h.base, 'missing-executable'), [], { limit: 48 }),
    { code: 'ENOENT' });
});

// Neither Linux nor Windows hands the orphan to its runner: Linux reparents it to init and
// Windows keeps the exited parent's pid. The macOS ps watchdog has neither a marker nor a job.
test('containment removes a detached child even when its parent exits between inspections', {
  skip: process.platform === 'darwin' && 'the macOS process watchdog cannot follow an orphan',
}, async (t) => {
  const h = makeRepo(t);
  const file = path.join(h.base, 'orphan.jsonl');
  t.after(() => { for (const row of survivors(file)) killPid(row.pid, 'SIGKILL'); });
  const result = await runContained(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    ${recordPid(file, 'child.pid')};
    process.exit(0);
  `], { cwd: h.repo, limit: 48, timeout: 60000 });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.reason, null, result.output);
  assert.equal(recorded(file).length, 1);
  assertNoneLeft(file);
});

test('Windows command lines quote arguments the way CreateProcess parses them back', () => {
  for (const [argv, line] of [
    [['C:\\node.exe', 'plain'], 'C:\\node.exe plain'],
    [['C:\\Program Files\\node.exe', ''], '"C:\\Program Files\\node.exe" ""'],
    [['a b', 'tab\there'], '"a b" "tab\there"'],
    [['say "hi"'], '"say \\"hi\\""'],
    [['dir with space\\'], '"dir with space\\\\"'],
    [['back\\"quote x'], '"back\\\\\\"quote x"'],
    [['no\\space'], 'no\\space'],
    [['line\nbreak'], '"line\nbreak"'],
  ]) assert.equal(windowsCommandLine(argv), line, JSON.stringify(argv));
});

test('a contained run returns the command exit status and output without the Windows job report', async (t) => {
  const h = makeRepo(t);
  const result = await runContained(process.execPath, ['-e', "console.log('done'); process.exitCode = 3"], { cwd: h.repo, limit: 48 });
  assert.equal(result.status, 3, result.output);
  assert.equal(result.reason, null, result.output);
  assert.match(result.output, /^done\r?\n$/, 'the helper report is not part of the command output');
});

test('an unavailable systemd manager is an infrastructure failure rather than a mutant kill', { skip: process.platform !== 'linux' && SYSTEMD_ONLY }, async (t) => {
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

test('scoped containment inherits the caller slice and inspects only its cgroup', { skip: process.platform !== 'linux' && SYSTEMD_ONLY }, async (t) => {
  const fixture = scopedFixture(t);
  const result = await fixture.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.reason, null, result.output);
  assert.ok(fixture.args.includes('--slice=agents.slice'), fixture.args.join(' '));
  assert.ok(fixture.reads > 0, 'the watchdog reads scoped process membership');
});

test('scoped memory catches require oom_kill rather than reclaim or allocation events', { skip: process.platform !== 'linux' && SYSTEMD_ONLY }, async (t) => {
  for (const [events, reason] of [
    ['max 604\noom 0\noom_kill 0\n', null],
    ['max 0\noom 2\noom_kill 0\n', null],
    ['max 0\noom 0\noom_kill 1\n', 'memory cap (4G)'],
  ]) {
    await t.test(events.trim().replaceAll('\n', ', '), async (t) => {
      const fixture = scopedFixture(t, file => {
        if (file === '/sys/fs/cgroup/fixture.scope/memory.events') return events;
      });
      const result = await fixture.run();
      assert.equal(result.reason, reason, result.output);
      if (!reason) assert.equal(result.status, 0, result.output);
    });
  }
});

test('scoped containment retains the exited runner identity across a missing stat', { skip: process.platform !== 'linux' && SYSTEMD_ONLY }, async (t) => {
  let gone = false;
  let reused = false;
  let signalled = false;
  let runner;
  t.mock.method(process, 'kill', pid => {
    if (Math.abs(pid) === runner && reused) signalled = true;
  });
  const fixture = scopedFixture(t, (file, child) => {
    runner = child?.pid;
    if (file !== `/proc/${runner}/stat` || child?.exitCode !== 0) return;
    if (!gone) {
      gone = true;
      throw Object.assign(new Error('runner exited'), { code: 'ENOENT' });
    }
    reused = true;
    const fields = Array(22).fill('0');
    fields[0] = signalled ? 'Z' : 'S';
    fields[2] = String(runner);
    fields[19] = 'reused-start';
    return `${runner} (unrelated process) ${fields.join(' ')}`;
  });
  const result = await fixture.run();
  assert.equal(result.status, 0, result.output);
  assert.ok(gone && reused, 'the runner disappeared and its PID was reused');
  assert.equal(signalled, false, 'cleanup must not signal a reused runner PID or group');
});

test('scoped containment tolerates cgroup removal during final reads and rejects inspection errors', { skip: process.platform !== 'linux' && SYSTEMD_ONLY }, async (t) => {
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

test('scoped containment forgets exited PIDs after one failed stat read', { skip: process.platform !== 'linux' && SYSTEMD_ONLY }, async (t) => {
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
  assert.equal(mutationTimeout(['fast'], times, 5000), 5000, '--deadline-floor lowers only the floor');
  assert.equal(mutationTimeout(['slow'], times, 5000), 100000);
  assert.equal(mutationTimeout(['slow'], times), 100000);
  assert.equal(mutationTimeout(['fast', 'slow'], times), 100500);
  assert.throws(() => mutationTimeout(['unmeasured'], times), /missing baseline/);
});

test('mutation runs retry only timeout catches once and classify the final result', async () => {
  const { runMutationTests } = require('../scripts/mutants');
  assert.equal(typeof runMutationTests, 'function');
  const pass = { status: 0, reason: null, output: '' };
  const failure = { status: 1, reason: null, output: 'test failed' };
  const timeout = { status: null, reason: 'caught-by-timeout (30000 ms)', output: '' };
  const cap = { status: null, reason: 'memory cap (4G)', output: '' };
  for (const [results, caughtBy] of [
    [[pass], null],
    [[failure], 'tests'],
    [[cap], 'cap'],
    [[timeout, pass], null],
    [[timeout, failure], 'tests'],
    [[timeout, timeout], 'timeout'],
    [[timeout, cap], 'cap'],
  ]) {
    let calls = 0;
    const result = await runMutationTests(['fast'], new Map([['fast', 10]]), async (files, deadline) => {
      assert.deepEqual(files, ['fast']);
      assert.equal(deadline, 30000);
      assert.ok(calls < results.length, 'at most one retry');
      return results[calls++];
    });
    assert.equal(calls, results.length);
    assert.equal(result.caughtBy, caughtBy);
    assert.deepEqual(result.run, results.at(-1));
  }
});

test('mutation summary separates a test failure from timeouts and caps', async (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib/gates'), { recursive: true });
  fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'lib/gates/merge.js'), `module.exports = (t, ctx) => {
    if (t.status !== 'accepted' || (!ctx.mergedIds?.includes(t.id))) return false;
    return true;
  };\n`);
  const pids = path.join(h.base, 'spawned.jsonl');
  fs.writeFileSync(path.join(h.repo, 'test/run.js'), `
    ${recordPid(pids, 'process.pid')};
    if (require('../lib/gates/merge')({ id: 'T1', status: 'submitted' }, { mergedIds: ['T1'] })) {
      console.error('unaccepted merge');
      process.exitCode = 1;
    }
  `);
  const result = await runContained(process.execPath, [
    path.join(ROOT, 'scripts/mutants.js'), '--root', h.repo,
    '--only', 'stack-merge-unaccepted-lower', '--no-full', '--jobs', '1',
  ], { env: { ...h.env, TOWER_CRANE_TEST_TMP: h.base }, limit: 48, timeout: 60000 });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.reason, null, result.output);
  assert.match(result.output, /1\/1 mutants caught \(1 by tests, 0 by timeout, 0 by caps\)/);
  assert.doesNotMatch(result.output, /retry/);
  assert.equal(recorded(pids).length, 2, 'a baseline and a mutant run');
  assertNoneLeft(pids);
});

test('a hung planted bug is caught by its baseline-derived timeout', async (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib/gates'), { recursive: true });
  fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'lib/gates/merge.js'), `module.exports = (t, ctx) => {
    if (t.status !== 'accepted' || (!ctx.mergedIds?.includes(t.id))) return false;
    return true;
  };\n`);
  const pids = path.join(h.base, 'spawned.jsonl');
  fs.writeFileSync(path.join(h.repo, 'test/run.js'), `
    ${recordPid(pids, 'process.pid')};
    if (require('../lib/gates/merge')({ id: 'T1', status: 'submitted' }, { mergedIds: ['T1'] })) {
      setInterval(() => {}, 1000);
    }
  `);
  const result = await runContained(process.execPath, [
    path.join(ROOT, 'scripts/mutants.js'), '--root', h.repo,
    // The unit test above holds the production 30-second floor; this run lowers it.
    '--only', 'stack-merge-unaccepted-lower', '--no-full', '--jobs', '1', '--deadline-floor', '5000',
  ], { env: { ...h.env, TOWER_CRANE_TEST_TMP: h.base }, limit: 48, timeout: 150000 }); // wait-allow: outer emergency deadline covers two mutation attempts and three Windows helper compiles
  assert.equal(result.reason, null, result.output);
  assert.equal(result.status, 0, result.output);
  const deadline = /caught.*stack-merge-unaccepted-lower \(caught-by-timeout \((\d+) ms\)\)/.exec(result.output);
  assert.ok(deadline && Number(deadline[1]) >= 5000, result.output);
  assert.match(result.output, /retry.*stack-merge-unaccepted-lower.*timeout/);
  assert.match(result.output, /1\/1 mutants caught \(0 by tests, 1 by timeout, 0 by caps\)/);
  assert.equal(recorded(pids).length, 3, 'a baseline and two timed-out mutant runs');
  assertNoneLeft(pids);
});
