'use strict';
// A child that a native fault ended (a Node or V8 crash, not a JavaScript error) exits by signal
// and prints nothing. No change to the code under test explains that, so the tests gate reruns a
// failure made only of such crashes once and reads the crashed child's core when apport kept one
// (docs/state.md#native-crashes).
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SIGNALS = new Set(['SIGSEGV', 'SIGBUS', 'SIGILL']);
const DAYS = 7;
// apport, Ubuntu's core_pattern, drops the crash report of a binary no package owns, such as nvm's
// node, but writes its core here when the crashed process's RLIMIT_CORE allows it, named
// core.<executable path with / and . as _>.<uid>.<boot id>.<pid>.<time>. The directory is
// root's, so its owner can read, chmod and empty a core but not remove it.
const COREDUMP_DIR = '/var/lib/apport/coredump';
// The frames kept from a backtrace, as many as the gate keeps of a failing output's tail.
const FRAMES = 40;

const indent = (line) => /^\s*/.exec(line)[0].length;
const EMPTY = /^(?:''|""|``|null|undefined|<Buffer\s*>)$/;

function headerName(line) {
  const spec = /^\s*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(line);
  if (spec) return spec[1];
  return /^\s*not ok(?:\s+\d+)?(?:\s+-\s*|\s+)(.+?)\s*$/.exec(line)?.[1] ?? null;
}

// The error lines a reporter printed under one failing test, from each place it printed the test.
function blocks(lines, name) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (headerName(lines[i]) !== name) continue;
    const base = indent(lines[i]);
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() && indent(line) <= base) break;
      block.push(line);
    }
    found.push(block);
  }
  return found;
}

// The failing tests streamed inside each failing suite or parent test. Spec opens a parent with
// `▶ name` and TAP with `# Subtest: name`; the parent's own failure line closes it.
function failingChildren(lines, names) {
  const wanted = new Set(names);
  const children = new Map();
  const scopes = [];
  for (const line of lines) {
    // Spec's summary repeats the failures without their nesting.
    if (/^\s*✖\s+failing tests:\s*$/.test(line)) break;
    const at = indent(line);
    const name = headerName(line);
    const open = name == null && /^\s*(?:▶|# Subtest:)\s+(.+?)\s*$/.exec(line);
    const passed = /^\s*(?:✔|﹣|ok(?:\s+\d+)?\s)/.test(line);
    if (name == null && !open && !passed) continue;
    if (name != null && wanted.has(name)) {
      for (const scope of scopes) {
        if (scope.indent >= at || scope.name === name) continue;
        if (!children.has(scope.name)) children.set(scope.name, new Set());
        children.get(scope.name).add(name);
      }
    }
    while (scopes.length && scopes.at(-1).indent >= at) scopes.pop();
    if (open) scopes.push({ name: open[1], indent: at });
  }
  return children;
}

// A parent that failed only because a test inside it failed prints no error of its own: spec
// leaves its line bare and TAP gives it failureType 'subtestsFailed'. A hook or the parent's own
// code failing prints that error, so the parent stays a failure of its own.
const aggregate = (block) => block.every((line) => !line.trim())
  || block.some((line) => /^\s*failureType:\s*'subtestsFailed'\s*$/.test(line));

// A child_process error or result object as util.inspect prints it: one property per line at one
// indent. The child is a native crash when its signal is one of SIGNALS and each output property
// it shows is empty.
function objectCrashes(block) {
  const crashes = [];
  for (let i = 0; i < block.length; i++) {
    const signal = /^\s*signal: '(SIG[A-Z]+)',?\s*$/.exec(block[i]);
    if (!signal || !SIGNALS.has(signal[1])) continue;
    const at = indent(block[i]);
    let start = i;
    while (start > 0 && block[start - 1].trim() && indent(block[start - 1]) >= at) start--;
    let end = i;
    while (end + 1 < block.length && block[end + 1].trim() && indent(block[end + 1]) >= at) end++;
    const props = new Map();
    for (const line of block.slice(start, end + 1)) {
      if (indent(line) !== at) continue;
      const prop = /^\s*([a-z]+): (.*?),?\s*$/.exec(line);
      if (prop) props.set(prop[1], prop[2]);
    }
    const streams = ['stdout', 'stderr'].filter((key) => props.has(key));
    if (!streams.length || !streams.every((key) => EMPTY.test(props.get(key)))) continue;
    const output = props.get('output');
    if (output != null && !/^\[\s*(?:(?:''|null|<Buffer\s*>)\s*,?\s*)*\]$/.test(output)) continue;
    const pid = /^\d+$/.test(props.get('pid') || '') ? Number(props.get('pid')) : null;
    crashes.push({ signal: signal[1], pid });
  }
  return crashes;
}

// A message that names the signal and ends where the child's output would follow, such as
// `tower-crane task add exited null (signal SIGSEGV): `, carries no output. TAP quotes the message.
function lineCrashes(block) {
  const crashes = [];
  for (const line of block) {
    const m = /\bsignal:? '?(SIG[A-Z]+)'?\)?:\s*['"`]?\s*$/.exec(line);
    if (m && SIGNALS.has(m[1])) crashes.push({ signal: m[1], pid: null });
  }
  return crashes;
}

// The native crashes the failing tests' errors show, and whether every failing test shows one or
// is a parent that failed only through failing tests inside it. A failure with any other cause
// keeps its verdict, so only `every` allows a rerun.
function find(output, names) {
  const lines = String(output || '').split(/\r?\n/);
  const children = failingChildren(lines, names);
  const crashes = [];
  const seen = new Set();
  let every = names.length > 0;
  for (const test of names) {
    const own = blocks(lines, test);
    const found = own.flatMap((block) => [...objectCrashes(block), ...lineCrashes(block)]);
    // One crash a reporter printed twice, or as a line and an object, is one entry; a pid tells two apart.
    const withPid = new Set(found.filter((c) => c.pid != null).map((c) => c.signal));
    const kept = found.filter((c) => c.pid != null || !withPid.has(c.signal));
    let mine = 0;
    for (const crash of kept) {
      const key = `${test}\0${crash.signal}\0${crash.pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      crashes.push({ test, ...crash });
      mine++;
    }
    // Its failing children are judged on their own.
    if (!mine && !(children.get(test)?.size && own.every(aggregate))) every = false;
  }
  return { crashes, every };
}

// Where apport writes cores, or null when core_pattern does not pipe to apport: with a plain
// pattern a raised limit would leave cores in the test's working directory instead.
function coreDir(pattern) {
  if (process.platform !== 'linux') return null;
  if (pattern === undefined) {
    try { pattern = fs.readFileSync('/proc/sys/kernel/core_pattern', 'utf8'); } catch { return null; }
  }
  return /^\|\s*\S*\/apport\s/.test(pattern) ? COREDUMP_DIR : null;
}

const mangle = (file) => file.replace(/[/.]/g, '_');

// This user's cores in dir that apport wrote at or after `since` (ms).
function cores(dir, since, uid = process.getuid()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const found = [];
  for (const name of names) {
    const m = /^core\.(.+)\.(\d+)\.[0-9a-f-]+\.(\d+)\.\d+$/.exec(name);
    if (!m || Number(m[2]) !== uid) continue;
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.isFile() && stat.size > 0 && stat.mtimeMs >= since) found.push({ file, exe: m[1], pid: Number(m[3]) });
  }
  return found;
}

// A core holds the crashed process's memory, tokens included, so it does not stay in the shared
// directory: emptied in place, since only root can remove it there.
function scrub(file) {
  try {
    fs.chmodSync(file, 0o600);
    fs.truncateSync(file, 0);
  } catch {}
}

// Copies the core into keep (mode 0700) as a 0600 file, then empties the original.
function claim(core, keep) {
  fs.mkdirSync(keep, { recursive: true, mode: 0o700 });
  fs.chmodSync(keep, 0o700);
  const dest = path.join(keep, path.basename(core.file));
  fs.copyFileSync(core.file, dest, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(dest, 0o600);
  scrub(core.file);
  return dest;
}

// The crashed thread's backtrace from gdb. With the stack read the core is deleted; without one it
// stays private for a person to read, and the reason is returned instead.
function analyze(file, { exe = null, gdb = 'gdb', timeout }) {
  return new Promise((resolve) => {
    const args = ['-batch', '-nx', '-ex', 'bt', ...(exe ? [exe] : []), '-c', file];
    execFile(gdb, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout = '', stderr = '') => {
      const stack = String(stdout).split('\n').filter((line) => /^#\d+\s/.test(line)).slice(0, FRAMES).map((line) => line.trimEnd());
      if (stack.length) {
        fs.rmSync(file, { force: true });
        resolve({ stack });
        return;
      }
      const why = error?.code === 'ENOENT' ? `${gdb} is not installed`
        : String(stderr).split('\n').map((line) => line.trim()).find(Boolean) || error?.message || 'gdb printed no stack';
      resolve({ error: why });
    });
  });
}

// Pairs each core written since `since` with the crash of the same pid: claims it into keep and reads
// its stack. Every other core written since then is emptied, so no core of a gate's commands is left.
async function collect(crashes, { dir, keep, since, gdb, timeout, execPath = process.execPath }) {
  for (const core of cores(dir, since)) {
    const crash = keep && crashes.find((c) => c.pid === core.pid && !c.core_file);
    if (!crash) {
      scrub(core.file);
      continue;
    }
    try {
      crash.core_file = claim(core, keep);
    } catch (e) {
      scrub(core.file);
      crash.core_error = `could not keep the core: ${e.message}`;
      continue;
    }
    const exe = mangle(execPath) === core.exe ? execPath : null;
    const read = await analyze(crash.core_file, { exe, gdb, timeout });
    if (read.stack) crash.stack = read.stack;
    else crash.core_error = read.error;
  }
  return crashes;
}

// Native crashes the tests gate recorded in the last DAYS days, from its audit events.
function recent(events, now = Date.now()) {
  const since = now - DAYS * 24 * 60 * 60 * 1000;
  let count = 0;
  let last = null;
  for (const e of events) {
    if (e.cmd !== 'check tests' || !Array.isArray(e.detail?.native_crash)) continue;
    const at = Date.parse(e.at);
    if (!(at >= since)) continue;
    count += e.detail.native_crash.length;
    if (!last || e.at > last.at) last = { at: e.at, task: e.task };
  }
  return { days: DAYS, count, last };
}

module.exports = { find, coreDir, cores, claim, scrub, analyze, collect, recent, SIGNALS, DAYS, COREDUMP_DIR, FRAMES };
