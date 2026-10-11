'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { createRepoSeed, cleanupRepoSeed } = require('./repo-seed');
const { tempRoot } = require('./tmp-root');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'tower-crane.js');
const HOOKS = path.join(__dirname, 'fixtures', 'hooks.js');
const TMP_ROOT = tempRoot();
const SHARED_REPO_SEED = process.env.TC_TEST_REPO_SEED;
const OWNER_KEY = 'fixture-owner-key';
delete process.env.TC_TEST_REPO_SEED;
// Scratch consumers can run directly without the runner's global setup.
fs.mkdirSync(TMP_ROOT, { recursive: true });

// Tests must not see the developer's git config (hooks, signing), an
// agent's TOWER_CRANE_* variables or the developer's own ladder defaults, so every
// child gets a clean, explicit env. The user file path is in the temp dir and
// absent until a test writes it.
function baseEnv(home) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('TOWER_CRANE_') || k.startsWith('GIT_') || k === 'TC_TEST_REPO_SEED') delete env[k];
  }
  // Existing fixtures act as the owner without a terminal, so they must
  // provide that identity and the owner key.
  env.TOWER_CRANE_AGENT = 'owner';
  env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.TOWER_CRANE_CONFIG = path.join(home, 'user-config', 'config.json');
  fs.mkdirSync(path.join(home, 'user-config', 'owner'), { recursive: true });
  fs.writeFileSync(path.join(home, 'user-config', 'owner', 'key'), `${OWNER_KEY}\n`);
  env.TOWER_CRANE_OWNER_KEY = OWNER_KEY;
  // spawn keeps receipts under the user's cache, which is not the tests' to write.
  env.HOME = path.join(home, 'home');
  env.USERPROFILE = env.HOME;
  env.LOCALAPPDATA = path.join(env.HOME, 'AppData', 'Local');
  env.XDG_CACHE_HOME = path.join(env.HOME, '.cache');
  return env;
}

function git(args, cwd, env) {
  return cp.execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

function makeRepo(t) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return makeRepoFromSeed(t, getRepoSeed().repo);
}

function makeRepoFromSeed(t, seedRepo) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-')));
  fs.writeFileSync(
    path.join(base, 'gitconfig'),
    '[user]\n\tname = tower-crane test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n',
  );
  const env = baseEnv(base);
  const repo = path.join(base, 'repo');
  try {
    fs.cpSync(seedRepo, repo, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  } catch (error) {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
  return context(t, base);
}

const repoTemplates = new Map();
function getRepoTemplate(key, prepare) {
  if (repoTemplates.has(key)) return repoTemplates.get(key);
  const ctx = makeRepo();
  try {
    prepare(ctx);
    const template = { base: ctx.base, repo: ctx.repo };
    repoTemplates.set(key, template);
    process.once('exit', () => {
      fs.rmSync(template.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
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
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-')));
  fs.cpSync(source, base, { recursive: true });
  return context(t, base);
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
    process.once('exit', () => fs.rmSync(h.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
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
      else if (e.isFile()) fix(path.join(dir, e.name));
    }
  };
  walk(h.base);
  for (const [k, v] of Object.entries(from.env)) if (typeof v === 'string') h.env[k] = rewrite(v);
  h.env.HOME = path.join(h.base, 'home');
  h.env.GIT_CONFIG_GLOBAL = path.join(h.base, 'gitconfig');
  h.env.TOWER_CRANE_CONFIG = path.join(h.base, 'user-config', 'config.json');
  if (from.gateSettings) h.gateSettings = from.gateSettings.map(rewrite);
  const worktrees = path.join(h.base, 'repo-worktrees');
  if (fs.existsSync(worktrees)) h.git(['worktree', 'repair', ...fs.readdirSync(worktrees).map((name) => path.join(worktrees, name))]);
  return Object.assign(h, JSON.parse(rewrite(JSON.stringify(template.fields))));
}

function context(t, base) {
  const env = baseEnv(base);
  fs.mkdirSync(env.HOME, { recursive: true });
  const repo = path.join(base, 'repo');
  const ctx = {
    base,
    repo,
    env,
    userConfig: env.TOWER_CRANE_CONFIG,
    state: path.join(repo, '.tower-crane'),
    detached: () => {
      const dir = path.join(base, 'detached');
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => {
        const file = path.join(dir, f);
        try { return [{ ...JSON.parse(fs.readFileSync(file, 'utf8')), file }]; }
        catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      }) : [];
    },
    cleanup: async () => {
      try { await stopDetached(ctx.detached()); }
      finally { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    },
    run: (args, opts = {}) => run(args, withHooks(ctx, opts)),
    runAsync: (args, opts = {}) => runAsync(args, withHooks(ctx, opts)),
    json: (args, opts) => {
      const r = ctx.run([...args, '--json'], opts);
      if (r.code !== 0) throw new Error(`tower-crane ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
      return JSON.parse(r.stdout);
    },
    ok: (args, opts) => {
      const r = ctx.run(args, opts);
      if (r.code !== 0) throw new Error(`tower-crane ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
      return r.stdout.trim();
    },
    readState: (file) => JSON.parse(fs.readFileSync(path.join(ctx.state, file), 'utf8')),
    // The current revision of a task, for review evidence a test records as a reviewer spawn did not start.
    revision: (id = 'T1') => String(ctx.readState('tasks.json').tasks.find((t) => t.id === id).revision),
    writeState: (file, data) => fs.writeFileSync(path.join(ctx.state, file), JSON.stringify(data, null, 2) + '\n'),
    // Record an exited reviewer dispatch of `agent` for the task's current head
    // and revision, so that agent's review evidence counts.
    reviewer: (id, agent, sha) => {
      const task = ctx.readState('tasks.json').tasks.find((x) => x.id === id);
      const at = new Date().toISOString();
      const detail = { agent, role: 'reviewer', rung: 'review', sha: sha || task.sha, revision: task.revision, pid: 999999, attempt: 1 };
      fs.appendFileSync(path.join(ctx.state, 'events.jsonl'), [
        { at, agent: 'orchestrator', cmd: 'spawn', task: id, detail },
        { at, agent: 'orchestrator', cmd: 'spawn exit', task: id, detail: { agent, pid: 999999, attempt: 1, code: 0 } },
      ].map((e) => `${JSON.stringify(e)}\n`).join(''));
    },
    git: (args, cwd = repo) => git(args, cwd, env),
    // Git prints Windows worktree paths with forward slashes, so compare resolved paths.
    registers: (dir) => ctx.git(['worktree', 'list', '--porcelain']).split(/\r?\n/)
      .some((line) => line.startsWith('worktree ') && path.resolve(line.slice('worktree '.length)) === path.resolve(dir)),
    init: (extra = []) => ctx.ok(['init', '--name', 'demo', '--goal', 'prove the engine', ...(ctx.gateSettings || []), ...extra]),
  };
  if (t) t.after(ctx.cleanup);
  return ctx;
}

// opts.hooks preloads test/fixtures/hooks.js into the CLI with those HOOK_*
// variables, acting on this repository's state directory.
function withHooks(ctx, opts) {
  const env = { ...ctx.env, ...(opts.env || {}) };
  Object.assign(env, { HOOK_STATE: ctx.state, HOOK_PROCESSES_DIR: path.join(ctx.base, 'detached') }, opts.hooks);
  const pre = ['--require', HOOKS];
  return { cwd: ctx.repo, ...opts, env, pre };
}

// A timeout here only guards against a hung CLI; the runner's per-test timeout
// is the backstop. Spawns that waited 15 to 23 s on a machine at load 50 to 80
// set the 60 s floor, so a slow machine does not read as a failure.
function run(args, { cwd, env, input, pre = [], timeout = 60000 } = {}) {
  const r = cp.spawnSync(process.execPath, [...pre, BIN, ...args], { cwd, env, input, encoding: 'utf8', timeout: Math.max(timeout, 60000) });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal };
}

const PTY_AVAILABLE = process.platform === 'linux'
  && cp.spawnSync('script', ['--version'], { timeout: 10000 }).status === 0;

function runPty(args, { cwd, env, timeout = 10000 } = {}) {
  // script uses a shell, so quote each argument to preserve names and paths.
  const command = [process.execPath, BIN, ...args].map((s) => `'${s.replace(/'/g, "'\\''")}'`).join(' ');
  const r = cp.spawnSync('script', ['-qec', command, '/dev/null'], { cwd, env, encoding: 'utf8', timeout });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal };
}

function runAsync(args, { cwd, env, pre = [] } = {}) {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [...pre, BIN, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const real = (p) => fs.realpathSync.native(p);

function detachedAlive(child) {
  if (process.platform === 'win32' && child.startTime !== undefined) {
    return child.startTime !== null && require('./windows-process').startTime(child.pid) === child.startTime;
  }
  if (child.kind === 'worker' && child.file && !fs.existsSync(child.file)) return false;
  try { process.kill(child.pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
  if (process.platform === 'linux') {
    let stat;
    try { stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8'); }
    catch (e) { if (['ENOENT', 'ESRCH'].includes(e.code)) return false; throw e; }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (['Z', 'X'].includes(fields[0]) || (child.startTicks && fields[19] !== child.startTicks)) return false;
  }
  return true;
}

function killDetached(child) {
  if (!detachedAlive(child)) return;
  if (process.platform === 'win32') {
    cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
}

async function stopDetached(children) {
  const monitors = children.filter((c) => c.kind === 'monitor');
  if (process.platform === 'win32' && monitors.length) {
    // Retain native handles before stopping workers. A PID can be reused
    // between probes, but WaitForExit still observes the original process.
    const records = JSON.stringify(monitors).replaceAll("'", "''");
    const script = `
$ErrorActionPreference = 'Stop'
$monitors = @()
try {
  foreach ($entry in (ConvertFrom-Json '${records}')) {
    if (!$entry.PSObject.Properties['startTime']) { throw 'Windows monitor creation identity is missing' }
    if ($null -eq $entry.startTime) { continue }
    try {
      $monitor = [System.Diagnostics.Process]::GetProcessById($entry.pid)
      $null = $monitor.Handle
    } catch [System.ArgumentException] { continue }
      catch [System.InvalidOperationException] { $monitor.Dispose(); continue }
    if ($monitor.StartTime.ToFileTimeUtc().ToString() -ne $entry.startTime) {
      $monitor.Dispose()
      continue
    }
    $monitors += $monitor
  }
  [Console]::Out.WriteLine('ready:' + (ConvertTo-Json -InputObject @($monitors | ForEach-Object { $_.Id }) -Compress))
  $null = [Console]::In.ReadLine()
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $survivors = @()
  foreach ($monitor in $monitors) {
    if (!$monitor.WaitForExit([int][Math]::Max(0, 10000 - $clock.ElapsedMilliseconds))) {
      $survivors += $monitor.Id
    }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($survivors) -Compress))
} finally {
  foreach ($monitor in $monitors) { $monitor.Dispose() }
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
        for (const worker of children.filter((c) => c.kind === 'worker')) killDetached(worker);
        for (const pid of JSON.parse(ready.slice(6).trim())) {
          cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
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
    assert.ok(stopped, 'monitor handles were not acquired');
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)), [], 'detached usage monitors outlived test teardown');
    return;
  }
  try {
    for (const child of children.filter((c) => c.kind === 'worker')) killDetached(child);
    const deadline = Date.now() + 10000;
    while (monitors.some(detachedAlive) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(monitors.filter(detachedAlive).map((c) => c.pid), [], 'detached usage monitors outlived test teardown');
  } finally {
    for (const monitor of monitors) killDetached(monitor);
    const deadline = Date.now() + 10000;
    while (monitors.some(detachedAlive) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(monitors.every((c) => !detachedAlive(c)), 'usage monitors survived forced cleanup');
  }
}

module.exports = { makeRepo, makeProjectRepo, makeTaskRepo, copyRepo, cachedFixture, run, runPty, PTY_AVAILABLE, runAsync, BIN, ROOT, HOOKS, real, TMP_ROOT, detachedAlive };
