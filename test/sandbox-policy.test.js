'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const P = require('../lib/sandbox-policy');
const TOML = require('../lib/toml');

const NO_STUBS = process.platform === 'win32' && 'harness stubs are shebang scripts';
const as = (agent) => ({ env: { TOWER_CRANE_AGENT: agent } });
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const task = (h, id) => h.readState('tasks.json').tasks.find((x) => x.id === id);

test('policy paths, owner-only classes and narrowing, as a variant table', (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sandbox-policy-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const project = path.join(base, 'repo');
  const runtime = path.join(base, 'runtime');
  for (const d of [home, project, runtime, path.join(base, 'link-target')]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(path.join(home, '.ssh'), path.join(base, 'link-target', 'keys'));
  const r = P.roots({ home, project, stateDir: path.join(project, '.tower-crane'), env: { XDG_RUNTIME_DIR: runtime }, settings: { env_file: '~/secrets.env' } });
  const policy = { version: 3, orchestrator_may_grant: { read: ['~/docs/*'], write: ['<project>/out/**', `${base}/link-target/**`, '~/**', `${runtime}/**`, '/run/**'] }, owner_only: P.OWNER_ONLY };
  const rows = [
    [{ field: 'write', value: `${project}/out` }, null],
    [{ field: 'write', value: 'out/a/b' }, null],
    [{ field: 'write', value: `${project}/outs` }, 'outside the sandbox policy'],
    [{ field: 'read', value: '~/docs/guide' }, null],
    [{ field: 'read', value: '~/docs/guide/deep' }, null],
    // A write glob also grants reads; a read glob never grants writes.
    [{ field: 'read', value: `${project}/out/x` }, null],
    [{ field: 'write', value: '~/docs/guide' }, null],
    [{ field: 'write', value: `${project}/src` }, 'outside the sandbox policy'],
    [{ field: 'write', value: path.join(base, 'elsewhere') }, 'outside the sandbox policy'],
    // ~/** lists them, yet credential stores and what holds them stay the owner's.
    [{ field: 'write', value: '~/.ssh' }, 'credentials stays owner-only'],
    [{ field: 'read', value: '~/.config/gh/hosts.yml' }, 'credentials stays owner-only'],
    [{ field: 'write', value: '~' }, 'credentials stays owner-only'],
    [{ field: 'write', value: '~/secrets.env' }, 'credentials stays owner-only'],
    [{ field: 'write', value: path.join(project, '.tower-crane', 'homes') }, 'credentials stays owner-only'],
    // A link inside a granted directory is judged where it leads.
    [{ field: 'write', value: `${base}/link-target/keys` }, 'credentials stays owner-only'],
    [{ field: 'write', value: '~/work' }, null],
    [{ field: 'write', value: path.join(runtime, 'bus') }, 'session_bus stays owner-only'],
    [{ field: 'write', value: path.join(runtime, 'docker.sock') }, 'sockets stays owner-only'],
    [{ field: 'write', value: '/run/docker.sock' }, 'sockets stays owner-only'],
    [{ field: 'read', value: '/var/run' }, 'sockets stays owner-only'],
    [{ field: 'domains', value: 'example.com' }, 'network stays owner-only'],
    [{ field: 'session_bus', value: true }, 'session_bus stays owner-only'],
  ];
  for (const [item, why] of rows) assert.equal(P.refusal(policy, item, r), why, JSON.stringify(item));
  assert.equal(P.refusal(null, { field: 'write', value: '~/work' }, r), 'no sandbox policy is set');

  for (const [glob, p, match] of [
    ['/a/**', '/a', true], ['/a/**', '/a/b/c', true], ['/a/*', '/a/b', true], ['/a/*', '/a/b/c', false],
    ['/a/**/z', '/a/z', true], ['/a/**/z', '/a/b/c/z', true], ['/a/b', '/a/b', true], ['/a/b', '/a/b/c', false],
    ['/a/?', '/a/b', true], ['/a/?', '/a/bc', false], ['/a.b/*', '/aXb/c', false], ['/**', '/x/y', true],
  ]) assert.equal(P.patternRegExp(glob, r).test(p), match, `${glob} ${p}`);

  const before = P.parse(JSON.stringify({ orchestrator_may_grant: { read: ['~/a'], write: ['~/b', '~/c'] } }));
  assert.deepEqual(P.widens(before, P.parse('{"orchestrator_may_grant":{"write":["~/c"]}}')), [], 'removing paths narrows');
  assert.deepEqual(P.widens(before, null), [], 'clearing narrows');
  assert.deepEqual(P.widens(before, P.parse('{"orchestrator_may_grant":{"read":["~/a","~/d"]}}')), ['read ~/d']);
  assert.deepEqual(P.widens(null, before), ['read ~/a', 'write ~/b', 'write ~/c'], 'a new policy widens');
  assert.deepEqual(P.parse('{"orchestrator_may_grant":{},"owner_only":["network"]}').owner_only, P.OWNER_ONLY, 'every class stays listed');
  for (const bad of ['{"orchestrator_may_grant":{"sockets":["/run/docker.sock"]}}', '{"orchestrator_may_grant":{"write":["relative"]}}',
    '{"orchestrator_may_grant":{"write":["~/a"]},"owner_only":["paths"]}', '{"orchestrator_may_grant":{},"version":4}', '[]']) {
    assert.throws(() => P.parse(bad), /--sandbox-policy/, bad);
  }
});

// A codex stand-in that saves the filesystem rules its profile grants.
function writeCodexStub(bin, out) {
  fs.writeFileSync(path.join(bin, 'codex'), [
    `#!${process.execPath}`, "'use strict';",
    'const fs = require("node:fs"), path = require("node:path");',
    `fs.writeFileSync(${JSON.stringify(out)}, fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8"));`,
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "grant" }));', '',
  ].join('\n'), { mode: 0o755 });
}

// The paths the agent's sandbox writes.
const writable = (out) => Object.entries(TOML.parse(fs.readFileSync(out, 'utf8')).permissions['tower-crane'].filesystem)
  .filter(([p, access]) => access === 'write' && !p.startsWith(':')).map(([p]) => p);

// Each probe relaunches a task's worker; the owner lifts the respawn cap a
// stand-in's exit without a submit counts toward.
function releaseExited(h, id) {
  const t = h.json(['task', 'show', id]);
  if (t.claim) h.ok(['release', id, '--agent', t.claim.agent, '--reason', 'worker exited']);
  if (t.needs_owner?.startsWith('worker exited without submitting')) h.ok(['owner-done', id]);
}

test('the orchestrator grants paths inside the owner\'s policy to one task, audited; outside it, owner-only classes and widening the policy stay the owner\'s; narrowing revokes at the next dispatch', { skip: NO_STUBS }, (t) => {
  const h = cachedFixture(t, 'sandbox policy', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Needs a cache', '--acceptance', 'done']);
    h.ok(['task', 'add', '--title', 'Other work', '--acceptance', 'done']);
    for (const id of ['T1', 'T2']) h.ok(['brief', 'set', id, '-'], { input: 'probe' });
    h.ok(['ladder', 'set', 'medium', '--harness', 'codex', '--profile', 'fixture-main', '--clear', 'model', '--clear', 'effort', '--clear', 'args']);
  });
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(h.base, 'config.toml');
  writeCodexStub(bin, out);
  const env = { ...h.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CODEX_HOME: '' };
  const writes = (id) => {
    releaseExited(h, id);
    h.ok(['spawn', '--task', id, '--wait'], { env });
    return writable(out);
  };
  const grants = path.join(fs.realpathSync(h.base), 'grants');
  const cache = path.join(grants, 'cache');
  const other = path.join(grants, 'other');
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const docs = path.join(fs.realpathSync(h.env.HOME), 'docs');
  fs.mkdirSync(docs, { recursive: true });
  const decisions = () => h.readState('decisions.json').decisions;

  // Without a policy the orchestrator's grant is the owner's to make.
  const early = h.run(['task', 'update', 'T1', '--sandbox', JSON.stringify({ write: [cache] })], as('orchestrator'));
  assert.equal(early.code, 1, early.stderr);
  assert.match(early.stderr, /sandbox is owner-required; opened D1/);
  assert.match(decisions()[0].why, /no sandbox policy is set/);
  assert.equal(task(h, 'T1').sandbox_grants, undefined);

  const policy = { orchestrator_may_grant: { read: ['~/docs/**'], write: [`${grants}/**`, '~/**', '/run/**'] } };
  // The orchestrator cannot set or widen the policy itself; a worker cannot touch it.
  const widen = h.run(['project', 'set', '--sandbox-policy', JSON.stringify(policy)], as('orchestrator'));
  assert.equal(widen.code, 1, widen.stderr);
  assert.match(widen.stderr, /sandbox\.policy is owner-required; opened D2/);
  assert.equal(h.readState('project.json').sandbox_policy, undefined);
  assert.match(h.run(['project', 'set', '--sandbox-policy', 'null'], as('worker-T1-1')).stderr, /only the orchestrator or the owner/);
  assert.equal(h.run(['project', 'set', '--sandbox-policy', '{"orchestrator_may_grant":{"sockets":["/run/docker.sock"]}}']).code, 2, 'sockets are never grantable');

  h.ok(['project', 'set', '--sandbox-policy', JSON.stringify(policy)]);
  const set = h.readState('project.json').sandbox_policy;
  assert.equal(set.version, 1);
  assert.deepEqual(set.owner_only, P.OWNER_ONLY);
  assert.equal(decisions()[1].status, 'answered', 'the owner making the change answers the orchestrator\'s request');
  const sameAgain = h.run(['project', 'set', '--sandbox-policy', JSON.stringify({ orchestrator_may_grant: { ...policy.orchestrator_may_grant, write: [...policy.orchestrator_may_grant.write, '/srv/**'] } })], as('orchestrator'));
  assert.equal(sameAgain.code, 1, 'adding a path to the policy is still the owner\'s');

  // Inside the policy: the orchestrator grants a write path and a read path to T1 alone.
  h.ok(['task', 'update', 'T1', '--sandbox', JSON.stringify({ write: [cache], read: ['~/docs/guides'] })], as('orchestrator'));
  const granted = task(h, 'T1');
  assert.deepEqual(granted.sandbox_grants.map(({ field, value, by, role, policy_version }) => ({ field, value, by, role, policy_version })), [
    { field: 'read', value: '~/docs/guides', by: 'orchestrator', role: 'orchestrator', policy_version: 1 },
    { field: 'write', value: cache, by: 'orchestrator', role: 'orchestrator', policy_version: 1 },
  ]);
  const log = events(h);
  const audit = log.findLast((e) => e.cmd === 'setting');
  assert.deepEqual(audit.detail.settings, { 'sandbox.grant': 'operational' });
  assert.equal(audit.detail.actor, 'orchestrator');
  const grant = log.findLast((e) => e.cmd === 'sandbox grant');
  assert.equal(grant.task, 'T1');
  assert.deepEqual(grant.detail, { by: 'orchestrator', role: 'orchestrator', policy_version: 1, granted: [{ field: 'read', value: '~/docs/guides' }, { field: 'write', value: cache }], removed: [] });
  const evidence = granted.evidence.findLast((e) => e.type === 'sandbox');
  assert.equal(evidence.agent, 'orchestrator');
  assert.match(evidence.summary, new RegExp(`sandbox granted: read ~/docs/guides, write ${cache} under sandbox policy v1`));
  assert.match(h.ok(['task', 'show', 'T1']), new RegExp(`sandbox widenings:\\n  - read ~/docs/guides by orchestrator under sandbox policy v1\\n  - write ${cache} by orchestrator under sandbox policy v1`));
  assert.match(h.ok(['status']), new RegExp(`sandbox widenings: T1 read ~/docs/guides by orchestrator under sandbox policy v1, write ${cache}`));
  assert.equal(h.run(['evidence', 'T1', '--type', 'sandbox', '--ok']).code, 1, 'sandbox evidence comes only with a grant');
  assert.ok(writes('T1').includes(cache), 'T1\'s dispatch writes the granted path');
  assert.ok(!writes('T2').includes(cache), 'T2\'s sandbox does not widen');

  // Outside the policy: refused, nothing changes, and the owner gets the decision.
  const outside = path.join(fs.realpathSync(h.base), 'elsewhere');
  const before = task(h, 'T1').sandbox_grants;
  const refused = h.run(['task', 'update', 'T1', '--sandbox', JSON.stringify({ write: [cache, outside], read: ['~/docs/guides'] })], as('orchestrator'));
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /sandbox is owner-required; opened D\d+/);
  const d3 = decisions().at(-1);
  assert.deepEqual(d3.escalation, { settings: ['sandbox'], change: { task: 'T1', sandbox: { write: [cache, outside], read: ['~/docs/guides'] } } });
  assert.match(d3.why, new RegExp(`write ${outside} \\(outside the sandbox policy\\)`));
  assert.deepEqual(task(h, 'T1').sandbox_grants, before);

  // Owner-only classes stay the owner's even where the policy's paths list them.
  for (const [sandbox, cls] of [
    [{ write: ['~/.ssh'] }, 'credentials'], [{ write: ['/run/docker.sock'] }, 'sockets'],
    [{ domains: ['example.com'] }, 'network'], [{ session_bus: true }, 'session_bus'],
  ]) {
    const r = h.run(['task', 'update', 'T2', '--sandbox', JSON.stringify(sandbox)], as('orchestrator'));
    assert.equal(r.code, 1, `${cls}: ${r.stderr}`);
    assert.match(r.stderr, /sandbox is owner-required; opened D\d+/);
    assert.match(decisions().at(-1).why, new RegExp(`${cls} stays owner-only`));
    assert.equal(task(h, 'T2').sandbox_grants, undefined);
  }

  // A worker's credential ask for items inside the policy goes to the orchestrator; one outside stays the owner's.
  const asked = h.ok(['ask', '--kind', 'credential', '--setting', 'sandbox', '--sandbox', JSON.stringify({ write: [other] }), '--question', 'May I write the other cache?', '--blocks', 'T2'], as('worker-T2-1'));
  assert.match(asked, /routed to the orchestrator: the requested sandbox items lie inside sandbox policy v1/);
  const routed = decisions().at(-1);
  assert.equal(routed.technical, true);
  assert.equal(routed.escalation, undefined);
  assert.deepEqual(routed.routed, { to: 'orchestrator', sandbox_policy: 1, items: [{ field: 'write', value: other }], asked_kind: 'credential' });
  h.ok(['answer', routed.id, '--choice', 'yes'], as('orchestrator'));
  const held = h.ok(['ask', '--kind', 'credential', '--setting', 'sandbox', '--sandbox', JSON.stringify({ write: ['~/.ssh'] }), '--question', 'May I write my keys?', '--blocks', 'T2'], as('worker-T2-1'));
  assert.doesNotMatch(held, /routed/);
  assert.deepEqual(decisions().at(-1).escalation.settings, ['sandbox']);
  assert.equal(h.run(['answer', decisions().at(-1).id, '--choice', 'no'], as('orchestrator')).code, 1, 'only the owner answers it');
  h.ok(['answer', decisions().at(-1).id, '--choice', 'no']);

  // A rung grant inside the policy is the orchestrator's too, and recorded as policy-backed.
  h.ok(['ladder', 'set', 'medium', '--sandbox', JSON.stringify({ write: [other] })], as('orchestrator'));
  assert.deepEqual(h.readState('project.json').sandbox_grants.map(({ rung, field, value, policy_version }) => ({ rung, field, value, policy_version })),
    [{ rung: 'medium', field: 'write', value: other, policy_version: 1 }]);
  assert.ok(writes('T2').includes(other));

  // The orchestrator may narrow the policy. What the narrower policy no longer covers is revoked.
  h.ok(['project', 'set', '--sandbox-policy', JSON.stringify({ orchestrator_may_grant: { read: ['~/docs/**'], write: ['~/**', '/run/**'] } })], as('orchestrator'));
  assert.equal(h.readState('project.json').sandbox_policy.version, 2);
  assert.deepEqual(task(h, 'T1').sandbox_grants.map((g) => g.value), ['~/docs/guides'], 'the read grant stays inside the narrower policy');
  const revoke = events(h).filter((e) => e.cmd === 'sandbox revoke');
  assert.deepEqual(revoke.map((e) => [e.task, e.detail.revoked.map((i) => i.value)]), [['T1', [cache]], [null, [other]]]);
  assert.match(task(h, 'T1').evidence.findLast((e) => e.type === 'sandbox').summary, /sandbox revoked: write .*, no longer inside the sandbox policy/);
  assert.equal(h.readState('project.json').ladder.medium.sandbox, undefined);
  assert.ok(!writes('T1').includes(cache), 'T1\'s next dispatch writes the path no more');
  assert.ok(!writes('T2').includes(other), 'nor does the rung\'s');
});

test('a grant the policy backs is left out of a dispatch once it falls outside, even before the policy changes', { skip: NO_STUBS }, (t) => {
  const h = cachedFixture(t, 'sandbox drift', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Needs a cache', '--acceptance', 'done']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'probe' });
    h.ok(['ladder', 'set', 'medium', '--harness', 'codex', '--profile', 'fixture-main', '--clear', 'model', '--clear', 'effort', '--clear', 'args']);
  });
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(h.base, 'config.toml');
  writeCodexStub(bin, out);
  const env = { ...h.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CODEX_HOME: '' };
  const grants = path.join(fs.realpathSync(h.base), 'grants');
  const cache = path.join(grants, 'cache');
  fs.mkdirSync(grants, { recursive: true });
  h.ok(['project', 'set', '--sandbox-policy', JSON.stringify({ orchestrator_may_grant: { write: [`${grants}/**`] } })]);
  h.ok(['task', 'update', 'T1', '--sandbox', JSON.stringify({ write: [cache] })], as('orchestrator'));
  // The granted path now leads to a credential store, as an agent with the parent's write could make it.
  const keys = path.join(fs.realpathSync(h.env.HOME), '.ssh');
  fs.mkdirSync(keys, { recursive: true });
  fs.symlinkSync(keys, cache);
  const started = h.ok(['spawn', '--task', 'T1', '--wait'], { env });
  assert.match(started, new RegExp(`sandbox grants the policy no longer backs were left out: T1 write ${cache}`));
  const allow = writable(out);
  assert.ok(!allow.includes(keys) && !allow.includes(cache), 'the agent does not get the store');
  assert.match(h.ok(['task', 'show', 'T1']), /write .* by orchestrator under sandbox policy v1 \(revoked: no longer inside the policy\)/);
});
