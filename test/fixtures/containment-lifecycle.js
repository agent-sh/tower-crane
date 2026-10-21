'use strict';

const cp = require('node:child_process');
const path = require('node:path');
const C = require('../../lib/containment');
const { writeAtomic, readPublished, updateJson } = require('../atomic-file');
const [role, dir, kind = 'supervisor', ending = 'zero', late = 'none'] = process.argv.slice(2);
const limits = { tasks_max: late === 'tasks' ? (C.canScope() ? 32 : 4) : 64,
  memory_max_bytes: (late === 'memory' ? 384 : 512) * 1024 ** 2 };
const retained = () => {
  try { return JSON.parse(readPublished(path.join(dir, 'identities.json'), 'utf8')); } catch { return []; }
};
// A hosted Windows runner's CIM snapshot and stop take about a second each, so the
// times that tell stopped work from surviving work stretch there. Keep in step with
// test/containment-lifecycle.test.js.
const scale = process.platform === 'win32' ? 5 : 1;

function launch(childRole, env, extra = []) {
  const child = cp.spawn(process.execPath, [__filename, childRole, dir, kind, ending, late, ...extra], {
    env, detached: true, stdio: 'ignore',
  });
  child.on('error', () => {});
  return child;
}

if (role === 'caller') {
  const child = C.spawn(process.execPath, [__filename, 'agent', dir, kind, ending, late], {
    resources: limits, stdio: 'ignore', retained,
  });
  child.once('close', async () => {
    await child.containmentDone;
    writeAtomic(path.join(dir, 'closed.json'), JSON.stringify(child.containment));
    process.exit(0);
  });
} else if (role === 'agent') {
  const env = { ...process.env };
  if (kind === 'supervisor') env.TOWERCRANE_SUPERVISOR = '1';
  if (kind === 'gate') env.TOWERCRANE_GATE_RUN_lifecycle = '1';
  const extra = kind === 'supervisor' ? ['spawn-monitor.js']
    : kind === 'wait' ? ['tower-crane.js', 'wait'] : ['tower-crane.js', 'check'];
  const dispatched = launch('managed', env, extra);
  // A dispatch returns only once its supervisor's identity is on record. On Windows
  // that identity is a CIM query of a second or more, longer than this owner's 400 ms.
  const recorded = process.env.TC_UNRECORDED_FIXTURE ? Promise.resolve()
    : new Promise(resolve => dispatched.once('spawn', resolve)).then(async () => {
      // Stands in for a slow CIM query where the identity is a fast /proc read.
      await new Promise(resolve => setTimeout(resolve, Number(process.env.TC_IDENTITY_DELAY_MS || 0))); // wait-allow: emulate a slow identity query
      const identity = await C.processIdentity(dispatched.pid);
      updateJson(path.join(dir, 'identities.json'), () => identity ? [identity] : [], []);
    });
  const end = () => {
    launch('ordinary', process.env);
    setTimeout(() => ending === 'signal' ? process.kill(process.pid, 'SIGTERM') // wait-allow: end the owner before dispatched work completes
      : process.exit(ending === 'nonzero' ? 7 : 0), 400);
  };
  recorded.then(end, end);
} else if (role === 'managed') {
  const env = { ...process.env };
  delete env.TOWERCRANE_SUPERVISOR;
  if (late === 'none') launch('grandchild', env);
  if (late === 'tasks') setTimeout(() => { // wait-allow: start the bounded fork probe after the owner exits
    let n = 0;
    const timer = setInterval(() => {
      launch('leaf', env);
      if (++n === 6) clearInterval(timer);
    }, 40); // wait-allow: finite late fork probe, at most six children
  }, 650 * scale);
  if (late === 'memory') setTimeout(() => { // wait-allow: allocate the fixed buffer budget after the owner exits
    global.blocks = Array.from({ length: 24 }, () => Buffer.alloc(16 * 1024 ** 2, 1));
  }, 650 * scale); // wait-allow: finite retained memory probe
  setTimeout(() => writeAtomic(path.join(dir, 'managed.done'), 'done'), 1100 * scale); // wait-allow: delayed dispatch completion proves survival
  setTimeout(() => process.exit(0), 1800 * scale); // wait-allow: finite dispatched controller lifetime
} else if (role === 'ordinary' || role === 'grandchild') {
  setTimeout(() => writeAtomic(path.join(dir, role + '.done'), 'done'), 1000 * scale); // wait-allow: distinguish surviving work from cleaned strays
  setTimeout(() => process.exit(0), 1400 * scale); // wait-allow: finite descendant lifetime
} else {
  setTimeout(() => process.exit(0), 2000 * scale); // wait-allow: finite late fork child lifetime
}
