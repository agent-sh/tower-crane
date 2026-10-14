'use strict';

// GitHub for a sandboxed agent. Its sandbox holds no GitHub credential: no
// GH_TOKEN, no git credential helper that answers, no gh login. Its git and
// gh shims send a push or a gh command to the spawn's broker (lib/broker.js),
// which checks it here, outside the sandbox, against the agent's role and
// task, and runs it with the user's own login.
//
// A push names only a commit. The destination is the task's branch on the
// task repository's origin, which the broker reads and checks itself. The
// commit reaches a repository of the broker's over git's transport, which
// hashes every object it receives, and the checks and the push read only
// that repository, never the object store or config the agent writes.
// A gh command is parsed with the flag table of lib/gh-flags.json, runs in
// the project's recorded repository with no local repository for gh to
// read, and in an environment holding nothing but what gh needs.
//
// Processes here run with node's child_process, not lib/commands.js: that
// module hardens git started in a repository the agent writes, and these
// run in the broker's own repository or in none.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refuse, usage } = require('./util');

const FLAGS = require('./gh-flags.json').commands;

// The variables gh and the API take a token from.
const TOKEN_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

// --- gh arguments -----------------------------------------------------------

// gh's flags parse like pflag: --name=value, --name value, -x value, -xvalue
// and clusters of one-letter booleans. A flag the table does not list for the
// command is refused, so a value is never taken for a positional or back.
function parseGh(args) {
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw usage('gh arguments must be strings');
  const command = args.slice(0, 2).join(' ');
  const table = FLAGS[command];
  if (!table || args.length < 2 || args[0].startsWith('-') || args[1].startsWith('-')) {
    throw refuse(`gh ${args.slice(0, 2).join(' ')} is not available to a sandboxed agent; it may run ${Object.keys(FLAGS).join(', ')}`);
  }
  const short = Object.fromEntries(Object.entries(table).filter(([, f]) => f.short).map(([name, f]) => [f.short, name]));
  const flags = [];
  const pos = [];
  let rest = false;
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (rest || a === '-' || !a.startsWith('-')) {
      pos.push(a);
    } else if (a === '--') {
      rest = true;
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const spec = Object.hasOwn(table, name) ? table[name] : null;
      if (!spec) throw usage(`gh ${command} has no flag --${name}`);
      if (spec.value) {
        if (eq < 0 && i + 1 >= args.length) throw usage(`gh ${command} --${name} needs a value`);
        flags.push({ name, value: eq < 0 ? args[++i] : a.slice(eq + 1) });
      } else {
        const value = eq < 0 ? undefined : a.slice(eq + 1);
        if (value !== undefined && !['true', 'false'].includes(value)) throw usage(`gh ${command} --${name} takes true or false`);
        flags.push({ name, ...(value === undefined ? {} : { value }) });
      }
    } else {
      for (let j = 1; j < a.length; j++) {
        const name = Object.hasOwn(short, a[j]) ? short[a[j]] : null;
        if (!name) throw usage(`gh ${command} has no flag -${a[j]}`);
        if (table[name].value) {
          const inline = a.slice(j + 1);
          if (!inline && i + 1 >= args.length) throw usage(`gh ${command} -${a[j]} needs a value`);
          flags.push({ name, value: inline || args[++i] });
          break;
        }
        flags.push({ name });
      }
    }
  }
  return { command, flags, pos };
}

// The arguments in one spelling: long flags with = values, then "--" and the
// positionals, so gh reads them as this parser did.
function buildGh({ command, flags, pos }) {
  const table = FLAGS[command];
  return [...command.split(' '), ...flags.map((f) => (table[f.name].value || f.value !== undefined ? `--${f.name}=${f.value}` : `--${f.name}`)),
    ...(pos.length ? ['--', ...pos] : [])];
}

// --- the task ---------------------------------------------------------------

// The role's agent file, as lib/agents.js renders its shims.
function rolePolicy(job) {
  const A = require('./agents');
  return A.policy(A.load(job.role === 'worker' && job.rung === 'research' ? 'researcher' : job.role));
}

function taskOf(job) {
  const st = require('./state').loadState(job.state);
  const task = st.tasks.tasks.find((t) => t.id === job.task);
  if (!task) throw refuse(`no task ${job.task}`);
  return { project: st.project, task };
}

function briefOf(job) {
  try {
    return fs.readFileSync(path.join(job.state, 'briefs', `${job.task}.md`), 'utf8');
  } catch {
    return '';
  }
}

// The task repository's git directory, as spawn found it on the host.
function commonDir(job) {
  return job.dispatch?.gitDirs?.common || job.dispatch?.repo?.commonDir || null;
}

const GITHUB = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i;
const LOCAL = /^(?:\/|file:\/\/|[A-Za-z]:[\\/])/;

// Where a push goes: origin's push URL, read from the repository's config
// file without its includes or URL rewriting. Agents can write that file, so
// the URL must be the project's recorded GitHub repository, or a path on this
// machine for a project that records none (test fixtures).
function pushTarget(common, repo) {
  const read = (key) => {
    const r = cp.spawnSync('git', ['config', '--file', path.join(common, 'config'), '--no-includes', '--get-all', key],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
  };
  const pushUrls = read('remote.origin.pushurl');
  const urls = pushUrls.length ? pushUrls : read('remote.origin.url');
  if (urls.length !== 1) throw refuse(`the task repository's origin has ${urls.length} push URLs; the broker pushes to exactly one`);
  const [url] = urls;
  if (repo) {
    const m = GITHUB.exec(url);
    if (!m || m[1].toLowerCase() !== repo.toLowerCase()) throw refuse(`origin pushes to ${url}, not to the project's repository ${repo}`);
    return url;
  }
  if (LOCAL.test(url)) return url;
  throw refuse(`origin pushes to ${url}, and the project records no repository to check it against (tower-crane project set --repo)`);
}

// Workflow files a task may change: those its title, acceptance or brief
// names, by file or by a directory above it.
function workflowAllowed(task, brief) {
  const named = require('./scope').tokens([task.title, ...(task.acceptance || []), brief].join('\n'))
    .map((t) => t.replace(/\\/g, '/').replace(/\/+$/, '')).filter((t) => t === '.github' || t.startsWith('.github/'));
  return (file) => named.some((t) => file === t || file.startsWith(`${t}/`));
}
const WORKFLOW = /^\.github\/(?:workflows|actions)\//;

// --- processes --------------------------------------------------------------

// Runs a command in a process group of its own, which io.track lets the
// broker stop with the agent. Output goes to io when stream is set, and is
// collected otherwise.
function run(command, args, { cwd, env, input, stream }, io) {
  return new Promise((resolve) => {
    const child = cp.spawn(command, args, { cwd, env, stdio: [typeof input === 'string' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true });
    io.track(child);
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stream ? io.stdout(d) : (stdout += d)));
    child.stderr.setEncoding('utf8').on('data', (d) => (stream ? io.stderr(d) : (stderr += d)));
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: `${stderr}${command}: ${e.message}\n` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

// The broker's environment for git: the user's own, without anything that
// would point git at another repository, and without git's tracing, whose
// output would reach the agent with the push's stderr.
const GIT_DROP = /^(?:GIT_TRACE.*|GIT_CURL_VERBOSE|GIT_REDACT_COOKIES|GIT_SSH_VARIANT_DEBUG)$/i;
function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_SHALLOW_FILE', 'GIT_QUARANTINE_PATH', 'GIT_REPLACE_REF_BASE']) delete env[key];
  for (const key of Object.keys(env)) if (GIT_DROP.test(key)) delete env[key];
  return env;
}

// The directory gh reads its config and hosts from, as gh finds it.
function ghConfigDir(env) {
  if (env.GH_CONFIG_DIR) return path.resolve(env.GH_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME) return path.resolve(env.XDG_CONFIG_HOME, 'gh');
  if (process.platform === 'win32' && env.APPDATA) return path.resolve(env.APPDATA, 'GitHub CLI');
  return path.resolve(env.HOME || os.homedir(), '.config', 'gh');
}

// Whether file is dir or inside it, through links on either side.
function within(file, dir) {
  const real = (p) => {
    const rest = [];
    for (let at = path.resolve(p); ; at = path.dirname(at)) {
      try { return path.join(fs.realpathSync.native(at), ...rest.reverse()); } catch { /* not there yet */ }
      if (path.dirname(at) === at) return path.resolve(p);
      rest.push(path.basename(at));
    }
  };
  const rel = path.relative(real(dir), real(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// What gh needs from the user's environment: where its login is, the
// session bus its keyring answers on, and the network settings. gh's --jq
// can read any variable it runs with, so nothing else goes in.
const GH_KEEP = /^(?:PATH|PATHEXT|HOME|USER|LOGNAME|USERNAME|USERPROFILE|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|COMSPEC|APPDATA|LOCALAPPDATA|PROGRAMDATA|XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|GH_CONFIG_DIR|GH_HOST|(?:HTTPS?|ALL|NO)_PROXY|SSL_CERT_(?:FILE|DIR))$/i;

function ghEnv(job) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => GH_KEEP.test(k) || TOKEN_ENV.includes(k.toUpperCase())));
  const config = ghConfigDir(env);
  const inside = [job.state, job.cwd, commonDir(job)].filter(Boolean).find((d) => within(config, d));
  if (inside) throw refuse(`gh's config directory ${config} is inside ${inside}, which an agent can write; the broker runs gh with the user's own config only`);
  // gh runs git to find a local repository; this one does not exist.
  return { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1',
    GIT_DIR: path.join(job.state, 'push', 'no-repository') };
}

// --- gh ---------------------------------------------------------------------

// Commands whose first positional names a pull request, and those that
// change one: they act on the task's own pull request only.
const PR_WRITES = new Set(['pr close', 'pr comment', 'pr edit', 'pr merge', 'pr ready', 'pr reopen', 'pr review']);
const PR_SELECTOR = new Set(['pr checks', 'pr diff', 'pr view', ...PR_WRITES]);
// Flags that act on the host rather than on GitHub: a browser, an editor, a
// file read by path, a saved form, the token itself.
const HOST_FLAGS = new Set(['web', 'editor', 'recover', 'show-token', 'attach']);

// The gh command the broker runs for args, checked against the role and task.
function ghCommand(job, args, env) {
  const policy = rolePolicy(job);
  const why = require('./shim').ghDenied(args, policy);
  if (why) throw refuse(`${why} is not allowed by this agent's agent file`);
  const parsed = parseGh(args);
  const { command, flags, pos } = parsed;
  const { project, task } = taskOf(job);
  const repo = project.repo;
  if (!repo) throw refuse('gh through the broker needs the project\'s repository (tower-crane project set --repo)');
  const table = FLAGS[command];
  const token = TOKEN_ENV.some((k) => env[k]);
  const kept = [];
  for (const f of flags) {
    if (HOST_FLAGS.has(f.name)) throw refuse(`gh ${command} --${f.name} would act on the broker's host; a sandboxed agent cannot use it`);
    if (table[f.name].value === 'file' && !(f.name === 'body-file' && f.value === '-')) {
      throw refuse(`gh ${command} --${f.name} reads a file on the broker's host; the gh shim sends --body-file content itself`);
    }
    if (f.name === 'jq' && token) throw refuse(`gh --jq can read the token gh runs with here; use --json and read the output`);
    if (f.name === 'repo') {
      if (f.value.toLowerCase() !== repo.toLowerCase()) throw refuse(`gh runs in the project's repository ${repo} only, not ${f.value}`);
      continue;
    }
    if (f.name === 'head' && command === 'pr create' && f.value !== task.branch) {
      throw refuse(`a pull request comes from the task branch ${task.branch}, not ${f.value}`);
    }
    kept.push(f);
  }
  for (const p of pos) if (/:\/\/|(?:^|\/)github\.com\//i.test(p)) throw refuse(`gh runs in the project's repository ${repo} only; name a pull request by number or branch, not ${p}`);
  if (command === 'repo view' && pos.length && pos[0].toLowerCase() !== repo.toLowerCase()) throw refuse(`gh repo view shows the project's repository ${repo} only`);
  const out = { command, flags: kept, pos: [...pos] };
  if (table.repo) out.flags.push({ name: 'repo', value: repo });
  if (command === 'repo view' && !pos.length) out.pos = [repo];
  if (command === 'pr create' && !kept.some((f) => f.name === 'head')) {
    if (!task.branch) throw refuse(`${job.task} has no branch for a pull request`);
    out.flags.push({ name: 'head', value: task.branch });
  }
  // No local branch here: a pull request command without one is the task's.
  if (PR_SELECTOR.has(command) && !out.pos.length) {
    if (!task.branch) throw refuse(`${job.task} has no branch; name the pull request`);
    out.pos = [task.branch];
  }
  return { parsed: out, repo, branch: task.branch, write: PR_WRITES.has(command) };
}

// The number of the task's own pull request that selector names.
async function ownPr(job, cmd, env, io) {
  const r = await run('gh', ['pr', 'view', `--repo=${cmd.repo}`, '--json', 'number,headRefName,isCrossRepository', '--', cmd.parsed.pos[0]],
    { cwd: job.state, env }, io);
  let pr;
  try { pr = JSON.parse(r.stdout); } catch { pr = null; }
  if (r.code !== 0 || !pr) throw refuse(`cannot read pull request ${cmd.parsed.pos[0]}: ${String(r.stderr).trim() || `gh exited ${r.code}`}`);
  if (pr.isCrossRepository || pr.headRefName !== cmd.branch) {
    throw refuse(`pull request #${pr.number} is from ${pr.headRefName}, not the task branch ${cmd.branch}; a sandboxed agent changes its own pull request only`);
  }
  return String(pr.number);
}

async function gh(job, args, input, io) {
  const env = ghEnv(job);
  const cmd = ghCommand(job, args, env);
  if (cmd.write) cmd.parsed.pos = [await ownPr(job, cmd, env, io), ...cmd.parsed.pos.slice(1)];
  const r = await run('gh', buildGh(cmd.parsed), { cwd: job.state, env, input, stream: true }, io);
  return r.code;
}

// --- push -------------------------------------------------------------------

// The task repository's object store is the agent's to write, and git trusts
// a loose object's file name when rev-list or diff-tree reads it. So the
// broker reads no object from that store directly. Its own repository,
// push/cache.git in the state directory, which no sandbox can write, receives
// the remote's branches and then the task commit over git's transport, where
// index-pack and unpack-objects compute each object's id from its content and
// fsck checks the agent's objects. The checks and the push read only that
// repository. It stays between pushes, so a push fetches only what the remote
// or the task added since the last one.
const CACHE = 'cache.git';

function pushRoot(job) {
  const root = path.join(job.state, 'push');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, '.gitignore'), '*\n');
  return root;
}

// One push at a time uses the cache, so no two fetches race on its refs. The
// lock is a file that appears whole, holding its holder's pid and start time,
// and a lock whose holder has exited is removed. Waiting ends when the agent
// hangs up.
async function lockCache(root, io) {
  const P = require('./processes');
  const file = path.join(root, 'cache.lock');
  const mine = JSON.stringify({ pid: process.pid, ...P.identity(process.pid) });
  let told = false;
  for (;;) {
    const staged = `${file}.${process.pid}.${require('node:crypto').randomBytes(8).toString('hex')}`;
    fs.writeFileSync(staged, mine);
    try {
      fs.linkSync(staged, file);
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    } finally {
      fs.rmSync(staged, { force: true });
    }
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* released meanwhile */ }
    if (holder && P.processState(holder) === 'exited') {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (io.gone?.()) throw refuse('the agent hung up while its push waited for another');
    if (!told) io.stderr('tower-crane: the broker waits for another push from this project to finish\n');
    told = true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// The object format of the task repository, from its config file alone.
function objectFormat(common) {
  return cp.spawnSync('git', ['config', '--file', path.join(common, 'config'), '--no-includes', '--get', 'extensions.objectformat'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true }).stdout?.trim() || 'sha1';
}

function initBare(dir, format) {
  const init = cp.spawnSync('git', ['init', '--quiet', '--bare', '--template=', `--object-format=${format}`, dir],
    { encoding: 'utf8', env: gitEnv(), timeout: 30000, windowsHide: true });
  if (init.status !== 0) throw refuse(`cannot prepare the push: ${String(init.stderr).trim()}`);
}

// The cache, made on first use. gc runs in the foreground, inside the lock.
function cacheRepo(root, format) {
  const dir = path.join(root, CACHE);
  if (!fs.existsSync(path.join(dir, 'HEAD'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    initBare(dir, format);
    fs.appendFileSync(path.join(dir, 'config'), '[gc]\n\tautoDetach = false\n[maintenance]\n\tautoDetach = false\n');
  }
  return dir;
}

// What upload-pack serves the task commit from: a bare repository of the
// broker's, with config the broker writes and no refs or hooks, whose objects
// are the task repository's through alternates. upload-pack never reads the
// task repository's config, and what it sends is hashed again on arrival.
function viewRepo(job, root, common, format) {
  const dir = fs.mkdtempSync(path.join(root, `view-${job.agent}-`));
  try {
    initBare(dir, format);
    fs.appendFileSync(path.join(dir, 'config'), '[uploadpack]\n\tallowAnySHA1InWant = true\n[core]\n\talternateRefsCommand = true\n');
    fs.mkdirSync(path.join(dir, 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'objects', 'info', 'alternates'), `${path.join(common, 'objects')}\n`);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

// Files a push may change only when the task names them: workflows, the
// local actions under .github/actions, and the action.yml or action.yaml of
// any other local action (uses: ./path) a workflow in the pushed commit runs.
async function protectedFiles(git, sha) {
  const grep = await git(['grep', '-h', '-I', '-E', '^[[:space:]-]*uses:[[:space:]]*[\'"]?\\./', sha, '--', '.github/workflows']);
  if (grep.code > 1) throw refuse(`cannot read the workflows of ${sha}: ${String(grep.stderr).trim()}`);
  const actions = new Set();
  for (const line of grep.stdout.split('\n')) {
    const m = /uses:\s*['"]?\.\/([^'"#\s]*)/.exec(line);
    if (!m) continue;
    const dir = path.posix.normalize(m[1] || '.').replace(/\/+$/, '');
    for (const name of ['action.yml', 'action.yaml']) actions.add(dir === '.' ? name : `${dir}/${name}`);
  }
  return (file) => WORKFLOW.test(file) || actions.has(file);
}

// Pushes request.sha to the task branch on origin, with the user's
// credentials, after checking that the role pushes, the commit exists, and
// no commit the remote lacks changes a workflow file the task does not name.
async function push(job, request, io) {
  if (rolePolicy(job).gitPush !== 'branch') throw refuse(`${job.agent} is a ${job.role}; its agent file allows no push`);
  const { project, task } = taskOf(job);
  const branch = task.branch;
  if (!branch) throw refuse(`${job.task} has no branch to push`);
  if (branch === project.base) throw refuse(`${branch} is the project's base branch; an agent pushes only its task branch`);
  const sha = String(request?.sha || '');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw usage('the broker pushes a full commit sha');
  const common = commonDir(job);
  if (!common) throw refuse('the broker has no task repository to push from');
  const url = pushTarget(common, project.repo);
  const root = pushRoot(job);
  const format = objectFormat(common);
  const env = gitEnv();
  const unlock = await lockCache(root, io);
  let view = null;
  try {
    const dir = cacheRepo(root, format);
    const git = (args, opts = {}) => run('git', ['--git-dir', dir, ...args], { cwd: dir, env, ...opts }, io);
    view = viewRepo(job, root, common, format);
    // The remote's branches first, so the task fetch sends only what the
    // remote lacks.
    const fetched = await git(['fetch', '--quiet', '--prune', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
      url, '+refs/heads/*:refs/remotes/origin/*']);
    if (fetched.code !== 0) throw refuse(`cannot read the remote's branches: ${String(fetched.stderr).trim()}`);
    const received = await git(['-c', 'protocol.file.allow=always', '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true',
      'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--upload-pack=git-upload-pack',
      view, `+${sha}:refs/push/task`]);
    if (received.code !== 0) {
      const why = String(received.stderr).trim();
      throw refuse(/not our ref|couldn't find remote ref|no such remote ref|bad object|unadvertised object/i.test(why)
        ? `commit ${sha} is not in the task repository` : `cannot read commit ${sha} from the task repository: ${why}`);
    }
    const exists = await git(['cat-file', '-e', `${sha}^{commit}`]);
    if (exists.code !== 0) throw refuse(`${sha} in the task repository is not a commit`);
    const allowed = workflowAllowed(task, briefOf(job));
    const commits = await git(['rev-list', sha, '--not', '--remotes']);
    if (commits.code !== 0) throw refuse(`cannot list the commits to push: ${String(commits.stderr).trim()}`);
    if (commits.stdout.trim()) {
      // A merge lists only the files it changed against every parent, so a
      // workflow change merged in from a branch the remote has is not its own.
      const files = await git(['diff-tree', '--stdin', '-r', '--root', '--cc', '--name-only', '--no-commit-id'], { input: commits.stdout });
      if (files.code !== 0) throw refuse(`cannot list the files the push changes: ${String(files.stderr).trim()}`);
      const guarded = await protectedFiles(git, sha);
      const workflows = [...new Set(files.stdout.split('\n').filter((f) => f && guarded(f) && !allowed(f)))];
      if (workflows.length) {
        throw refuse(`the push changes ${workflows.join(', ')}; ${job.task} does not name it, so CI workflow changes go through the owner or a task whose brief names the file`);
      }
    }
    io.stderr(`tower-crane: the broker pushes ${sha.slice(0, 12)} to ${branch} on ${url}\n`);
    const pushed = await git(['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', url, `${sha}:refs/heads/${branch}`], { stream: true });
    return pushed.code;
  } finally {
    if (view) fs.rmSync(view, { recursive: true, force: true });
    unlock();
  }
}

module.exports = { TOKEN_ENV, parseGh, buildGh, ghCommand, gh, push, pushTarget, workflowAllowed, FLAGS };
