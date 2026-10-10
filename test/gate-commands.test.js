'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, cachedFixture, runPty, PTY_AVAILABLE } = require('./helpers');
const { gateFixture } = require('./gate-helpers');
const { shellQuote } = require('../lib/gates/common');

// Built once per process and copied for each test.
function fixture(t) {
  const h = cachedFixture(t, 'submitted', (h) => {
    h.init();
    const sha = gateFixture(h);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
    return { sha };
  });
  return { h, sha: h.sha };
}

function pin(h) {
  h.ok(['project', 'set', '--tests-cmd', 'node test/value.test.js',
    '--clean-cmd', h.env.TOWER_CRANE_CLEAN_CMD]);
}

const shown = (h, type) => h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === type);
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('unpinned agent commands cannot execute a shell payload', (t) => {
  const { h } = fixture(t);
  // Remove fixture configuration through the owner CLI.
  if (h.readState('project.json').gates) h.ok(['project', 'set', '--tests-cmd', 'null', '--clean-cmd', 'null']);
  const marker = path.join(h.base, 'executed');
  const script = path.join(h.base, 'payload.js');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  const cmd = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
  for (const type of ['tests', 'clean']) {
    const r = h.run(['check', type, 'T1', '--cmd', cmd, '--agent', 'worker', '--json'],
      { env: { TOWER_CRANE_CLEAN_CMD: cmd } });
    assert.equal(r.code, 1, r.stderr + r.stdout);
    const summary = JSON.parse(r.stdout).summary;
    assert.match(summary, new RegExp(`no ${type === 'tests' ? 'test' : 'cleanup'} command pinned`));
    assert.doesNotMatch(summary, /--cmd differs from the pinned/);
    assert.equal(fs.existsSync(marker), false, `${type} executed an unpinned command`);
  }
});

test('status reports when no test or cleanup command is pinned', (t) => {
  const { h } = fixture(t);
  h.ok(['project', 'set', '--tests-cmd', 'null', '--clean-cmd', 'null']);

  assert.match(h.ok(['status']), /gates blocked: no pinned commands/);
});

test('only the orchestrator or the explicit owner can set or clear gate commands at init and project set', (t) => {
  for (const flag of ['--tests-cmd', '--clean-cmd', '--tests-proof-cmd']) {
    const h = makeRepo(t);
    const init = h.run(['init', '--name', 'demo', '--goal', 'work', flag, 'node check.js', '--agent', 'worker']);
    assert.equal(init.code, 1, init.stderr);
    assert.match(init.stderr, /only the orchestrator or the owner/);
    assert.equal(fs.existsSync(path.join(h.state, 'project.json')), false);
    h.init([flag, flag === '--tests-proof-cmd' ? 'node {tests}' : 'node check.js']);
    const before = h.readState('project.json');
    for (const value of ['node other.js', 'null', before.gates[flag.slice(2).replaceAll('-', '_')]]) {
      const r = h.run(['project', 'set', flag, value, '--agent', 'worker']);
      assert.equal(r.code, 1, r.stderr);
      assert.deepEqual(h.readState('project.json'), before);
    }
    for (const value of ['', '   ']) {
      assert.equal(h.run(['project', 'set', flag, value]).code, 2);
      assert.deepEqual(h.readState('project.json'), before);
    }
  }
});

test('gates use pinned commands and reject differing flags and cleanup environment before execution', (t) => {
  const { h, sha } = fixture(t);
  pin(h);
  for (const type of ['tests', 'clean']) {
    const r = h.run(['check', type, 'T1', '--cmd', 'node -e "process.exit(0)"', '--agent', 'worker', '--json']);
    assert.equal(r.code, 1, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).commands, []);
    assert.match(JSON.parse(r.stdout).summary, /pinned/);
  }
  const r = h.run(['check', 'clean', 'T1', '--json'],
    { env: { TOWER_CRANE_CLEAN_CMD: 'node -e "process.exit(0)"' } });
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).commands, []);
  for (const type of ['tests', 'clean']) {
    const receipt = h.json(['check', type, 'T1', '--agent', 'worker'],
      { env: { TOWER_CRANE_CLEAN_CMD: '' } });
    assert.equal(receipt.ok, true);
    assert.deepEqual(events(h).at(-1).detail.gate_policy, receipt.gate_policy);
    assert.equal(shown(h, type).ok, true);
  }
  h.ok(['project', 'set', '--clean-cmd', `${h.env.TOWER_CRANE_CLEAN_CMD} --base=${sha}`]);
  h.ok(['check', 'clean', 'T1'], { env: { TOWER_CRANE_CLEAN_CMD: '' } });
  assert.equal(shown(h, 'clean').ok, true, 'the pinned prefix can contain its own arguments');
});

test('terminal owner fallback cannot pin gate commands', { skip: !PTY_AVAILABLE }, (t) => {
  const h = makeRepo(t);
  h.init();
  const before = h.readState('project.json');
  const env = { ...h.env };
  delete env.TOWER_CRANE_AGENT;
  const result = runPty(['project', 'set', '--tests-cmd', 'node check.js'], { cwd: h.repo, env });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /only the orchestrator or the owner/);
  assert.deepEqual(h.readState('project.json'), before);
});

for (const type of ['tests', 'clean']) {
  test(`${type} command changes stale receipts at acceptance and merge until rerun`, (t) => {
    const { h, sha } = fixture(t);
    pin(h);
    h.ok(['check', 'tests', 'T1']);
    h.ok(['check', 'clean', 'T1']);
    h.reviewer('T1', 'reviewer', sha);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer']);
    const previous = h.readState('project.json').gates[`${type}_cmd`];
    const changed = `${previous} `;
    // A semantic change to the shell command, preserving fixture behavior.
    h.ok(['project', 'set', `--${type}-cmd`, `${changed}--fixture`]);
    if (type === 'clean') h.env.TOWER_CRANE_CLEAN_CMD = `${changed}--fixture`;
    assert.equal(shown(h, type).ok, false);
    const accept = h.run(['accept', 'T1']);
    assert.equal(accept.code, 1);
    assert.match(accept.stderr, /command.*(changed|matches)/);
    h.ok(['check', type, 'T1']);
    h.ok(['accept', 'T1']);
    h.ok(['project', 'set', `--${type}-cmd`, previous]);
    const merge = h.run(['merge', 'T1']);
    assert.equal(merge.code, 1);
    assert.match(merge.stderr, /its gates no longer pass.*command/);
  });

  test(`${type} legacy and mismatched command receipts cannot satisfy acceptance`, (t) => {
    const { h } = fixture(t);
    pin(h);
    h.ok(['check', type, 'T1']);
    const tasks = h.readState('tasks.json');
    const audit = events(h);
    const entry = tasks.tasks[0].evidence.at(-1);
    const detail = audit.at(-1).detail;
    delete entry.gate_policy;
    delete detail.gate_policy;
    h.writeState('tasks.json', tasks);
    fs.writeFileSync(path.join(h.state, 'events.jsonl'), audit.map(JSON.stringify).join('\n') + '\n');
    assert.equal(shown(h, type).ok, false);
    h.ok(['check', type, 'T1']);
    const fresh = h.readState('tasks.json');
    const freshAudit = events(h);
    const run = fresh.tasks[0].evidence.at(-1).commands.find((c) => c.command !== 'git');
    const auditedRun = freshAudit.at(-1).detail.commands.find((c) => c.command !== 'git');
    run.command = auditedRun.command = 'node -e "process.exit(0)"';
    h.writeState('tasks.json', fresh);
    fs.writeFileSync(path.join(h.state, 'events.jsonl'), freshAudit.map(JSON.stringify).join('\n') + '\n');
    assert.equal(shown(h, type).ok, false, 'matching audit alone cannot substitute a different command');
  });
}

test('expensive proof uses an owner-pinned template and rejects caller-selected payloads', (t) => {
  const { h } = fixture(t);
  pin(h);
  h.ok(['project', 'set', '--tests-expensive', 'true', '--tests-proof-cmd', 'node {tests}']);
  const bad = h.run(['check', 'tests', 'T1', '--proof-cmd', 'node -e "process.exit(0)" {tests}', '--json']);
  assert.equal(bad.code, 1, bad.stderr);
  assert.deepEqual(JSON.parse(bad.stdout).commands, []);
  const pass = h.json(['check', 'tests', 'T1']);
  assert.equal(pass.ok, true);
  assert.equal(pass.gate_policy.tests_proof_cmd, 'node {tests}');
  const tasks = h.readState('tasks.json');
  const audit = events(h);
  const entry = tasks.tasks[0].evidence.at(-1);
  const detail = audit.at(-1).detail;
  const proofCommand = entry.gate_policy.tests_proof_cmd.replaceAll('{tests}', entry.receipt.proof_tests.map(shellQuote).join(' '));
  const proof = entry.commands.find((c) => c.command === proofCommand && c.status !== 0);
  assert.ok(proof, 'the scoped failing proof has a recorded command');
  // The full suite receipt remains valid while the failing proof is substituted.
  const index = entry.commands.indexOf(proof);
  entry.commands[index].command = detail.commands[index].command = 'node -e "process.exit(1)"';
  h.writeState('tasks.json', tasks);
  fs.writeFileSync(path.join(h.state, 'events.jsonl'), audit.map(JSON.stringify).join('\n') + '\n');
  assert.equal(shown(h, 'tests').ok, false);
  h.ok(['check', 'tests', 'T1']);
  h.ok(['project', 'set', '--tests-proof-cmd', 'node --trace-warnings {tests}']);
  assert.equal(shown(h, 'tests').ok, false);
});

for (const type of ['tests', 'clean']) {
  test(`individual ${type} receipts stay visibly stale after a command change and a fresh pass`, (t) => {
    const { h, sha } = fixture(t);
    pin(h);
    h.ok(['check', 'tests', 'T1']);
    h.ok(['check', 'clean', 'T1']);
    h.reviewer('T1', 'reviewer', sha);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer']);
    h.ok(['accept', 'T1']);
    const entries = () => h.ok(['task', 'show', 'T1']).split('\n').filter((line) => line.startsWith(`  - ${type} ok at`));
    const sheet = () => fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8').match(/<article id="T1"[\s\S]*?<\/article>/)[0];
    assert.equal(entries().length, 1);
    assert.doesNotMatch(entries()[0], /does not count/);

    const previous = h.readState('project.json').gates[`${type}_cmd`];
    const next = type === 'tests' ? 'node --trace-warnings test/value.test.js' : `${previous} --fixture`;
    h.ok(['project', 'set', `--${type}-cmd`, next]);
    assert.match(entries()[0], /does not count/);
    assert.match(sheet(), new RegExp(`class="nocount">\\(does not count: ${type} evidence command policy`));
    assert.match(sheet(), new RegExp(`class="pip missing">${type}</span>`));

    h.ok(['check', type, 'T1'], { env: { TOWER_CRANE_CLEAN_CMD: '' } });
    assert.equal(entries().length, 2);
    assert.match(entries()[0], /does not count/);
    assert.doesNotMatch(entries()[1], /does not count/);
    assert.equal((sheet().match(new RegExp(`does not count: ${type} evidence command policy`, 'g')) || []).length, 1);
    assert.match(sheet(), new RegExp(`class="pip pass">${type}</span>`));
  });
}

test('changing only an evidence policy cannot reuse an audited pass for the new pin', (t) => {
  const { h } = fixture(t);
  pin(h);
  h.ok(['check', 'tests', 'T1']);
  h.ok(['project', 'set', '--tests-cmd', 'node --trace-warnings test/value.test.js']);
  const tasks = h.readState('tasks.json');
  tasks.tasks[0].evidence.at(-1).gate_policy.tests_cmd = h.readState('project.json').gates.tests_cmd;
  h.writeState('tasks.json', tasks);
  assert.equal(shown(h, 'tests').ok, false);
});

// Starts a run-only tests check whose command waits until the test releases it.
async function holdTestsCheck(h, t) {
  const ready = path.join(h.base, 'ready');
  const release = path.join(h.base, 'release');
  const script = path.join(h.base, 'wait.js');
  fs.writeFileSync(script, `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
const started = Date.now();
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); }
  else if (Date.now() - started > 10000) { process.exit(1); }
}, 10);
`);
  const cmd = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
  h.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd', cmd]);
  const pending = h.runAsync(['check', 'tests', 'T1', '--json']);
  t.after(() => { if (fs.existsSync(h.base)) fs.writeFileSync(release, 'release'); });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready)) {
    assert.ok(Date.now() < deadline, 'gate did not start');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { cmd, pending, release: () => fs.writeFileSync(release, 'release') };
}

test('a pin changed while a gate runs cannot relabel its old command receipt', async (t) => {
  const { h } = fixture(t);
  const held = await holdTestsCheck(h, t);
  h.ok(['project', 'set', '--tests-cmd', `${held.cmd} changed`]);
  held.release();
  const r = await held.pending;
  assert.equal(r.code, 0, r.stderr);
  const evidence = JSON.parse(r.stdout);
  assert.equal(evidence.gate_policy.tests_cmd, held.cmd);
  assert.deepEqual(events(h).at(-1).detail.gate_policy, evidence.gate_policy);
  assert.equal(shown(h, 'tests').ok, false);
});

test('a tests.paths change while a gate runs cannot relabel its old receipt', async (t) => {
  const { h } = fixture(t);
  const held = await holdTestsCheck(h, t);
  h.ok(['project', 'set', '--tests-paths', '["elsewhere/**"]']);
  held.release();
  const r = await held.pending;
  assert.equal(r.code, 0, r.stderr);
  const evidence = JSON.parse(r.stdout);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.gate_policy.paths, null);
  assert.deepEqual(events(h).at(-1).detail.gate_policy, evidence.gate_policy);
  assert.equal(shown(h, 'tests').ok, false);
});

// Each setting decides which tests prove the change, so a pass under the previous setting does not count.
for (const [name, before, change] of [
  ['tests.paths', [], ['--tests-paths', '["elsewhere/**"]']],
  ['tests.keep', ['--tests-keep', '["value.js"]'], ['--tests-keep', 'null']],
  ['tests.keep from unset to an empty list', [], ['--tests-keep', '[]']],
  ['tests.expensive', [], ['--tests-expensive', 'true']],
]) {
  test(`changing ${name} makes a passing tests proof stale at acceptance and merge`, (t) => {
    const { h, sha } = fixture(t);
    pin(h);
    if (before.length) h.ok(['project', 'set', ...before]);
    h.ok(['check', 'tests', 'T1']);
    h.ok(['check', 'clean', 'T1']);
    h.reviewer('T1', 'reviewer', sha);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer']);
    h.ok(['accept', 'T1']);
    assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
    h.ok(['project', 'set', ...change]);
    assert.equal(shown(h, 'tests').ok, false);
    assert.match(shown(h, 'tests').reason, /tests paths, keep, expensive, map or required CI setting/);
    const merge = h.run(['merge', 'T1']);
    assert.equal(merge.code, 1);
    assert.match(merge.stderr, /its gates no longer pass.*tests paths, keep, expensive, map or required CI setting/);
  });
}

test('an unrelated executor setting keeps a passing tests proof valid', (t) => {
  const { h } = fixture(t);
  pin(h);
  h.ok(['check', 'tests', 'T1']);
  h.ok(['project', 'set', '--executors', '3']);
  assert.equal(shown(h, 'tests').ok, true);
});
