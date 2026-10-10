'use strict';

const { ROOT, repo, task, load, replay, event, P, fs, path, out } = require('./harness');
const T = require(`${ROOT}/lib/tasks`);
const probes = [];
function probe(id, expected, fn) {
  probes.push({ id, expected, async run() {
    const h = repo();
    try {
      h.init();
      task(h);
      task(h);
      const clock = path.join(h.base, 'clock.js');
      fs.writeFileSync(clock, `const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [RealDate.now() + 120000])); }
  static now() { return RealDate.now() + 120000; }
};\n`);
      const later = { env: { NODE_OPTIONS: `--require=${clock}` } };
      return await fn(h, later);
    } finally { await h.cleanup(); }
  } });
}

probe('L01', 'Concurrent CLI claims have exactly one winner.', async (h) => {
  const results = await Promise.all(['one', 'two', 'three'].map((a) => h.runAsync(['claim', 'T1', '--agent', a])));
  const winners = results.filter((r) => r.code === 0).length;
  return { held: winners === 1, observed: { winners, codes: results.map((r) => r.code) } };
});
probe('L02', 'An expired lease can be taken over and the old claimant cannot submit.', (h, later) => {
  h.ok(['claim', 'T1', '--agent', 'one', '--lease', '1']);
  h.ok(['claim', 'T1', '--agent', 'two'], later);
  const r = h.run(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'one'], later);
  return { held: r.code === 1 && /only the claimant/.test(r.stderr), observed: out(r) };
});
probe('L03', 'Expired renewal refuses when another task took the only worker slot.', (h, later) => {
  h.ok(['project', 'set', '--workers', '1']);
  h.ok(['claim', 'T1', '--agent', 'one', '--lease', '1']);
  h.ok(['claim', 'T2', '--agent', 'two'], later);
  const r = h.run(['renew', 'T1', '--agent', 'one'], later);
  return { held: r.code === 1 && /workers limit/.test(r.stderr), observed: out(r) };
});
probe('L04', 'Submission by the last claimant after expiry is allowed until takeover, as requireClaimant is identity-based.', (h, later) => {
  h.ok(['claim', 'T1', '--agent', 'one', '--lease', '1']);
  const r = h.run(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'one'], later);
  return { verdict: r.code === 0 ? 'by design' : 'held', observed: out(r) };
});
probe('L05', 'Renewing an expired claim rechecks a newly added unmet dependency.', (h, later) => {
  h.ok(['claim', 'T1', '--agent', 'one', '--lease', '1']);
  h.ok(['task', 'update', 'T1', '--dep', 'T2'], later);
  const control = h.run(['claim', 'T1', '--agent', 'one'], later);
  const renew = h.run(['renew', 'T1', '--agent', 'one'], later);
  return { held: control.code === 1 && renew.code === 1,
    observed: { claim: out(control), renew: out(renew) } };
});
probe('L06', 'Renewing an expired claim respects a newly set needs-owner blocker.', (h, later) => {
  h.ok(['claim', 'T1', '--agent', 'one', '--lease', '1']);
  h.ok(['task', 'update', 'T1', '--needs-owner', 'await prerequisite'], later);
  const control = h.run(['claim', 'T1', '--agent', 'one'], later);
  const renew = h.run(['renew', 'T1', '--agent', 'one'], later);
  return { held: control.code === 1 && renew.code === 1,
    observed: { claim: out(control), renew: out(renew) } };
});
probe('L07', 'Renewing an expired lease rechecks resource locks held by another task.', (h, later) => {
  h.ok(['task', 'update', 'T1', '--lock', 'probe-resource']);
  h.ok(['task', 'update', 'T2', '--lock', 'probe-resource']);
  h.ok(['claim', 'T1', '--agent', 'one', '--lease', '1']);
  h.ok(['claim', 'T2', '--agent', 'two'], later);
  const r = h.run(['renew', 'T1', '--agent', 'one'], later);
  return { held: r.code === 1 && /lock probe-resource/.test(r.stderr), observed: out(r) };
});
probe('L08', 'A cancelled task refuses submit and renewal by its old claimant.', (h) => {
  h.ok(['claim', 'T1', '--agent', 'one']);
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  const submit = h.run(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'one']);
  const renew = h.run(['renew', 'T1', '--agent', 'one']);
  return { held: submit.code === 1 && renew.code === 1, observed: { submit: out(submit), renew: out(renew) } };
});
probe('L09', 'A live reservation for one worker prevents another worker claiming the same task (T136).', (h) => {
  const r = replay(h.snapshot());
  r.st.events.push(event('spawn', 'T1', { role: 'worker', agent: 'first', attempt: 1,
    reserved: true, pid: process.pid, ...P.identity(process.pid) }));
  const tasks = load('lib/tasks.js', [], { './state': r.state });
  let accepted = false;
  let error;
  try { tasks.claim({ ...r.ctx, agent: 'second' }); accepted = true; } catch (e) { error = e.message; }
  return { held: !accepted, observed: { accepted, error, holders: T.workerHolders(r.st, Date.now()) } };
});
probe('L10', 'A dead reservation no longer consumes a worker slot (T136).', (h) => {
  const r = replay(h.snapshot());
  const detail = { role: 'worker', agent: 'first', attempt: 1,
    reserved: true, pid: process.pid, ...P.identity(process.pid), start_ticks: 'impossible-start-ticks' };
  r.st.events.push(event('spawn', 'T1', detail));
  const holders = T.workerHolders(r.st, Date.now());
  return { held: holders.length === 0, observed: { processState: P.processState(detail), holders } };
});
probe('L11', 'A matching exit receipt releases an unclaimed reservation.', (h) => {
  const r = replay(h.snapshot());
  const detail = { role: 'worker', agent: 'first', attempt: 1, reserved: true, pid: process.pid, ...P.identity(process.pid) };
  r.st.events.push(event('spawn', 'T1', detail), event('spawn exit', 'T1', { agent: 'first', attempt: 1, pid: process.pid, code: 0 }));
  const holders = T.workerHolders(r.st, Date.now());
  return { held: holders.length === 0, observed: { holders } };
});
probe('L12', 'An old attempt exit cannot release a new reservation with the same PID.', (h) => {
  const r = replay(h.snapshot());
  const detail = { role: 'worker', agent: 'first', attempt: 2, reserved: true, pid: process.pid, ...P.identity(process.pid) };
  r.st.events.push(event('spawn', 'T1', detail), event('spawn exit', 'T1', { agent: 'first', attempt: 1, pid: process.pid, code: 0 }));
  const holders = T.workerHolders(r.st, Date.now());
  return { held: holders.length === 1, observed: { holders } };
});

module.exports = probes;
