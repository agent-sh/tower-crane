'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, detachedAlive, BIN } = require('./helpers');
const { readPublished } = require('./atomic-file');
const { killPid, waitOnRepo } = require('./signals');
const P = require('../lib/processes');

test('home liveness and output cleanup use different controller ownership tables', {
  skip: process.platform !== 'linux' && 'Linux run-marker snapshots',
}, () => {
  const originalRead = fs.readFileSync;
  const originalDir = fs.readdirSync;
  const mark = 'TOWERCRANE_SPAWN_RUN_home_table';
  const cases = [
    ['wait', 'node bin/tower-crane.js wait', false],
    ['check', 'node bin/tower-crane.js check tests T1', false],
    ['accept', 'node bin/tower-crane.js accept T1', false],
    ['merge', 'node bin/tower-crane.js merge --accepted', false],
    ['keeper', 'node lib/containment-keeper.js "{}"', false],
    ['ordinary', 'node watcher.js', false],
    ['supervisor', 'node lib/spawn-monitor.js job.json', true],
  ];
  try {
    for (const [kind, command, supervisor] of cases) {
      const pid = 9000001;
      const child = pid + 1;
      fs.readdirSync = (dir, ...args) => dir === '/proc' ? [String(pid), String(child)] : originalDir(dir, ...args);
      fs.readFileSync = (file, ...args) => {
        if (file === `/proc/${pid}/stat`) return `${pid} (root) S 1 ${pid} ${Array(16).fill('0').join(' ')} start`;
        if (file === `/proc/${child}/stat`) return `${child} (child) S ${pid} ${child} ${Array(16).fill('0').join(' ')} child-start`;
        if (file === `/proc/${pid}/environ`) return `${mark}=1\0${supervisor ? P.SUPERVISOR_MARK + '=1\0' : ''}`;
        if (file === `/proc/${child}/environ`) return '';
        if (file === `/proc/${pid}/cmdline`) return command.replace(/ /g, '\0');
        if (file === `/proc/${child}/cmdline`) return 'node\0child.js';
        return originalRead(file, ...args);
      };
      const live = supervisor ? [] : [pid, child];
      const cleanup = kind === 'ordinary' ? [pid, child] : [];
      const identity = { pid, start: 'start' };
      assert.deepEqual(P.strayIndex([mark], { spared: supervisor ? [identity] : [] })([mark]).sort(), live, kind);
      assert.deepEqual(P.strays(null, mark, { spared: supervisor ? [identity] : [] }).sort(), live, kind);
      assert.deepEqual(P.strays(null, mark, { spared: kind === 'ordinary' ? [] : [identity] }).sort(), cleanup, kind);
      assert.deepEqual(P.strays(null, mark).sort(), [pid, child], 'names and markers alone grant no retention');
    }
  } finally {
    fs.readFileSync = originalRead;
    fs.readdirSync = originalDir;
  }
});

for (const detached of [true, false]) {
test(`a subsequent CLI spawn keeps a ${detached ? 'detached' : 'same-group'} controller home until it exits`, {
  skip: process.platform !== 'linux' && 'Linux marked-home liveness',
}, async (t) => {
  const h = cachedFixture(t, 'controller-home', h => {
    h.init(['--tasks-max', '64', '--memory-max-bytes', String(512 * 1024 ** 2)]);
    for (const title of ['Controller owner', 'Prune while live', 'Prune after exit']) {
      const id = h.ok(['task', 'add', '--title', title, '--acceptance', 'keeps owned paths', '--tier', 'easy']).trim();
      h.ok(['brief', 'set', id, '-'], { input: 'Finite home lifetime probe.\n' });
    }
  });
  h.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
  const dir = path.join(h.base, 'probe');
  fs.mkdirSync(dir);
  const ready = path.join(dir, 'ready.json');
  const writeAtomic = require.resolve('./atomic-file');
  const agent = path.join(dir, 'agent.js');
  fs.writeFileSync(agent, `
const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');
const {fakeAgentEnv}=require(${JSON.stringify(require.resolve('./agent-env'))});
if(process.env.TOWER_CRANE_TASK==='T1'){
 const home=path.dirname(process.env.TOWER_CRANE_HOOK);
 const paths={home,cache:path.join(home,'home','.cache'),tmp:path.join(home,'tmp')};
 for(const p of Object.values(paths))fs.mkdirSync(p,{recursive:true});
 const child=cp.spawn(process.execPath,[${JSON.stringify(BIN)},'wait','--observe','--follow','--agent',process.env.TOWER_CRANE_AGENT],{
  env:fakeAgentEnv({...process.env,HOME:path.join(home,'home'),XDG_CACHE_HOME:paths.cache,TMPDIR:paths.tmp}),
  detached:${detached},stdio:'ignore'});child.unref();
 const registered=()=>{
  const dir=path.join(process.env.TOWER_CRANE_STATE,'controllers');
  if(!fs.existsSync(dir)||!fs.readdirSync(dir).some(name=>name.startsWith(child.pid+'-')))return setTimeout(registered,25); // wait-allow: wait for the controller's recorded identity
  require(${JSON.stringify(writeAtomic)}).writeAtomic(${JSON.stringify(ready)},JSON.stringify({pid:child.pid,...paths}));
  process.exit(0);
 };
 registered();
 setTimeout(()=>process.exit(1),10000).unref(); // wait-allow: finite registration fixture deadline
}
`);
  for (const rung of ['easy', 'orchestrator']) {
    h.ok(['ladder', 'set', rung, '--harness', 'command', '--command',
      JSON.stringify([process.execPath, agent, '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
  }
  let held;
  t.after(() => { if (held && detachedAlive({ pid: held.pid })) killPid(held.pid, 'SIGKILL'); });
  const spawned = h.json(['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait']);
  held = JSON.parse(readPublished(ready, 'utf8'));
  assert.ok(detachedAlive({ pid: held.pid }));
  h.ok(['spawn', '--task', 'T2', '--wait']);
  for (const key of ['home', 'cache', 'tmp']) assert.ok(fs.existsSync(held[key]), `${key} pruned while its controller runs`);
  const kept = h.json(['status']).kept_homes.find(entry => entry.agent === spawned.agent);
  if (detached) assert.ok(kept?.pids.includes(held.pid));
  else assert.notEqual(P.processGroupState({ pid: spawned.pid }), 'exited');
  killPid(held.pid, 'SIGTERM');
  await waitOnRepo(h, () => !detachedAlive({ pid: held.pid }), 'controller did not exit');
  h.ok(['spawn', '--task', 'T3', '--wait']);
  for (const key of ['home', 'cache', 'tmp']) assert.equal(fs.existsSync(held[key]), false, `${key} retained after its last user exits`);
});
}
