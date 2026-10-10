'use strict';
// Identity and authority: who the CLI believes is acting.
const { H, rec, save, out, noTask, plain } = require('./lib');

const h = H.makeRepo();
try {
  h.init(['--repo', 'acme/app']);
  h.ok(['task', 'add', '--title', 'One', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'Two', '--acceptance', 'b']);
  const sha = h.git(['rev-parse', 'HEAD']);
  const asOrch = { ...noTask(h.env), TOWER_CRANE_AGENT: 'orchestrator' };

  let r = h.run(['project', 'set', '--merge-admin', 'true', '--agent', 'owner'], { env: asOrch });
  rec('I1', 'identity', 'TOWER_CRANE_AGENT=orchestrator tower-crane project set --merge-admin true --agent owner (no TTY, no TOWER_CRANE_TASK)',
    'refused or a decision opened: merge.admin is owner-required and the process was started as the orchestrator',
    `${out(r)}; merge.admin is now ${JSON.stringify(h.readState('project.json').merge?.admin)}`, r.code === 0 ? 'CONFIRMED' : 'held');

  r = h.run(['project', 'set', '--merge-admin', 'false', '--agent', 'orchestrator'], { env: asOrch });
  rec('I1b', 'identity', 'TOWER_CRANE_AGENT=orchestrator tower-crane project set --merge-admin false --agent orchestrator (control)',
    'refused with a decision opened for the owner', out(r), r.code !== 0 ? 'held' : 'CONFIRMED');

  r = h.run(['project', 'set', '--workers', '3', '--agent', 'owner'], { env: { ...h.env, TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: 'T1' } });
  rec('I2', 'identity', 'TOWER_CRANE_AGENT=worker-T1-1 TOWER_CRANE_TASK=T1 tower-crane project set --workers 3 --agent owner',
    'refused', out(r), r.code !== 0 ? 'held' : 'CONFIRMED');

  r = h.run(['project', 'set', '--workers', '4', '--agent', 'owner'], { env: { ...noTask(h.env), TOWER_CRANE_AGENT: 'worker-T1-1' } });
  rec('I3', 'identity', 'env -u TOWER_CRANE_TASK TOWER_CRANE_AGENT=worker-T1-1 tower-crane project set --workers 4 --agent owner',
    'refused: TOWER_CRANE_AGENT names a worker', `${out(r)}; limits.workers is now ${h.readState('project.json').limits.workers}`, r.code === 0 ? 'CONFIRMED' : 'held');

  r = h.run(['project', 'set', '--workers', '5', '--agent', 'orchestrator'], { env: { ...noTask(h.env), TOWER_CRANE_AGENT: 'worker-T1-1' } });
  rec('I4', 'identity', 'TOWER_CRANE_AGENT=worker-T1-1 tower-crane project set --workers 5 --agent orchestrator',
    'refused', out(r), r.code !== 0 ? 'held' : 'CONFIRMED');

  r = h.run(['project', 'set', '--workers', '6', '--agent', 'orchestrator'], { env: plain(h.env) });
  rec('I5', 'identity', 'tower-crane project set --workers 6 --agent orchestrator from a process with no TOWER_CRANE_AGENT',
    'accepted (documented: an unspawned name orchestrator is the orchestrator)', out(r), r.code === 0 ? 'by design' : 'held');

  // Review evidence under names that were never a reviewer.
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  h.ok(['task', 'update', 'T1', '--kind', 'docs']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker-T1-1']);
  r = h.run(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'made-up-reviewer'], { env: plain(h.env) });
  const gates = h.ok(['task', 'show', 'T1']).split('\n').find((l) => l.startsWith('gates:')) || '';
  rec('I6', 'identity/gates', `tower-crane evidence T1 --type review --ok --sha ${sha.slice(0, 7)} --agent made-up-reviewer (a name no spawn started)`,
    'not counted: review evidence should come from a reviewer spawned for that sha', `${out(r)}; ${gates}`, /review ok/.test(gates) ? 'CONFIRMED' : 'held');
  r = h.run(['accept', 'T1', '--agent', 'orchestrator'], { env: plain(h.env) });
  rec('I7', 'identity/gates', 'tower-crane accept T1 --agent orchestrator after I6 (docs task, review is its only gate)',
    'refused: no independent review happened', `${out(r)}; status ${h.readState('tasks.json').tasks[0].status}`, r.code === 0 ? 'CONFIRMED' : 'held');

  h.ok(['claim', 'T2', '--agent', 'worker-T2-1']);
  r = h.run(['evidence', 'T2', '--type', 'tests', '--ok', '--sha', sha, '--agent', 'orchestrator'], { env: plain(h.env) });
  rec('I8', 'gates', 'tower-crane evidence T2 --type tests --ok --agent orchestrator', 'refused: only check tests records tests evidence', out(r), r.code !== 0 ? 'held' : 'CONFIRMED');
} finally {
  save('identity');
  require('node:fs').rmSync(h.base, { recursive: true, force: true });
}
