'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, detachedAlive, fakeAgentEnv, dispatch, BIN } = require('./helpers');
const { readPublished, writeAtomic } = require('./atomic-file');
const { killPid, waitOnRepo, fileWritten, HUNG_TEST_MS } = require('./signals');
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

const controllerHome = (t) => cachedFixture(t, 'controller-home', h => {
  h.init(['--tasks-max', '64', '--memory-max-bytes', String(512 * 1024 ** 2)]);
  for (const title of ['Controller owner', 'Prune while live', 'Prune after exit']) {
    const id = h.ok(['task', 'add', '--title', title, '--acceptance', 'keeps owned paths', '--tier', 'easy']).trim();
    h.ok(['brief', 'set', id, '-'], { input: 'Finite home lifetime probe.\n' });
  }
});

for (const detached of [true, false]) {
for (const delayed of [false, true]) {
test(`a subsequent CLI spawn keeps a ${detached ? 'detached' : 'same-group'} controller home until it exits${delayed ? ' after held startup' : ''}`, {
  skip: process.platform !== 'linux' && 'Linux marked-home liveness',
  timeout: HUNG_TEST_MS,
}, async (t) => {
  const h = controllerHome(t);
  h.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
  const dir = path.join(h.base, 'probe');
  fs.mkdirSync(dir);
  const ready = path.join(dir, 'ready.json');
  const started = path.join(dir, 'controller-started.json');
  const forked = path.join(dir, 'controller-forked.json');
  const release = path.join(dir, 'release');
  const atomic = require.resolve('./atomic-file');
  const preload = path.join(dir, 'startup.js');
  fs.writeFileSync(preload, `
const fs=require('node:fs'),path=require('node:path');
if(${delayed}&&path.basename(process.argv[1]||'')==='agent.js'){
 const timeout=global.setTimeout;
 global.setTimeout=(fn,ms,...args)=>timeout(fn,ms===10000?1:ms,...args);
}
if(process.argv[1]===${JSON.stringify(BIN)}&&process.argv[2]==='wait'){
 require(${JSON.stringify(atomic)}).writeAtomic(${JSON.stringify(started)},JSON.stringify({
  pid:process.pid,startTicks:require(${JSON.stringify(require.resolve('../lib/processes'))}).identity(process.pid).start_ticks,
  hostRoot:process.env.TOWER_CRANE_HOST_ROOT
 }));
 if(${delayed}){
  const until=performance.now()+${HUNG_TEST_MS}; // wait-allow: injected startup barrier shares the test's hung backstop
  while(!fs.existsSync(${JSON.stringify(release)})){
   if(performance.now()>=until)throw new Error('controller startup was not released');
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
  }
 }
}
`);
  h.env.NODE_OPTIONS += ` --require ${JSON.stringify(preload)}`;
  const agent = path.join(dir, 'agent.js');
  fs.writeFileSync(agent, `
const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');
const {fakeAgentEnv}=require(${JSON.stringify(require.resolve('./agent-env'))});
if(!process.env.TOWER_CRANE_HOST_ROOT)throw new Error('agent lost its fixture host');
require(${JSON.stringify(atomic)}).writeAtomic(path.join(${JSON.stringify(dir)},'host-'+process.env.TOWER_CRANE_TASK+'.json'),
 JSON.stringify({hostRoot:process.env.TOWER_CRANE_HOST_ROOT}));
if(process.env.TOWER_CRANE_TASK==='T1'){
 const home=path.dirname(process.env.TOWER_CRANE_HOOK);
 const paths={home,cache:path.join(home,'home','.cache'),tmp:path.join(home,'tmp')};
 for(const p of Object.values(paths))fs.mkdirSync(p,{recursive:true});
 const env=fakeAgentEnv({...process.env,HOME:path.join(home,'home'),XDG_CACHE_HOME:paths.cache,TMPDIR:paths.tmp});
 if(env.TOWER_CRANE_HOST_ROOT!==process.env.TOWER_CRANE_HOST_ROOT)throw new Error('nested wait lost its fixture host');
 const child=cp.spawn(process.execPath,[${JSON.stringify(BIN)},'wait','--observe','--follow','--agent',process.env.TOWER_CRANE_AGENT],{
  env,
  detached:${detached},stdio:'ignore'});child.unref();
 require(${JSON.stringify(atomic)}).writeAtomic(${JSON.stringify(forked)},JSON.stringify({
  pid:child.pid,startTicks:require(${JSON.stringify(require.resolve('../lib/processes'))}).identity(child.pid).start_ticks
 }));
 // Only the renamed record counts: containment reads no staged registration.
 const record=new RegExp('^'+child.pid+'-[a-f0-9]{16}\\\\.json$');
 child.once('exit',(code,signal)=>{process.stderr.write('controller '+child.pid+' exited ('+(signal||code)+') before it registered\\n');process.exit(1);});
 const registered=()=>{
  const dir=path.join(process.env.TOWER_CRANE_STATE,'controllers');
  if(!fs.existsSync(dir)||!fs.readdirSync(dir).some(name=>record.test(name)))return setTimeout(registered,25); // wait-allow: wait for the controller's recorded identity
  require(${JSON.stringify(atomic)}).writeAtomic(${JSON.stringify(ready)},JSON.stringify({pid:child.pid,...paths}));
  process.exit(0);
 };
 registered();
 // Half the test's backstop, so this named failure reaches the test before its own timeout.
 setTimeout(()=>{process.stderr.write('controller '+child.pid+' did not register\\n');process.exit(1);},${HUNG_TEST_MS / 2}).unref(); // wait-allow: registration shares the test's hung backstop
}
`);
  for (const rung of ['easy', 'orchestrator']) {
    h.ok(['ladder', 'set', rung, '--harness', 'command', '--command',
      JSON.stringify([process.execPath, agent, '{prompt}']),
      '--env', JSON.stringify(fakeAgentEnv({ NODE_OPTIONS: h.env.NODE_OPTIONS })),
      '--clear', 'profile', '--clear', 'effort']);
  }
  let held;
  let controller;
  let phase = 'spawn';
  t.after(() => {
    if (t.signal.aborted) console.error(`controller-home timeout at ${phase}; controller=${controller?.pid || held?.pid || 'unknown'}`);
    const owned = controller || held || (fs.existsSync(forked) ? JSON.parse(readPublished(forked, 'utf8')) : null);
    if (owned && detachedAlive(owned)) killPid(owned.pid, 'SIGKILL');
  });
  const deadline = new AbortController();
  const bound = setTimeout(() => deadline.abort(new Error('controller handshake timed out')), HUNG_TEST_MS);
  const dispatched = dispatch(t, h, { args: ['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait', '--json'] });
  const pending = dispatched.run;
  const checked = pending.then(result => {
    assert.equal(result.code, 0, `spawn --wait exited ${result.code}\nagent stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    return JSON.parse(result.stdout);
  });
  let spawned;
  try {
    if (delayed) {
      phase = 'controller startup';
      controller = await Promise.race([
        fileWritten(started, { json: true, signal: deadline.signal }),
        checked,
      ]);
      writeAtomic(release, 'release');
    }
    phase = 'spawn completion';
    spawned = await checked;
    phase = 'controller identity';
    controller ||= await fileWritten(started, { json: true, signal: deadline.signal });
  } finally {
    clearTimeout(bound);
    deadline.abort();
    writeAtomic(release, 'release');
    await pending;
  }
  held = JSON.parse(readPublished(ready, 'utf8'));
  assert.equal(controller.pid, held.pid);
  assert.equal(controller.hostRoot, h.env.TOWER_CRANE_HOST_ROOT, 'nested wait uses the fixture host');
  assert.ok(detachedAlive({ pid: held.pid }));
  phase = 'prune while live';
  h.ok(['spawn', '--task', 'T2', '--wait']);
  for (const key of ['home', 'cache', 'tmp']) assert.ok(fs.existsSync(held[key]), `${key} pruned while its controller runs`);
  const kept = h.json(['status']).kept_homes.find(entry => entry.agent === spawned.agent);
  if (detached) assert.ok(kept?.pids.includes(held.pid));
  else assert.notEqual(P.processGroupState({ pid: spawned.pid }), 'exited');
  killPid(held.pid, 'SIGTERM');
  phase = 'controller exit';
  await waitOnRepo(h, () => !detachedAlive({ pid: held.pid }), 'controller did not exit');
  phase = 'prune after exit';
  h.ok(['spawn', '--task', 'T3', '--wait']);
  for (const key of ['home', 'cache', 'tmp']) assert.equal(fs.existsSync(held[key]), false, `${key} retained after its last user exits`);
  for (const id of ['T1', 'T2', 'T3']) {
    assert.equal(JSON.parse(readPublished(path.join(dir, `host-${id}.json`), 'utf8')).hostRoot,
      h.env.TOWER_CRANE_HOST_ROOT, `${id} spawn uses the fixture host`);
  }
});
}
}

test('a controller started before its spawn is recorded registers before its wait starts', {
  skip: process.platform !== 'linux' && 'Linux marked-home liveness',
  timeout: HUNG_TEST_MS,
}, async (t) => {
  const h = controllerHome(t);
  h.ok(['ladder', 'set', 'orchestrator', '--harness', 'command', '--command',
    JSON.stringify([process.execPath, '-e', '0', '{prompt}']), '--env', JSON.stringify(fakeAgentEnv({ NODE_OPTIONS: h.env.NODE_OPTIONS })),
    '--clear', 'profile', '--clear', 'effort']);
  const agent = 'orchestrator-T1-1';
  const dir = path.join(h.base, 'probe');
  fs.mkdirSync(dir);
  const unrecorded = path.join(dir, 'read-unrecorded');
  // Marks the controller's first log read that has no spawn record for it, so
  // the dispatch below records the spawn only after the controller started.
  const preload = path.join(dir, 'read-probe.js');
  fs.writeFileSync(preload, `
if(process.argv[1]===${JSON.stringify(BIN)}&&process.argv[2]==='wait'){
 const S=require(${JSON.stringify(require.resolve('../lib/state'))});
 const read=S.readEvents;
 let marked=false;
 S.readEvents=(...args)=>{
  const events=read(...args);
  if(!marked&&!events.some(e=>e.cmd==='spawn'&&e.detail?.agent===${JSON.stringify(agent)})){
   marked=true;
   require(${JSON.stringify(require.resolve('./atomic-file'))}).writeAtomic(${JSON.stringify(unrecorded)},'1');
  }
  return events;
 };
}
`);
  let stdout = '';
  let exited = false;
  const controller = cp.spawn(process.execPath, [BIN, 'wait', '--observe', '--follow', '--agent', agent], {
    cwd: h.repo,
    env: { ...h.env, NODE_OPTIONS: `${h.env.NODE_OPTIONS} --require ${JSON.stringify(preload)}`,
      TOWER_CRANE_AGENT: agent, TOWER_CRANE_TASK: 'T1', TOWER_CRANE_STATE: h.state,
      // A supervisor's startup window, here bounded by the test's own backstop.
      TOWER_CRANE_STARTUP_DEADLINE: String(Date.now() + HUNG_TEST_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  controller.stdout.on('data', (d) => { stdout += d; });
  controller.stderr.on('data', (d) => { stdout += d; });
  controller.once('exit', () => { exited = true; });
  t.after(() => { if (!exited) controller.kill('SIGKILL'); });
  const alive = () => !exited;
  await waitOnRepo(h, () => fs.existsSync(unrecorded) || stdout.includes('"type":"ready"'),
    `controller ${controller.pid} read no log; output: ${stdout}`, { alive });
  const records = () => {
    try { return fs.readdirSync(path.join(h.state, 'controllers')).filter((name) => name.startsWith(`${controller.pid}-`) && name.endsWith('.json')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const before = records();
  h.ok(['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait']);
  await waitOnRepo(h, () => stdout.includes('"type":"ready"'), `controller ${controller.pid} never started its wait; output: ${stdout}`, { alive });
  assert.deepEqual(before, [], 'the controller registered before its spawn was recorded');
  assert.equal(records().length, 1, `controller ${controller.pid} started its wait without registering`);
});

test('only a spawned identity inside its startup window waits for its own spawn record', async (t) => {
  const { awaitSpawnRecord } = require('../lib/authority');
  const h = controllerHome(t);
  const agent = 'orchestrator-T1-1';
  const soon = () => String(Date.now() + 200);
  const env = (extra = {}) => ({ TOWER_CRANE_AGENT: agent, TOWER_CRANE_STATE: h.state, TOWER_CRANE_STARTUP_DEADLINE: soon(), ...extra });
  const rows = [
    ['spawn not recorded yet', () => ({ agent, env: env() }), true],
    ['no startup deadline', () => ({ agent, env: env({ TOWER_CRANE_STARTUP_DEADLINE: undefined }) }), false],
    ['deadline passed', () => ({ agent, env: env({ TOWER_CRANE_STARTUP_DEADLINE: String(Date.now() - 1) }) }), false],
    ['another identity than the spawned one', () => ({ agent: 'worker-T1-1', env: env() }), false],
    ['another state directory', () => ({ agent, env: env(), stateDir: path.join(h.base, 'other') }), false],
    ['plain orchestrator name', () => ({ agent: 'orchestrator', env: env({ TOWER_CRANE_AGENT: 'orchestrator' }) }), false],
    ['owner', () => ({ agent: 'owner', env: env({ TOWER_CRANE_AGENT: 'owner' }) }), false],
  ];
  // Each row reads the clock when it runs: a waiting row uses up the deadline of the next.
  for (const [name, ctx, waits] of rows) {
    let done = false;
    const pending = awaitSpawnRecord({ stateDir: h.state, ...ctx() }).then(() => { done = true; });
    // A command that does not wait resolves before any timer runs.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(!done, waits, name);
    await pending;
  }
});
