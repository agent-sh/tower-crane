'use strict';
// A child that a native fault ended (a Node or V8 crash, not a JavaScript error) exits by signal
// and prints nothing. No change to the code under test explains that, so the tests gate reruns a
// failure made only of such crashes once (docs/state.md#native-crashes).
const fs = require('node:fs');
const path = require('node:path');

const SIGNALS = new Set(['SIGSEGV', 'SIGBUS', 'SIGILL']);
const DAYS = 7;
// apport writes crash reports of unpackaged binaries here once `unpackaged=true` is set.
const CRASH_DIR = '/var/crash';

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

// The native crashes the failing tests' errors show, and whether every failing test shows one.
// A failure with any other cause keeps its verdict, so only `every` allows a rerun.
function find(output, names) {
  const lines = String(output || '').split(/\r?\n/);
  const crashes = [];
  const seen = new Set();
  let every = names.length > 0;
  for (const test of names) {
    const own = blocks(lines, test).flatMap((block) => [...objectCrashes(block), ...lineCrashes(block)]);
    // One crash a reporter printed twice, or as a line and an object, is one entry; a pid tells two apart.
    const withPid = new Set(own.filter((c) => c.pid != null).map((c) => c.signal));
    const kept = own.filter((c) => c.pid != null || !withPid.has(c.signal));
    let mine = 0;
    for (const crash of kept) {
      const key = `${test}\0${crash.signal}\0${crash.pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      crashes.push({ test, ...crash });
      mine++;
    }
    if (!mine) every = false;
  }
  return { crashes, every };
}

// The newest node crash report written at or after `since` (ms), or null. A report names the
// crashed executable's path with `/` as `_`, so nvm's node writes `_home_..._bin_node.UID.crash`.
function crashFile(dir, since) {
  if (!dir) return null;
  let newest = null;
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  for (const name of entries) {
    if (!/node/i.test(name) || !name.endsWith('.crash')) continue;
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.mtimeMs >= since && (!newest || stat.mtimeMs > newest.mtimeMs)) newest = { file, mtimeMs: stat.mtimeMs };
  }
  return newest?.file ?? null;
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

module.exports = { find, crashFile, recent, SIGNALS, DAYS, CRASH_DIR };
