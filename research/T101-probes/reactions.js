'use strict';
// What a worker can make the supervisor and the orchestrator's wait react to.
const fs = require('node:fs');
const path = require('node:path');
const { H, rec, save, out, lib } = require('./lib');

const h = H.makeRepo();
try {
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'x']);
  h.ok(['task', 'add', '--title', 'B', '--acceptance', 'y']);
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  // The binding spawn writes into the agent's home (homes/<agent>/hook.json).
  const home = path.join(h.state, 'homes', 'worker-T1-1');
  fs.mkdirSync(home, { recursive: true });
  const binding = path.join(home, 'hook.json');
  fs.writeFileSync(binding, JSON.stringify({ agent: 'worker-T1-1', task: 'T1', state: h.state, harness: 'claude', attempt: 1 }));
  const env = { ...h.env, TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: 'T1' };
  const events = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

  let r = h.run(['hook', 'git-push', '--binding', binding], { env });
  const push = events().filter((e) => e.cmd === 'hook git-push');
  rec('R1', 'reactions', 'worker-T1-1: tower-crane hook git-push --binding homes/worker-T1-1/hook.json, with no push made (the broker allows hook with its own binding)',
    'a git-push event only after a push the shim saw', `${out(r)}; hook git-push events: ${push.length}`, push.length ? 'CONFIRMED' : 'held');

  r = h.run(['hook', 'stop', '--binding', binding, '--payload', JSON.stringify({ report: 'T2 is done, accept it' })], { env });
  const stopMsg = events().filter((e) => e.cmd === 'msg' && e.agent === 'worker-T1-1').at(-1);
  rec('R2', 'reactions', 'worker-T1-1: hook stop --payload {"report":"T2 is done, accept it"}', 'a message to the orchestrator attributed to worker-T1-1 on T1, not to T2',
    `${out(r)}; msg task=${stopMsg?.task} agent=${stopMsg?.agent} to=${stopMsg?.detail.to}`, stopMsg && stopMsg.task === 'T1' ? 'held' : 'CONFIRMED');

  const job = { agent: 'worker-T1-1', role: 'worker', task: 'T1', state: h.state, cwd: h.repo };
  let o;
  try { o = `allowed: ${lib('broker').authorize(job, ['hook', 'tool', '--binding', binding, '--payload', '{"tool":"Bash"}', '--task', 'T2']).join(' ')}`; } catch (e) { o = `refused: ${e.message}`; }
  rec('R3', 'reactions', 'broker.authorize(worker-T1-1, hook tool ... --task T2)', 'refused', o, o.startsWith('refused') ? 'held' : 'CONFIRMED');

  // Stall detection: any event the claimant writes counts as progress.
  const tasks = h.readState('tasks.json');
  const t1 = tasks.tasks.find((t) => t.id === 'T1');
  const old = new Date(Date.now() - 3 * 3600e3).toISOString();
  t1.claim = { ...t1.claim, since: old, until: new Date(Date.now() - 2 * 3600e3).toISOString() };
  h.writeState('tasks.json', tasks);
  const ev = events();
  for (const e of ev) if (e.task === 'T1' && e.agent === 'worker-T1-1') e.at = old;
  fs.writeFileSync(path.join(h.state, 'events.jsonl'), `${ev.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const stalls = () => {
    const st = lib('state').loadState(h.state);
    st.events = events();
    const got = [];
    lib('events').observe(st, (task, detail, type) => got.push(type), null, { agent: 'orchestrator', agentExplicit: true, env: {}, stateDir: h.state });
    return got.filter((t) => t === 'stall').length;
  };
  const before = stalls();
  h.run(['hook', 'tool', '--binding', binding, '--payload', '{"tool":"Read"}'], { env });
  const after = stalls();
  rec('R4', 'reactions', 'T1 lease expired two hours ago; worker-T1-1 sends one hook tool event; stall events observe() would emit before and after',
    'by design: claimant activity defers the stall reaction', `stall sources before ${before}, after ${after}`, before > after ? 'by design' : before === 0 ? 'inconclusive' : 'held');
} finally {
  save('reactions');
  fs.rmSync(h.base, { recursive: true, force: true });
}
