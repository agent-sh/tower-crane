'use strict';

const { waitUntil, HUNG_TEST_MS, killPid, killGroup } = require('./signals');

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const test = require('node:test');
const { createRepoSeed, cleanupRepoSeed, FOREGROUND_MAINTENANCE } = require('./repo-seed');
const { tempRoot, liveRoot } = require('./tmp-root');
const { readPublished } = require('./atomic-file');
const UserConfigGuard = require('./fixtures/user-config-guard');
const StateFiles = require('./state-files');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'tower-crane.js');
const HOOKS = path.join(__dirname, 'fixtures', 'hooks.js');
const ACCOUNT_HOME = path.join(__dirname, 'fixtures', 'account-home.js');
const ACCOUNT_HOME_OPTION = `--require "${ACCOUNT_HOME.replace(/\\/g, '/')}"`;
const TMP_ROOT = tempRoot();
const LIVE_ROOT = liveRoot();
const SHARED_REPO_SEED = process.env.TC_TEST_REPO_SEED;
const OWNER_KEY = 'fixture-owner-key';
const fileFixtures = new Set();
async function cleanupFileFixtures() {
  for (const fixture of fileFixtures) await fixture.cleanup();
}
// A stopping monitor can start the next attempt's monitor and worker after a snapshot of the
// detached records, so teardown takes new snapshots and kills their unseen records until none appear.
function unseenDetached(fixture, seen) {
  const key = (c) => `${c.pid}:${c.startTicks ?? c.startTime}`;
  const fresh = fixture.detached().filter((c) => !seen.has(key(c)));
  for (const c of fresh) seen.add(key(c));
  return fresh;
}
// Processes started during teardown are not expected to exit on their own, so they are killed.
async function killStarted(children) {
  children.forEach(killDetached);
  await waitUntil(() => !children.some(detachedAlive), {
    what: () => `processes started during teardown survived it: ${children.filter(detachedAlive).map((c) => c.pid).join(', ')}`,
  });
}
// process.exit() and uncaught exceptions skip beforeExit, and an exit listener runs only
// synchronous code, so this stops detached children with signals and removes the directories.
function cleanupFileFixturesSync() {
  for (const fixture of fileFixtures) {
    try {
      const seen = new Set();
      for (let fresh; (fresh = unseenDetached(fixture, seen)).length;) fresh.forEach(killDetached);
    } catch (error) {
      console.error(error);
    } finally {
      fs.rmSync(fixture.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fileFixtures.delete(fixture);
    }
  }
}
// Plain CLI probes also import helpers; only test workers have file teardown.
if (process.env.NODE_TEST_CONTEXT) test.after(cleanupFileFixtures);
else {
  process.once('beforeExit', () => {
    cleanupFileFixtures().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
  process.once('exit', cleanupFileFixturesSync);
}
delete process.env.TC_TEST_REPO_SEED;
// Scratch consumers can run directly without the runner's global setup.
fs.mkdirSync(TMP_ROOT, { recursive: true });

// A non-live test must never start a real harness CLI: that can spend money,
// reach the network and depend on the host's login. Every test process puts a
// guard for each harness first on PATH, so a fixture that forgets a stub, or a
// route that falls back to a harness on PATH, reaches the guard instead. A live
// probe's opt-in lifts the guard for the harness it runs, and a fixture pinned
// to a live rung (pinLiveRung) runs without it.
const liveBrowser = (env, harness) => env.TOWER_CRANE_LIVE_BROWSER === '1'
  && (!env.TOWER_CRANE_LIVE_BROWSER_HARNESS || env.TOWER_CRANE_LIVE_BROWSER_HARNESS === harness);
const LIVE_OPT_INS = {
  claude: (env) => env.TOWER_CRANE_LIVE_CLAUDE === '1' || env.TOWER_CRANE_LIVE_REVIEW_CACHE === '1' || liveBrowser(env, 'claude'),
  codex: (env) => env.TOWER_CRANE_LIVE_CODEX === '1' || liveBrowser(env, 'codex'),
  opencode: () => false,
  pi: () => false,
  agy: () => false,
};
const HARNESS_GUARD = installHarnessGuard();

function installHarnessGuard() {
  const guarded = Object.keys(LIVE_OPT_INS).filter((name) => !LIVE_OPT_INS[name](process.env));
  if (!guarded.length) return null;
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-harness-guard-')));
  const hits = path.join(dir, 'hits.jsonl');
  const argv = (name) => [process.execPath, path.join(__dirname, 'fixtures', 'harness-guard.js'), hits, name];
  for (const name of guarded) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec ${argv(name).map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@${argv(name).map((a) => `"${a}"`).join(' ')} %*\r\n`);
  }
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  process.env[key] = dir + path.delimiter + (process.env[key] || '');
  return { dir, hits, reported: new Set() };
}

// Fails on guard calls not yet reported: with `base`, only those a fixture
// under it made (by working directory or state directory), so the test that
// owns the fixture fails; without it, every one left.
function assertNoHarnessCalls(base) {
  if (!HARNESS_GUARD) return;
  let text;
  // read-published: the guard appends hits; nothing replaces the file.
  try { text = fs.readFileSync(HARNESS_GUARD.hits, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  const inside = (p) => typeof p === 'string' && (p === base || p.startsWith(base + path.sep));
  // A line still being written has no newline yet; the next check reads it.
  const found = text.split('\n').slice(0, -1).map((line, i) => ({ i, hit: JSON.parse(line) }))
    .filter(({ i, hit }) => !HARNESS_GUARD.reported.has(i) && (!base || inside(hit.cwd) || inside(hit.state)));
  for (const { i } of found) HARNESS_GUARD.reported.add(i);
  if (found.length) {
    assert.fail(`a non-live test started a real harness instead of a stub:\n${found.map(({ hit }) => JSON.stringify(hit)).join('\n')}`);
  }
}
// Calls no fixture owns, such as a test running a harness itself, fail the
// file. A plain script fails through its exit code: a node:test hook would make
// the test runner own the script's exit.
if (HARNESS_GUARD) {
  if (process.env.NODE_TEST_CONTEXT) test.after(() => assertNoHarnessCalls());
  process.once('exit', () => {
    try {
      if (!process.env.NODE_TEST_CONTEXT) assertNoHarnessCalls();
    } catch (error) {
      console.error(error.message);
      process.exitCode ||= 1;
    } finally {
      fs.rmSync(HARNESS_GUARD.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

// Tests must not see the developer's git config (hooks, signing), an
// agent's TOWER_CRANE_* variables or the developer's own ladder defaults, so every
// child gets a clean, explicit env. The user file path is in the temp dir and
// absent between calls unless a test writes it.
function baseEnv(home) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const k of Object.keys(env)) {
    if (k.startsWith('TOWER_CRANE_') || k.startsWith('GIT_') || k === 'TC_TEST_REPO_SEED') delete env[k];
  }
  // Existing fixtures act as the owner without a terminal, so they must
  // provide that identity and the owner key.
  env.TOWER_CRANE_AGENT = 'owner';
  env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  // spawn keeps receipts under the user's cache, which is not the tests' to write.
  env.HOME = path.join(home, 'home');
  // The account's home, where init finds the default owner_config_dir, is the
  // fixture's too (fixtures/account-home.js), so no test reads or binds the
  // developer's ~/.config/tower-crane. The user file and owner key sit where
  // the owner's real ones do.
  env.TC_ACCOUNT_HOME = env.HOME;
  env.NODE_OPTIONS = withAccountHome(env.NODE_OPTIONS);
  // The hook also loads fixtures/user-config-guard.js, which records a CLI
  // whose user file lies outside the roots this test process fixed at load.
  env[UserConfigGuard.ROOTS_ENV] = UserConfigGuard.roots().join(path.delimiter);
  env.TOWER_CRANE_CONFIG = path.join(env.HOME, '.config', 'tower-crane', 'config.json');
  fs.mkdirSync(path.join(env.HOME, '.config', 'tower-crane', 'owner'), { recursive: true });
  fs.writeFileSync(path.join(env.HOME, '.config', 'tower-crane', 'owner', 'key'), `${OWNER_KEY}\n`);
  env.TOWER_CRANE_OWNER_KEY = OWNER_KEY;
  env.USERPROFILE = env.HOME;
  env.LOCALAPPDATA = path.join(env.HOME, 'AppData', 'Local');
  env.XDG_CACHE_HOME = path.join(env.HOME, '.cache');
  // A child exiting after teardown must not recreate its fixture with a compile-cache write.
  env.NODE_DISABLE_COMPILE_CACHE = '1';
  delete env.NODE_COMPILE_CACHE;
  // A gate's worktree and temp directories stay in the fixture, so a gate the test kills
  // cannot leave them in the shared temporary directory.
  env.TOWER_CRANE_TMP = path.join(home, 'gate-tmp');
  return env;
}

// Lib code a test calls in its own process reads the user file named in
// process.env, by default the developer's real ~/.config/tower-crane/config.json.
// This points it at the fixture's user file, the one baseEnv gives the CLIs,
// until the test ends.
function useFixtureUserFile(t, h) {
  const saved = process.env.TOWER_CRANE_CONFIG;
  process.env.TOWER_CRANE_CONFIG = h.env.TOWER_CRANE_CONFIG;
  t.after(() => {
    if (saved === undefined) delete process.env.TOWER_CRANE_CONFIG;
    else process.env.TOWER_CRANE_CONFIG = saved;
  });
}

// NODE_OPTIONS with the account home hook first, whatever else a test adds.
function withAccountHome(options) {
  const rest = String(options ?? '').replace(ACCOUNT_HOME_OPTION, '').trim();
  return rest ? `${ACCOUNT_HOME_OPTION} ${rest}` : ACCOUNT_HOME_OPTION;
}

// The owner_config_dir of every project.json in a fixture that lies outside
// the root the fixtures live in: a CLI that ran without
// fixtures/account-home.js bound it to the real account's home. A copied
// template keeps its template's binding, a fixture under the same root.
// Values no CLI records (relative, or with NUL bytes) are a test's own.
function ownerDirsOutside(base, root = path.dirname(base)) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4 && !['.git', 'node_modules', 'homes', 'brokers'].includes(e.name)) walk(p, depth + 1);
      else if (e.isFile() && e.name === 'project.json') {
        let dirOf;
        try { dirOf = JSON.parse(fs.readFileSync(p, 'utf8')).owner_config_dir; } catch { continue; }
        if (typeof dirOf !== 'string' || !path.isAbsolute(dirOf) || dirOf.includes('\0')) continue;
        if (!dirOf.startsWith(root + path.sep)) found.push(`${p}: ${dirOf}`);
      }
    }
  };
  walk(base, 0);
  return found;
}

function git(args, cwd, env) {
  return cp.execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixtureLadder() {
  return {
    harness: 'codex',
    ladder: {
      orchestrator: { harness: 'claude', model: 'fixture-large', effort: 'high' },
      easy: { profile: 'fixture-light', effort: 'medium' },
      medium: { profile: 'fixture-main', effort: 'high' },
      hard: { harness: 'claude', model: 'fixture-large', effort: 'high' },
      research: { harness: 'claude', model: 'fixture-large', effort: 'max' },
      review: { profile: 'fixture-main', effort: 'high' },
      small: { profile: 'fixture-light', effort: 'low' },
    },
  };
}

// A command rung that fails at once and starts nothing, as an unconfigured
// harness would. stubRungs(h) puts it on every rung but the orchestrator when
// h.init() runs next, for fixtures whose automation dispatches workers or
// reviewers the test never inspects; without it they reach the harness guard.
const STUB_RUNG = { harness: 'command', command: [process.execPath, '-e', 'process.exit(1)', '{prompt}'] };
function stubRungs(h) {
  h.initLadder = Object.fromEntries(Object.keys(fixtureLadder().ladder)
    .filter((name) => name !== 'orchestrator').map((name) => [name, STUB_RUNG]));
}

function pinRung(h, name, rung) {
  const args = ['ladder', 'set', name];
  for (const key of ['harness', 'model', 'profile', 'provider', 'effort', 'args', 'command']) {
    args.push(...(rung[key] === undefined ? ['--clear', key]
      : [`--${key}`, Array.isArray(rung[key]) ? JSON.stringify(rung[key]) : rung[key]]));
  }
  h.ok(args);
}

function pinLiveRung(h, harness, rung = 'small') {
  const field = harness === 'codex' ? 'profile' : 'model';
  const variable = `TOWER_CRANE_LIVE_${field.toUpperCase()}`;
  assert.ok(process.env[variable], `set ${variable} to run a live ${harness} probe`);
  pinRung(h, rung, { harness, [field]: process.env[variable] });
  // The fixture runs a real harness on purpose, so its agents get the PATH
  // without the guard: the guard's stand-ins are test plumbing, not programs
  // the agent's sandbox should open.
  if (HARNESS_GUARD) {
    const key = Object.keys(h.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    h.env[key] = String(h.env[key] || '').split(path.delimiter).filter((dir) => dir !== HARNESS_GUARD.dir).join(path.delimiter);
  }
}

// Init copies defaults from the user layer. Seed that layer only for the call,
// so fixtures keep testing absent user files and later personal overrides.
function fixtureInit(ctx, args, opts, call) {
  if (args[0] !== 'init' || ctx.builtin) return call(args, opts);
  let original;
  try { original = readPublished(ctx.userConfig, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let user;
  try { user = original === undefined ? {} : JSON.parse(original); }
  catch { return call(args, opts); }
  if (!user || typeof user !== 'object' || Array.isArray(user)) return call(args, opts);
  if (user.ladder !== undefined && (!user.ladder || typeof user.ladder !== 'object' || Array.isArray(user.ladder))) return call(args, opts);
  const pinned = fixtureLadder();
  Object.assign(pinned.ladder, ctx.initLadder);
  for (const [name, rung] of Object.entries(user.ladder || {})) {
    pinned.ladder[name] = rung && Object.keys(rung).every(k => k === 'fallbacks')
      ? { ...pinned.ladder[name], ...rung } : rung;
  }
  fs.mkdirSync(path.dirname(ctx.userConfig), { recursive: true });
  fs.writeFileSync(ctx.userConfig, JSON.stringify({ ...pinned, ...user, ladder: pinned.ladder }));
  try { return call(args, opts); }
  finally {
    if (original === undefined) fs.rmSync(ctx.userConfig);
    else fs.writeFileSync(ctx.userConfig, original);
  }
}

// The test runner shares its clean Git seed with all isolated file workers.
let repoSeed;
function getRepoSeed() {
  if (repoSeed) return repoSeed;
  if (SHARED_REPO_SEED) {
    repoSeed = { base: path.dirname(SHARED_REPO_SEED), repo: SHARED_REPO_SEED };
  } else {
    repoSeed = createRepoSeed(TMP_ROOT);
    process.once('exit', () => cleanupRepoSeed(repoSeed));
  }
  return repoSeed;
}

// options.root puts the fixture under another directory than TMP_ROOT, such as LIVE_ROOT.
function makeRepo(t, options = {}) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return makeRepoFromSeed(t, getRepoSeed().repo, options);
}

// A new fixture directory under the temp root, removed if its setup throws: no test owns it yet.
function fixtureDir(setup, root = TMP_ROOT) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'tower-crane-'));
  try {
    return setup(fs.realpathSync.native(dir));
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

function makeRepoFromSeed(t, seedRepo, options = {}) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fixtureDir((base) => {
    fs.writeFileSync(
      path.join(base, 'gitconfig'),
      '[user]\n\tname = tower-crane test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n' + FOREGROUND_MAINTENANCE,
    );
    const env = baseEnv(base);
    const repo = path.join(base, 'repo');
    fs.cpSync(seedRepo, repo, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    return context(t, base, options);
  }, options.root);
}

const repoTemplates = new Map();
function getRepoTemplate(key, prepare) {
  if (repoTemplates.has(key)) return repoTemplates.get(key);
  // Cached state must use the same pinned init path as fresh repositories.
  const ctx = makeRepo();
  try {
    prepare(ctx);
    const template = { base: ctx.base, repo: ctx.repo };
    repoTemplates.set(key, template);
    return template;
  } catch (error) {
    fs.rmSync(ctx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

function makeProjectRepo(t) {
  const template = getRepoTemplate('project', (ctx) => ctx.init());
  return makeRepoFromSeed(t, template.repo);
}

function makeTaskRepo(t, tasks, { projectArgs = [] } = {}) {
  const key = `tasks:${JSON.stringify({ tasks, projectArgs })}`;
  const template = getRepoTemplate(key, (ctx) => {
    ctx.init();
    if (projectArgs.length) ctx.ok(['project', 'set', ...projectArgs]);
    for (const [index, task] of tasks.entries()) {
      const id = task.id || `T${index + 1}`;
      ctx.ok(['task', 'add', ...task.args]);
      if (task.brief !== undefined) ctx.ok(['brief', 'set', id, '-'], { input: task.brief });
    }
  });
  return makeRepoFromSeed(t, template.repo);
}

// A test context over a copy of another context's directory, for files that
// build one fixture and give each test its own copy instead of rebuilding it.
// Git and state paths still name the source; the caller repairs them.
function copyRepo(t, source) {
  return fixtureDir((base) => {
    fs.cpSync(source, base, { recursive: true });
    return context(t, base);
  });
}

// A fixture built once per test process, each test getting its own copy:
// build(h) runs on a fresh repository and returns fields to carry, such as a
// sha. Paths naming the template's directory are rewritten in the copy's
// files, env, gate settings and fields; worktrees are relinked to the copy.
const fixtures = new Map();
function cachedFixture(t, key, build) {
  let template = fixtures.get(key);
  if (!template) {
    const h = makeRepo();
    try {
      template = { h, fields: build(h) || {} };
    } catch (error) {
      fs.rmSync(h.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      throw error;
    }
    fixtures.set(key, template);
  }
  const from = template.h;
  const h = copyRepo(t, from.base);
  // Both separators, raw and JSON-escaped, since git reports Windows paths with forward slashes.
  const forms = (p) => [...new Set([p, p.replaceAll('\\', '/')].flatMap((s) => [JSON.stringify(s).slice(1, -1), s]))];
  const [olds, news] = [forms(from.base), forms(h.base)];
  const rewrite = (text) => olds.reduce((s, old, i) => s.split(old).join(news[i]), text);
  const fix = (p) => {
    const text = fs.readFileSync(p, 'utf8');
    const next = rewrite(text);
    if (next === text) return;
    // In place, not writeFileSync: Windows refuses to recreate a hidden file,
    // and git hides a linked worktree's .git file.
    const fd = fs.openSync(p, 'r+');
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, next, 0);
    } finally {
      fs.closeSync(fd);
    }
  };
  // Of a git directory, bare or not, only its config names paths, such as a local remote.
  const walk = (dir) => {
    if (fs.existsSync(path.join(dir, 'HEAD')) && fs.existsSync(path.join(dir, 'objects'))) {
      fix(path.join(dir, 'config'));
      return;
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      // The database is binary; its text is rewritten below.
      else if (e.isFile() && !StateFiles.DB_FILES.has(e.name)) fix(path.join(dir, e.name));
    }
  };
  walk(h.base);
  StateFiles.rewriteState(h.state, rewrite);
  for (const [k, v] of Object.entries(from.env)) if (typeof v === 'string') h.env[k] = rewrite(v);
  h.env.HOME = path.join(h.base, 'home');
  h.env.GIT_CONFIG_GLOBAL = path.join(h.base, 'gitconfig');
  h.env.TOWER_CRANE_CONFIG = path.join(h.env.HOME, '.config', 'tower-crane', 'config.json');
  h.env.TC_ACCOUNT_HOME = h.env.HOME;
  if (from.gateSettings) h.gateSettings = from.gateSettings.map(rewrite);
  repairWorktrees(h);
  return Object.assign(h, JSON.parse(rewrite(JSON.stringify(template.fields))));
}

// Relinks a copied repository's task worktrees to the copy. A copy turns the
// link to each relocated admin directory into an absolute one naming the
// template, and git worktree repair does not follow those links:
// lib/worktree.js relinkAdmins joins them as after a project move, and git
// repairs the rest.
function repairWorktrees(h) {
  const root = path.join(h.base, 'repo-worktrees');
  if (!fs.existsSync(root)) return;
  require('../lib/worktree').relinkAdmins(h.repo, path.join(h.repo, '.git'));
  const trees = fs.readdirSync(root).filter((name) => name !== '.git-admin').map((name) => path.join(root, name));
  if (trees.length) h.git(['worktree', 'repair', ...trees]);
}

function context(t, base, options = {}) {
  const env = baseEnv(base);
  fs.mkdirSync(env.HOME, { recursive: true });
  const repo = path.join(base, 'repo');
  const ctx = {
    base,
    repo,
    env,
    builtin: options.builtin,
    userConfig: env.TOWER_CRANE_CONFIG,
    state: path.join(repo, '.tower-crane'),
    detached: () => {
      const dir = path.join(base, 'detached');
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => {
        const file = path.join(dir, f);
        // hooks.js publishes records atomically; one still incomplete is not recorded yet.
        let record;
        try { record = JSON.parse(readPublished(file, 'utf8')); }
        catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return []; throw e; }
        // A monitor's exit listener marks its exit beside its record.
        if (record.kind === 'monitor' && fs.existsSync(path.join(dir, `${record.token || record.pid}.exited`))) record.exited = true;
        return [{ ...record, file }];
      }) : [];
    },
    // Steps that must run before the directory goes, such as stopping processes that poll in it.
    teardown: [],
    cleanup: async ({ monitorGraceMs } = {}) => {
      let strayOwnerDirs = [];
      const seen = new Set();
      try {
        try {
          for (const step of ctx.teardown.splice(0)) await step();
        } finally {
          try { await stopDetached(unseenDetached(ctx, seen), monitorGraceMs); }
          finally {
            for (let fresh; (fresh = unseenDetached(ctx, seen)).length;) await killStarted(fresh);
          }
        }
      } finally {
        try {
          // A killed monitor cannot close its broker's socket outside this fixture.
          const brokers = path.join(ctx.state, 'brokers');
          if (fs.existsSync(brokers)) {
            for (const agent of fs.readdirSync(brokers, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
              const file = path.join(brokers, agent.name, 'broker.json');
              let socket;
              try { ({ socket } = JSON.parse(readPublished(file, 'utf8'))); }
              catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
              if (typeof socket === 'string' && path.basename(socket) === 's' && /^tower-crane-[A-Za-z0-9]{6}$/.test(path.basename(path.dirname(socket)))) {
                fs.rmSync(path.dirname(socket), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
              }
            }
          }
        } finally {
          strayOwnerDirs = ownerDirsOutside(base);
          // A lib call this test made in its own process may still hold the
          // fixture's database open, which Windows refuses to remove.
          require('../lib/db').closeAll();
          fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          // rmSync returns without error when an entry vanished under it, leaving the rest;
          // a second pass removes those. What a process still running keeps writing is a leak.
          if (fs.existsSync(base)) fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          fileFixtures.delete(ctx);
        }
      }
      assert.deepEqual(strayOwnerDirs, [], 'a CLI in this fixture bound a project to an owner_config_dir outside it');
      if (fs.existsSync(base)) {
        assert.fail(`fixture ${base} outlived its cleanup: ${fs.readdirSync(base, { recursive: true }).slice(0, 10).join(', ')}`);
      }
      assertNoHarnessCalls(base);
      UserConfigGuard.assertNoUserConfigLeaks(base);
    },
    run: (args, opts = {}) => fixtureInit(ctx, args, opts, (a, o) => run(a, withHooks(ctx, o))),
    runAsync: (args, opts = {}) => runAsync(args, withHooks(ctx, opts)),
    // A CLI child the test signals or reads while it runs. Detached processes
    // it starts, such as a worker dispatch, are recorded, so cleanup stops them.
    spawnCli: (args, opts = {}) => {
      const { cwd, env, pre } = withHooks(ctx, opts);
      return cp.spawn(process.execPath, [...pre, BIN, ...args], { cwd, env });
    },
    json: (args, opts) => {
      const r = ctx.run([...args, '--json'], opts);
      if (r.code !== 0) throw cliFailure(args, r);
      return JSON.parse(r.stdout);
    },
    ok: (args, opts) => {
      const r = ctx.run(args, opts);
      if (r.code !== 0) throw cliFailure(args, r);
      return r.stdout.trim();
    },
    readState: (file) => StateFiles.readDoc(ctx.state, file),
    // The current revision of a task, for review evidence a test records as a reviewer spawn did not start.
    revision: (id = 'T1') => String(ctx.readState('tasks.json').tasks.find((t) => t.id === id).revision),
    writeState: (file, data) => StateFiles.writeDoc(ctx.state, file, data),
    // The events the log holds, and an append as a command would log them.
    events: (opts) => StateFiles.readEvents(ctx.state, opts),
    appendEvents: (events) => StateFiles.appendEvents(ctx.state, events),
    // Record an exited reviewer dispatch of `agent` for the task's current head
    // and revision, so that agent's review evidence counts.
    reviewer: (id, agent, sha) => {
      const task = ctx.readState('tasks.json').tasks.find((x) => x.id === id);
      const at = new Date().toISOString();
      const detail = { agent, role: 'reviewer', rung: 'review', sha: sha || task.sha, revision: task.revision, pid: 999999, attempt: 1 };
      StateFiles.appendEvents(ctx.state, [
        { at, agent: 'orchestrator', cmd: 'spawn', task: id, detail },
        { at, agent: 'orchestrator', cmd: 'spawn exit', task: id, detail: { agent, pid: 999999, attempt: 1, code: 0 } },
      ]);
    },
    git: (args, cwd = repo) => git(args, cwd, env),
    // Git prints Windows worktree paths with forward slashes, so compare resolved paths.
    registers: (dir) => ctx.git(['worktree', 'list', '--porcelain']).split(/\r?\n/)
      .some((line) => line.startsWith('worktree ') && path.resolve(line.slice('worktree '.length)) === path.resolve(dir)),
    init: (extra = []) => ctx.ok(['init', '--name', 'demo', '--goal', 'prove the engine', ...(ctx.gateSettings || []), ...extra]),
  };
  fileFixtures.add(ctx);
  if (t) t.after(ctx.cleanup);
  return ctx;
}

// opts.hooks preloads test/fixtures/hooks.js into the CLI with those HOOK_*
// variables, acting on this repository's state directory. opts.pre adds
// preloads after it.
function withHooks(ctx, opts) {
  const env = { ...ctx.env, ...(opts.env || {}) };
  env.NODE_OPTIONS = withAccountHome(env.NODE_OPTIONS);
  Object.assign(env, { HOOK_STATE: ctx.state, HOOK_PROCESSES_DIR: path.join(ctx.base, 'detached') }, opts.hooks);
  const pre = ['--require', HOOKS, ...(opts.pre || [])];
  return { cwd: ctx.repo, ...opts, env, pre };
}

// A command shares the runner's hung-test backstop so CLI wait readiness is
// not cut short by a separate subprocess budget.
function run(args, { cwd, env, input, pre = [], timeout = HUNG_TEST_MS } = {}) {
  const r = cp.spawnSync(process.execPath, [...pre, BIN, ...args], { cwd, env, input, encoding: 'utf8', timeout: timeout === 0 ? 0 : Math.max(timeout, HUNG_TEST_MS) }); // wait-allow: explicit zero delegates to the runner; positive command watchdogs retain the hung minimum
  return {
    code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal,
    ...(r.error && { error: { code: r.error.code, message: r.error.message } }),
  };
}

function cliFailure(args, result) {
  const details = [
    result.signal && `signal ${result.signal}`,
    result.error && `error ${result.error.code}: ${result.error.message}`,
  ].filter(Boolean).join('; ');
  return new Error(`tower-crane ${args.join(' ')} exited ${result.code}${details ? ` (${details})` : ''}: ${result.stderr}`);
}

const PTY_AVAILABLE = process.platform === 'linux'
  && cp.spawnSync('script', ['--version'], { timeout: 300000 }).status === 0;

function runPty(args, { cwd, env, timeout = HUNG_TEST_MS } = {}) {
  // script uses a shell, so quote each argument to preserve names and paths.
  const command = [process.execPath, BIN, ...args].map((s) => `'${s.replace(/'/g, "'\\''")}'`).join(' ');
  const r = cp.spawnSync('script', ['-qec', command, '/dev/null'], { cwd, env, encoding: 'utf8', timeout: Math.max(timeout, HUNG_TEST_MS) });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal };
}

// `detached` makes the CLI lead its own process group on POSIX, so a test can
// stop it and the children it shares that group with.
function runAsync(args, { cwd, env, pre = [], onSpawn, detached = false } = {}) {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [...pre, BIN, ...args], { cwd, env, detached: detached && process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    onSpawn?.(child);
  });
}

// A dispatch in the background (spawn --wait by default) whose waits end as
// soon as it exits: a dispatch that failed or stopped early must not read as a
// hung test, so each wait's error names all of the dispatch's output. A
// dispatch still running when the runner aborts the test (its timeout) prints
// the waits still pending and its output, and its process tree is stopped.
// `until(check, what)` waits for a condition, `signal(file)` for a file.
function dispatch(t, h, { args = ['spawn', '--task', 'T1', '--wait', '--json'], ...opts } = {}) {
  let child;
  let output = '';
  let closed = false;
  const pending = new Set();
  const run = h.runAsync(args, {
    ...opts,
    detached: true,
    onSpawn: (c) => {
      child = c;
      for (const stream of [c.stdout, c.stderr]) stream.on('data', (d) => { output += d; });
      c.on('close', () => { closed = true; });
    },
  });
  const shown = () => output.trim() || '(none)';
  const abort = () => {
    if (closed) return;
    const waits = pending.size ? [...pending].join('; ') : '(none: the test awaited the dispatch exit)';
    process.stderr.write(`${args.join(' ')} (pid ${child.pid}) still running when the test was aborted (${t.signal.reason?.message || t.signal.reason}); pending waits: ${waits}; dispatch output so far: ${shown()}\n`);
    if (process.platform === 'win32') cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: HUNG_TEST_MS });
    else {
      try { killGroup(child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
  };
  t.signal.addEventListener('abort', abort, { once: true });
  run.then(() => t.signal.removeEventListener('abort', abort));
  const until = (check, what) => {
    pending.add(what);
    return waitUntil(check, {
      paths: [h.base], alive: () => !closed,
      what: () => `${what} during ${args.join(' ')}; dispatch output: ${shown()}`,
    }).finally(() => pending.delete(what));
  };
  const signal = (file) => until(() => {
    try { return readPublished(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }, `signal ${path.basename(file)}`);
  return { run, until, signal, output: () => output };
}

const real = (p) => fs.realpathSync.native(p);

// Process creation times follow the Windows system timer tick (about 15.6 ms)
// and Node reads the clock differently, so a child recorded right after its
// start may appear to start a few ticks after its record.
const RECORD_TOLERANCE_MS = 100;

function detachedAlive(child) {
  if (process.platform === 'win32' && (child.startTime !== undefined || child.recordedAt !== undefined)) {
    if (child.startTime === null) return false;
    const started = require('./windows-process').startTime(child.pid);
    if (started === null) return false;
    if (child.startTime !== undefined) return started === child.startTime;
    // FILETIME counts 100 ns intervals from 1601; the record counts milliseconds from 1970.
    return Number(BigInt(started) / 10000n - 11644473600000n) <= child.recordedAt + RECORD_TOLERANCE_MS;
  }
  if (child.kind === 'worker' && child.file && !fs.existsSync(child.file)) return false;
  try { killPid(child.pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
  if (process.platform === 'linux') {
    let stat;
    // read-published: the kernel serves /proc; nothing replaces the file.
    try { stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8'); }
    catch (e) { if (['ENOENT', 'ESRCH'].includes(e.code)) return false; throw e; }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (['Z', 'X'].includes(fields[0]) || (child.startTicks && fields[19] !== child.startTicks)) return false;
  }
  return true;
}

// Processes still working inside a fixture, by working directory: /proc on
// Linux, lsof on macOS and other POSIX systems. A removed directory reads with
// a " (deleted)" suffix and still counts. Where no probe works, as on Windows,
// the result names why instead of passing an empty list as a clean check.
function processesIn(base, { platform = process.platform, lsof = runLsof } = {}) {
  const inBase = (cwd) => {
    cwd = cwd.replace(/ \(deleted\)$/, '');
    return cwd === base || cwd.startsWith(base + path.sep);
  };
  if (platform === 'linux') {
    const pids = [];
    for (const name of fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
      let cwd;
      try { cwd = fs.readlinkSync(`/proc/${name}/cwd`); }
      catch { continue; } // Exited, a zombie, or not ours to read.
      if (inBase(cwd)) pids.push(Number(name));
    }
    return { pids };
  }
  if (platform === 'win32') return { skip: 'Windows has no working-directory probe' };
  const r = lsof();
  if (r.error) return { skip: `lsof did not run: ${r.error.code || r.error.message}` };
  // lsof exits 1 when it could not read some process; its own process always lists a cwd.
  if (!r.stdout) return { skip: `lsof listed nothing (exit ${r.status})` };
  const pids = new Set();
  let pid = null;
  for (const line of r.stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid !== null && inBase(line.slice(1))) pids.add(pid);
  }
  return { pids: [...pids] };
}

function runLsof() {
  return cp.spawnSync('lsof', ['-n', '-P', '-w', '-d', 'cwd', '-F', 'pn'], { encoding: 'utf8', timeout: HUNG_TEST_MS });
}

// Fails when a process the test started still works inside its fixture after
// cleanup. A system without a probe reports the check as skipped.
function assertNoProcessesIn(t, base, opts) {
  const found = processesIn(base, opts);
  if (found.skip) t.diagnostic(`process leak check skipped: ${found.skip}`);
  else assert.deepEqual(found.pids, [], 'no process the test started outlives its fixture');
}

function killDetached(child) {
  if (!detachedAlive(child)) return;
  if (process.platform === 'win32') {
    cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 300000 });
  } else {
    try { killGroup(child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
}

async function stopDetached(children, monitorGraceMs) {
  const monitors = children.filter((c) => c.kind === 'monitor');
  if (process.platform === 'win32' && children.length) {
    // Retain native handles before stopping anything. A PID can be reused
    // between probes, but a held handle keeps it and WaitForExit observes the
    // original process. A process proves itself by its recorded creation time
    // or by starting no later than its parent recorded it.
    const records = JSON.stringify(children.map((c) => ({ pid: c.pid, kind: c.kind, startTime: c.startTime, recordedAt: c.recordedAt ?? null })))
      .replaceAll("'", "''");
    const script = `
$ErrorActionPreference = 'Stop'
$held = @()
try {
  foreach ($entry in (ConvertFrom-Json '${records}')) {
    if ($entry.PSObject.Properties['startTime']) {
      if ($null -eq $entry.startTime) { continue }
    } elseif ($null -eq $entry.recordedAt) {
      if ($entry.kind -eq 'monitor') { throw 'Windows monitor creation identity is missing' }
      continue
    }
    $process = $null
    try {
      $process = [System.Diagnostics.Process]::GetProcessById($entry.pid)
      $null = $process.Handle
    } catch [System.ArgumentException] { continue }
      catch [System.InvalidOperationException] { if ($process) { $process.Dispose() }; continue }
    # A process exiting during this query reads a null creation time; it has already stopped.
    $started = $process.StartTime
    if ($null -eq $started) { $same = $false }
    elseif ($entry.PSObject.Properties['startTime']) { $same = $started.ToFileTimeUtc().ToString() -eq $entry.startTime }
    else { $same = $started.ToUniversalTime() -le [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$entry.recordedAt + ${RECORD_TOLERANCE_MS}).UtcDateTime }
    if (!$same) {
      $process.Dispose()
      continue
    }
    $held += [pscustomobject]@{ Kind = $entry.kind; Process = $process }
  }
  $ids = @{
    monitors = @($held | Where-Object { $_.Kind -eq 'monitor' } | ForEach-Object { $_.Process.Id })
    workers = @($held | Where-Object { $_.Kind -ne 'monitor' } | ForEach-Object { $_.Process.Id })
  }
  [Console]::Out.WriteLine('ready:' + (ConvertTo-Json -InputObject $ids -Compress))
  $null = [Console]::In.ReadLine()
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $survivors = @()
  foreach ($entry in $held) {
    if (!$entry.Process.WaitForExit([int][Math]::Max(0, 300000 - $clock.ElapsedMilliseconds))) {
      $survivors += [pscustomobject]@{ kind = $entry.Kind; pid = $entry.Process.Id }
    }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($survivors) -Compress))
} finally {
  foreach ($entry in $held) { $entry.Process.Dispose() }
}
`;
    const child = cp.spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let stopped = false;
    child.stdout.on('data', (data) => {
      stdout += data;
      const ready = stdout.split('\n').slice(0, -1).find((line) => line.startsWith('ready:'));
      if (!stopped && ready) {
        stopped = true;
        const ids = JSON.parse(ready.slice(6).trim());
        for (const pid of [...ids.workers, ...ids.monitors]) {
          cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 300000 });
        }
        child.stdin.end('\n');
      }
    });
    child.stderr.on('data', (data) => { stderr += data; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, stderr);
    assert.ok(stopped, 'process handles were not acquired');
    const survivors = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.deepEqual(survivors.filter((s) => s.kind === 'monitor').map((s) => s.pid), [], 'detached usage monitors outlived test teardown');
    assert.deepEqual(survivors.map((s) => s.pid), [], 'detached workers outlived test teardown');
    return;
  }
  let grace;
  const controller = new AbortController();
  try {
    for (const child of children.filter((c) => c.kind === 'worker')) killDetached(child);
    if (monitorGraceMs !== undefined) {
      grace = setTimeout(() => controller.abort(new Error('detached usage monitors outlived test teardown')), monitorGraceMs); // wait-allow: deliberate teardown-failure tests supply their observation grace
    }
    await waitUntil(() => monitors.every((child) => !detachedAlive(child)), {
      signal: controller.signal, what: 'detached usage monitors outlived test teardown',
    });
  } finally {
    clearTimeout(grace);
    for (const monitor of monitors) killDetached(monitor);
    await waitUntil(() => monitors.every((child) => !detachedAlive(child)));
    assert.ok(monitors.every((c) => !detachedAlive(c)), 'usage monitors survived forced cleanup');
  }
}

// Personal fallbacks as a fixture's owner sets them: written to the user
// file, and, when a route carries authority (lib/route-grants.js), written
// again through ladder set as the owner, which pins it. A route carrying
// authority that only the file holds is skipped at spawn.
const UNSANDBOXED = ['agy', 'opencode', 'pi', 'command'];
const AUTHORITY = ['command', 'args', 'tools', 'mcp', 'web_mcp', 'sandbox', 'env', 'env_file', 'scope'];
function ownerFallbacks(h, rung, routes) {
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { [rung]: { fallbacks: routes } } }));
  if (Array.isArray(routes) && routes.some((r) => r && typeof r === 'object' && (UNSANDBOXED.includes(r.harness) || AUTHORITY.some((k) => r[k] !== undefined)))) {
    h.ok(['ladder', 'set', rung, '--fallbacks', JSON.stringify(routes)]);
  }
}

// A fresh cache root of at most maxBytes, as short as a user's own ~/.cache, for
// tests of claude's and codex's short temp directories. Fixture roots are too
// deep for them. The bases are gate-tmp's: the account's ~/.cache from the
// password database, since HOME can name a deep sandbox home, then
// XDG_RUNTIME_DIR. The length is the real path's, since the CLI names its
// short directories from the resolved cache (codexTmp). A missing base is
// passed over, not made: removing a ~/.cache made here could race another
// file's gate between shortBase and harnessTmp. Each base passed over for its
// link or its absence is reported. Null when no base is short enough and
// writable; the directory goes when the test ends.
function shortCacheRoot(t, maxBytes) {
  for (const base of require('../lib/gate-tmp').shortBases()) {
    let real;
    try {
      real = fs.realpathSync(base);
    } catch (err) {
      let link = false;
      try {
        link = fs.lstatSync(base).isSymbolicLink();
      } catch {
        // Nothing at base.
      }
      t.diagnostic(link ? `${base} is a link to a missing directory` : `${base} cannot be resolved (${err.code}); it is not made here`);
      continue;
    }
    const bytes = Buffer.byteLength(path.join(real, 'tc-test-XXXXXX'));
    if (bytes > maxBytes) {
      if (real !== base) t.diagnostic(`${base} resolves to ${real}, whose tc-test-XXXXXX root is ${bytes} bytes, more than ${maxBytes}`);
      continue;
    }
    let root;
    try {
      root = fs.mkdtempSync(path.join(base, 'tc-test-'));
    } catch {
      continue;
    }
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    return root;
  }
  return null;
}

// A directory TOWER_CRANE_PLUGIN_ROOT can name: spawn opens only a Tower Crane
// checkout or plugin, told by its package.json.
function pluginRoot(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: require('../package.json').name }) + '\n');
  return dir;
}

module.exports = { pluginRoot, shortCacheRoot, useFixtureUserFile, ownerFallbacks, ownerDirsOutside, ACCOUNT_HOME, repairWorktrees, makeRepo, makeProjectRepo, makeTaskRepo, copyRepo, cachedFixture, fixtureLadder, pinRung, pinLiveRung, stubRungs, STUB_RUNG, HARNESS_GUARD, run, runPty, PTY_AVAILABLE, runAsync, dispatch, BIN, ROOT, HOOKS, real, TMP_ROOT, LIVE_ROOT, detachedAlive, processesIn, assertNoProcessesIn };
