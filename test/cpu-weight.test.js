'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { cachedFixture } = require('./helpers');
const { scopeEnv } = require('./containment-plan');
const G = require('../lib/governor');
const C = require('../lib/containment');
const gates = require('../lib/gates/common');

test('the CPU host probe preserves both output streams on failed commands and invalid reports', () => {
  const { checkRun, parseRun } = require('../scripts/probe-cpu-weight');
  for (const failure of [
    { status: 1 }, { status: 2 }, { status: null, signal: 'SIGTERM' },
    { status: null, error: Object.assign(new Error('startup failed'), { code: 'ENOENT' }) },
    { status: null, error: Object.assign(new Error('deadline reached'), { code: 'ETIMEDOUT' }) },
    { status: 0, error: new Error('runner failed') },
  ]) {
    const result = { stdout: '{"before":{"median_ms":100},"with_gate":{"median_ms":124.03}}',
      stderr: 'median build time changed 24.03%', ...failure };
    assert.throws(() => checkRun(result, 'probe phase'), (error) => {
      assert.match(error.message, /probe phase/);
      assert.ok(error.message.includes(result.stdout));
      assert.ok(error.message.includes(result.stderr));
      return true;
    });
  }
  assert.deepEqual(parseRun({ status: 0, stdout: '{"weight":7}', stderr: '' }, 'scope'), { weight: 7 });
  for (const stdout of ['', 'not-json']) {
    assert.throws(() => parseRun({ status: 0, stdout, stderr: 'diagnostic marker' }, 'scope'), /scope[\s\S]*diagnostic marker/);
  }
});

test('the CPU host probe reports signed changes and retains the strict 10 percent boundary', () => {
  const { comparison } = require('../scripts/probe-cpu-weight');
  for (const [median, signed, passes] of [
    [100, 0, true], [109, 0.09, true], [109.99, 0.0999, true],
    [110, 0.1, false], [124.03, 0.2403, false],
    [91, -0.09, true], [90.01, -0.0999, true],
    [90, -0.1, false], [75.97, -0.2403, false],
  ]) {
    const result = comparison([101, 99, 100], [median + 1, median - 1, median]);
    assert.ok(Math.abs(result.signed_change - signed) < 1e-12);
    assert.equal(result.absolute_change, Math.abs(result.signed_change));
    assert.equal(result.absolute_change < 0.1, passes, String(median));
    assert.equal(result.before.median_ms, 100);
    assert.equal(result.with_gate.median_ms, median);
  }
  for (const samples of [[], [100], [100, 100], [100, 100, 100, 100], [0, 100, 200], [-1, 100, 200], [NaN, 100, 200]]) {
    assert.throws(() => comparison(samples, [100, 100, 100]), /three positive finite timings/);
    assert.throws(() => comparison([100, 100, 100], samples), /three positive finite timings/);
  }
});

test('the CPU host probe balances three trial pairs and stops gates on every failure path', async () => {
  const { measureTrials } = require('../scripts/probe-cpu-weight');
  for (const failure of [null, 'start', 'ready', 'with_gate', 'second_baseline']) {
    let active = false;
    let started = 0;
    let stopped = 0;
    const order = [];
    const run = () => measureTrials({
      startGate() {
        if (failure === 'start') throw new Error('start failure');
        assert.equal(active, false);
        active = true;
        started++;
        return { trial: started };
      },
      async waitGate(gate) {
        assert.ok(gate.trial);
        if (failure === 'ready') throw new Error('ready failure');
      },
      async stopGate(gate) {
        assert.ok(gate.trial);
        assert.equal(active, true);
        active = false;
        stopped++;
      },
      async build(condition, trial) {
        assert.equal(active, condition === 'with_gate');
        order.push(condition);
        if (condition === failure || failure === 'second_baseline' && condition === 'before' && trial === 1) {
          throw new Error(`${failure} failure`);
        }
        return 100 + trial + (condition === 'with_gate' ? 1 : 0);
      },
    });
    if (failure) await assert.rejects(run, new RegExp(`${failure} failure`));
    else {
      const result = await run();
      assert.deepEqual(order, ['before', 'with_gate', 'with_gate', 'before', 'before', 'with_gate']);
      assert.deepEqual(result.before.runs_ms, [100, 101, 102]);
      assert.deepEqual(result.with_gate.runs_ms, [101, 102, 103]);
      assert.equal(started, 3);
    }
    assert.equal(active, false, failure || 'success');
    assert.equal(stopped, started, failure || 'success');
  }
});

test('the CPU host probe summarizes three build timings without reordering samples', () => {
  const { summary } = require('../scripts/probe-cpu-weight');
  for (const [samples, median, min, max] of [
    [[10, 20, 30], 20, 10, 30],
    [[10, 30, 20], 20, 10, 30],
    [[20, 10, 30], 20, 10, 30],
    [[20, 30, 10], 20, 10, 30],
    [[30, 10, 20], 20, 10, 30],
    [[30, 20, 10], 20, 10, 30],
    [[2, 10, 30], 10, 2, 30],
    [[4, 9, 4], 4, 4, 9],
    [[0, 0, 0], 0, 0, 0],
    [[2.5, 0.25, 1.5], 1.5, 0.25, 2.5],
  ]) {
    const runs = Object.freeze(samples);
    assert.deepEqual(summary(runs), { median_ms: median, min_ms: min, max_ms: max, runs_ms: runs });
  }
});

test('CPU weights merge project overrides and validate the systemd range', () => {
  for (const [config, agents, gates] of [
    [undefined, 100, 1],
    [{ agents: 200 }, 200, 1],
    [{ gates: 20 }, 100, 20],
    [{ agents: 10000, gates: 1 }, 10000, 1],
  ]) {
    const project = { governor: { cpu_weight: config } };
    for (const kind of G.KINDS) {
      assert.equal(G.cpuWeight(project, kind), ['tests', 'clean', 'ci', 'suite'].includes(kind) ? gates : agents, kind);
    }
  }
  for (const value of [0, -1, 10001, 1.5, '10', null]) {
    assert.match(G.errors({ cpu_weight: { gates: value } }).join('; '), /cpu_weight\.gates/);
  }
  for (const value of [[], 10, null, { worker: 100 }]) {
    assert.ok(G.errors({ cpu_weight: value }).length, JSON.stringify(value));
  }
  for (const [weight, nice] of [[1, 19], [10, 10], [100, 0], [10000, 0]]) {
    assert.equal(G.cpuNice(weight), nice);
  }
});

test('the CLI carries configured agent weights into its scope launch plan', { skip: process.platform !== 'linux' }, (t) => {
  const h = cachedFixture(t, 'cpu-weight', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Weighted agent', '--acceptance', 'weighted', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Weighted fixture.\n' });
  });
  h.ok(['project', 'set', '--governor', '{"cpu_weight":{"agents":321,"gates":7}}', '--agent', 'orchestrator']);
  assert.equal(h.readState('project.json').governor.cpu_weight.agents, 321);
  const launch = h.json(['spawn', '--task', 'T1', '--dry-run'], { env: { ...h.env, ...scopeEnv(h) } });
  const runner = launch.argv.findIndex((arg) => path.basename(arg) === 'containment-runner.js');
  assert.ok(runner >= 0, JSON.stringify(launch.argv));
  assert.equal(JSON.parse(launch.argv[runner + 1]).cpuWeight, 321);
});

test('gate commands carry the project gate weight to the containment launcher', async () => {
  const calls = [];
  const ctx = { project: { governor: { cpu_weight: { agents: 321, gates: 7 } } },
    exec: async (cmd, args, opts) => { calls.push(opts); return { status: 0, stdout: '', stderr: '' }; } };
  await gates.shell(ctx, 'gate fixture');
  await gates.exec(ctx, 'gate', [], { processTree: true });
  assert.deepEqual(calls.map((opts) => opts.cpuWeight), [7, 7]);
});

test('scope arguments enforce CPUWeight after optional scope properties', () => {
  const args = C.scopeArguments('unit.scope', 'agents.slice', { tasks_max: 64, memory_max_bytes: 1024 },
    { CPUWeight: '999' }, 7);
  assert.equal(args.filter((arg) => arg.startsWith('CPUWeight=')).at(-1), 'CPUWeight=7');
});

test('watchdog launches set nice before the command executes', { skip: process.platform !== 'linux' }, async (t) => {
  const h = cachedFixture(t, 'cpu-weight-fallback', (h) => h.init());
  const fake = path.join(__dirname, 'fixtures', 'containment-systemd.js');
  const script = `
const C = require(${JSON.stringify(require.resolve('../lib/containment'))});
const child = C.spawn(process.execPath, ['-e', 'console.log(require("node:os").getPriority())'], {
  cpuWeight: 1, resources: { tasks_max: 64, memory_max_bytes: 536870912 },
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TOWER_CRANE_TEST_CONTAINMENT: '1' },
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('close', (code) => { process.exitCode = code; });
`;
  const result = await gates.treeExec(process.execPath, ['--require', fake, '-e', script], {
    env: { ...h.env, TC_FAKE_NO_MANAGER: '1', [C.MARK]: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Number(result.stdout.trim()), 19);
});

test('nested runners write every configured weight inside the inherited fence', { skip: process.platform !== 'linux' }, async (t) => {
  const h = cachedFixture(t, 'cpu-weight-nested', (h) => h.init());
  const fake = path.join(__dirname, 'fixtures', 'containment-systemd.js');
  const runner = require.resolve('../lib/containment-runner');
  for (const weight of [1, 7, 100, 10000]) {
    const parent = path.join(h.base, `parent-${weight}`);
    fs.mkdirSync(parent);
    const unit = 'tower-crane-123-0123456789abcdef.scope';
    const result = await gates.treeExec(process.execPath, ['--require', fake, runner,
      JSON.stringify({ tasks_max: 64, memory_max_bytes: 536870912, cpuWeight: weight }),
      parent, unit, process.execPath, '-e', 'console.log("nested")'], {
      env: { ...h.env, TC_FAKE_CGROUP: parent },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'nested\n');
    const group = path.join(parent, `nested-${unit}`);
    assert.equal(fs.readFileSync(path.join(group, 'cpu.weight'), 'utf8'), String(weight));
    assert.equal(fs.readFileSync(path.join(group, 'pids.max'), 'utf8'), '64');
    assert.equal(fs.readFileSync(path.join(group, 'memory.max'), 'utf8'), '536870912');
    assert.deepEqual(fs.readFileSync(path.join(group, 'cgroup.subtree_control'), 'utf8').split(/\s+/).sort(), ['cpu', 'memory', 'pids']);
  }
});

test('partial CPU delegation retains kernel caps and degrades scheduling to nice', { skip: process.platform !== 'linux' }, async (t) => {
  const h = cachedFixture(t, 'cpu-weight-partial', (h) => h.init());
  const fake = path.join(__dirname, 'fixtures', 'containment-systemd.js');
  const runner = require.resolve('../lib/containment-runner');
  const baselineNice = require('node:os').getPriority();
  const rows = [
    ['nested without CPU', 'nested', { TC_FAKE_CPU_CONTROLLERS: 'memory pids' }, 1, 'nice'],
    ['D-Bus without CPU', 'dbus', { TC_FAKE_CPU_CONTROLLERS: 'memory pids' }, 1, 'nice'],
    ['CLI without CPU', 'cli', { TC_FAKE_CPU_CONTROLLERS: 'memory pids' }, 1, 'nice'],
    ['nested normal agent without CPU', 'nested', { TC_FAKE_CPU_CONTROLLERS: 'memory pids' }, 100, 'nice'],
    ['nested configured agent without CPU', 'nested', { TC_FAKE_CPU_CONTROLLERS: 'memory pids' }, 10, 'nice'],
    ['nested CPU disappears during enable', 'nested', { TC_FAKE_CPU_ENABLE_ERROR: 'ENOENT' }, 1, 'nice'],
    ['nested CPU enable permission denied', 'nested', { TC_FAKE_CPU_ENABLE_ERROR: 'EACCES' }, 1, 'nice'],
    ['nested CPU weight permission denied', 'nested', { TC_FAKE_CPU_WEIGHT_ERROR: 'EPERM' }, 1, 'nice'],
    ['nested CPU weight disappears', 'nested', { TC_FAKE_CPU_WEIGHT_ERROR: 'ENOENT' }, 1, 'nice'],
    ['nested CPU present', 'nested', {}, 1, 'cgroup'],
    ['D-Bus CPU present', 'dbus', {}, 1, 'cgroup'],
    ['CLI CPU present', 'cli', {}, 1, 'cgroup'],
  ];
  for (const [label, mode, extra, weight, backend] of rows) {
    const parent = path.join(h.base, label.replaceAll(' ', '-'));
    fs.mkdirSync(parent);
    fs.writeFileSync(path.join(parent, 'memory.max'), '1073741824');
    fs.writeFileSync(path.join(parent, 'pids.max'), '128');
    fs.writeFileSync(path.join(parent, 'cgroup.subtree_control'), 'memory pids');
    const unit = 'tower-crane-123-0123456789abcdef.scope';
    const group = path.join(parent, mode === 'nested' ? `nested-${unit}` : unit);
    if (mode !== 'nested') fs.mkdirSync(group);
    const report = path.join(h.base, `${path.basename(parent)}.json`);
    const limits = { tasks_max: 64, memory_max_bytes: 536870912 };
    const args = [runner, JSON.stringify({ ...limits, cpuWeight: weight }),
      mode === 'nested' ? parent : mode === 'dbus' ? `@${unit}:test-fence.slice` : '', unit,
      process.execPath, '-e', 'console.log(JSON.stringify({ nice: require("node:os").getPriority(), scoped: process.env.TOWER_CRANE_SCOPED }))'];
    const argv = mode === 'cli' ? [fake, ...C.scopeArguments(unit, 'test-fence.slice', limits, {}, weight), process.execPath, ...args]
      : ['--require', fake, ...args];
    const result = await gates.treeExec(process.execPath, argv, {
      env: { ...h.env, TC_FAKE_CGROUP: mode === 'nested' ? parent : group, TC_FAKE_SYSTEMD_LOG: path.join(parent, 'manager.jsonl'),
        TOWER_CRANE_CONTAINMENT_REPORT: report, ...extra },
    });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    const metadata = JSON.parse(fs.readFileSync(report, 'utf8'));
    const output = JSON.parse(result.stdout);
    assert.equal(metadata.cpu_weight_backend, backend, label);
    assert.equal(output.nice, backend === 'nice' ? Math.min(19, baselineNice + G.cpuNice(weight)) : baselineNice, label);
    assert.equal(output.scoped, '1', label);
    assert.equal(metadata.group, group, label);
    if (mode === 'nested') {
      assert.equal(fs.readFileSync(path.join(group, 'memory.max'), 'utf8'), String(limits.memory_max_bytes), label);
      assert.equal(fs.readFileSync(path.join(group, 'pids.max'), 'utf8'), String(limits.tasks_max), label);
      assert.equal(fs.readFileSync(path.join(parent, 'memory.max'), 'utf8'), '1073741824', label);
      assert.equal(fs.readFileSync(path.join(parent, 'pids.max'), 'utf8'), '128', label);
    } else {
      const properties = JSON.parse(fs.readFileSync(path.join(parent, 'manager.jsonl'), 'utf8'));
      assert.equal(properties.TasksMax, String(limits.tasks_max), label);
      assert.equal(properties.MemoryMax, String(limits.memory_max_bytes), label);
      assert.equal(properties.CPUWeight, String(weight), label);
    }
    const controllers = fs.readFileSync(path.join(group, 'cgroup.subtree_control'), 'utf8').split(/\s+/);
    assert.ok(controllers.includes('memory') && controllers.includes('pids'), label);
  }
});

test('nice fallback preserves native launch errors and successful shell execution', { skip: process.platform !== 'linux' }, async (t) => {
  const h = cachedFixture(t, 'cpu-weight-errors', (h) => h.init());
  const bin = path.join(h.base, 'error-bin');
  fs.mkdirSync(bin);
  const blocked = path.join(bin, 'blocked');
  fs.writeFileSync(blocked, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  const badInterpreter = path.join(bin, 'bad-interpreter');
  fs.writeFileSync(badInterpreter, '#!/does-not-exist-t518-shell\n', { mode: 0o755 });
  const plainShell = path.join(bin, 'plain-shell');
  fs.writeFileSync(plainShell, 'printf "fallback\\n"\n', { mode: 0o755 });
  const fake = path.join(__dirname, 'fixtures', 'containment-systemd.js');
  for (const [label, command, args, code, status, output, emptyPath] of [
    ['bare missing', 'missing-t518-command', [], 'ENOENT'],
    ['absolute missing', path.join(bin, 'missing'), [], 'ENOENT'],
    ['relative missing', './missing-t518-command', [], 'ENOENT'],
    ['absolute permission', blocked, [], 'EACCES'],
    ['PATH permission', 'blocked', [], 'EACCES'],
    ['missing interpreter', badInterpreter, [], 'ENOENT'],
    ['plain executable shell', plainShell, [], undefined, 0, 'fallback\n'],
    ['application exit 126', process.execPath, ['-e', 'process.exit(126)'], undefined, 126, ''],
    ['application exit 127', process.execPath, ['-e', 'process.exit(127)'], undefined, 127, ''],
    ['absolute executable with empty PATH', process.execPath, ['-e', 'console.log(require("node:os").getPriority())'], undefined, 0, '19\n', true],
  ]) {
    const script = `
const G = require(${JSON.stringify(require.resolve('../lib/gates/common'))});
G.treeExec(${JSON.stringify(command)}, ${JSON.stringify(args)}, {
  cpuWeight: 1, resources: { tasks_max: 64, memory_max_bytes: 536870912 },
  env: { ...process.env, ${emptyPath ? "PATH: ''," : ''} TOWER_CRANE_TEST_CONTAINMENT: '1' },
}).then((result) => console.log(JSON.stringify({ code: result.error?.code, status: result.status, stdout: result.stdout })));
`;
    const result = await gates.treeExec(process.execPath, ['--require', fake, '-e', script], {
      env: { ...h.env, PATH: bin + path.delimiter + h.env.PATH,
        TC_FAKE_NO_MANAGER: '1', [C.MARK]: '' },
    });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.code, code, label);
    if (!code) {
      assert.equal(actual.status, status, label);
      assert.equal(actual.stdout, output, label);
    }
  }
});
