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

// Missing permissions deny access. Pre-T112 branch policies migrate only from
// the protected dispatch binding and the task and repository recorded in state.
function readPolicy(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const policy = { gitPush: 'none', gh: [], hook: null, branch: null, repo: null, ...raw };
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
    const tasks = JSON.parse(fs.readFileSync(path.join(b.state, 'tasks.json'), 'utf8'));
    const project = JSON.parse(fs.readFileSync(path.join(b.state, 'project.json'), 'utf8'));
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
// The only settings -c may make: what test fixtures need. A -c that could
// rewrite a URL, add a push URL or define an alias would let a push that
// looks local reach another machine.
const SAFE_C = /^(user\.(name|email)|init\.defaultbranch|commit\.gpgsign|tag\.gpgsign|core\.autocrlf|core\.quotepath|advice\.[a-z]+|color\.[a-z.]+)$/i;

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
    const result = cp.spawnSync(real, [...globals, ...argv], { encoding: 'utf8', timeout: 10000 });
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

function main() {
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
  const pushArgs = [];
  const why = tool === 'git' ? gitDenied(args, policy, real, pushArgs) : ghDenied(args, policy);
  if (why) {
    process.stderr.write(`tower-crane: ${why} is not allowed by this agent's agent file\n`);
    return 126;
  }
  const env = { ...process.env };
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
  if (r.status === 0 && policy.hook) {
    const words = args.filter((a, i) => !a.startsWith('-') && !(i && (tool === 'git' ? GIT_GLOBAL[args[i - 1]] : GH_VALUE.includes(args[i - 1]))));
    const action = tool === 'git' && words[0] === 'push' ? 'git-push'
      : tool === 'gh' && words[0] === 'pr' && words[1] === 'create' ? 'pr-created' : null;
    if (action) {
      try { require('./hook-bridge').call(action); } catch (e) {
        process.stderr.write(`tower-crane: command event not recorded: ${e.message}\n`);
      }
    }
  }
  return r.status === null ? 1 : r.status;
}

if (require.main === module) process.exit(main());

module.exports = { gitDenied, ghDenied, findReal };
