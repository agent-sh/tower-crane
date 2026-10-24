'use strict';

// git and gh as a spawned agent finds them on PATH. Each call is checked
// against an allowlist from the agent file: git's own commands (where they
// may write is the sandbox's call), push to another machine only without
// force through origin in the recorded repository, with every destination
// fixed to refs/heads/<task branch> on gitPush branch, and gh reads plus the
// writes ghWrite names.
// Everything else, aliases included, is refused, whatever order the options
// come in.
//
// usage: node shim.js <policy.json> <shim dir> <git|gh> [args...]

const fs = require('node:fs');
const path = require('node:path');
const cp = require('./commands');
const { mergeMasked, checkoutMasked } = require('./masked-merge');
const { clearPlaceholders } = require('./git-placeholders');

// Missing permissions deny access. Pre-T112 branch policies migrate only from
// the protected dispatch binding and the task and repository recorded in state.
function readPolicy(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const policy = { gitPush: 'none', gh: [], hook: null, branch: null, repo: null, masks: false, broker: false, repoDir: null, ...raw };
  if (policy.gitPush === 'branch' && (raw.branch === undefined || raw.repo === undefined)) {
    const home = path.dirname(file);
    const hook = path.join(home, 'hook.json');
    const { binding } = require('./harness-hooks');
    if (path.resolve(policy.hook || '') !== path.resolve(hook)) throw new Error('policy migration requires its dispatch hook');
    const b = binding(hook);
    if (fs.realpathSync(home) !== fs.realpathSync(path.join(b.state, 'homes', b.agent))
        || b.agent !== process.env.TOWER_CRANE_AGENT
        || path.resolve(b.state) !== path.resolve(process.env.TOWER_CRANE_STATE || '')
        || b.task !== process.env.TOWER_CRANE_TASK) throw new Error('policy migration requires its dispatch identity');
    const { tasks, project } = require('./state').loadState(b.state);
    const task = tasks.tasks.find((t) => t.id === b.task);
    if (raw.branch === undefined) policy.branch = task?.branch || null;
    // A project without a recorded repository keeps a null repo: every other
    // command still runs, and gitDenied refuses only pushes to another machine.
    if (raw.repo === undefined) policy.repo = project.repo || null;
  }
  return policy;
}

// git options allowed before the subcommand, and whether each takes a value.
const GIT_GLOBAL = { '-C': 1, '-c': 1, '--git-dir': 1, '--work-tree': 1, '--namespace': 1, '--no-pager': 0, '-P': 0,
  '--literal-pathspecs': 0, '--no-optional-locks': 0, '--bare': 0, '--no-replace-objects': 0 };
// git's own commands. Anything else is an alias or a git-* program on PATH,
// which could stand for any command, so it is refused. Where a command writes
// is the sandbox's call: a reviewer's worktree is read-only there, while its
// temp and cache dirs, where test fixtures run git init and commit, are not.
const GIT_COMMANDS = new Set(('add am apply archive bisect blame branch bundle cat-file check-attr check-ignore checkout '
  + 'cherry cherry-pick clean clone commit commit-tree config count-objects describe diff diff-files diff-index diff-tree '
  + 'fetch for-each-ref format-patch fsck gc grep hash-object help init log ls-files ls-remote ls-tree merge merge-base '
  + 'merge-file merge-tree mktree mv name-rev notes pack-refs pull push range-diff read-tree rebase reflog remote repack '
  + 'replace reset restore rev-list rev-parse revert rm shortlog show show-ref sparse-checkout stash status submodule '
  + 'switch symbolic-ref tag unpack-objects update-index update-ref var verify-commit verify-pack version whatchanged '
  + 'worktree write-tree').split(' '));
// Index of git's subcommand: the global options before it were checked by gitDenied.
function subcommandAt(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    i += GIT_GLOBAL[flag] && inline === undefined ? 2 : 1;
  }
  return i;
}
// The only settings -c may make: what test fixtures need. A -c that could
// rewrite a URL, add a push URL or define an alias would let a push that
// looks local reach another machine.
const SAFE_C = /^(user\.(name|email)|init\.defaultbranch|commit\.gpgsign|tag\.gpgsign|core\.autocrlf|core\.quotepath|advice\.[a-z]+|color\.[a-z.]+)$/i;

// A read with a time limit carries a variable of its own in its
// environment, as a spawn's run does (lib/processes.js strays). When the
// limit passes, spawnSync kills only the child it started; what that child
// started kept running and, through a PATH wrapper back into this shim,
// recursed on and doubled with every timeout. Those are found by the
// variable and killed too, until a pass finds none it has not signaled. The
// read stays in the shim's process group, so a supervisor that stops the
// agent's group stops it with the rest. The mark has a random part: after
// pid reuse, a pid and a count alone could name a survivor of an earlier shim.
function bounded(file, args, options) {
  const mark = `TOWER_CRANE_SHIM_READ_${process.pid}_${require('node:crypto').randomBytes(8).toString('hex')}`;
  const r = cp.spawnSync(file, args, { ...options, env: { ...(options.env || process.env), [mark]: '1' } });
  if (r.error?.code === 'ETIMEDOUT') {
    const { strays } = require('./processes');
    const signaled = new Set();
    for (let left = strays(null, mark); left.some((pid) => !signaled.has(pid)); left = strays(null, mark)) {
      for (const pid of left) {
        signaled.add(pid);
        try { process.kill(pid, 'SIGKILL'); } catch { /* exited, or not ours */ }
      }
    }
  }
  return r;
}

// A program on PATH ahead of the real git or gh that runs `git` or `gh`
// again, as a test's or a user's wrapper does, leads back to this shim:
// findReal picks it, the shim runs it, and it runs the shim, without end.
// Every process the shim starts gets the shim's pid and the program it
// resolved, and a git shim's also get the PATH it ran with. A second shim is
// in a loop only when it resolves that same program: a wrapper that drops
// its own directory from PATH and runs `git` by name reaches the shim again,
// but that shim resolves the git past the wrapper and runs it. Then a shim
// whose parent is the shim that set the pid was started through an exec by
// the program that shim ran. Real git puts its exec path first on PATH for
// every program it starts, hooks included (git 2.53.0), so a git shim that
// sees the marked PATH unchanged was reached with no git in between, through
// a wrapper that did not exec. gh changes no PATH, so a gh shim checks the
// pid only and clears the PATH mark.
const SHIM_PID = 'TOWER_CRANE_SHIM_PID';
const SHIM_REAL = 'TOWER_CRANE_SHIM_REAL';
const SHIM_PATH = 'TOWER_CRANE_SHIM_GIT_PATH';
// How many shims run inside one another, counting this one. A shim runs
// inside another only where a hook or helper names the shim's own path: one
// that runs `git` by name gets the git in git's exec path. So real nesting
// stays at 2 or 3, and past 8 it is a loop the checks above missed, such as
// a wrapper that changes PATH and does not exec, or a Windows .cmd wrapper,
// where cmd.exe stands between the shims and no pid matches. 8 bounds such a
// loop to 8 shims inside one another.
const SHIM_DEPTH = 'TOWER_CRANE_SHIM_DEPTH';
const MAX_DEPTH = 8;
const pathOf = (env) => String(env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'] ?? '');

function reentered(tool, real, env = process.env, ppid = process.ppid) {
  if (env[SHIM_REAL] !== path.resolve(real)) return false;
  if (env[SHIM_PID] === String(ppid)) return true;
  return tool === 'git' && env[SHIM_PATH] !== undefined && env[SHIM_PATH] === pathOf(env);
}

function depthOf(env = process.env) {
  return (Number.parseInt(env[SHIM_DEPTH], 10) || 0) + 1;
}

function markChildren(tool, real, depth) {
  process.env[SHIM_PID] = String(process.pid);
  process.env[SHIM_REAL] = path.resolve(real);
  process.env[SHIM_DEPTH] = String(depth);
  if (tool === 'git') process.env[SHIM_PATH] = pathOf(process.env);
  else delete process.env[SHIM_PATH];
}

// What the shim starts other than the real program, such as the CLI that
// records a push, runs git of its own with the same PATH and is no loop. It
// keeps the depth: what it runs still runs inside this shim.
function unmark() {
  delete process.env[SHIM_PID];
  delete process.env[SHIM_REAL];
  delete process.env[SHIM_PATH];
}

// gh options that take a value; they may come anywhere.
const GH_VALUE = ['-R', '--repo', '--hostname'];

// The only options a push to another machine may use, spelled exactly: git
// accepts abbreviations, so anything else could be --delete, --force or
// --mirror in disguise.
const PUSH_OPTIONS = ['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--porcelain'];

// A push to a repository on this machine changes nothing anyone else sees:
// test fixtures push to temporary bare repositories. The target counts as
// local only when every URL git would push to is a path on this machine,
// after git applies its URL rewriting, and no pushInsteadOf rule is set.
function localTarget(target, globals, real) {
  const q = (args) => {
    const r = cp.spawnSync(real, [...globals, ...args], { encoding: 'utf8' });
    return { status: r.status, lines: String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
  };
  if (q(['config', '--get-regexp', '^url\\..*\\.pushinsteadof$']).lines.length) return false;
  const remotes = q(['remote']).lines;
  const urls = remotes.includes(target)
    ? q(['remote', 'get-url', '--push', '--all', target]).lines
    : q(['ls-remote', '--get-url', target]).lines;
  return urls.length > 0 && urls.every((u) => /^(\/|file:\/\/)/.test(u) || /^[A-Za-z]:[\\/]/.test(u));
}

function gitDenied(args, policy, real, pushArgs = []) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (!Object.prototype.hasOwnProperty.call(GIT_GLOBAL, flag)) return `git ${flag}`;
    const value = GIT_GLOBAL[flag] && inline === undefined ? args[i + 1] : inline;
    if (flag === '-c' && !SAFE_C.test(String(value).split('=')[0])) return `git -c ${String(value).split('=')[0]}`;
    i += GIT_GLOBAL[flag] && inline === undefined ? 2 : 1;
  }
  const sub = args[i];
  if (sub === undefined) return null;
  if (!GIT_COMMANDS.has(sub)) return `git ${sub}`;
  if (sub === 'stash' && args[i + 1] !== 'list') return 'git stash (commit work in progress on the task branch instead)';
  if (sub !== 'push') return null;
  const rest = args.slice(i + 1);
  // Only the plainest push, `git push <dest> [refspec...]` with no option
  // anywhere, can count as local: git accepts abbreviated options, so no
  // parser here could tell which argument an option takes.
  if (rest.length && rest.every((a) => !a.startsWith('-')) && localTarget(rest[0], args.slice(0, i), real)) return null;
  if (policy.gitPush !== 'branch') return 'git push';
  if (!policy.branch) return 'git push without a task branch';
  if (args.slice(0, i).some((a) => a === '--namespace' || a.startsWith('--namespace=')) || process.env.GIT_NAMESPACE) return 'git push with a namespace';
  const option = rest.find((a) => a.startsWith('-') && !PUSH_OPTIONS.includes(a));
  if (option) return `git push ${option}`;
  // A refspec that forces (+), deletes (empty source) or matches everything.
  if (rest.filter((a) => !a.startsWith('-')).slice(1).some((r) => /^[+:]/.test(r))) return 'git push +refspec or :refspec';
  // Configuration can make a plain push mirror or force: refuse it rather
  // than read every way git combines it.
  const r = cp.spawnSync(real, [...args.slice(0, i), 'config', '--get-regexp', '^remote\\..*\\.(mirror|push)$'], { encoding: 'utf8' });
  // Any mirror key counts, whatever its value: git reads yes, on, 1 and a
  // bare key as true.
  if (String(r.stdout || '').split(/\r?\n/).some((l) => /^remote\..*\.mirror(\s|$)/i.test(l) || /\.push\s+[+:]/i.test(l))) return 'git push with a mirror or forcing push refspec in config';
  const globals = args.slice(0, i);
  let failed = r.error || r.status === null || r.status > 1;
  const read = (argv) => {
    const result = bounded(real, [...globals, ...argv], { encoding: 'utf8', timeout: 10000 });
    if (result.error || result.status === null || result.status > 1) failed = true;
    return String(result.stdout || '').trim();
  };
  const config = (key) => read(['config', '--get', key]);
  if (read(['config', '--bool', '--get', 'push.followTags']) === 'true') return 'git push with followTags';
  const recurse = config('push.recurseSubmodules').toLowerCase();
  if (recurse && !['no', 'false', 'off', '0', 'check'].includes(recurse)) return 'git push with recursive submodule pushes';
  const own = `refs/heads/${policy.branch}`;
  const words = rest.filter((a) => !a.startsWith('-'));
  let target = words[0];
  let refs = words.slice(1);
  let current;
  const currentRef = () => (current ??= read(['symbolic-ref', '-q', 'HEAD']));
  const currentBranch = () => currentRef().replace(/^refs\/heads\//, '');
  if (!target) {
    const branch = currentBranch();
    target = config(`branch.${branch}.pushRemote`) || config('remote.pushDefault')
      || config(`branch.${branch}.remote`) || 'origin';
  }
  if (!localTarget(target, globals, real)) {
    if (target !== 'origin' || !policy.repo) return 'git push outside the recorded origin repository';
    const matchesRepo = (url) => {
      const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url);
      return match && match[1].toLowerCase() === policy.repo.toLowerCase();
    };
    const fetch = read(['config', '--get-all', 'remote.origin.url']);
    if (!matchesRepo(fetch)) return 'git push with origin outside the recorded repository';
    const configuredPush = read(['config', '--get-all', 'remote.origin.pushurl']);
    if (configuredPush && configuredPush.split(/\r?\n/).some((url) => url !== fetch)) return 'git push with origin.pushurl different from the fetch URL';
    // Git rewrites URLs before using them, and a remote may have several push URLs.
    const resolvedFetch = read(['remote', 'get-url', '--all', 'origin']);
    const pushUrls = read(['remote', 'get-url', '--push', '--all', 'origin']);
    if (!matchesRepo(resolvedFetch) || !pushUrls || pushUrls.split(/\r?\n/).some((url) => url !== resolvedFetch)) return 'git push with origin URLs outside the recorded fetch URL';
  }
  if (!refs.length) {
    const configured = read(['config', '--get-all', `remote.${target}.push`]);
    if (configured) refs = configured.split(/\r?\n/);
    else {
      if (currentRef() !== own) return 'git push from another branch';
      const mode = config('push.default') || 'simple';
      const upstreamRemote = config(`branch.${policy.branch}.remote`);
      if (mode === 'upstream' || (mode === 'simple' && target === upstreamRemote)) {
        const upstream = read(['config', '--get-all', `branch.${policy.branch}.merge`]);
        if (upstream !== own || target !== upstreamRemote) return 'git push to another upstream branch';
      } else if (mode !== 'current' && !(mode === 'simple' && upstreamRemote && target !== upstreamRemote)) {
        return 'git push without a single task branch destination';
      }
      refs = [`HEAD:${own}`];
    }
  }
  const normalized = [];
  for (const ref of refs) {
    if (/^[+:]/.test(ref) || ref.includes('*')) return 'git push +refspec, :refspec or wildcard';
    const parts = ref.split(':');
    const source = parts[0];
    const dest = parts.length === 1 ? read(['rev-parse', '--symbolic-full-name', source]) : parts[1];
    if (parts.length > 2 || !source || (dest !== own && !(parts.length === 2 && dest === policy.branch))) {
      return 'git push to a ref outside the task branch';
    }
    // Full destinations prevent Git from guessing a tag or another namespace
    // when a remote already has a ref with the same short name.
    normalized.push(`${source}:${own}`);
  }
  if (failed) return 'git push with unreadable configuration or refs';
  // Automatic tags and submodules could add destinations after the config checks.
  pushArgs.push(...globals, 'push', '--no-follow-tags', '--recurse-submodules=no', ...rest.filter((a) => a.startsWith('-')), target, ...normalized);
  return null;
}

// The git directory of the repository a git call runs in, asked with the call's
// own options (-C, --git-dir), so its placeholders are the ones the call would hit.
// Null outside a repository: a call there has no placeholder to clear.
function gitCommonDir(args, real) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += GIT_GLOBAL[args[i]] && !args[i].includes('=') ? 2 : 1;
  const r = bounded(real, [...args.slice(0, i), 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 10000 });
  const dir = r.status === 0 ? r.stdout.trim() : '';
  return path.isAbsolute(dir) ? dir : null;
}

function ghDenied(args, policy) {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (GH_VALUE.includes(a)) i++;
      continue;
    }
    words.push(a);
  }
  if (!words.length) return null;
  const ok = policy.gh.some((c) => c.split(' ').every((w, n) => words[n] === w));
  return ok ? null : `gh ${words.slice(0, 2).join(' ')}`;
}

function findReal(tool, skip) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!dir || path.resolve(dir) === path.resolve(skip)) continue;
    // A nested spawn must reach the executable rather than its parent's shim.
    if (fs.existsSync(path.join(dir, '..', '.tower-crane-origin.json'))) continue;
    for (const ext of exts) {
      const f = path.join(dir, tool + ext);
      try {
        if (fs.statSync(f).isFile()) {
          if (process.platform !== 'win32') fs.accessSync(f, fs.constants.X_OK);
          return f;
        }
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

// --- through the broker ------------------------------------------------------
//
// A sandboxed agent holds no GitHub credential. Its pushes of the task
// branch and its gh commands go to the spawn's broker, which checks them
// again outside the sandbox and runs them with the user's login
// (lib/github-broker.js). The checks here only give the agent the reason
// before a round trip; the broker's are the ones that hold.

const out = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) };

function brokerFile() {
  const file = process.env.TOWER_CRANE_BROKER;
  if (!file) throw new Error('this agent pushes and runs gh through its broker, and TOWER_CRANE_BROKER is unset');
  return file;
}

// Whether a git call runs in the task's repository, the one the broker pushes from.
function inTaskRepo(globals, real, policy) {
  if (!policy.repoDir) return false;
  const r = bounded(real, [...globals, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 10000 });
  const dir = r.status === 0 ? r.stdout.trim() : '';
  const same = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; } };
  return !!dir && same(dir, policy.repoDir);
}

// The remote a push names, or the one git would pick for the current branch.
function pushTarget(globals, rest, real) {
  const words = rest.filter((a) => !a.startsWith('-'));
  if (words[0]) return words[0];
  const read = (argv) => String(bounded(real, [...globals, ...argv], { encoding: 'utf8', timeout: 10000 }).stdout || '').trim();
  const branch = read(['symbolic-ref', '-q', '--short', 'HEAD']);
  return (branch && read(['config', '--get', `branch.${branch}.pushRemote`])) || read(['config', '--get', 'remote.pushDefault'])
    || (branch && read(['config', '--get', `branch.${branch}.remote`])) || 'origin';
}

// The pack the broker asks for: the commit and what it needs that the remote
// lacks, built here in the sandbox from what the agent can read. have lists
// the remote's branch heads; those this repository holds bound the pack, and
// the broker supplies a thin pack's bases from its own copy of the remote.
function packFor(real, globals, sha) {
  return (have) => {
    const known = bounded(real, [...globals, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
      { input: have.map((h) => `${h}\n`).join(''), encoding: 'utf8', timeout: 60000 });
    const bounds = String(known.stdout || '').split('\n').filter((l) => / commit$/.test(l)).map((l) => `^${l.split(' ')[0]}`);
    const child = cp.spawn(real, [...globals, 'pack-objects', '--stdout', '--revs', '--thin', '--delta-base-offset', '-q'],
      { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdin.on('error', () => {});
    child.stdin.end([sha, ...bounds].map((l) => `${l}\n`).join(''));
    // Called when the broker answers before reading the whole pack.
    child.stdout.stop = () => child.kill();
    return child.stdout;
  };
}

// `git push [origin] [refspec]` of the task branch: the shim names the
// commit, sends a pack of it, and the broker pushes it to the task branch on
// origin.
async function brokerPush(globals, rest, policy, real) {
  if (policy.gitPush !== 'branch' || !policy.branch) return { why: 'git push' };
  const option = rest.find((a) => a.startsWith('-') && !PUSH_OPTIONS.includes(a));
  if (option) return { why: `git push ${option}` };
  const own = `refs/heads/${policy.branch}`;
  const read = (argv) => bounded(real, [...globals, ...argv], { encoding: 'utf8', timeout: 10000 });
  const refs = rest.filter((a) => !a.startsWith('-')).slice(1);
  if (refs.length > 1) return { why: 'git push of more than one refspec' };
  let source;
  if (!refs.length) {
    if (String(read(['symbolic-ref', '-q', 'HEAD']).stdout || '').trim() !== own) return { why: 'git push from another branch' };
    source = 'HEAD';
  } else {
    const ref = refs[0];
    if (/^[+:]/.test(ref) || ref.includes('*')) return { why: 'git push +refspec, :refspec or wildcard' };
    const parts = ref.split(':');
    const dest = parts.length === 1 ? String(read(['rev-parse', '--symbolic-full-name', parts[0]]).stdout || '').trim() : parts[1];
    if (parts.length > 2 || !parts[0] || (dest !== own && dest !== policy.branch)) return { why: 'git push to a ref outside the task branch' };
    source = parts[0];
  }
  const resolved = read(['rev-parse', '--verify', '--quiet', `${source}^{commit}`]);
  const sha = String(resolved.stdout || '').trim();
  if (resolved.status !== 0 || !sha) return { why: `git push of ${source}, which names no commit` };
  const code = await require('./broker').request(brokerFile(), { push: { sha } }, out, { pack: packFor(real, globals, sha) });
  if (code === 0) {
    // What git itself records after a push, so status and the next push
    // know where origin's branch is. The config may be read-only here.
    read(['update-ref', `refs/remotes/origin/${policy.branch}`, sha]);
    if (rest.includes('-u') || rest.includes('--set-upstream')) {
      read(['config', `branch.${policy.branch}.remote`, 'origin']);
      read(['config', `branch.${policy.branch}.merge`, own]);
    }
  }
  return { code };
}

// --- fetch through the broker ------------------------------------------------
//
// ssh and https to origin fail in the sandbox: no credential, no SSH agent
// (hidden /run), and in a user namespace ssh refuses its own root-owned
// config files ("Bad owner"). A fetch of origin from the task repository goes
// to the broker, which fetches with the user's login into its own repository
// and sends back the task's branches and a thin pack of what the agent lacks.
// The pack is indexed here, so git hashes every object it takes, and origin's
// branches are recorded where git's own fetch would record them.

// Options a brokered fetch takes. It fetches branches only, never tags.
const FETCH_OPTIONS = ['-q', '--quiet', '-v', '--verbose', '-p', '--prune', '-n', '--no-tags', '--progress', '--no-progress', '--no-write-fetch-head'];
// The most commits the request names, as lib/github-broker.js reads them.
const MAX_HAVE = 8000;

// The remote a fetch or pull names, or the one git would pick for the current branch.
function fetchRemote(globals, rest, real) {
  const words = rest.filter((a) => !a.startsWith('-'));
  if (words[0]) return words[0];
  const read = (argv) => String(bounded(real, [...globals, ...argv], { encoding: 'utf8', timeout: 10000 }).stdout || '').trim();
  const branch = read(['symbolic-ref', '-q', '--short', 'HEAD']);
  return (branch && read(['config', '--get', `branch.${branch}.remote`])) || 'origin';
}

// Whether origin is the project's recorded GitHub repository, read as the
// broker reads it: the one URL in the config, without URL rewriting. Only
// that origin is the broker's to fetch; git fetches any other, a path on
// this machine included, in the sandbox as before.
function brokeredOrigin(globals, real, policy) {
  if (!policy.repo) return false;
  const r = bounded(real, [...globals, 'config', '--get-all', 'remote.origin.url'], { encoding: 'utf8', timeout: 10000 });
  const urls = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const m = urls.length === 1 ? require('./github-broker').GITHUB.exec(urls[0]) : null;
  return r.status === 0 && !!m && m[1].toLowerCase() === policy.repo.toLowerCase();
}

// The branch a refspec fetches: B, refs/heads/B, either with a leading +, or
// with :refs/remotes/origin/B, where git's own fetch would store it.
function fetchBranch(spec) {
  const m = /^\+?(?:refs\/heads\/)?([^:*]+)(?::refs\/remotes\/origin\/([^:*]+))?$/.exec(spec);
  if (!m || m[1].startsWith('refs/') || m[1].startsWith('+') || (m[2] !== undefined && m[2] !== m[1])) return null;
  return m[1];
}

async function brokerFetch(globals, rest, real) {
  // Until the fetch completes: a shim whose event loop runs dry before the
  // broker's answer must not exit as a success.
  process.exitCode = 1;
  const fail = (code, message) => {
    process.stderr.write(`tower-crane: ${message}\n`);
    return code;
  };
  const option = rest.find((a) => a.startsWith('-') && !FETCH_OPTIONS.includes(a));
  if (option) return fail(126, `git fetch ${option} cannot go through the broker, which fetches the task's branches from origin with ${FETCH_OPTIONS.join(' ')}`);
  const branches = [];
  for (const spec of rest.filter((a) => !a.startsWith('-')).slice(1)) {
    const b = fetchBranch(spec);
    if (!b) return fail(126, `git fetch origin ${spec}: the broker fetches branches by name (BRANCH or +refs/heads/BRANCH:refs/remotes/origin/BRANCH)`);
    if (!branches.includes(b)) branches.push(b);
  }
  const quiet = rest.includes('-q') || rest.includes('--quiet');
  const read = (argv, opts = {}) => bounded(real, [...globals, ...argv], { encoding: 'utf8', timeout: 30000, ...opts });
  const have = [...new Set(String(read(['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes/origin']).stdout || '')
    .split('\n').filter(Boolean))].slice(0, MAX_HAVE);
  let answer = null;
  let indexer = null;
  let indexed = null;
  let indexError = '';
  // Once index-pack has exited, the rest of the pack is dropped and nothing
  // waits for a drain that cannot come: the broker's answer still has to
  // arrive, and the failure is reported from index-pack's exit.
  let closed = false;
  const waiting = [];
  const wake = () => { for (const fn of waiting.splice(0)) fn(); };
  const io = {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    refs: (r) => { answer = r; },
    pack: (chunk) => {
      if (!indexer) {
        // In the task repository, which the sandbox lets the agent write.
        indexer = cp.spawn(real, [...globals, 'index-pack', '--stdin', '--fix-thin'], { stdio: ['pipe', 'ignore', 'pipe'] });
        indexer.stdin.on('error', () => {});
        indexer.stdin.on('drain', wake);
        indexer.stderr.setEncoding('utf8').on('data', (d) => { indexError += d; });
        indexed = new Promise((resolve) => {
          const done = (result) => {
            closed = true;
            wake();
            resolve(result);
          };
          indexer.on('error', (e) => done({ code: 127, error: e.message }));
          indexer.on('close', (code) => done({ code }));
        });
      }
      return closed || indexer.stdin.write(chunk);
    },
    drained: (fn) => (closed ? fn() : waiting.push(fn)),
  };
  const code = await require('./broker').request(brokerFile(), { fetch: { branches, have } }, io);
  let result = { code: 0 };
  if (indexer) {
    indexer.stdin.end();
    result = await indexed;
  }
  if (code !== 0) return code;
  if (result.code !== 0) return fail(1, `cannot index the pack the broker sent: ${result.error || indexError.trim() || `git exited ${result.code}`}`);
  if (!answer || typeof answer.refs !== 'object' || !answer.refs) return fail(1, 'the broker sent no branches for the fetch');
  const url = String(answer.url || 'origin');
  const prune = rest.includes('-p') || rest.includes('--prune');
  const lines = [];
  const heads = [];
  let status = 0;
  for (const [b, sha] of Object.entries(answer.refs)) {
    const ref = `refs/remotes/origin/${b}`;
    const old = String(read(['rev-parse', '--verify', '--quiet', ref]).stdout || '').trim();
    if (sha === null) {
      if (branches.includes(b)) {
        process.stderr.write(`fatal: couldn't find remote ref refs/heads/${b}\n`);
        status = 128;
      } else if (prune && old) {
        read(['update-ref', '-d', ref, old]);
        lines.push(` - [deleted]         (none)     -> origin/${b}`);
      }
      continue;
    }
    if (typeof sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) || read(['cat-file', '-e', `${sha}^{commit}`]).status !== 0) {
      return fail(1, `the broker's ${b} at ${sha} did not arrive whole`);
    }
    if (old !== sha) {
      const set = read(['update-ref', '-m', `fetch: through the broker`, ref, sha]);
      if (set.status !== 0) return fail(1, `cannot record ${ref}: ${String(set.stderr).trim()}`);
      lines.push(old ? `   ${old.slice(0, 7)}..${sha.slice(0, 7)}  ${b} -> origin/${b}` : ` * [new branch]      ${b} -> origin/${b}`);
    }
    heads.push({ b, sha });
  }
  if (!quiet && lines.length) process.stderr.write(`From ${url}\n${lines.join('\n')}\n`);
  if (!rest.includes('--no-write-fetch-head') && heads.length) {
    // What git pull and git merge FETCH_HEAD read: the named branches are
    // for merging; without names, the current branch's upstream is.
    const current = String(read(['symbolic-ref', '-q', '--short', 'HEAD']).stdout || '').trim();
    const upstream = current && String(read(['config', '--get', `branch.${current}.remote`]).stdout || '').trim() === 'origin'
      ? String(read(['config', '--get', `branch.${current}.merge`]).stdout || '').trim().replace(/^refs\/heads\//, '') : '';
    const merge = (b) => (branches.length ? branches.includes(b) : b === upstream);
    const file = String(read(['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD']).stdout || '').trim();
    const sorted = [...heads.filter((h) => merge(h.b)), ...heads.filter((h) => !merge(h.b))];
    if (file) fs.writeFileSync(file, sorted.map((h) => `${h.sha}\t${merge(h.b) ? '' : 'not-for-merge'}\tbranch '${h.b}' of ${url}\n`).join(''));
  }
  return status;
}

// gh through the broker. A --body-file the agent names is read here, in its
// sandbox, and sent as the command's stdin.
async function brokerGh(args) {
  const G = require('./github-broker');
  let parsed;
  try {
    parsed = G.parseGh(args);
  } catch (e) {
    process.stderr.write(`tower-crane: ${e.message}\n`);
    return 126;
  }
  let input;
  for (const f of parsed.flags) {
    if (f.name !== 'body-file') continue;
    input = f.value === '-' ? require('./util').readStdin().toString('utf8') : fs.readFileSync(path.resolve(f.value), 'utf8');
    f.value = '-';
  }
  return require('./broker').request(brokerFile(), { gh: G.buildGh(parsed), ...(input === undefined ? {} : { input }) }, out);
}

function recordAction(policy, tool, args) {
  if (!policy.hook) return;
  unmark();
  const words = args.filter((a, i) => !a.startsWith('-') && !(i && (tool === 'git' ? GIT_GLOBAL[args[i - 1]] : GH_VALUE.includes(args[i - 1]))));
  const action = tool === 'git' && words[0] === 'push' ? 'git-push'
    : tool === 'gh' && words[0] === 'pr' && words[1] === 'create' ? 'pr-created' : null;
  if (action) {
    try { require('./hook-bridge').call(action); } catch (e) {
      process.stderr.write(`tower-crane: command event not recorded: ${e.message}\n`);
    }
  }
}

async function main() {
  const [policyFile, shimDir, tool, ...args] = process.argv.slice(2);
  let policy;
  try { policy = readPolicy(policyFile); } catch (e) {
    process.stderr.write(`tower-crane: ${e.message}\n`);
    return 126;
  }
  const real = findReal(tool, shimDir);
  if (!real) {
    process.stderr.write(`tower-crane: ${tool} is not installed\n`);
    return 127;
  }
  if (reentered(tool, real)) {
    process.stderr.write(`tower-crane: ${tool} shim loop: ${real} leads back to this shim\n`);
    return 127;
  }
  const depth = depthOf();
  if (depth > MAX_DEPTH) {
    process.stderr.write(`tower-crane: ${tool} shim loop: ${depth} shims run inside one another, past ${MAX_DEPTH}; ${real} or a hook keeps running the shim\n`);
    return 127;
  }
  markChildren(tool, real, depth);
  const denied = (why) => {
    process.stderr.write(`tower-crane: ${why} is not allowed by this agent's agent file\n`);
    return 126;
  };
  // A sandboxed agent's git reads no system config, as its harness's git and
  // spawn's read of the remote hosts do (harness-git.js, agents.js
  // remoteHosts), so the URLs the push checks below read are the ones git
  // uses, whatever the agent's own environment says.
  if (policy.broker && tool === 'git') process.env.GIT_CONFIG_NOSYSTEM = '1';
  const sub = subcommandAt(args);
  if (policy.broker && tool === 'gh' && args.some((a) => !a.startsWith('-'))) {
    const why = ghDenied(args, policy);
    if (why) return denied(why);
    const code = await brokerGh(args);
    if (code === 0) recordAction(policy, tool, args);
    return code;
  }
  if (policy.broker && tool === 'git' && (args[sub] === 'fetch' || args[sub] === 'pull')) {
    const globals = args.slice(0, sub);
    const rest = args.slice(sub + 1);
    const why = gitDenied(globals, policy, real);
    if (why) return denied(why);
    if (fetchRemote(globals, rest, real) === 'origin' && inTaskRepo(globals, real, policy) && brokeredOrigin(globals, real, policy)) {
      if (args[sub] === 'pull') {
        process.stderr.write('tower-crane: git pull cannot reach origin from the sandbox; git fetch origin goes through the broker, then git merge origin/BRANCH\n');
        return 126;
      }
      return brokerFetch(globals, rest, real);
    }
  }
  if (policy.broker && tool === 'git' && args[sub] === 'push') {
    const globals = args.slice(0, sub);
    const rest = args.slice(sub + 1);
    const why = gitDenied(globals, policy, real);
    if (why) return denied(why);
    if (pushTarget(globals, rest, real) === 'origin' && inTaskRepo(globals, real, policy)) {
      const r = await brokerPush(globals, rest, policy, real);
      if (r.why) return denied(r.why);
      if (r.code === 0) recordAction(policy, tool, args);
      return r.code;
    }
  }
  const pushArgs = [];
  const why = tool === 'git' ? gitDenied(args, policy, real, pushArgs) : ghDenied(args, policy);
  if (why) return denied(why);
  // A sandboxed agent has no credential for another machine: only a push to
  // a path here runs in its sandbox.
  if (policy.broker && tool === 'git' && args[sub] === 'push') {
    const rest = args.slice(sub + 1);
    const target = pushTarget(args.slice(0, sub), rest, real);
    if (!localTarget(target, args.slice(0, sub), real)) {
      process.stderr.write(`tower-crane: git push to ${target} from here has no credentials; push the task branch to origin from the task's worktree, and the broker runs it\n`);
      return 126;
    }
  }
  if (tool === 'git') {
    const commonDir = gitCommonDir(args, real);
    if (commonDir) clearPlaceholders(commonDir);
  }
  // A merge or checkout that brings in a path claude's sandbox masks cannot be
  // written by git, so the shim moves it with plumbing; any other runs as git's own.
  if (tool === 'git' && policy.masks && args[sub] === 'merge') {
    const code = mergeMasked(args.slice(0, sub), args.slice(sub + 1), real);
    if (code !== null) return code;
  }
  if (tool === 'git' && policy.masks && args[sub] === 'checkout') {
    const code = checkoutMasked(args.slice(0, sub), args.slice(sub + 1), real);
    if (code !== null) return code;
  }
  const env = require('./harness-git').sandboxedEnv({ ...process.env });
  if (tool === 'gh' && args[0] === 'stack') {
    // An explicitly allowed extension owns its atomic lease-protected Git pushes.
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[key] = String(env[key] || '').split(path.delimiter)
      .filter((dir) => path.resolve(dir) !== path.resolve(shimDir)).join(path.delimiter);
  }
  const r = cp.spawnSync(real, pushArgs.length ? pushArgs : args, { stdio: 'inherit', shell: /\.(cmd|bat)$/i.test(real), env });
  if (r.error) {
    process.stderr.write(`tower-crane: cannot run ${real} (${r.error.message})\n`);
    return 127;
  }
  if (r.status === 0) recordAction(policy, tool, args);
  return r.status === null ? 1 : r.status;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`tower-crane: ${e.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { gitDenied, ghDenied, findReal, packFor, fetchBranch, reentered };
