'use strict';
// Plumbing shared by the gates: running commands (replaceable through ctx.exec), git and gh
// helpers, the merge base a task is measured against, and temporary worktrees at one commit.
const { spawn, spawnSync, assertUnlocked, confirmLocation } = require('../commands');
const { clearPlaceholders } = require('../git-placeholders');
const { strays, withoutRunMarks } = require('../processes');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// After SIGTERM a test runner gets this long to remove its own temp files before SIGKILL.
const TERM_GRACE_MS = 5000;
// Once the command has exited its pipes drain in milliseconds; a process that left the
// process group (a daemon) can hold them open forever, so stop waiting after this.
const DRAIN_MS = 2000;
// Timers fire within milliseconds of their due time. One this late means the caller blocked the
// event loop (a synchronous child process), so the child's exit and output could not be seen.
const LATE_MS = 1000;

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

// Stands in for a line longer than a tail keeps. Any piece of such a line could begin or end inside
// a secret, which the redactor would no longer recognize, so none of it is kept.
const OMITTED = '[overlong line omitted]';

// The last `keep` characters of text, starting at a line: a cut through a line could leave half a
// secret at the front. When the window lies inside one line, that line is omitted.
function keepTail(text, keep) {
  if (text.length <= keep) return text;
  const from = text.length - keep;
  if (text[from - 1] === '\n') return text.slice(from);
  const start = text.indexOf('\n', from) + 1;
  if (start > 0 && start < text.length) return text.slice(start);
  return text.endsWith('\n') ? `${OMITTED}\n` : OMITTED;
}

// Keeps the last `keep` characters of a stream so a chatty test suite cannot exhaust memory.
// After an overlong line is omitted, the rest of that line is dropped up to its newline.
function tailBuffer(keep) {
  let text = '';
  let skipping = false;
  return {
    push(chunk) {
      if (skipping) {
        const nl = chunk.indexOf('\n');
        if (nl < 0) return;
        skipping = false;
        text += '\n';
        chunk = chunk.slice(nl + 1);
      }
      text += chunk;
      if (text.length > keep * 2) {
        text = keepTail(text, keep);
        skipping = text === OMITTED;
      }
    },
    get value() {
      return keepTail(text, keep);
    },
  };
}

// Joins a command's stdout and stderr by whole lines. Each stream is held until its newline, so a
// chunk of one stream never lands inside a line of the other: a child that block-buffers stdout
// flushes it mid-line, and a stderr line joined there would cut a secret in two halves that the
// redactor sees apart. Lines keep their order within a stream; across the streams they appear in
// the order their newlines arrived. A shared pipe would keep the order of the writes but join the
// streams mid-line wherever the child flushes mid-line. A line that outgrows twice `keep` is
// dropped up to its newline and replaced by OMITTED. `flush()` ends the unfinished lines at close,
// one line each.
function lineJoiner(push, keep) {
  const parts = { out: '', err: '' };
  const skipping = { out: false, err: false };
  return {
    push(stream, chunk) {
      let text = chunk;
      if (skipping[stream]) {
        const nl = text.indexOf('\n');
        if (nl < 0) return;
        skipping[stream] = false;
        push(`${OMITTED}\n`);
        text = text.slice(nl + 1);
      }
      // Only the new chunk is searched: searching what is held again on every chunk would make a
      // long line quadratic.
      const end = text.lastIndexOf('\n') + 1;
      if (end) {
        push(parts[stream] + text.slice(0, end));
        parts[stream] = text.slice(end);
      } else {
        parts[stream] += text;
      }
      if (parts[stream].length > keep * 2) {
        parts[stream] = '';
        skipping[stream] = true;
      }
    },
    flush() {
      const rest = ['out', 'err'].map((stream) => (skipping[stream] ? OMITTED : parts[stream])).filter(Boolean).join('\n');
      parts.out = parts.err = '';
      skipping.out = skipping.err = false;
      if (rest) push(rest);
    },
  };
}

function killTree(child, signal, mark) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  const others = strays(child.pid, mark);
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
  for (const pid of others) {
    try { process.kill(pid, signal); } catch { /* Already gone. */ }
  }
}

function spawnCommand(cmd, args, opts) {
  if (process.platform === 'win32' && !opts.shell) {
    const env = opts.env || process.env;
    const dirs = /[\\/]/.test(cmd) ? [''] : String(env.PATH || env.Path || '').split(path.delimiter);
    const extensions = path.extname(cmd) ? [''] : (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';');
    for (const dir of dirs) {
      for (const ext of extensions) {
        const file = dir ? path.join(dir, cmd + ext) : cmd + ext;
        try { if (!fs.statSync(file).isFile()) continue; }
        catch { continue; }
        if (/\.(cmd|bat)$/i.test(file)) {
          const quoted = [file, ...args].map((arg) => `"${String(arg).replace(/"/g, '""')}"`).join(' ');
          return { cmd: env.ComSpec || env.COMSPEC || 'cmd.exe',
            args: ['/d', '/s', '/c', `"${quoted}"`], windowsVerbatimArguments: true };
        }
        return { cmd: file, args };
      }
    }
  }
  return { cmd, args };
}

// Same contract as spawnSync ({status, signal, stdout, stderr, error}; error.code ETIMEDOUT on
// timeout), plus `output`: stdout and stderr joined by whole lines (lineJoiner). spawnSync kills only
// the shell on timeout and leaves the test runner it started running, so the command gets its
// own process group here and the whole group is stopped on timeout and after exit.
function treeExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const aborted = () => Object.assign(new Error('gate command interrupted'), { code: 'ABORT_ERR' });
    if (opts.signal?.aborted) {
      resolve({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', output: '', error: aborted() });
      return;
    }
    const win = process.platform === 'win32';
    const keep = opts.keep || Infinity;
    const out = tailBuffer(keep);
    const err = tailBuffer(keep);
    const all = tailBuffer(keep);
    const afterTimeout = tailBuffer(keep);
    const lines = lineJoiner((text) => { all.push(text); if (timedOut) afterTimeout.push(text); }, keep);
    let child;
    const mark = win ? null : `TOWERCRANE_GATE_RUN_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
    try {
      assertUnlocked(cmd);
      const command = spawnCommand(cmd, args || [], opts);
      child = spawn(command.cmd, command.args, {
        cwd: opts.cwd,
        env: mark ? { ...withoutRunMarks(opts.env || process.env), [mark]: '1' } : opts.env,
        shell: opts.shell,
        detached: !win,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: command.windowsVerbatimArguments,
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
      opts.signal?.removeEventListener('abort', interrupt);
      // Whatever the command left running in its group would outlive the worktree it runs in.
      if (!win && child.pid) killTree(child, 'SIGKILL', mark);
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin?.destroy();
      lines.flush();
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
    const interrupt = () => {
      spawnError = aborted();
      killTree(child, 'SIGKILL', mark);
      timers.push(setTimeout(finish, DRAIN_MS));
    };
    opts.signal?.addEventListener('abort', interrupt, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let activity = 0;
    child.stdout.on('data', (d) => { activity++; out.push(d); lines.push('out', d); });
    child.stderr.on('data', (d) => { activity++; err.push(d); lines.push('err', d); });
    child.on('error', (e) => { spawnError = e; finish(); });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      // The command is done; processes it left behind hold the pipes, so stop them now. After a
      // timeout they are still inside their grace period and the hard kill below handles them.
      if (timedOut) return;
      if (!win) killTree(child, 'SIGKILL', mark);
      timers.push(setTimeout(finish, DRAIN_MS));
    });
    child.on('close', (code, signal) => {
      exit = exit || { code, signal };
      finish();
    });
    if (child.stdin) {
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') { spawnError = error; finish(); }
      });
      child.stdin.end(opts.input);
    }
    const expire = () => {
      timedOut = true;
      // Whole lines only: the rest of an unfinished line can arrive during the grace period, and
      // its first half alone could be part of a secret the redactor no longer recognizes.
      timeoutOutput = all.value;
      killTree(child, 'SIGTERM', mark);
      timers.push(setTimeout(() => {
        killTree(child, 'SIGKILL', mark);
        timers.push(setTimeout(finish, DRAIN_MS));
      }, TERM_GRACE_MS));
    };
    const arm = () => {
      const due = Date.now() + opts.timeout;
      timers.push(setTimeout(() => {
        const late = Date.now() - due > LATE_MS;
        const seen = activity;
        // The timers phase runs before the poll phase that delivers the child's exit and output.
        // One immediate lets them arrive. A child that exited is not timed out, and after a
        // blocked loop a child that wrote meanwhile was waiting on its full pipe, so its window
        // starts again; a child with nothing to show is stopped.
        setImmediate(() => {
          if (done || exit) return;
          if (late && activity !== seen) arm();
          else expire();
        });
      }, opts.timeout));
    };
    if (opts.timeout > 0) arm();
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

// A command killed by a signal failed in its runner, not in the code under test. A shell reports
// the signal as exit 128 plus its number, so both forms count.
function killed(r) {
  return !!r.signal || (Number.isInteger(r.status) && r.status > 128 && r.status <= 192);
}

// A command that is not installed: a shell's 127, cmd.exe's 9009 or its diagnostic with exit 1, or a spawn that found no file.
// The pinned command is then wrong, not the change under test.
function notFound(r) {
  const output = r.output ?? [r.stdout, r.stderr].filter(Boolean).join('\n');
  return !!r.missing || [127, 9009].includes(r.status)
    || (r.status === 1 && /^'[^'\r\n]+' is not recognized as an internal or external command,\r?\noperable program or batch file\.\s*$/i.test(output.trim()));
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
  const run = ctx.exec || (ctx.signal ? treeExec : spawnSyncExec);
  return normalize(await run(cmd, args, { encoding: 'utf8', maxBuffer: Infinity, ...opts,
    signal: opts?.cleanup && ctx.signal?.aborted ? undefined : ctx.signal || opts?.signal }));
}

// A shell command line with a timeout; the default runner stops the whole process tree.
async function shell(ctx, command, opts = {}) {
  const run = ctx.exec || treeExec;
  return normalize(await run(command, [], { encoding: 'utf8', shell: true, ...opts,
    signal: opts.cleanup && ctx.signal?.aborted ? undefined : ctx.signal || opts.signal }));
}

function git(ctx, cwd, args, opts) {
  return exec(ctx, 'git', ['-C', cwd, ...args], opts);
}

// gh must never wait on a prompt: gates run unattended.
function gh(ctx, args) {
  return exec(ctx, 'gh', args, { cwd: ctx.root, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', ...ctx.ghEnv } });
}

function ghFailure(r, what) {
  const details = [`status=${r.status}`, `signal=${r.signal}`];
  if (r.error) details.push(`${r.error.code || 'error'}: ${r.error.message}`);
  const diagnostic = `(${details.join(', ')})`;
  if (r.missing) return `gh not found on PATH; install the GitHub CLI and run gh auth login ${diagnostic}`;
  // A timed-out read may have printed part of its answer; that text is not the failure.
  if (r.timedOut) return `${what} failed: ${r.error.message} ${diagnostic}`;
  return `${what} failed: ${errText(r) || 'no output'} ${diagnostic}`;
}

async function resolveCommit(ctx, cwd, rev) {
  const r = await git(ctx, cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return r.ok ? r.stdout.trim() : null;
}

// A commit of a merged tree with the base and the head as parents, for a gate to check out
// clean: HEAD at the head with the merge in the index makes git status dirty. A fixed identity
// and the newer parent's commit time make the same base and head give the same commit. No ref
// names it; it leaves with the next gc.
const MERGE_IDENTITY = { name: 'Tower Crane', email: 'tower-crane@localhost' };

// --no-show-signature: log.showSignature would print each signed commit's verification before its time.
async function mergeCommit(ctx, root, { base, head, tree }) {
  const times = await git(ctx, root, ['show', '-s', '--no-show-signature', '--format=%ct', base, head]);
  const seconds = times.ok ? Math.max(...times.stdout.trim().split('\n').map(Number)) : NaN;
  if (!Number.isSafeInteger(seconds)) return { error: `cannot read the commit times of ${short(base)} and ${short(head)}: ${errText(times)}` };
  const date = `@${seconds} +0000`;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: MERGE_IDENTITY.name, GIT_AUTHOR_EMAIL: MERGE_IDENTITY.email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: MERGE_IDENTITY.name, GIT_COMMITTER_EMAIL: MERGE_IDENTITY.email, GIT_COMMITTER_DATE: date,
  };
  const r = await git(ctx, root, ['commit-tree', '--no-gpg-sign', tree, '-p', base, '-p', head, '-m', `Merge ${head} into ${base}`], { env });
  const sha = r.ok ? r.stdout.trim() : '';
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return { error: `cannot commit the merged tree: ${errText(r)}` };
  return { sha };
}

// The merge base of `sha` with the base branch. A stale local branch would count commits the
// task only inherited as its change, so `origin/<base>` is also tried and the merge base
// nearest to `sha` wins.
async function mergeBase(ctx, cwd, base, sha, task) {
  if (task?.hotfix) {
    const parent = await resolveCommit(ctx, cwd, `${sha}^1`);
    return parent === task.hotfix.base_sha && sha === task.hotfix.merge_sha ? { ref: 'hotfix first parent', sha: parent } : null;
  }
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

// The newest commit of the base branch, local or origin: a stale local branch would miss a failure that
// origin already has.
async function baseTip(ctx, cwd, base) {
  const refs = base.startsWith('origin/') ? [base] : [base, `origin/${base}`];
  let best = null;
  for (const ref of refs) {
    const sha = await resolveCommit(ctx, cwd, ref);
    if (sha && (!best || (await git(ctx, cwd, ['merge-base', '--is-ancestor', best, sha])).ok)) best = sha;
  }
  return best;
}


// Git keeps each worktree's bookkeeping in one administrative directory and does not serialize
// add, remove and prune across processes: a prune can delete an add's directory before the add
// writes it. Gates that share a repository would then fail at random, so those calls take the
// repository's worktree lock, the one task worktree creation, relink, prune and removal take
// (lib/worktree.js underWorktreeLock, which says where it lives and why). The gate itself runs
// outside it. The wait matches the state lock's.
const WORKTREE_LOCK_MS = 60000;

// Runs fn under the repository's worktree lock, in the state directory ctx names. A lock whose
// holder died is cleared by its marker; a live holder that keeps it past the wait gives a failed
// result that names the directory. The marker is touched while fn runs, since git worktree add
// with its post-checkout hook, or a forced remove of a large tree, can outlast the 60 s after
// which a waiter on another host or in another pid namespace takes an untouched one over. The
// timer fires only while git runs asynchronously; a synchronous exec blocks it.
const LOCK_REFRESH_MS = 10000;

async function underWorktreeLock(ctx, root, fn) {
  const W = require('../worktree');
  const S = require('../state');
  const common = await git(ctx, root, ['rev-parse', '--git-common-dir'], { cleanup: true });
  if (!common.ok) return fail(`could not find the git directory of ${root}: ${errText(common)}`);
  try { confirmLocation(root, process.env, { common: common.stdout }); } catch (e) { return fail(e.message); }
  const commonDir = path.resolve(root, common.stdout.trim());
  const where = W.lockPath({ root, commonDir, stateDir: ctx.stateDir });
  const deadline = Date.now() + WORKTREE_LOCK_MS;
  let lock;
  for (;;) {
    try {
      lock = W.tryWorktreeLock(where);
    } catch (e) {
      return fail(e.message);
    }
    if (lock) break;
    if (Date.now() > deadline) return fail(`another worktree operation holds ${where}; if no gate is running, remove that directory`);
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 40)));
  }
  let legacy = null;
  const refresh = setInterval(() => S.refreshMarkedLock(lock), LOCK_REFRESH_MS);
  refresh.unref();
  try {
    legacy = W.legacyHold(commonDir);
    return await fn();
  } finally {
    clearInterval(refresh);
    W.releaseWorktreeLock(lock, legacy);
  }
}

// Runs fn(dir, env) in a detached worktree at `sha` under the gate temporary root (lib/gate-tmp.js:
// TOWER_CRANE_TMP, then the project's gates.tmp_root, then tc/g under the user cache) and removes the
// worktree afterwards whatever happens. env points TMPDIR, TMP and TEMP at a directory beside the
// worktree, so the gate's commands and their test helpers keep scratch there, and that directory
// goes with the worktree. Returns fn's result, or a failed gate result when the worktree cannot be
// created.
async function withWorktree(ctx, root, sha, fn) {
  const gateTmp = require('../gate-tmp');
  const tmp = gateTmp.root(ctx.project, ctx.tmpEnv);
  let parent;
  try {
    fs.mkdirSync(tmp, { recursive: true });
    sweepStale(ctx, tmp);
    parent = fs.mkdtempSync(path.join(tmp, gateTmp.GATE_PREFIX));
    fs.writeFileSync(path.join(parent, OWNER_FILE), `${JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now() })}\n`);
    fs.mkdirSync(path.join(parent, 'tmp'));
  } catch (e) {
    // The scratch directory can fail after the parent exists, and nothing else removes that parent.
    if (parent) removeTree(ctx, parent);
    return fail(`cannot create a temporary directory under ${tmp}: ${e.message}; set TOWER_CRANE_TMP or gates.tmp_root to a writable directory`);
  }
  const dir = path.join(parent, 'wt');
  const scratch = path.join(parent, 'tmp');
  const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
  // A root the caller's environment does not override is not overridden for the gate's commands either.
  if (ctx.tmpEnv && !ctx.tmpEnv.TOWER_CRANE_TMP) delete env.TOWER_CRANE_TMP;
  // The gate stops every process its command started, and a `git gc --auto` that detached would
  // be killed mid-write in the repository's object store. Appended after any entries already set.
  const count = Number.parseInt(env.GIT_CONFIG_COUNT, 10) || 0;
  Object.assign(env, { GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: 'gc.autoDetach', [`GIT_CONFIG_VALUE_${count}`]: 'false' });
  // A caller's compile cache is an absolute path in the caller's temp root, which TMPDIR does not move.
  if (env.NODE_COMPILE_CACHE) env.NODE_COMPILE_CACHE = path.join(scratch, 'node-compile-cache');
  const gitDir = path.join(root, '.git');
  // A relocated task worktree's admin directory is joined to it again before
  // prune, which would empty one a project move left pointing at the old
  // place (lib/worktree.js relinkAdmins).
  const relink = () => { if (fs.statSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) require('../worktree').relinkAdmins(root, gitDir, { locked: true }); };
  try {
    // Read from the path, not with git: a git call here would be recorded in the gate's
    // receipt, and the review packet quotes the receipt's commands.
    if (fs.statSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) clearPlaceholders(gitDir);
    const added = await underWorktreeLock(ctx, root, async () => {
      try { relink(); } catch (e) { return fail(`could not relink task worktrees: ${e.message}`); }
      const pruned = await git(ctx, root, ['worktree', 'prune']);
      if (!pruned.ok) return fail(`could not prune worktree registrations: ${errText(pruned)}`);
      // The post-checkout hook runs during add, so it gets the same scratch environment as the gate.
      const add = await git(ctx, root, ['worktree', 'add', '--detach', dir, sha], { env });
      if (!add.ok) {
        return fail(`could not create a worktree at ${short(sha)}: ${errText(add)}. Check that ${root} is the repository, the commit exists, and its post-checkout hook passes.`);
      }
      return null;
    });
    if (added) return added;
    return await fn(dir, env);
  } finally {
    // A failed add can still have registered the worktree (a post-checkout hook that exits
    // non-zero does), so removal runs either way and prune clears a registration left behind.
    const removed = await underWorktreeLock(ctx, root, async () => {
      const remove = () => git(ctx, root, ['worktree', 'remove', '--force', dir], { cleanup: true });
      const result = await remove();
      if (!result.ok && ctx.signal?.aborted) await remove();
      // A sandbox can recreate empty admin mount points even after removal succeeds.
      try { relink(); } catch { /* the next preparation reports it */ }
      await git(ctx, root, ['worktree', 'prune'], { cleanup: true });
    });
    if (removed?.ok === false && ctx.log) ctx.log(removed.summary);
    removeTree(ctx, parent);
  }
}

// Each gate directory names the process that made it. A gate that was killed, or a host that
// crashed, leaves its directory behind, and unlike /tmp the default root under the user's cache
// is not emptied at boot.
const OWNER_FILE = 'owner.json';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: a process of another user holds the pid, so it is not known to be gone.
    return e.code === 'EPERM';
  }
}

// The longest single command budget the project allows: a gate's directory lives at least this
// long, so a younger one is never taken for stale even when its pid was reused.
function gateBudgetMs(project) {
  const timeouts = require('../gate-timeouts');
  const minutes = Math.max(timeouts.minutes(project || {}, 'tests'), timeouts.minutes(project || {}, 'clean'));
  const local = project?.ci?.local;
  const seconds = [local?.timeout, ...Object.values(local?.by_kind || {}).map((o) => o?.timeout)].filter(Number.isFinite);
  return Math.max(minutes * 60000, ...seconds.map((s) => s * 1000));
}

// Removes gate directories in root whose owner process on this host is gone and which are older
// than the project's longest gate budget. A directory without an owner file was made by an older
// Tower Crane that may still be running a gate there, so it is left alone. The repository's
// registration of a removed worktree goes with the next worktree prune.
function sweepStale(ctx, root) {
  const prefix = require('../gate-tmp').GATE_PREFIX;
  const budget = gateBudgetMs(ctx.project);
  let names;
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const dir = path.join(root, name);
    let owner;
    try { owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')); } catch { continue; }
    if (!Number.isInteger(owner?.pid) || owner.host !== os.hostname() || !Number.isFinite(owner.started)) continue;
    if (Date.now() - owner.started <= budget || owner.pid === process.pid || alive(owner.pid)) continue;
    removeTree(ctx, dir);
    if (ctx.log) ctx.log(`removed stale gate directory ${dir} (owner ${owner.pid} is gone)`);
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
  killed,
  notFound,
  sameSha,
  tailLines,
  keepTail,
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
  mergeCommit,
  mergeBase,
  baseTip,
  withWorktree,
  sweepStale,
  removeTree,
  listSome,
};
