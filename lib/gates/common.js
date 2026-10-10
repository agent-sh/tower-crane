'use strict';
// Plumbing shared by the gates: running commands (replaceable through ctx.exec), git and gh
// helpers, the merge base a task is measured against, and temporary worktrees at one commit.
const { spawn, spawnSync, assertUnlocked } = require('../commands');
const fs = require('fs');
const os = require('os');
const path = require('path');

// After SIGTERM a test runner gets this long to remove its own temp files before SIGKILL.
const TERM_GRACE_MS = 5000;
// Once the command has exited its pipes drain in milliseconds; a process that left the
// process group (a daemon) can hold them open forever, so stop waiting after this.
const DRAIN_MS = 2000;

function fail(summary, extra) {
  return { ok: false, summary, ...extra };
}

function short(sha) {
  return String(sha || '').slice(0, 10);
}

// Short and full forms of one commit name the same commit.
function sameSha(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  if (x.length < 7 || y.length < 7) return x === y;
  return x.startsWith(y) || y.startsWith(x);
}

function tailLines(text, n) {
  const lines = String(text || '').replace(/\s+$/, '').split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

function privateMarker(prefix, index) {
  const radix = 0x1900;
  return `${prefix}${String.fromCharCode(0xe000 + Math.floor(index / radix))}${String.fromCharCode(0xe000 + (index % radix))}${prefix}`;
}

function sensitiveEnvName(name) {
  return /(token|secret|password|passwd|credential|api[_-]?key|access[_-]?key|private[_-]?key|cookie)/i.test(name);
}

// Only text that is credential-shaped by its prefix or its header is redacted. Bare hex and base64
// runs are not: paths, long file names and commit SHAs match them too.
function redactTokenShapes(text) {
  return String(text)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted:GITHUB_TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted:GITHUB_TOKEN]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[redacted:API_KEY]')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted:AWS_ACCESS_KEY_ID]')
    .replace(/\bxox[a-z]-[A-Za-z0-9-]{10,}\b/gi, '[redacted:SLACK_TOKEN]')
    .replace(/(\bauthorization:\s*(?:(?:bearer|basic|token)\s+)?)\S+/gi, '$1[redacted:AUTHORIZATION]');
}

function credentialShaped(text) {
  return redactTokenShapes(text) !== String(text);
}

// An environment value is a secret when it has a token shape, or when its name is credential-named
// and the value is long and mixed (letters and digits, no spaces). Numbers, booleans and short words
// are never secrets, whatever the name: MAX_THINKING_TOKENS=1 must not rewrite a test's TAP ordinal.
function secretValue(name, value) {
  if (typeof value !== 'string') return false;
  if (credentialShaped(value)) return true;
  return sensitiveEnvName(name) && /^[A-Za-z0-9+\/=_.-]{20,}$/.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

// Keep environment values only in this short-lived closure. Callers pass the
// redacted text onward and never include the values in state or diagnostics.
function createRedactor(secrets = []) {
  const byValue = new Map();
  for (const [name, value] of secrets) {
    if (typeof value !== 'string' || !value || !value.trim()) continue;
    const label = String(name || 'ENV').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
    const previous = byValue.get(value);
    if (!previous || sensitiveEnvName(label) && !sensitiveEnvName(previous)) byValue.set(value, label);
  }
  const ordered = [...byValue].sort(([a], [b]) => b.length - a.length);

  return (input) => {
    let text = String(input ?? '');
    const protectedMarkers = [];
    text = text.replace(/\[redacted:[A-Za-z0-9_]+\]/g, (placeholder) => {
      const marker = privateMarker('\uF001', protectedMarkers.length);
      protectedMarkers.push({ marker, placeholder });
      return marker;
    });
    const markers = [];
    for (const [secret, name] of ordered) {
      if (!text.includes(secret)) continue;
      const marker = privateMarker('\uF000', markers.length);
      text = text.split(secret).join(marker);
      markers.push({ marker, name });
    }
    text = redactTokenShapes(text);
    for (const { marker, name } of markers) text = text.split(marker).join(`[redacted:${name}]`);
    for (const { marker, placeholder } of protectedMarkers) text = text.split(marker).join(placeholder);
    return text;
  };
}

function shellQuote(s) {
  const v = String(s);
  if (process.platform === 'win32') return `"${v.replace(/"/g, '""')}"`;
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(v)) return v;
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function spawnSyncExec(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: Infinity, windowsHide: true, ...opts });
}

// Keeps the last `keep` characters of a stream so a chatty test suite cannot exhaust memory.
function tailBuffer(keep) {
  let text = '';
  return {
    push(chunk) {
      text += chunk;
      if (text.length > keep * 2) text = text.slice(-keep);
    },
    get value() {
      return text.length > keep ? text.slice(-keep) : text;
    },
  };
}

function killTree(child, signal) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}

// Same contract as spawnSync ({status, signal, stdout, stderr, error}; error.code ETIMEDOUT on
// timeout), plus `output`: stdout and stderr interleaved in arrival order. spawnSync kills only
// the shell on timeout and leaves the test runner it started running, so the command gets its
// own process group here and the whole group is stopped on timeout and after exit.
function treeExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const keep = opts.keep || Infinity;
    const out = tailBuffer(keep);
    const err = tailBuffer(keep);
    const all = tailBuffer(keep);
    const afterTimeout = tailBuffer(keep);
    let child;
    try {
      child = spawn(cmd, args || [], {
        cwd: opts.cwd,
        env: opts.env,
        shell: opts.shell,
        detached: !win,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ status: null, signal: null, stdout: '', stderr: '', output: '', error });
      return;
    }
    let done = false;
    let timedOut = false;
    let timeoutOutput;
    let spawnError = null;
    let exit = null;
    const timers = [];
    const finish = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      // Whatever the command left running in its group would outlive the worktree it runs in.
      if (!win && child.pid) killTree(child, 'SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      let error = spawnError;
      if (!error && timedOut) {
        error = new Error(`timed out after ${opts.timeout} ms`);
        error.code = 'ETIMEDOUT';
      }
      resolve({
        status: exit ? exit.code : null,
        signal: exit ? exit.signal : null,
        stdout: out.value,
        stderr: err.value,
        output: all.value,
        ...(timedOut ? { timeoutOutput, timeoutDiagnostics: afterTimeout.value } : {}),
        error: error || undefined,
      });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out.push(d); all.push(d); if (timedOut) afterTimeout.push(d); });
    child.stderr.on('data', (d) => { err.push(d); all.push(d); if (timedOut) afterTimeout.push(d); });
    child.on('error', (e) => { spawnError = e; finish(); });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      // The command is done; processes it left behind hold the pipes, so stop them now. After a
      // timeout they are still inside their grace period and the hard kill below handles them.
      if (timedOut) return;
      if (!win) killTree(child, 'SIGKILL');
      timers.push(setTimeout(finish, DRAIN_MS));
    });
    child.on('close', (code, signal) => {
      exit = exit || { code, signal };
      finish();
    });
    if (opts.timeout > 0) {
      timers.push(setTimeout(() => {
        timedOut = true;
        timeoutOutput = all.value;
        killTree(child, 'SIGTERM');
        timers.push(setTimeout(() => {
          killTree(child, 'SIGKILL');
          timers.push(setTimeout(finish, DRAIN_MS));
        }, TERM_GRACE_MS));
      }, opts.timeout));
    }
  });
}

function normalize(r) {
  const res = r || {};
  const error = res.error || null;
  return {
    ok: !error && res.status === 0,
    status: res.status === undefined ? null : res.status,
    signal: res.signal || null,
    stdout: res.stdout == null ? '' : String(res.stdout),
    stderr: res.stderr == null ? '' : String(res.stderr),
    output: res.output == null ? null : String(res.output),
    timeoutOutput: res.timeoutOutput == null ? null : String(res.timeoutOutput),
    timeoutDiagnostics: res.timeoutDiagnostics == null ? null : String(res.timeoutDiagnostics),
    error,
    timedOut: Boolean(error && error.code === 'ETIMEDOUT'),
    missing: Boolean(error && error.code === 'ENOENT'),
  };
}

// How a finished command ended, in words.
function how(r) {
  if (r.timedOut) return 'timed out';
  if (r.missing) return 'not found on PATH';
  if (r.error) return r.error.message;
  if (r.status === null && r.signal) return `killed by ${r.signal}`;
  return `exit ${r.status}`;
}

function errText(r, n = 5) {
  return tailLines(r.stderr.trim() || r.stdout.trim(), n);
}

async function exec(ctx, cmd, args, opts) {
  assertUnlocked(cmd);
  const run = ctx.exec || spawnSyncExec;
  return normalize(await run(cmd, args, { encoding: 'utf8', maxBuffer: Infinity, ...opts }));
}

// A shell command line with a timeout; the default runner stops the whole process tree.
async function shell(ctx, command, opts = {}) {
  const run = ctx.exec || treeExec;
  return normalize(await run(command, [], { encoding: 'utf8', shell: true, ...opts }));
}

function git(ctx, cwd, args, opts) {
  return exec(ctx, 'git', ['-C', cwd, ...args], opts);
}

// gh must never wait on a prompt: gates run unattended.
function gh(ctx, args) {
  return exec(ctx, 'gh', args, { cwd: ctx.root, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } });
}

function ghFailure(r, what) {
  if (r.missing) return 'gh not found on PATH; install the GitHub CLI and run gh auth login';
  return `${what} failed: ${errText(r)}`;
}

async function resolveCommit(ctx, cwd, rev) {
  const r = await git(ctx, cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return r.ok ? r.stdout.trim() : null;
}

// The merge base of `sha` with the base branch. A stale local branch would count commits the
// task only inherited as its change, so `origin/<base>` is also tried and the merge base
// nearest to `sha` wins.
async function mergeBase(ctx, cwd, base, sha) {
  const refs = base.startsWith('origin/') ? [base] : [base, `origin/${base}`];
  let best = null;
  for (const ref of refs) {
    const r = await git(ctx, cwd, ['merge-base', ref, sha]);
    if (!r.ok) continue;
    const mb = r.stdout.trim();
    if (!best) {
      best = { ref, sha: mb };
    } else if (mb !== best.sha && (await git(ctx, cwd, ['merge-base', '--is-ancestor', best.sha, mb])).ok) {
      best = { ref, sha: mb };
    }
  }
  return best;
}


// Runs fn(dir, env) in a detached worktree at `sha` under TOWER_CRANE_TMP (or the system temp dir)
// and removes the worktree afterwards whatever happens. env points TMPDIR, TMP and TEMP at a
// directory beside the worktree, so the gate's commands and their test helpers keep scratch
// there, and that directory goes with the worktree. Returns fn's result, or a failed gate result
// when the worktree cannot be created.
async function withWorktree(ctx, root, sha, fn) {
  const tmp = process.env.TOWER_CRANE_TMP || os.tmpdir();
  let parent;
  try {
    fs.mkdirSync(tmp, { recursive: true });
    parent = fs.mkdtempSync(path.join(tmp, 'tower-crane-'));
    fs.mkdirSync(path.join(parent, 'tmp'));
  } catch (e) {
    // The scratch directory can fail after the parent exists, and nothing else removes that parent.
    if (parent) removeTree(ctx, parent);
    return fail(`cannot create a temporary directory under ${tmp}: ${e.message}; set TOWER_CRANE_TMP to a writable directory`);
  }
  const dir = path.join(parent, 'wt');
  const scratch = path.join(parent, 'tmp');
  const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
  try {
    const pruned = await git(ctx, root, ['worktree', 'prune']);
    if (!pruned.ok) return fail(`could not prune worktree registrations: ${errText(pruned)}`);
    // The post-checkout hook runs during add, so it gets the same scratch environment as the gate.
    const add = await git(ctx, root, ['worktree', 'add', '--detach', dir, sha], { env });
    if (!add.ok) {
      return fail(`could not create a worktree at ${short(sha)}: ${errText(add)}. Check that ${root} is the repository, the commit exists, and its post-checkout hook passes.`);
    }
    return await fn(dir, env);
  } finally {
    // A failed add can still have registered the worktree (a post-checkout hook that exits
    // non-zero does), so removal runs either way and prune clears a registration left behind.
    await git(ctx, root, ['worktree', 'remove', '--force', dir]);
    removeTree(ctx, parent);
    // A sandbox can recreate empty admin mount points even after removal succeeds.
    await git(ctx, root, ['worktree', 'prune']);
  }
}

function removeTree(ctx, dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    if (ctx.log) ctx.log(`could not delete ${dir}: ${e.message}`);
  }
}

function listSome(items, n = 10) {
  if (items.length <= n) return items.join(', ');
  return `${items.slice(0, n).join(', ')} and ${items.length - n} more`;
}

module.exports = {
  fail,
  short,
  sameSha,
  tailLines,
  createRedactor,
  secretValue,
  shellQuote,
  treeExec,
  how,
  errText,
  exec,
  shell,
  git,
  gh,
  ghFailure,
  resolveCommit,
  mergeBase,
  withWorktree,
  listSome,
};
