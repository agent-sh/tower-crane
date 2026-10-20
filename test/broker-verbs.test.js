'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { cachedFixture, ROOT } = require('./helpers');
const B = require('../lib/broker');
const C = require('../lib/containment');

const NODE = process.execPath;
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const WORKER = { TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: 'T1' };
const systemd = C.canScope();

const VERB_JS = `
const fs = require('node:fs');
const path = require('node:path');
const [campaign, rounds, out] = process.argv.slice(2);
fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ campaign, rounds, via: process.env.TOWER_CRANE_VIA ?? null }));
console.log('pinned', campaign, rounds, process.env.TOWER_CRANE_VERB);
`;

function verbs(sha) {
  const commit = { commit: sha, paths: ['tools'] };
  return {
    rehearse: {
      argv: [NODE, 'tools/verb.js', '{param.campaign}', '{param.rounds}', '{out}'], source: commit, timeout_sec: 60,
      outputs: ['receipt.json'], delegate: true,
      params: { campaign: { type: 'string', pattern: '[a-z0-9-]+' }, rounds: { type: 'integer', pattern: '[1-9][0-9]?' } },
    },
    private: { argv: [NODE, 'tools/verb.js', 'private', '1', '{out}'], source: commit, timeout_sec: 60 },
    sleepy: { argv: [NODE, 'tools/sleep.js'], source: commit, timeout_sec: 1, delegate: true },
    storm: {
      argv: [NODE, 'containment-harness.js', 'storm', 'unused'], source: { path: FIXTURES }, timeout_sec: 60, delegate: true,
      resources: { tasks_max: systemd ? 32 : 4, memory_max_bytes: 512 * 1024 * 1024 },
    },
    memory: {
      argv: [NODE, 'containment-harness.js', 'memory', 'unused'], source: { path: FIXTURES }, timeout_sec: 60, delegate: true,
      resources: { tasks_max: 64, memory_max_bytes: 96 * 1024 * 1024 },
    },
  };
}

function fixture(t) {
  const h = cachedFixture(t, 'broker-verbs', (h) => {
    h.init(['--base', 'main']);
    fs.mkdirSync(path.join(h.repo, 'tools'));
    fs.writeFileSync(path.join(h.repo, 'tools', 'verb.js'), VERB_JS);
    fs.writeFileSync(path.join(h.repo, 'tools', 'sleep.js'), "console.log('sleeping', process.pid); setInterval(() => {}, 1000);\n");
    h.git(['add', '-A']);
    h.git(['commit', '-qm', 'verb scripts']);
    const sha = h.git(['rev-parse', 'HEAD']);
    h.ok(['project', 'set', '--broker-verbs', JSON.stringify(verbs(sha))]);
    h.ok(['task', 'add', '--title', 'Lab rehearsal', '--acceptance', 'the rehearsal ran']);
    h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'other']);
    h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
    return { sha };
  });
  // Spawn records the task scratch; the test sets it the same way.
  h.scratch = path.join(h.base, 'scratch');
  fs.mkdirSync(h.scratch);
  const state = h.readState('tasks.json');
  state.tasks.find((t) => t.id === 'T1').scratch = h.scratch;
  h.writeState('tasks.json', state);
  return h;
}

const evidence = (h) => h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'verb');
const verb = (h, name, params = [], env = WORKER) => h.run(['verb', name, ...params.flatMap((p) => ['--param', p])], { env });
const REHEARSE = ['campaign=c1', 'rounds=3'];

test('the project records owner-approved verbs with a pinned copy of their source', (t) => {
  const h = fixture(t);
  const v = h.readState('project.json').broker.verbs.rehearse;
  assert.match(v.source.digest, /^[0-9a-f]{64}$/);
  const { manifest, tree } = require('../lib/verbs').verifyPinned(h.state, v.source.digest);
  assert.deepEqual(manifest.files.map(([p]) => p), ['tools/sleep.js', 'tools/verb.js'], 'only source.paths are pinned');
  assert.equal(fs.readFileSync(path.join(tree, 'tools', 'verb.js'), 'utf8'), VERB_JS);
  assert.match(h.ok(['project', 'show']), /broker verb rehearse: .*pinned [0-9a-f]{12}.*delegated/);
});

test('an approved verb runs through the broker on the host for a granted task and records evidence', async (t) => {
  const h = fixture(t);
  h.ok(['task', 'update', 'T1', '--broker-verbs', 'rehearse', '--agent', 'orchestrator']);
  assert.match(h.ok(['task', 'show', 'T1']), /broker verbs: rehearse/);
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', harness: 'codex',
    cwd: h.repo, broker: path.join(h.base, 'brokers', 'worker-T1-1', B.FILE) };
  assert.throws(() => B.authorize(job, ['verb', 'rehearse', '--task', 'T2']), /works on T1 only, not T2/);
  const broker = await B.start(job);
  t.after(() => broker.close());
  const r = await h.runAsync(['verb', 'rehearse', '--param', 'campaign=c1', '--param', 'rounds=3'], { env: { ...broker.env, ...WORKER } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^pinned c1 3 rehearse$/m);
  assert.match(r.stdout, /verb rehearse for T1: exit 0/);
  const [e] = evidence(h);
  assert.equal(e.ok, true);
  assert.equal(e.via, 'broker');
  assert.equal(e.agent, 'worker-T1-1');
  assert.deepEqual(e.verb.params, { campaign: 'c1', rounds: '3' });
  assert.equal(e.verb.exit_code, 0);
  assert.equal(e.verb.timed_out, false);
  assert.ok(Number.isInteger(e.verb.duration_ms));
  assert.deepEqual(e.verb.source, h.readState('project.json').broker.verbs.rehearse.source);
  const [out] = e.verb.outputs;
  assert.equal(path.dirname(out.path), h.scratch, 'the output lands in the task scratch');
  const receipt = fs.readFileSync(out.path);
  assert.equal(out.sha256, crypto.createHash('sha256').update(receipt).digest('hex'));
  assert.deepEqual(JSON.parse(receipt), { campaign: 'c1', rounds: '3', via: null }, 'the verb gets none of the broker\'s variables');
  assert.match(r.stdout, new RegExp(`receipt.json: ${out.path.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} sha256 ${out.sha256}`));
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((ev) => ev.cmd === 'verb' && ev.task === 'T1' && ev.detail.verb === 'rehearse' && ev.detail.outputs[0].sha256 === out.sha256));
  assert.equal(fs.readdirSync(path.join(h.state, 'verbs', 'runs')).length, 0, 'the private output directory is removed');
});

test('a worker that edits or commits the verb script in its checkout still runs the pinned copy', (t) => {
  const h = fixture(t);
  h.ok(['task', 'update', 'T1', '--broker-verbs', 'rehearse', '--agent', 'orchestrator']);
  const edited = "console.log('edited by the worker');\n";
  fs.writeFileSync(path.join(h.repo, 'tools', 'verb.js'), edited);
  let r = verb(h, 'rehearse', REHEARSE);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /pinned c1 3/);
  assert.doesNotMatch(r.stdout, /edited/);
  h.git(['switch', '-qc', 'tower-crane/T1-lab']);
  h.git(['commit', '-qam', 'worker edit']);
  h.git(['switch', '-q', 'main']);
  h.git(['merge', '-q', '--ff-only', 'tower-crane/T1-lab']);
  r = verb(h, 'rehearse', REHEARSE);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /pinned c1 3/, 'even the base branch moving does not change the approved commit');

  // The pinned copy is checked before every run.
  const { source } = h.readState('project.json').broker.verbs.rehearse;
  fs.writeFileSync(path.join(require('../lib/verbs').sourcesDir(h.state), source.digest, 'tree', 'tools', 'verb.js'), edited);
  const before = evidence(h).length;
  r = verb(h, 'rehearse', REHEARSE);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /pinned copy of tools\/verb\.js .* changed or went missing/);
  assert.doesNotMatch(r.stdout, /edited/);
  assert.equal(evidence(h).length, before);
});

test('pinning refuses git objects that do not hash to their names', (t) => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.repo, 'tools', 'verb.js'), "console.log('approved v2');\n");
  h.git(['commit', '-qam', 'v2']);
  const sha = h.git(['rev-parse', 'HEAD']);
  const blob = h.git(['rev-parse', 'HEAD:tools/verb.js']);
  // A worker writes the shared git directory: it swaps the approved blob's content.
  const file = path.join(h.repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  const forged = Buffer.from("console.log('forged');\n");
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, zlib.deflateSync(Buffer.concat([Buffer.from(`blob ${forged.length}\0`), forged])));
  const before = h.readState('project.json');
  const r = h.run(['project', 'set', '--broker-verbs', JSON.stringify(verbs(sha))]);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, new RegExp(`object ${blob} .* does not hash to its name`));
  assert.deepEqual(h.readState('project.json'), before);
});

test('ungranted, unclaimed and out-of-pattern requests are refused and run nothing', (t) => {
  const h = fixture(t);
  h.ok(['task', 'update', 'T1', '--broker-verbs', 'rehearse', '--agent', 'orchestrator']);
  const rows = [
    { name: 'a verb the task has no grant for', verb: 'private', params: [], stderr: /T1 has no grant for broker verb private; the owner grants it/ },
    { name: 'an undeclared verb', verb: 'missing', params: [], stderr: /no broker verb missing/ },
    { name: 'a string outside its pattern', verb: 'rehearse', params: ['campaign=../../etc', 'rounds=3'], stderr: /campaign="\.\.\/\.\.\/etc" is outside verb rehearse's string pattern/ },
    { name: 'an integer that is not one', verb: 'rehearse', params: ['campaign=c1', 'rounds=0x1'], stderr: /rounds="0x1" is outside verb rehearse's integer pattern/ },
    { name: 'an undeclared parameter', verb: 'rehearse', params: [...REHEARSE, 'store=/tmp'], stderr: /has no parameter store/ },
    { name: 'a missing parameter', verb: 'rehearse', params: ['campaign=c1'], stderr: /needs --param rounds=VALUE/ },
    { name: 'a repeated parameter', verb: 'rehearse', params: [...REHEARSE, 'rounds=4'], stderr: /--param rounds is given twice/ },
    { name: 'an agent without the claim', verb: 'rehearse', params: REHEARSE, env: { TOWER_CRANE_AGENT: 'worker-T1-2', TOWER_CRANE_TASK: 'T1' }, stderr: /worker-T1-2 does not hold T1's claim/ },
  ];
  const sources = fs.readdirSync(require('../lib/verbs').sourcesDir(h.state));
  for (const row of rows) {
    const r = verb(h, row.verb, row.params, row.env);
    assert.notEqual(r.code, 0, row.name);
    assert.match(r.stderr, row.stderr, row.name);
    assert.equal(fs.readdirSync(h.scratch).length, 0, row.name);
  }
  assert.deepEqual(evidence(h), []);
  assert.deepEqual(fs.readdirSync(require('../lib/verbs').sourcesDir(h.state)), sources);
  const r = h.run(['evidence', 'T1', '--type', 'verb', '--ok', '--sha', 'a'.repeat(40)], { env: WORKER });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /only tower-crane verb records verb evidence/);
});

test('the orchestrator grants delegated verbs; other grants and every verb change are the owner\'s', (t) => {
  const h = fixture(t);
  const orchestrator = { env: { TOWER_CRANE_AGENT: 'orchestrator' } };
  const audit = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).findLast((e) => e.cmd === 'setting');
  h.ok(['task', 'update', 'T1', '--broker-verbs', 'rehearse,sleepy'], orchestrator);
  assert.deepEqual(audit().detail.settings, { 'task.broker_verbs': 'operational' });
  let r = h.run(['task', 'update', 'T1', '--broker-verbs', 'rehearse,private'], orchestrator);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /task\.broker_verbs_owner is owner-required; opened D1/);
  assert.deepEqual(h.readState('tasks.json').tasks[0].broker_verbs, ['rehearse', 'sleepy']);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(['task', 'update', 'T1', '--broker-verbs', 'rehearse,private'], orchestrator);
  assert.deepEqual(h.readState('tasks.json').tasks[0].broker_verbs, ['rehearse', 'private']);
  assert.equal(audit().detail.approved_by, 'D1');
  r = h.run(['task', 'update', 'T1', '--broker-verbs', 'rehearse'], { env: WORKER });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /operational: only the orchestrator or the owner/);
  assert.equal(h.run(['task', 'update', 'T1', '--broker-verbs', 'nope'], orchestrator).code, 1);
  h.ok(['task', 'update', 'T1', '--broker-verbs', ''], orchestrator);
  assert.equal(h.readState('tasks.json').tasks[0].broker_verbs, undefined);

  const project = h.readState('project.json');
  r = h.run(['project', 'set', '--broker-verbs', 'null'], orchestrator);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /broker\.verbs is owner-required; opened D2/);
  r = h.run(['project', 'set', '--broker-verbs', 'null'], { env: WORKER });
  assert.equal(r.code, 1);
  assert.deepEqual(h.readState('project.json'), project);
  h.ok(['project', 'set', '--broker-verbs', 'null']);
  assert.equal(h.readState('project.json').broker, undefined);
});

test('project set refuses verbs that a worker could steer', (t) => {
  const h = fixture(t);
  const sha = h.sha;
  const base = verbs(sha).rehearse;
  const other = h.git(['commit-tree', `${sha}^{tree}`, '-m', 'off the base branch']);
  const rows = [
    { name: 'a source inside the repository', verb: { ...base, source: { path: path.join(h.repo, 'tools') } }, stderr: /source\.path .* is inside .*an agent writes/ },
    { name: 'a mount inside the repository', verb: { ...base, mounts: { store: h.repo } }, stderr: /mounts\.store .* is inside/ },
    { name: 'a literal path into the repository', verb: { ...base, argv: [NODE, path.join(h.repo, 'tools', 'verb.js'), '{param.campaign}', '{param.rounds}', '{out}'] }, stderr: /argv .* is inside/ },
    { name: 'a commit off the base branch', verb: { ...base, source: { commit: other } }, stderr: /is not on refs\/heads\/main/ },
    { name: 'a parameter in the program', verb: { ...base, argv: ['{param.campaign}', '{param.rounds}'] }, code: 2, stderr: /argv\[0\] names the program/ },
    { name: 'an undeclared parameter', verb: { ...base, argv: [...base.argv, '{param.store}'] }, code: 2, stderr: /\{param\.store\}, which params does not declare/ },
    { name: 'a parameter without a pattern', verb: { ...base, params: { ...base.params, rounds: { type: 'integer' } } }, code: 2, stderr: /params\.rounds must be/ },
    { name: 'no timeout', verb: { ...base, timeout_sec: undefined }, code: 2, stderr: /timeout_sec must be/ },
    { name: 'a given digest', verb: { ...base, source: { ...base.source, digest: '0'.repeat(64) } }, code: 2, stderr: /digest is written by project set/ },
  ];
  const project = h.readState('project.json');
  for (const row of rows) {
    const r = h.run(['project', 'set', '--broker-verbs', JSON.stringify({ rehearse: row.verb })]);
    assert.equal(r.code, row.code ?? 1, `${row.name}: ${r.stderr}`);
    assert.match(r.stderr, row.stderr, row.name);
  }
  assert.deepEqual(h.readState('project.json'), project);
});

for (const row of [
  { verb: 'sleepy', check: (e) => assert.equal(e.verb.timed_out, true), summary: /timed out after 1 s/ },
  { verb: 'storm', check: (e) => assert.equal(e.verb.resource_reason, 'resource-tasks-max'), summary: /resource-tasks-max/ },
  { verb: 'memory', check: (e) => assert.equal(e.verb.resource_reason, 'resource-memory-max'), summary: /resource-memory-max/ },
]) {
  test(`the ${row.verb === 'sleepy' ? 'timeout' : `${row.verb} cap`} stops a runaway verb and is recorded`, (t) => {
    const h = fixture(t);
    h.ok(['task', 'update', 'T1', '--broker-verbs', row.verb, '--agent', 'orchestrator']);
    const r = verb(h, row.verb, [], { ...WORKER, TOWER_CRANE_TEST_CONTAINMENT: '1' });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, row.summary);
    const [e] = evidence(h);
    assert.equal(e.ok, false);
    assert.match(e.summary, row.summary);
    row.check(e);
  });
}
