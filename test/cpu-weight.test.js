'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cachedFixture, TMP_ROOT } = require('./helpers');
const { readPublished } = require('./atomic-file');
const { gateFixture } = require('./gate-helpers');
const { waitUntil } = require('./signals');
const { harnessArgv } = require('./containment-plan');
const C = require('../lib/containment');
const G = require('../lib/gates/common');

const FAKE_SYSTEMD = path.join(__dirname, 'fixtures', 'containment-systemd.js');
const PRELOAD = path.join(__dirname, 'fixtures', 'project-slices.js');
const RUNNER = require.resolve('../lib/containment-runner');
const LIMITS = { tasks_max: 64, memory_max_bytes: 512 * 1024 * 1024 };
const UNIT = 'tower-crane-123-0123456789abcdef.scope';

const digest = (dir) => crypto.createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 12);

function scratch(t, name) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('each project gets one slice directly below the caller slice, at the same name from any caller', (t) => {
  const base = scratch(t, 'slices');
  const a = path.join(base, 'a', '.tower-crane');
  const b = path.join(base, 'b', '.tower-crane');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  const link = path.join(base, 'link');
  fs.symlinkSync(path.join(base, 'a'), link, 'dir');
  const [ka, kb] = [digest(a), digest(b)];
  assert.notEqual(ka, kb);
  for (const [caller, dir, slice] of [
    ['agents.slice', a, `agents-towercrane_${ka}.slice`],
    ['agents.slice', b, `agents-towercrane_${kb}.slice`],
    ['agents.slice', path.join(link, '.tower-crane'), `agents-towercrane_${ka}.slice`],
    // A unit already in a project's slice starts the next one beside it, not below.
    [`agents-towercrane_${kb}.slice`, a, `agents-towercrane_${ka}.slice`],
    [`agents-towercrane_${ka}.slice`, a, `agents-towercrane_${ka}.slice`],
    ['app-gnome.slice', a, `app-gnome-towercrane_${ka}.slice`],
    ['-.slice', a, `towercrane_${ka}.slice`],
  ]) {
    const got = C.projectSlice(caller, dir);
    assert.equal(got, slice, `${caller} ${dir}`);
    // systemd nests a slice one level per dash, so the project's slice is a child of the caller's.
    const parent = caller.replace(/-towercrane_[0-9a-f]{12}\.slice$/, '.slice');
    assert.equal(got.split('-').length, parent === '-.slice' ? 1 : parent.split('-').length + 1, got);
  }
});

test('systemd-run and D-Bus scopes carry CPUWeight only for a weight other than the agents\' default', {
  skip: process.platform === 'win32' && 'Linux scope runner uses execve',
}, async (t) => {
  const base = scratch(t, 'weights');
  const slice = C.projectSlice('test-fence.slice', base);
  for (const mode of ['cli', 'dbus']) {
    for (const [role, weight] of [['gate', C.GATE_WEIGHT], ['gate at a set weight', 700], ['agent', C.AGENT_WEIGHT], ['agent at a set weight', 150]]) {
      const label = `${mode}-${role.replaceAll(' ', '-')}`;
      const group = path.join(base, label, UNIT);
      fs.mkdirSync(group, { recursive: true });
      const log = path.join(base, `${label}.jsonl`);
      const settings = JSON.stringify({ ...LIMITS, fleet: false, ...(weight !== C.AGENT_WEIGHT ? { cpu_weight: weight } : {}) });
      const args = [RUNNER, settings, mode === 'dbus' ? `@${UNIT}:${slice}` : '', UNIT, process.execPath, '-e', ''];
      const command = mode === 'dbus' ? ['--require', FAKE_SYSTEMD, ...args]
        : [FAKE_SYSTEMD, ...C.scopeArguments(UNIT, slice, LIMITS, { CPUQuota: '200%' }, weight), process.execPath, ...args];
      const result = await G.treeExec(process.execPath, command, {
        env: { ...process.env, TC_FAKE_CGROUP: group, TC_FAKE_SYSTEMD_LOG: log, TOWER_CRANE_CONTAINMENT_REPORT: path.join(base, `${label}-report.json`) },
      });
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      const properties = JSON.parse(fs.readFileSync(log, 'utf8').trim());
      assert.equal(properties.Slice, slice, label);
      assert.equal(properties.CPUWeight, weight === C.AGENT_WEIGHT ? undefined : String(weight), label);
    }
  }
});

test('a nested attempt sets its weight inside the scope it inherits, or records why it could not', {
  skip: process.platform === 'win32' && 'Linux scope runner uses execve',
}, async (t) => {
  const base = scratch(t, 'nested');
  for (const [label, delegated, weight, expected] of [
    ['gate', true, C.GATE_WEIGHT, { applied: true }],
    ['gate without a cpu controller', false, C.GATE_WEIGHT, { applied: false }],
    ['agent', true, undefined, undefined],
  ]) {
    const parent = path.join(base, label.replaceAll(' ', '-'), 'parent.scope');
    fs.mkdirSync(parent, { recursive: true });
    if (delegated) fs.writeFileSync(path.join(parent, 'cgroup.subtree_control'), 'memory pids\n');
    const report = path.join(base, `${label.replaceAll(' ', '-')}-report.json`);
    const settings = JSON.stringify({ ...LIMITS, ...(weight ? { cpu_weight: weight } : {}) });
    const result = await G.treeExec(process.execPath, ['--require', FAKE_SYSTEMD, RUNNER, settings, parent, UNIT, process.execPath, '-e', ''], {
      env: { ...process.env, TC_FAKE_CGROUP: parent, TOWER_CRANE_CONTAINMENT_REPORT: report },
    });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    const published = JSON.parse(readPublished(report, 'utf8'));
    const nested = path.join(parent, `nested-${UNIT}`);
    assert.equal(published.group, nested, label);
    if (!expected) {
      assert.equal(published.cpu, undefined, label);
      assert.equal(fs.existsSync(path.join(nested, 'cpu.weight')), false, label);
      assert.equal(fs.readFileSync(path.join(parent, 'cgroup.subtree_control'), 'utf8'), 'memory pids\n', 'an agent leaves its parent\'s controllers alone');
    } else if (expected.applied) {
      assert.deepEqual(published.cpu, { applied: true }, label);
      assert.equal(fs.readFileSync(path.join(nested, 'cpu.weight'), 'utf8'), String(weight));
      assert.equal(fs.readFileSync(path.join(parent, 'cgroup.subtree_control'), 'utf8'), '+cpu');
    } else {
      assert.equal(published.cpu.applied, false, label);
      assert.match(published.cpu.reason, /cpu controller of .*parent\.scope is not delegated/);
    }
  }
});

test('Windows and macOS launches record that the weight was not applied', (t) => {
  const dir = scratch(t, 'platform');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  for (const os of ['darwin', 'win32']) {
    let plan;
    Object.defineProperty(process, 'platform', { ...platform, value: os });
    try { plan = C.launchPlan(process.execPath, ['-e', ''], { resources: LIMITS, cpuWeight: C.GATE_WEIGHT, stateDir: dir }); }
    finally { Object.defineProperty(process, 'platform', platform); }
    assert.equal(plan.kernel, false);
    assert.deepEqual(plan.cpu, { weight: C.GATE_WEIGHT, applied: false, reason: `no systemd scopes on ${os}` });
    assert.equal(C.describeCpu(plan.cpu), `not applied (no systemd scopes on ${os})`);
  }
});

function project(t) {
  const h = cachedFixture(t, 'project-slices', (h) => {
    h.init();
    const sha = gateFixture(h);
    h.ok(['task', 'add', '--title', 'Weighted gate', '--acceptance', 'the gate outranks agents']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
    h.ok(['task', 'add', '--title', 'Agent', '--acceptance', 'default weight', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T2', '-'], { input: 'An agent scope.\n' });
    h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', '0', '{prompt}']),
      '--clear', 'profile', '--clear', 'effort']);
    // A cleanup tool that reports no findings, once TC_HOLD_RELEASE exists when that is set.
    const hold = path.join(h.base, 'hold.js');
    fs.writeFileSync(hold, `const fs = require('node:fs');
const path = require('node:path');
const release = process.env.TC_HOLD_RELEASE;
const done = () => { console.log(JSON.stringify({ scope: 'diff', items: [] })); process.exit(0); };
if (!release) done();
fs.writeFileSync(release + '.started', '');
fs.watch(path.dirname(release), () => { if (fs.existsSync(release)) done(); });
if (fs.existsSync(release)) done();
`);
    h.ok(['project', 'set', '--clean-cmd', [process.execPath, hold].map(G.shellQuote).join(' ')]);
  });
  h.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
  h.env.TOWER_CRANE_CLEAN_CMD = '';
  h.env.TC_FAKE_MANAGER_LOG = path.join(h.base, 'manager.jsonl');
  h.env.TC_FAKE_SCOPE_LOG = path.join(h.base, 'scopes.jsonl');
  return h;
}

test('the CLI starts each project\'s gates and agents in its own slice, gates at gates.cpu_weight, and status shows the weight of a running gate', {
  skip: process.platform !== 'linux' && 'systemd scopes are Linux only',
}, async (t) => {
  const a = project(t);
  const b = project(t);
  const pre = ['--require', PRELOAD];
  const sliceOf = (h) => `agents-towercrane_${digest(h.state)}.slice`;
  assert.notEqual(sliceOf(a), sliceOf(b));

  for (const bad of ['0', '10001', '1.5', 'many']) assert.equal(a.run(['project', 'set', '--gates-cpu-weight', bad]).code, 2, bad);
  assert.equal(a.run(['project', 'set', '--gates-cpu-weight', '700', '--agent', 'worker']).code, 1, 'a worker cannot change the weight');
  a.ok(['project', 'set', '--gates-cpu-weight', '700', '--agent', 'orchestrator']);
  assert.equal(a.readState('project.json').gates.cpu_weight, 700);
  b.ok(['project', 'set', '--agents-cpu-weight', '150', '--agent', 'orchestrator']);
  assert.match(a.ok(['project', 'show']), /gates\.cpu_weight: 700\nagents\.cpu_weight: 100/);
  assert.match(b.ok(['project', 'show']), /gates\.cpu_weight: 400\nagents\.cpu_weight: 150/);

  // Agents: the scope a dispatch would start, in its project's slice, with a weight only when one is set.
  for (const [h, weight] of [[a, undefined], [b, 150]]) {
    const plan = h.json(['spawn', '--task', 'T2', '--dry-run'], { pre });
    const runner = plan.argv.findIndex((arg) => arg.endsWith('containment-runner.js'));
    assert.ok(runner > 0, plan.argv.join(' '));
    assert.equal(JSON.parse(plan.argv[runner + 1]).cpu_weight, weight);
    assert.match(plan.argv[runner + 2], new RegExp(`^@tower-crane-\\d+-[0-9a-f]{16}\\.scope:${sliceOf(h)}$`));
    assert.deepEqual(plan.containment.cpu, { weight: weight ?? C.AGENT_WEIGHT, slice: sliceOf(h) });
    assert.deepEqual(harnessArgv(plan.argv).slice(0, 2), [process.execPath, '-e']);
  }

  // A gate: its command's scope in the same project's slice, at the project's gate weight, shown by status while it runs.
  const release = path.join(a.base, 'release');
  let closed = false;
  const running = a.runAsync(['check', 'clean', 'T1', '--json'], { pre, env: { TC_HOLD_RELEASE: release } }).finally(() => { closed = true; });
  await waitUntil(() => fs.existsSync(`${release}.started`), { paths: [a.base], alive: () => !closed, what: 'the clean command starts' });
  const shown = await waitUntil(() => a.ok(['status']).split('\n').find((line) => line.startsWith('gate cpu weight:')),
    { alive: () => !closed, what: 'status shows the running gate\'s weight' });
  assert.equal(shown, `gate cpu weight: T1 clean gate 700 in ${sliceOf(a)}`);
  fs.writeFileSync(release, '');
  const done = await running;
  assert.equal(done.code, 0, done.stderr);
  const launches = fs.readFileSync(a.env.TC_FAKE_SCOPE_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(launches.length, 1, JSON.stringify(launches));
  assert.equal(launches[0].settings.cpu_weight, 700);
  assert.equal(launches[0].target, `@${launches[0].unit}:${sliceOf(a)}`);
  const evidence = () => a.readState('tasks.json').tasks.find((x) => x.id === 'T1').evidence.findLast((e) => e.type === 'clean');
  assert.deepEqual(evidence().cpu, { weight: 700, slice: sliceOf(a) });

  // Without systemd scopes the gate still runs, and its receipt says the weight was not applied.
  const plain = a.run(['check', 'clean', 'T1', '--json'], { pre, env: { TC_FAKE_NO_MANAGER: '1' } });
  assert.equal(plain.code, 0, plain.stderr);
  assert.deepEqual(evidence().cpu, { weight: 700, applied: false, reason: 'no cgroup v2 or systemd user manager' });
});
