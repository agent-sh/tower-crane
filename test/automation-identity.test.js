'use strict';

// Who may run reactions, the environment of gates and merges a supervisor runs,
// review dispatch with revuto findings, reviewer replacement, supervised
// submissions, refill holds and revisions a restore retired.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { waitOnRepo, killPid } = require('./signals');
const { BIN } = require('./helpers');
const { gateEvidence, retireRevision } = require('./gate-helpers');
const { waitFor } = require('./canary');
const { shellQuote } = require('../lib/gates/common');
const { readPublished } = require('./atomic-file');
const { setup, configureHarness, refillFixture, harness } = require('./automation-helpers');
const StateFiles = require('./state-files');

// A gone holder's marker that cannot be removed stays until a person acts.
test('the wait host reports a dispatch lock it cannot clear once, not on every pass', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'permission bits do not bind' }, async (t) => {
  const h = refillFixture(t);
  const os = require('node:os');
  const cp = require('node:child_process');
  const dir = path.join(h.state, 'dispatch', 'lock');
  fs.mkdirSync(dir, { recursive: true });
  const gone = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const nonce = 'a1b2c3d4e5f60718';
  fs.writeFileSync(path.join(dir, nonce), JSON.stringify({ pid: Number(gone.stdout), host: os.hostname(), at: new Date().toISOString(), nonce }));
  const old = new Date(Date.now() - 5 * 60000);
  fs.utimesSync(path.join(dir, nonce), old, old);
  fs.chmodSync(dir, 0o555);
  let result;
  try {
    result = await h.runAsync(['wait', '--types', 'spawn', '--timeout', '5', '--agent', 'orchestrator']); // wait-allow: the refill passes in this window are what the test counts
  } finally {
    // Before the fixture's cleanup, which removes the directory.
    fs.chmodSync(dir, 0o755);
  }
  assert.equal(result.code, 2, result.stderr);
  const reports = result.stderr.split('\n').filter((line) => /automation refill: .*worker dispatch is locked by pid \d+ .*which is gone, but its lock could not be removed/.test(line));
  assert.equal(reports.length, 1, result.stderr);
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0);
});

function startupContexts(h, withRules) {
  const startups = h.logs().filter((e) => e.cmd === 'startup');
  assert.deepEqual(startups.map((e) => e.detail.role), ['worker', 'reviewer']);
  for (const { task, detail } of startups) {
    const report = JSON.parse(fs.readFileSync(path.join(h.env.AUTOMATION_CONTEXT_DIR, `${detail.agent}.json`), 'utf8'));
    assert.equal(report.harness, 'command');
    assert.equal(report.args[2], report.prompt, 'the shared stub records the delivered argument');
    assert.match(report.prompt, /^## Goal\n/);
    assert.ok(report.prompt.includes(`Project goal: ${detail.goal}`));
    const target = JSON.parse(/## Task\s+```json\n([\s\S]*?)\n```/.exec(report.prompt)[1]);
    assert.equal(target.id, task);
    assert.equal(target.title, detail.target.title);
    assert.equal(target.acceptance.length, detail.target.acceptance);
    assert.equal(detail.receives_prompt, true);
    assert.equal(detail.prompt_bytes, Buffer.byteLength(report.prompt));
    assert.equal(detail.prompt_tokens, Math.ceil(detail.prompt_bytes / 4));
    assert.equal(report.prompt.includes('## House rules'), detail.rules.length > 0);
    if (withRules) {
      assert.ok(detail.rules.some((r) => r.path === path.join(h.base, 'AGENTS.md') && r.loaded === 'read'));
      for (const rule of detail.rules) assert.ok(report.prompt.includes(rule.path));
    } else {
      // A temp root beneath another checkout can inherit that checkout's rules.
      assert.equal(detail.rules.some((rule) => rule.path === path.join(h.base, 'AGENTS.md')), false);
      for (const rule of detail.rules) assert.ok(report.prompt.includes(rule.path));
      assert.equal(detail.rules_bytes, detail.rules.reduce((bytes, rule) => bytes + rule.bytes, 0));
      assert.equal(detail.rules_tokens, Math.ceil(detail.rules_bytes / 4));
    }
  }
}

test('a worker identity cannot authorize reactions by passing the orchestrator name', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const result = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'],
    { env: { TOWER_CRANE_AGENT: 'worker', TOWER_CRANE_TASK: 'T1' } });
  assert.equal(result.code, 2);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
});

test('a worker that names its own identity cannot complete CI or run reactions as the orchestrator', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const worker = { env: { TOWER_CRANE_AGENT: 'worker-T1-1' } };
  const completed = h.run(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'worker-T1-1'], worker);
  assert.equal(completed.code, 1, completed.stderr);
  assert.match(completed.stderr, /ci completed is an orchestrator or owner command/);
  const waited = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'worker-T1-1'], worker);
  assert.equal(waited.code, 2, waited.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
  assert.equal(h.logs().filter((e) => e.cmd === 'ci completed').length, 0);
  h.consume();
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.map((e) => e.type), ['tests', 'clean', 'ci'],
    'the orchestrator still runs the reactions');
});

test('supervisor reactions pin unconfigured gates and bypass the real restrictive agent shims', async (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node test/value.test.js' } }));
  h.git(['add', 'package.json']);
  h.git(['commit', '-qm', 'detectable test command']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  h.saveGithub(state);
  h.ok(['project', 'set', '--tests-cmd', 'null', '--clean-cmd', 'null']);
  configureHarness(h);
  h.env.AUTOMATION_POLICY_PROBE = path.join(h.base, 'policy-probe.jsonl');
  h.ok(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  await waitOnRepo(h, () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok));
  const pins = h.logs().filter((e) => e.cmd === 'gates pin');
  assert.deepEqual(pins.map((e) => e.detail.key), ['tests_cmd', 'clean_cmd']);
  assert.ok(pins.every((e) => e.agent === 'orchestrator' && e.detail.authority === 'orchestrator'));
  const probes = fs.readFileSync(h.env.AUTOMATION_POLICY_PROBE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(probes.length, 2);
  assert.ok(probes.every((p) => p.denials.every((d) => d.status === 126 && /not allowed/.test(d.stderr))), JSON.stringify(probes));
  assert.ok(probes.every((p) => p.path.includes(path.join(h.state, 'homes'))));
  startupContexts(h, false);
});

test('gates and merges a supervisor runs keep the host environment, not its agent\'s home, shims, cache or identity', { skip: process.platform === 'win32' && 'the pi stub and git hook are shebang scripts' }, async (t) => {
  const h = setup(t);
  configureHarness(h);
  // Git reads ~/.gitconfig as the global file: a home's config is the user's.
  delete h.env.GIT_CONFIG_GLOBAL;
  const probe = (name) => path.join(h.base, `${name}.jsonl`);
  const read = (name) => (fs.existsSync(probe(name)) ? readPublished(probe(name), 'utf8').trim().split('\n').map(JSON.parse) : []);
  // Each agent writes a global git config in its own home, which runs a hook on checkout.
  const hooks = path.join(h.base, 'planted-hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\necho "$PWD" >> ${shellQuote(probe('planted-hook'))}\n`, { mode: 0o755 });
  const bin = path.join(h.base, 'agent-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pi'), `#!${process.execPath}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
fs.writeFileSync(path.join(os.homedir(), '.gitconfig'), '[core]\\n\\thooksPath = ' + ${JSON.stringify(hooks)} + '\\n');
fs.appendFileSync(${JSON.stringify(probe('agent'))}, JSON.stringify({ HOME: os.homedir(), XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }) + '\\n');
process.argv.splice(2, 0, ${JSON.stringify(BIN)}, 'auto');
require(${JSON.stringify(harness)});
`, { mode: 0o755 });
  for (const rung of ['easy', 'review']) h.ok(['ladder', 'set', rung, '--harness', 'pi', '--model', 'stub-model',
    ...['profile', 'provider', 'effort', 'args', 'command'].flatMap((f) => ['--clear', f])]);
  const record = `const fs = require('node:fs');
const { HOME, PATH, XDG_CACHE_HOME, TMPDIR, TOWER_CRANE_AGENT, TOWER_CRANE_TASK, TOWER_CRANE_HOOK } = process.env;
fs.appendFileSync(${JSON.stringify(probe('tests-gate'))}, JSON.stringify({ HOME, PATH, XDG_CACHE_HOME, TMPDIR, TOWER_CRANE_AGENT, TOWER_CRANE_TASK, TOWER_CRANE_HOOK }) + '\\n');
require(require('node:path').resolve('test/value.test.js'));
`;
  fs.writeFileSync(path.join(h.base, 'tests-gate.js'), record);
  const tmpRoot = path.join(h.base, 'project-tmp');
  fs.mkdirSync(tmpRoot);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(path.join(h.base, 'tests-gate.js'))}`, '--tests-mode', 'run-only',
    '--tmp-root', tmpRoot]);
  h.env.AUTOMATION_ENV_PROBE = probe('gh');
  h.env.PATH = `${bin}${path.delimiter}${h.env.PATH}`;
  // The dispatcher's own gate root, which a gate the supervisor runs later must not keep.
  assert.ok(h.env.TOWER_CRANE_TMP);
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  await waitOnRepo(h, () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok),
    () => JSON.stringify(h.logs().slice(-10)));
  // The agents ran in their own homes and caches, so the host values below are not theirs.
  const agents = read('agent');
  assert.equal(agents.length, 2);
  for (const agent of agents) {
    assert.ok(agent.HOME.startsWith(path.join(h.state, 'homes')), agent.HOME);
    assert.notEqual(agent.XDG_CACHE_HOME, h.env.XDG_CACHE_HOME);
  }
  const planted = fs.existsSync(probe('planted-hook')) ? readPublished(probe('planted-hook'), 'utf8') : '';
  assert.equal(planted, '', 'no gate git ran a hook from an agent home');
  const host = (seen) => {
    assert.equal(seen.HOME, h.env.HOME);
    assert.equal(seen.XDG_CACHE_HOME, h.env.XDG_CACHE_HOME);
    assert.ok(!seen.PATH.includes(path.join(h.state, 'homes')), seen.PATH);
    // The dispatcher's identity, or the orchestrator a reaction dispatched the reviewer as; never a spawned agent's.
    assert.ok([h.env.TOWER_CRANE_AGENT, 'orchestrator'].includes(seen.TOWER_CRANE_AGENT), seen.TOWER_CRANE_AGENT);
    assert.equal(seen.TOWER_CRANE_TASK, undefined);
  };
  const gates = read('tests-gate');
  assert.ok(gates.length >= 1);
  for (const seen of gates) {
    host(seen);
    assert.equal(seen.TOWER_CRANE_HOOK, undefined);
    assert.ok(seen.TMPDIR.startsWith(tmpRoot), seen.TMPDIR);
  }
  const merges = read('gh').filter((call) => call.args[0] === 'pr' && call.args[1] === 'merge');
  assert.equal(merges.length, 1);
  host(merges[0]);
  assert.equal(merges[0].TOWER_CRANE_SANDBOX, undefined);
  const tests = h.readState('tasks.json').tasks[0].evidence.find((e) => e.type === 'tests');
  assert.equal(tests.tmp_root, tmpRoot);
});

test('large review dispatch hands revuto findings to the reviewer and an ok that ignores a P1 is refused', async (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, 'large.md'), 'A focused review reads this diff. '.repeat(1000) + '\n');
  h.git(['add', 'large.md']);
  h.git(['commit', '-qm', 'large review diff']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  configureHarness(h);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  state.ci[h.sha] = 'success';
  const comment = (id, body, extra = {}) => ({ id, in_reply_to_id: null, path: 'src.js', line: 3, original_line: 3, body,
    user: 'revuto-review[bot]', original_commit_id: h.sha, html_url: `https://github.com/acme/demo/pull/7#discussion_r${id}`, ...extra });
  state.comments = [
    comment(101, '[P1] The loop never terminates on empty input.'),
    comment(102, '[P2] Missing null check.'),
    { ...comment(103, '[resolved]\nFixed by the guard above.'), in_reply_to_id: 102, user: 'worker' },
    comment(104, 'Nit: rename this.'),
    comment(105, '[P1] Outdated finding.', { line: null }),
    comment(106, '[P1] Not from revuto.', { user: 'someone' }),
  ];
  h.saveGithub(state);
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  await waitOnRepo(h, () => h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.role === 'reviewer'),
    () => JSON.stringify(h.logs().slice(-10)));
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.deepEqual(review.detail.revuto.map((f) => [f.id, f.severity, f.reply]), [[101, 'P1', null], [102, 'P2', 103], [104, null, null]]);
  const brief = fs.readFileSync(path.join(h.state, 'reviews', `T1-${h.sha}.md`), 'utf8');
  assert.match(brief, /## Revuto findings/);
  assert.match(brief, /### \[P1\] src\.js:3 \(comment 101\)\n\n\[P1\] The loop never terminates on empty input\./);
  assert.match(brief, /### \[P2\] src\.js:3 \(comment 102, resolved in reply 103\)/);
  assert.match(brief, /### src\.js:3 \(comment 104\)/);
  assert.doesNotMatch(brief, /Outdated finding|Not from revuto/);
  const contextFile = path.join(h.env.AUTOMATION_CONTEXT_DIR, `${review.detail.agent}.json`);
  assert.ok(fs.existsSync(contextFile), fs.readFileSync(review.detail.log, 'utf8'));
  const { prompt } = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  assert.match(prompt, /Read .*reviews.* for the diff at/);
  assert.match(prompt, /## Revuto findings/);
  assert.match(prompt, /### \[P1\] src\.js:3 \(comment 101\)\n\n\[P1\] The loop never terminates on empty input\./);
  assert.match(prompt, /## Gate results/);
  assert.doesNotMatch(prompt, /diff --git a\/large.md/);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.evidence.some((e) => e.type === 'review'), false, 'the reviewer ok was refused');
  assert.equal(task.status, 'submitted');
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', review.detail.agent]);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /review ok refused; revuto \[P1\] comment 101 at src\.js:3 \(https:\/\/github\.com\/acme\/demo\/pull\/7#discussion_r101\)/);
  assert.doesNotMatch(refused.stderr, /comment 10[2-6]/);
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--fail', '--agent', review.detail.agent]);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('brokered review evidence clears a revuto finding whose file changed since the comment', async (t) => {
  const h = setup(t);
  configureHarness(h);
  const state = h.github();
  const before = h.git(['rev-parse', `${h.sha}^`]);
  const comment = (id, commit) => ({ id, in_reply_to_id: null, path: 'value.js', line: 1, original_line: 1, body: `[P1] finding ${id}`,
    user: 'revuto-review[bot]', original_commit_id: commit, html_url: null });
  // value.js changed between before and the head; nothing changed after the head.
  state.comments = [comment(201, before), comment(202, h.sha)];
  h.saveGithub(state);
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  await waitOnRepo(h, () => h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.role === 'reviewer'),
    () => JSON.stringify(h.logs().slice(-10)));
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.deepEqual(review.detail.revuto.map((f) => [f.id, f.changed]), [[201, true], [202, false]]);
  // The state broker runs evidence with TOWER_CRANE_VIA=broker, where tower-crane reads no repository.
  const broker = { env: { ...h.env, TOWER_CRANE_VIA: 'broker' } };
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', review.detail.agent, '--state', h.state], broker);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /review ok refused; revuto \[P1\] comment 202 at value\.js:1 has no code change/);
  assert.doesNotMatch(refused.stderr, /comment 201/);
});

test('revuto findings on bracketed paths require a change to the literal file', async (t) => {
  const h = setup(t);
  configureHarness(h);
  fs.mkdirSync(path.join(h.repo, 'routes'));
  fs.writeFileSync(path.join(h.repo, 'routes', '[id].js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(h.repo, 'routes', 'i.js'), 'module.exports = 1;\n');
  h.git(['add', 'routes']);
  h.git(['commit', '-qm', 'add route fixtures']);
  const commented = h.git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(h.repo, 'routes', 'i.js'), 'module.exports = 2;\n');
  h.git(['add', 'routes']);
  h.git(['commit', '-qm', 'change sibling route']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  state.ci[h.sha] = 'success';
  h.saveGithub(state);
  h.submit();
  // Revuto posts after the submit: one already on the PR would refuse it, as review ok does.
  const posted = h.github();
  posted.comments = [{ id: 401, in_reply_to_id: null, path: 'routes/[id].js', line: 1,
    body: '[P1] The dynamic route is still broken.', user: 'revuto-review[bot]', original_commit_id: commented }];
  h.saveGithub(posted);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  const first = await h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  assert.equal(first.code, 1, first.stdout + first.stderr);
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.equal(review.detail.revuto[0].changed, false);
  const broker = { env: { ...h.env, TOWER_CRANE_VIA: 'broker' } };
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok',
    '--agent', review.detail.agent, '--state', h.state], broker);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /review ok refused; revuto \[P1\] comment 401 at routes\/\[id\]\.js:1/);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok), false);

  fs.writeFileSync(path.join(h.repo, 'routes', '[id].js'), 'module.exports = 2;\n');
  h.git(['add', 'routes']);
  h.git(['commit', '-qm', 'fix dynamic route']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  const updated = h.github();
  updated.prs['7'].headRefOid = h.sha;
  updated.ci[h.sha] = 'success';
  h.saveGithub(updated);
  h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '7', '--agent', 'worker']);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  const fixed = await h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
  const latest = h.logs().findLast((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.equal(latest.detail.revuto[0].changed, true);
  assert.ok(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok && e.sha === h.sha));
});

test('revuto replies require an explicit resolution and later discussion reopens the finding', async (t) => {
  const h = setup(t);
  configureHarness(h);
  const before = h.git(['rev-parse', `${h.sha}^`]);
  const finding = (id, commit = h.sha) => ({ id, in_reply_to_id: null, path: 'value.js', line: 1,
    body: `[P1] finding ${id}`, user: 'revuto-review[bot]', original_commit_id: commit });
  const reply = (id, thread, body) => ({ id, in_reply_to_id: thread, user: 'worker', body });
  // A tracked worker lets automatic reactions dispatch another reviewer after
  // a refused verdict; this test controls both snapshots with native submission.
  h.submit();
  // Revuto posts after the submit: open [P1] findings already on the PR would refuse it, as review ok does.
  const state = h.github();
  state.comments = [
    finding(301), reply(311, 301, 'I can still reproduce this. This is not fixed.'),
    finding(302), reply(312, 302, '[resolved]\nFixed by the guard above.'),
    finding(303, before), reply(313, 303, 'Please explain this change.'),
    finding(304), reply(314, 304, 'Not fixed yet.'), reply(324, 304, '[RESOLVED]'),
    finding(305), reply(315, 305, '[resolved]'), reply(325, 305, 'I can still reproduce this.'),
    finding(306), reply(316, 306, '> [resolved]\nThis is a quote, not a resolution.'),
  ];
  h.saveGithub(state);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  const first = await h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  assert.equal(first.code, 1, first.stdout + first.stderr);
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const broker = { env: { ...h.env, TOWER_CRANE_VIA: 'broker' } };
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok',
    '--agent', review.detail.agent, '--state', h.state], broker);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  for (const id of [301, 305, 306]) assert.match(refused.stderr, new RegExp(`comment ${id} at value\\.js:1`));
  assert.doesNotMatch(refused.stderr, /comment 30[234]/);
  assert.deepEqual(review.detail.revuto.map((f) => [f.id, f.reply, f.resolved, f.changed]), [
    [301, 311, false, false], [302, 312, true, false], [303, 313, false, true],
    [304, 324, true, false], [305, 325, false, false], [306, 316, false, false],
  ]);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review'), false);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);

  const updated = h.github();
  for (const id of [301, 305, 306]) updated.comments.push(reply(id + 100, id, '[resolved]\nVerified at this head.'));
  h.saveGithub(updated);
  const rerun = await h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  assert.equal(rerun.code, 0, rerun.stdout + rerun.stderr);
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker').length, 0);
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 2);
  assert.ok(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok));
});

// A poll can read the event log mid-append; that read counts as not yet.
function pollUntil(h, what, check) {
  return waitOnRepo(h, check, () => `${what}: ${JSON.stringify(h.logs().slice(-10))}`);
}

test('a reviewer that exits 1 without a verdict is replaced at the same head', async (t) => {
  const h = setup(t);
  configureHarness(h);
  h.env.AUTOMATION_REVIEW_CRASH_ONCE = path.join(h.base, 'review-crashed');
  const reviewers = () => h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  await pollUntil(h, 'replacement review', () => reviewers().length === 2
    && h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok));
  const exit = h.logs().find((e) => e.cmd === 'spawn exit' && e.detail.agent === reviewers()[0].detail.agent);
  assert.equal(exit.detail.code, 1);
  assert.equal(h.logs().some((e) => e.cmd === 'review held'), false);
});

test('a reviewer whose monitor never records its exit is replaced after the receipt bound with one notice', async (t) => {
  const h = setup(t);
  configureHarness(h);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  const task = h.readState('tasks.json').tasks[0];
  const at = new Date().toISOString();
  // The worker exited; the reviewer's process is gone, and its monitor (this
  // test process) runs on without writing the reviewer's spawn exit.
  StateFiles.appendLog(h.state, [
    { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail: { agent: 'worker', role: 'worker', sha: task.sha, revision: task.revision, pid: 999998, attempt: 1 } },
    { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T1', detail: { agent: 'worker', pid: 999998, attempt: 1, code: 0 } },
    { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail: { agent: 'reviewer-T1-9', role: 'reviewer', rung: 'review',
      sha: task.sha, revision: task.revision, pid: 999999, attempt: 1, monitor_pid: process.pid, revuto: [] } },
  ].map((e) => `${JSON.stringify(e)}\n`).join(''));
  const reviewers = () => h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const missing = () => h.logs().filter((e) => e.cmd === 'review exit missing');
  h.consume();
  assert.equal(reviewers().length, 1, 'no replacement while the monitor may still record the exit');
  assert.equal(missing().length, 0);
  // Default supervision: 10 min max backoff, 7 s group cleanup and a 1 min drain.
  const clock = path.join(__dirname, 'fixtures', 'clock.js').replace(/\\/g, '/');
  // The clock preload joins the offline GitHub preload Windows needs rather than replacing it.
  const later = { env: { NODE_OPTIONS: `${h.env.NODE_OPTIONS || ''} --require "${clock}"`.trim(), TOWER_CRANE_TEST_NOW: String(Date.parse(at) + 11 * 60000 + 8000) } };
  h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'], later);
  await pollUntil(h, 'replacement reviewer', () => reviewers().length === 2);
  assert.equal(missing().length, 1);
  assert.equal(missing()[0].detail.agent, 'reviewer-T1-9');
  assert.equal(missing()[0].detail.reason, 'reviewer monitor did not record its exit');
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'review_exit_missing');
  assert.equal(item.task, 'T1');
  assert.deepEqual(item.action.argv.slice(0, 2), ['inbox', '--ack']);
  h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'], later);
  assert.equal(missing().length, 1, 'one notice per reviewer');
});

test('a reviewer that exits without a verdict is not respawned at that head until a revuto thread changes', async (t) => {
  const h = setup(t);
  configureHarness(h);
  h.env.AUTOMATION_REVIEW_NOTE = '1';
  const state = h.github();
  state.comments = [{ id: 501, in_reply_to_id: null, path: 'value.js', line: 1, body: '[P1] Bounds are unchecked.',
    user: 'revuto-review[bot]', original_commit_id: h.sha, html_url: 'https://github.com/acme/demo/pull/7#discussion_r501' }];
  h.saveGithub(state);
  const reviewers = () => h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const held = () => h.logs().filter((e) => e.cmd === 'review held');
  const until = (what, check) => pollUntil(h, what, check);
  const gone = (pid) => {
    try { killPid(pid, 0); return false; } catch { return true; }
  };
  // The reaction to a reviewer's exit is where automation used to dispatch the
  // next reviewer; its monitor finishes before the orchestrator acts again.
  const settled = (agent) => {
    const spawn = reviewers().find((e) => e.detail.agent === agent);
    const exit = h.logs().find((e) => e.cmd === 'spawn exit' && e.detail.agent === agent);
    return !!exit && h.logs().some((e) => e.cmd === 'automation' && e.detail.source === exit.id && e.detail.phase !== 'running')
      && gone(spawn.detail.monitor_pid);
  };
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  await until('first reviewer', () => reviewers().length > 0);
  const first = reviewers()[0].detail.agent;
  await until('first reviewer exit reaction', () => settled(first));
  assert.equal(reviewers().length, 1, 'no second reviewer at the same head');
  assert.equal(held().length, 1);
  const notice = held()[0];
  assert.equal(notice.to, 'orchestrator');
  assert.equal(notice.detail.agent, first);
  assert.equal(notice.detail.sha, h.sha);
  assert.deepEqual(notice.detail.exit, { code: 0, signal: null });
  assert.match(notice.detail.reason, /Review passed; evidence refused: .*review ok refused; revuto \[P1\] comment 501/);
  assert.match(notice.detail.reason, /\[resolved\]/, 'the refusal names how the finding gets resolved');
  assert.deepEqual(notice.detail.revuto, ['[P1] comment 501 at value.js:1 (https://github.com/acme/demo/pull/7#discussion_r501)']);
  const inbox = h.json(['inbox', '--agent', 'orchestrator']);
  const item = inbox.items.find((i) => i.kind === 'review_held');
  assert.equal(item.task, 'T1');
  assert.deepEqual(item.action.argv, ['accept', 'T1']);

  // A later reaction with nothing changed holds without a second notice.
  h.consume();
  assert.equal(reviewers().length, 1);
  assert.equal(held().length, 1);

  // Discussion on the thread is a new input: one more reviewer, held again when it stops the same way.
  const discussed = h.github();
  discussed.comments.push({ id: 511, in_reply_to_id: 501, user: 'owner', body: 'The guard is in parse.js.' });
  h.saveGithub(discussed);
  h.consume();
  await until('second reviewer', () => reviewers().length === 2);
  const second = reviewers()[1].detail.agent;
  await until('second reviewer exit reaction', () => settled(second));
  assert.equal(reviewers().length, 2);
  assert.deepEqual(held().map((e) => e.detail.agent), [first, second]);

  // The orchestrator resolves the finding: the reply re-enables dispatch and the next ok counts.
  const long = h.run(['ci', 'resolve', '501', '--task', 'T1', '--reason', 'x'.repeat(1001), '--agent', 'orchestrator']);
  assert.equal(long.code, 2, long.stderr);
  assert.match(long.stderr, /1001 characters; keep it to 1000/);
  const resolved = h.ok(['ci', 'resolve', '501', '--task', 'T1', '--reason', 'Fixed by the guard in parse.js, as @owner asked.', '--agent', 'orchestrator']);
  assert.match(resolved, /comment 501/);
  const reply = h.github().comments.at(-1);
  assert.equal(reply.in_reply_to_id, 501);
  assert.equal(reply.body, '[resolved]\nFixed by the guard in parse.js, as @\u200downer asked.\n\nby orchestrator');
  await until('third reviewer', () => reviewers().length === 3);
  assert.equal(reviewers()[2].detail.revuto[0].resolved, true);
  await until('review evidence', () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok));
  assert.equal(held().length, 2);
});

test('a supervised worker submission runs gates and dispatches the offline reviewer after exit', async (t) => {
  const h = setup(t);
  configureHarness(h, { rules: true });
  // A worker that owns its PR waits on it and its review starts at once (pr-owner.test.js); this one does not own it.
  h.ok(['project', 'set', '--owners', '0']);
  const hold = path.join(h.base, 'worker-hold');
  const spawned = h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'],
    { env: { AUTOMATION_WORKER_HOLD: hold } });
  try {
    await waitOnRepo(h, () => fs.existsSync(hold));
    h.consume();
    assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 0,
      'a worker still running after submit blocks review dispatch');
  } finally {
    fs.writeFileSync(`${hold}.go`, '');
    assert.equal((await spawned).code, 0);
  }
  // Reviewer completion has its own CLI command deadline after worker exit.
  await waitOnRepo(h, () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok));
  const events = h.logs();
  const review = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const exit = events.findIndex((e) => e.cmd === 'spawn exit' && e.detail.role === 'worker');
  assert.ok(review > exit);
  const workerStartup = events.findIndex((e) => e.cmd === 'startup' && e.detail.role === 'worker');
  const worker = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'worker');
  const reviewStartup = events.findIndex((e) => e.cmd === 'startup' && e.detail.role === 'reviewer');
  assert.ok(workerStartup >= 0 && workerStartup < worker && worker < exit);
  assert.ok(reviewStartup > exit && reviewStartup < review);
  startupContexts(h, true);
  assert.equal(events.filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 1);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

test('a submit the wait host reads before its files are renamed still runs the gates', async (t) => {
  const h = setup(t);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const started = path.join(h.base, 'wait-started');
  const waiter = h.runAsync(['wait', '--types', 'worker-message', '--timeout', '300', '--agent', 'orchestrator'],
    { hooks: { HOOK_WATCH_READY: started } });
  t.after(() => waiter);
  await waitFor(started);
  // The worker's commit pauses after its events reach the log, before
  // tasks.json moves to submitted, which the host reads in that window.
  h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '7', '--agent', 'worker'], { hooks: { HOOK_COMMIT_DELAY_MS: '2000' } });
  const submit = h.logs().findLast((e) => e.cmd === 'submit');
  // The host handles the submit before it wakes on a message logged after it.
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'done', '--agent', 'w-1']);
  assert.equal((await waiter).code, 0);
  const receipts = h.logs().filter((e) => e.cmd === 'automation' && e.detail.source === submit.id);
  assert.equal(receipts.at(-1)?.detail.phase, 'done', 'the host reacted to the submit');
  const tests = h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests');
  assert.equal(tests.length, 1, 'and ran its gates');
});

test('the refill hold ends at the rework time plus gates.rework_hold_min and only covers a restorable gate rework', () => {
  const Hold = require('../lib/rework-hold');
  const sha = 'a'.repeat(40);
  const at = '2026-10-15T00:00:00.000Z';
  const st = { project: { gates: {} }, events: [{ at, cmd: 'rework', task: 'T1', agent: 'orchestrator', via: 'automation',
    detail: { sha, previous_revision: 1, revision: 2, gate: 'ci' } }] };
  const task = { id: 'T1', status: 'rework', revision: 2, sha, claim: null };
  const start = Date.parse(at);
  assert.equal(Hold.holdEnd(st, task, start + 60000), '2026-10-15T00:05:00.000Z');
  assert.equal(Hold.holdEnd(st, task, start + 5 * 60000), null, 'refill proceeds once the window ends');
  assert.equal(Hold.holdEnd({ ...st, project: { gates: { rework_hold_min: 0 } } }, task, start), null, 'zero disables the hold');
  assert.equal(Hold.holdEnd({ ...st, project: { gates: { rework_hold_min: 0.5 } } }, task, start + 20000), '2026-10-15T00:00:30.000Z');
  assert.equal(Hold.holdEnd(st, { ...task, revision: 3 }, start), null, 'a task that can no longer be restored is not held');
  const person = { ...st, events: [{ ...st.events[0], detail: { sha, previous_revision: 1, revision: 2 } }] };
  assert.equal(Hold.holdEnd(person, task, start), null, 'a rework without a gate is not held');
  assert.deepEqual(Hold.errors({ rework_hold_min: -1 }).length, 1);
});

test('task update and brief set skip a revision a restore retired', (t) => {
  const h = setup(t);
  h.submit();
  const revision = () => h.readState('tasks.json').tasks[0].revision;
  let current = revision();
  retireRevision(h, 'T1', current + 1);
  h.ok(['task', 'update', 'T1', '--acceptance', 'it works everywhere']);
  assert.equal(revision(), current + 2, 'task update skips the retired number');
  current = revision();
  retireRevision(h, 'T1', current + 1);
  h.ok(['brief', 'set', 'T1', '-'], { input: '# Change\n\nImplement the new acceptance.\n' });
  assert.equal(revision(), current + 2, 'brief set skips the retired number');
});

test('a stack refresh and a quality climb skip a revision a restore retired', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'retired-'));
  try {
    const sha = 'a'.repeat(40);
    const task = () => ({ id: 'T1', title: 'Change', status: 'submitted', kind: 'code', size: 'M', tier: 'easy',
      tier_range: { min: 'easy', max: 'hard' }, revision: 2, sha, claim: null, notes: [], evidence: [], spend: { entries: [] }, escalations: [] });
    const st = { dir, project: {}, decisions: { decisions: [] },
      events: [{ at: '2026-10-15T00:00:00.000Z', cmd: 'restore', task: 'T1', agent: 'orchestrator', detail: { from_revision: 3, revision: 2 } }] };
    const emitted = [];
    const emit = (id, detail, cmd) => emitted.push({ id, detail, cmd });
    const refreshed = task();
    require('../lib/stack').sendBack(st, refreshed, 'stack sync moved the branch', 'orchestrator', emit);
    assert.equal(refreshed.revision, 4, 'a stack refresh skips the retired number');
    const climbed = task();
    require('../lib/escalation').recordFailure(st, emit, climbed, 'orchestrator', { trigger: 'tests', reason: 'tests failed', source: 'E1' });
    assert.equal(climbed.revision, 4, 'a quality climb skips the retired number');
    assert.deepEqual(emitted.filter((e) => e.cmd === 'rework').map((e) => e.detail.revision), [4, 4]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
