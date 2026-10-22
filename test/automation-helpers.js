'use strict';

// The automation suites share these fixtures; each suite file runs in its own process.

const fs = require('node:fs');
const path = require('node:path');
const { waitUntil } = require('./signals');
const { makeRepo, cachedFixture, stubRungs, BIN, detachedAlive } = require('./helpers');
const { gateFixture } = require('./gate-helpers');

const ghStub = path.join(__dirname, 'fixtures', 'automation-gh.js');
const harness = path.join(__dirname, 'fixtures', 'automation-harness.js');
const MERGEABILITY_PAUSE = path.join(__dirname, 'fixtures', 'mergeability-pause.js');

// These suites test the gates themselves, so they run tests before review
// unless a test asks for the default order.
function setup(t, { kind = 'code', ci = 'success', repo, testsFirst = true } = {}) {
  const h = repo || makeRepo(t);
  // Sandboxed command harnesses create synthetic mount targets under their inherited TMPDIR.
  const tmp = path.join(h.base, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  Object.assign(h.env, { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
  h.sha = gateFixture(h);
  // A rework refills workers and a submission starts reviewers; a test that
  // checks one pins its own harness.
  stubRungs(h);
  h.init(['--repo', 'acme/demo', '--base', 'main', ...(testsFirst ? ['--review-policy', '{"tests_first":true}'] : [])]);
  const tools = path.join(h.base, 'tools');
  fs.writeFileSync(path.join(tools, 'gh'), `#!/usr/bin/env node\nrequire(${JSON.stringify(ghStub)});\n`);
  fs.chmodSync(path.join(tools, 'gh'), 0o755);
  // The offline GitHub settles at once; automation keeps its UNKNOWN re-reads without their pauses.
  h.env.NODE_OPTIONS = `--require=${JSON.stringify(MERGEABILITY_PAUSE)}`;
  h.env.HOOK_MERGEABILITY_PAUSE_MS = '10';
  // Each fixture step is a fresh wait that rechecks CI within seconds.
  h.env.HOOK_CI_POLL_MS = '0';
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(tools, 'gh.cmd'), `@"${process.execPath}" "${ghStub}" %*\r\n`);
    const preload = path.join(h.base, 'offline-gh.js');
    // Windows cannot spawn a .cmd directly. Resolve PATH first so agent
    // policy shims still run before the offline GitHub executable.
    // The offline executable stands in for gh.exe, which takes each argument
    // as given; through cmd.exe a multi-line argument would end at its newline.
    fs.writeFileSync(preload, `const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),run=cp.spawnSync;
const offline=${JSON.stringify(path.join(tools, 'gh.cmd'))};
cp.spawnSync=(cmd,args,opts)=>{
  if(cmd!=='gh')return run(cmd,args,opts);
  const env=opts?.env||process.env;
  for(const dir of String(env.PATH||env.Path||'').split(path.delimiter)){
    for(const ext of ['.exe','.cmd','.bat']){
      const file=path.join(dir,cmd+ext);
      if(!fs.existsSync(file))continue;
      if(ext==='.exe')return run(file,args,opts);
      if(path.resolve(file)===path.resolve(offline))return run(process.execPath,[${JSON.stringify(ghStub)},...args],opts);
      const quoted=[file,...args].map(arg=>'"'+String(arg).replace(/"/g,'""')+'"').join(' ');
      return run(env.ComSpec||env.COMSPEC||'cmd.exe',['/d','/s','/c','"'+quoted+'"'],
        {...opts,windowsVerbatimArguments:true});
    }
  }
  return run(cmd,args,opts);
};\n`);
    h.env.NODE_OPTIONS += ` --require=${JSON.stringify(preload)}`;
  }
  h.env.AUTOMATION_GITHUB = path.join(h.base, 'github.json');
  attach(h);
  h.saveGithub({ root: h.repo, prs: { 7: {
    state: 'OPEN', headRefOid: h.sha, headRefName: 'fixture-change',
    headRepository: { nameWithOwner: 'acme/demo' }, url: 'https://github.com/acme/demo/pull/7',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefName: 'main',
  } }, ci: { [h.sha]: ci } });
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works', '--kind', kind]);
  h.ok(['brief', 'set', 'T1', '-'], { input: '# Change\n\nImplement the acceptance.\n' });
  return h;
}

// The calls a setup() fixture's tests make, bound to h, so a copy of a cached
// fixture gets its own.
function attach(h) {
  h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
  h.saveGithub = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(state));
  h.submit = (id = 'T1', sha = h.sha, pr = '7') => {
    h.ok(['claim', id, '--agent', 'worker']);
    // A worker's submit refuses failing CI (T149), so the head is submitted while its
    // CI reads green. The CI the test set returns before any reaction runs.
    const before = h.github();
    const ciAtSubmit = before.ci[sha];
    before.ci[sha] = 'success';
    h.saveGithub(before);
    h.ok(['submit', id, '--sha', sha, '--pr', pr, '--agent', 'worker']);
    const after = h.github();
    after.ci[sha] = ciAtSubmit;
    h.saveGithub(after);
  };
  h.consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return h;
}

// The first gate run holds the only executor until the test writes `release`;
// it writes `stalled` once it starts. With giveUpMs it also passes on its own
// after that long, so a test whose release never comes fails on what ran
// before the gate ended instead of hanging.
function holdSuite(h, { giveUpMs = null } = {}) {
  const suite = path.join(h.base, 'tools', 'hold-suite.js');
  const stalled = path.join(h.base, 'stalled');
  const release = path.join(h.base, 'release');
  fs.writeFileSync(suite, `const fs = require('node:fs');
if (fs.existsSync(${JSON.stringify(stalled)})) process.exit(0);
fs.writeFileSync(${JSON.stringify(stalled)}, '');
const end = ${giveUpMs === null ? 'Infinity' : `Date.now() + ${giveUpMs}`};
const poll = () => (fs.existsSync(${JSON.stringify(release)}) || Date.now() >= end ? process.exit(0) : setTimeout(poll, 50)); // wait-allow: probe cadence only; the release signal, giveUpMs and hung-test timeout bound this fixture
poll();
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    '--executors', '1', '--agent', 'orchestrator']);
  return { stalled, release };
}

function configureHarness(h, { rules = false } = {}) {
  const home = path.join(h.base, 'home');
  fs.mkdirSync(home, { recursive: true });
  Object.assign(h.env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), XDG_CACHE_HOME: path.join(home, '.cache'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), npm_config_cache: path.join(home, 'npm'),
    GH_TOKEN: 'automation-fixture', STUB_RUN: '[]',
    AUTOMATION_CONTEXT_DIR: path.join(h.base, 'context'),
  });
  fs.mkdirSync(h.env.AUTOMATION_CONTEXT_DIR);
  if (rules) fs.writeFileSync(path.join(h.base, 'AGENTS.md'), 'Read the acceptance before changing code.\n');
  h.ok(['task', 'update', 'T1', '--tier', 'easy']);
  // Dispatch strips Node preloads, and on Windows the agents' own CLI calls
  // reach the offline GitHub only through the preload setup() wrote.
  const env = process.platform === 'win32' ? ['--env', JSON.stringify({ NODE_OPTIONS: h.env.NODE_OPTIONS })] : [];
  for (const rung of ['easy', 'review']) h.ok(['ladder', 'set', rung, '--harness', 'command', '--command',
    JSON.stringify([process.execPath, harness, BIN, 'auto', '{prompt}']), ...env,
    ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((f) => ['--clear', f])]);
}

function refillFixture(t) {
  const h = cachedFixture(null, 'automation-refill', (repo) => {
    const h = setup(null, { ci: 'pending', repo });
    configureHarness(h);
    // Refill dispatches a gate rework at once here; the restore hold has its own tests.
    h.ok(['project', 'set', '--workers', '1', '--rework-hold-min', '0']);
    for (const id of ['T2', 'T3', 'T4']) {
      h.ok(['task', 'add', '--title', id, '--acceptance', 'works', '--tier', 'easy',
        ...(id === 'T4' ? ['--dep', 'T3'] : [])]);
      h.ok(['brief', 'set', id, '-'], { input: `Implement ${id}.\n` });
    }
    const script = path.join(h.base, 'refill-worker.js');
    fs.writeFileSync(script, `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const task = process.env.TOWER_CRANE_TASK;
cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, 'claim', task], { env: fakeAgentEnv(process.env), stdio: 'pipe' });
const file = path.join(process.env.AUTOMATION_CONTEXT_DIR, task);
// Tests read the prompt once the marker exists, so the marker comes last.
fs.writeFileSync(file + '.prompt', process.argv[2]);
fs.writeFileSync(file, '');
if (process.env.REFILL_ORPHAN) {
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  // The test signals this pid, so it must never read the file empty.
  require(${JSON.stringify(path.join(__dirname, 'atomic-file'))}).writeAtomic(file + '.orphan', String(child.pid));
}
const poll = () => fs.existsSync(file + '.go') ? fs.writeFileSync(file + '.exited', '') : setTimeout(poll, 25); // wait-allow: probe cadence only; the finish file releases the worker
poll();
`);
    h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, script, '{prompt}'])]);
    return { sha: h.sha };
  });
  h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
  h.saveGithub = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(state));
  h.submit = (id = 'T1', agent = 'worker') => {
    h.ok(['claim', id, '--agent', agent]);
    // A worker's submit refuses failing CI (T149), so the head is submitted while its
    // CI reads green. The CI the test set returns after the submit.
    const before = h.github();
    const ciAtSubmit = before.ci[h.sha];
    before.ci[h.sha] = 'success';
    h.saveGithub(before);
    h.ok(['submit', id, '--sha', h.sha, '--pr', '7', '--agent', agent]);
    const after = h.github();
    after.ci[h.sha] = ciAtSubmit;
    h.saveGithub(after);
  };
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  h.consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  h.marker = (id) => path.join(h.env.AUTOMATION_CONTEXT_DIR, id);
  t.after(async () => {
    const ids = h.readState('tasks.json').tasks.map((task) => task.id);
    for (const id of ids) fs.writeFileSync(`${h.marker(id)}.go`, '');
    // A worker a test killed never writes its exit marker; its gone process ends the wait.
    for (const id of ids) {
      const pid = h.logs().findLast((e) => e.cmd === 'spawn' && e.task === id)?.detail.pid;
      if (!fs.existsSync(h.marker(id)) || !pid) continue;
      await waitUntil(() => fs.existsSync(`${h.marker(id)}.exited`) || !detachedAlive({ pid }), {
        paths: [path.dirname(h.marker(id))], what: `refill worker ${id} did not exit`,
      });
    }
    await h.cleanup();
  });
  return h;
}

module.exports = { setup, attach, holdSuite, configureHarness, refillFixture, ghStub, harness, MERGEABILITY_PAUSE };
