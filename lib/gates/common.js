'use strict';
// Plumbing shared by the gates: running commands (replaceable through ctx.exec), git and gh
// helpers, the merge base a task is measured against, and temporary worktrees at one commit.
const { spawn, spawnSync, assertUnlocked, confirmLocation } = require('../commands');
const { clearPlaceholders } = require('../git-placeholders');
const { strays, withoutRunMarks, windowsKillTree } = require('../processes');
// Gate output is cleaned with the same stripper as CI logs before it is redacted.
const { stripEscapes, stripEscapesViews, redactTokenShapes, tokenSpansMerged } = require('../ci-log-text');
const { redactBinary } = require('../binary-redact');
const { textBudget, textWork } = require('../text-redaction-budget');
const TestGrants = require('../test-grants');
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
// How often the cleanup after a command looks again for what is left.
const CHECK_MS = 20;

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
  // The two characters that open and close markers, one for secrets and one for placeholders, are
  // ones neither the input nor a secret holds, so each of them in the marked text belongs to a
  // marker: input that holds the usual ones keeps them as its own text, in redact as in ranges.
  const PRIVATE = /[\uE000-\uF8FF]/g;
  const taken = new Set(ordered.flatMap(([value]) => value.match(PRIVATE) ?? []));
  const usual = { secret: '\uF000', placeholder: '\uF001', marker: /[\uF000\uF001][\uE000-\uF8FF]{2}[\uF000\uF001]/g };
  const prefixes = (input) => {
    const used = input.match(PRIVATE);
    if (!used && !taken.size) return usual;
    const seen = new Set([...taken, ...(used ?? [])]);
    const free = [];
    for (let c = 0xf000; free.length < 2 && c <= 0xf8ff; c++) if (!seen.has(String.fromCharCode(c))) free.push(String.fromCharCode(c));
    for (let c = 0xe000; free.length < 2 && c < 0xf000; c++) if (!seen.has(String.fromCharCode(c))) free.push(String.fromCharCode(c));
    if (free.length < 2) return usual;
    const [secret, placeholder] = free;
    return { secret, placeholder, marker: new RegExp(`[${secret}${placeholder}][\\uE000-\\uF8FF]{2}[${secret}${placeholder}]`, 'g') };
  };

  const redact = (input) => textBudget(String(input ?? ''), () => {
    let text = String(input ?? '');
    const prefix = prefixes(text);
    const restore = new Map();
    // One marker for each distinct placeholder: strip leaves one for every secret it redacted.
    const kept = new Map();
    text = text.replace(/\[redacted:[A-Za-z0-9_]+\]/g, (placeholder) => {
      textWork();
      let marker = kept.get(placeholder);
      if (!marker) {
        marker = privateMarker(prefix.placeholder, kept.size);
        kept.set(placeholder, marker);
        restore.set(marker, placeholder);
      }
      return marker;
    });
    let secrets = 0;
    for (const [secret, name] of ordered) {
      textWork(1 + Math.ceil(text.length / 4096));
      if (!text.includes(secret)) continue;
      const marker = privateMarker(prefix.secret, secrets++);
      // Count matches before split allocates one piece per occurrence.
      for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + secret.length)) textWork();
      text = text.split(secret).join(marker);
      restore.set(marker, `[redacted:${name}]`);
    }
    text = redactTokenShapes(text);
    // One pass for every marker: a split and join per marker made a text of many placeholders
    // quadratic (1 MiB of them took minutes).
    return restore.size ? text.replace(prefix.marker, (m) => restore.get(m) ?? m) : text;
  });
  // The spans redact replaces in input, as { a, b, label } in input's indices, in order and apart:
  // replacing each with `[redacted:label]` gives redact(input). The same steps as redact, with each
  // character of the marked text tracked back to the input. A placeholder input already holds, as
  // strip puts in, is a span of its own with its own label.
  redact.ranges = (input) => textBudget(String(input ?? ''), () => {
    const orig = String(input ?? '');
    // Every marker stands in as the same text, which the token shapes read as redact's markers.
    const { secret: p } = prefixes(orig);
    const standIn = `${p}\uE000\uE000${p}`;
    // The marked text as pieces: [text start, input start, input end, label or null]; a marker
    // piece (label set) stands for its whole input span.
    let text = orig;
    let pieces = [[0, 0, orig.length, null]];
    const mark = (re, label) => {
      const next = [];
      const parts = [];
      let from = 0;
      let length = 0;
      const plainTo = (end) => {
        if (end <= from) return;
        spansOf(from, end, (t, a, b, label) => next.push([length + t - from, a, b, label]));
        parts.push(text.slice(from, end));
        length += end - from;
      };
      for (const m of text.matchAll(re)) {
        textWork();
        plainTo(m.index);
        const [oa] = inputAt(m.index);
        const [, ob] = inputAt(m.index + m[0].length - 1);
        next.push([length, oa, ob, typeof label === 'function' ? label(m[0]) : label]);
        parts.push(standIn);
        length += 4;
        from = m.index + m[0].length;
      }
      plainTo(text.length);
      text = parts.join('');
      pieces = next;
    };
    // Pieces of the current text inside [from, end), each as visit(offset, input start, input end,
    // label): arrays for each piece held a few hundred bytes per secret in a log of many.
    const spansOf = (from, end, visit) => {
      for (let k = pieceAt(from); k < pieces.length && pieces[k][0] < end; k++) {
        const [t0, a, b, label] = pieces[k];
        const t1 = k + 1 < pieces.length ? pieces[k + 1][0] : text.length;
        if (label != null) visit(t0, a, b, label);
        else visit(Math.max(t0, from), a + Math.max(0, from - t0), a + Math.min(t1, end) - t0, null);
      }
    };
    const pieceAt = (i) => {
      let lo = 0;
      let hi = pieces.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (pieces[mid][0] <= i) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    // The input span of current character i.
    const inputAt = (i) => {
      const [t0, a, b, label] = pieces[pieceAt(i)];
      return label != null ? [a, b] : [a + i - t0, a + i - t0 + 1];
    };
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    mark(/\[redacted:[A-Za-z0-9_]+\]/g, (placeholder) => placeholder.slice(10, -1));
    for (const [secret, name] of ordered) {
      textWork(1 + Math.ceil(text.length / 4096));
      if (text.includes(secret)) mark(new RegExp(escape(secret), 'g'), name);
    }
    const out = [];
    let from = 0;
    // A marker that starts before `from` lies in the token span that ended there, which already
    // stands for all of it.
    const markers = (end) => {
      spansOf(from, end, (t, a, b, l) => {
        if (l && t >= from) out.push({ a, b, label: l });
      });
    };
    for (const [start, end, label] of tokenSpansMerged(text)) {
      markers(start);
      out.push({ a: inputAt(start)[0], b: inputAt(end - 1)[1], label });
      from = end;
    }
    markers(text.length);
    return out;
  }, () => [{ a: 0, b: String(input ?? '').length, label: 'UNSCANNABLE' }]);
  const values = ordered.map(([value]) => value);
  // The cleaned text, as { text, at }, with what either reading of its escapes redacts redacted
  // (stripEscapesViews, redactEither). Where both read the same text, so does the redactor.
  redact.stripMapped = (input) => textBudget(String(input ?? ''), () => {
    const [view, terminal] = stripEscapesViews(input, values);
    if (view.text === terminal.text) return view;
    const raw = [];
    for (const { a, b, label } of redact.ranges(terminal.text)) raw.push({ a: terminal.at(a)[0], b: terminal.at(b - 1)[1], label });
    return raw.length ? redactEither(view, redact.ranges(view.text), raw) : view;
  }, (notice, reason) => ({ text: notice, at: () => [0, String(input ?? '').length], unscannable: reason }));
  // A buffer that is not UTF-8 text, redacted at its exact byte matches, or { missed } when a
  // secret shows that those cannot remove (lib/binary-redact.js).
  redact.bytes = (buffer) => redactBinary(buffer, ordered);
  // Cleans terminal text so that a control inside one of these values cannot hide it from the
  // literal match (lib/ci-log-text.js stripEscapes), with what either reading of its escapes
  // redacts already redacted.
  redact.strip = (input) => redact.stripMapped(input).text;
  return redact;
}

// view ({ text, at }) with what the redactor finds in it (own: { a, b, label } in view indices, in
// order and apart) and the view's characters that stand for raw text in one of others ({ a, b,
// label } in raw indices) replaced by placeholders, as { text, at }, or view itself when others add
// nothing: what another reading of the same raw text redacts stays redacted. Characters a raw span
// meets that own leaves join the placeholder they touch, which keeps its label, or make their own;
// a space put in for a word boundary stands for no raw text and is left. A raw span no character
// stands for, text the other reading put back and this one left hidden, gets a placeholder between
// the characters around it.
function redactEither(view, own, others) {
  const n = view.text.length;
  // The first index from `from` on where pred holds, pred being monotone: galloping, as each
  // search starts near where the last one ended.
  const first = (from, pred) => {
    let lo = from;
    let step = 1;
    while (lo + step <= n && !pred(lo + step - 1)) {
      lo += step;
      step *= 2;
    }
    let hi = Math.min(n, lo + step - 1);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pred(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  // The raw end of own[k], and whether no character outside own[k] stands for raw text inside its
  // raw span, so that a raw span inside it meets only its characters.
  const rawEnd = (k) => view.at(own[k].b - 1)[1];
  const owns = (k, a, b) => {
    const { a: x, b: y } = own[k];
    const ra = view.at(x)[0];
    const rb = view.at(y - 1)[1];
    return ra <= a && b <= rb && (x === 0 || view.at(x - 1)[1] <= ra) && (y === n || view.at(y)[0] >= rb);
  };
  const shows = (x, y) => {
    for (let i = x; i < y; i++) {
      const [p, q] = view.at(i);
      if (p < q && (view.hasRaw?.(i) ?? true)) return true;
    }
    return false;
  };
  // What others add to own, as view spans [a, b) with a label, in order: a raw span that meets no
  // character stands at f, with a == b and its raw span ra, rb.
  const extra = [];
  // others and own are in order, so each search starts where the last one stopped.
  let k = 0;
  let f = 0;
  for (const { a, b, label } of others) {
    textWork();
    if (b <= a) continue;
    while (k < own.length && rawEnd(k) <= a) k++;
    if (k < own.length && owns(k, a, b)) continue;
    // The view characters [f, l) whose raw spans meet [a, b): at() is monotone, so they are
    // consecutive. f equals l where none does, and the span stands at f.
    f = first(f, (i) => view.at(i)[1] > a);
    let l = first(f, (i) => view.at(i)[0] >= b);
    // Where a put-back's raw span reaches past the characters after it, at() steps back: the
    // characters next to [f, l) that still meet [a, b) join it.
    const meets = (i) => {
      const [p, q] = view.at(i);
      return q > a && p < b;
    };
    while (f > 0 && meets(f - 1)) f--;
    while (l < n && meets(l)) l++;
    let j = k;
    while (j > 0 && own[j - 1].b > f) j--;
    while (j < own.length && own[j].b <= f) j++;
    if (f === l) {
      if (!(j < own.length && own[j].a < f)) extra.push({ a: f, b: f, label, ra: a, rb: b });
      continue;
    }
    // What own leaves of [f, l).
    for (let x = f; x < l; j++) {
      const o = own[j];
      const y = o && o.a < l ? Math.max(x, o.a) : l;
      if (y > x && shows(x, y)) extra.push({ a: x, b: y, label, ra: Infinity, rb: -Infinity });
      if (!o || o.a >= l) break;
      x = Math.max(x, o.b);
    }
  }
  if (!extra.length) return view;
  // A raw span that meets characters an earlier one met too can start before that one's last piece.
  for (let e = 1; e < extra.length; e++) {
    if (extra[e].a < extra[e - 1].a) {
      extra.sort((x, y) => x.a - y.a);
      break;
    }
  }
  const parts = [];
  // Per part: text start, view start or -1, raw start, raw end.
  let pieces = new Float64Array(64);
  let count = 0;
  let length = 0;
  const add = (text, o, a, b) => {
    if (count * 4 === pieces.length) {
      const grown = new Float64Array(pieces.length * 2);
      grown.set(pieces);
      pieces = grown;
    }
    const p = count++ * 4;
    pieces[p] = length;
    pieces[p + 1] = o;
    pieces[p + 2] = a;
    pieces[p + 3] = b;
    parts.push(text);
    length += text.length;
  };
  // own and extra merged by start, own first where both start at one index: spans that overlap
  // make one placeholder, and so do an extra and a span it touches. Own placeholders that touch
  // stay apart, as the redactor writes them.
  let i = 0;
  let cur = null;
  const flush = () => {
    if (cur.a > i) add(view.text.slice(i, cur.a), i, 0, 0);
    const ra = cur.a < cur.b ? Math.min(cur.ra, view.at(cur.a)[0]) : cur.ra;
    const rb = cur.a < cur.b ? Math.max(cur.rb, view.at(cur.b - 1)[1]) : cur.rb;
    add(`[redacted:${cur.label}]`, -1, ra, rb);
    i = Math.max(i, cur.b);
  };
  for (let x = 0, y = 0; x < own.length || y < extra.length;) {
    const s = y >= extra.length || (x < own.length && own[x].a <= extra[y].a) ? { ...own[x++], ra: Infinity, rb: -Infinity, extra: false } : { ...extra[y++], extra: true };
    if (cur && (s.a < cur.b || (s.a === cur.b && (s.extra || cur.extra)))) {
      cur.b = Math.max(cur.b, s.b);
      cur.ra = Math.min(cur.ra, s.ra);
      cur.rb = Math.max(cur.rb, s.rb);
      cur.extra ||= s.extra;
    } else {
      if (cur) flush();
      cur = s;
    }
  }
  flush();
  if (i < n) add(view.text.slice(i), i, 0, 0);
  return eitherView(parts.join(''), pieces, count, view);
}

// redactEither's result, made apart from it so that it keeps only its pieces and the view, not
// the spans and parts redactEither read.
function eitherView(text, pieces, count, view) {
  // The piece the last call found: calls mostly come in order.
  let hint = 0;
  const at = (t) => {
    const starts = (p) => pieces[p * 4];
    let lo = hint;
    if (!(starts(lo) <= t && (lo + 1 === count || t < starts(lo + 1)))) {
      lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts(mid) <= t) lo = mid;
        else hi = mid - 1;
      }
    }
    hint = lo;
    const o = pieces[lo * 4 + 1];
    return o < 0 ? [pieces[lo * 4 + 2], pieces[lo * 4 + 3]] : view.at(o + t - pieces[lo * 4]);
  };
  return { text, at };
}

// Terminal text cleaned for a redactor: with a createRedactor redactor, its values stay whole.
function stripFor(redact, text) {
  return typeof redact?.strip === 'function' ? redact.strip(text) : stripEscapes(text);
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
        push(`${OMITTED}\n`, stream);
        text = text.slice(nl + 1);
      }
      // Only the new chunk is searched: searching what is held again on every chunk would make a
      // long line quadratic.
      const end = text.lastIndexOf('\n') + 1;
      if (end) {
        push(parts[stream] + text.slice(0, end), stream);
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
      const rest = ['out', 'err'].map((stream) => [stream, skipping[stream] ? OMITTED : parts[stream]]).filter(([, text]) => text);
      parts.out = parts.err = '';
      skipping.out = skipping.err = false;
      rest.forEach(([stream, text], i) => push(i < rest.length - 1 ? `${text}\n` : text, stream));
    },
  };
}

// Runs of lines cut to keepTail's window of their joined text: whole runs drop from the front and
// the first kept run loses the part before the window.
function tailRuns(runs, keep) {
  const joined = runs.map((r) => r.text).join('');
  const kept = keepTail(joined, keep);
  if (kept.length === joined.length) return runs;
  if (!joined.endsWith(kept)) return [{ stream: runs.at(-1).stream, text: kept }];
  const out = runs.map((r) => ({ ...r }));
  let drop = joined.length - kept.length;
  while (drop >= out[0].text.length) drop -= out.shift().text.length;
  if (drop) out[0].text = out[0].text.slice(drop);
  return out;
}

// A tailBuffer of the joined output that also knows which stream wrote each run of lines, so the
// output can be redacted one stream at a time (redactJoined). The window is keepTail's.
function runBuffer(keep) {
  let runs = [];
  let size = 0;
  const trim = () => {
    runs = tailRuns(runs, keep);
    size = runs.reduce((n, r) => n + r.text.length, 0);
  };
  return {
    push(text, stream) {
      if (!text) return;
      const last = runs.at(-1);
      if (last?.stream === stream) last.text += text;
      else runs.push({ stream, text });
      size += text.length;
      if (size > keep * 2) trim();
    },
    get runs() {
      trim();
      return runs.map((r) => ({ ...r }));
    },
    get value() {
      trim();
      return runs.map((r) => r.text).join('');
    },
  };
}

// Two commands' output as one, `${a}\n${b}` cut to keep, with the runs of both when each has runs
// that rebuild its output.
function joinOutputs(a, b, keep) {
  const text = (r) => r.output ?? `${r.stdout}\n${r.stderr}`;
  const output = keepTail(`${text(a)}\n${text(b)}`, keep);
  const rebuilds = (r) => r.output != null && Array.isArray(r.runs) && r.runs.map((run) => run.text).join('') === r.output;
  if (!rebuilds(a) || !rebuilds(b)) return { output, runs: null };
  const runs = [...a.runs.map((run) => ({ ...run })), { stream: a.runs.at(-1)?.stream ?? b.runs[0]?.stream ?? 'out', text: '\n' }];
  for (const run of b.runs) {
    if (runs.at(-1).stream === run.stream) runs.at(-1).text += run.text;
    else runs.push({ ...run });
  }
  const cut = tailRuns(runs, keep);
  return { output, runs: cut.map((run) => run.text).join('') === output ? cut : null };
}

// Each { a, b, label } range of text replaced by its placeholder; overlapping ranges join, labeled
// by the first.
function applyRanges(text, ranges) {
  const sorted = [...ranges].sort((x, y) => x.a - y.a || y.b - x.b);
  const parts = [];
  let from = 0;
  let cur = null;
  const flush = () => {
    parts.push(text.slice(from, cur.a), `[redacted:${cur.label}]`);
    from = cur.b;
  };
  for (const { a, b, label } of sorted) {
    if (b <= a) continue;
    if (cur && a < cur.b) {
      cur.b = Math.max(cur.b, b);
      continue;
    }
    if (cur) flush();
    cur = { a, b, label };
  }
  if (cur) flush();
  parts.push(text.slice(from));
  return parts.join('');
}

// A command's joined output, cleaned and redacted. The redactor puts a secret split across lines
// back together only when those lines are adjacent, and lines of the other stream can arrive
// between two lines one stream wrote together: a token wrapped onto two stdout lines, with a
// stderr line read between them, would pass in pieces. So the joined text is redacted as it
// arrived, and each stream's own text is read for secrets too; a secret only a stream's own text
// shows is redacted where its pieces landed in the joined text, each piece on its own, and the
// newline that ends a piece's run stays. Without runs that rebuild `output` exactly (a replaced
// exec) the joined text is redacted alone.
function redactJoined(r, redact) {
  const raw = r.output != null ? r.output : [r.stdout, r.stderr].filter(Boolean).join('\n');
  return textBudget(raw, () => redactJoinedWithin(r, redact, raw));
}

function redactJoinedWithin(r, redact, raw) {
  const runs = Array.isArray(r.runs) ? r.runs : [];
  const streams = [...new Set(runs.map((run) => run.stream))];
  if (typeof redact?.ranges !== 'function' || streams.length < 2 || runs.map((run) => run.text).join('') !== raw) {
    return redact(stripFor(redact, raw));
  }
  const view = redact.stripMapped(raw);
  const own = redact.ranges(view.text);
  const n = view.text.length;
  // The view's characters that stand for raw characters in [a, b): a secret the view put back
  // whole stands for its whole raw span, so a piece inside it takes all of it.
  const first = (pred) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pred(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const toView = (a, b) => [first((i) => view.at(i)[1] > a), first((i) => view.at(i)[0] >= b)];
  // A view newline that stands for one raw CR or LF.
  const lineBreak = (i) => {
    const [p, q] = view.at(i);
    return view.text[i] === '\n' && q === p + 1 && (raw[p] === '\n' || raw[p] === '\r');
  };
  // own is in order and apart, so a piece the view already redacts lies inside one of its ranges.
  const inside = (a, b) => {
    let lo = 0;
    let hi = own.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (own[mid].a <= a) lo = mid;
      else hi = mid - 1;
    }
    return own.length > 0 && own[lo].a <= a && b <= own[lo].b;
  };
  // The raw spans of the view's ranges that no character outside the range also stands for. A
  // piece inside one maps into its range, so most pieces, the secrets the joined view found too,
  // skip the search through the view.
  const owned = [];
  for (const { a, b } of own) {
    const ra = view.at(a)[0];
    const rb = view.at(b - 1)[1];
    if ((a === 0 || view.at(a - 1)[1] <= ra) && (b === n || view.at(b)[0] >= rb)) owned.push([ra, rb]);
  }
  const ownedHas = (a, b) => {
    let lo = 0;
    let hi = owned.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (owned[mid][0] <= a) lo = mid;
      else hi = mid - 1;
    }
    return owned.length > 0 && owned[lo][0] <= a && b <= owned[lo][1];
  };
  const more = [];
  for (const stream of streams) {
    // [offset in the stream's text, offset in the joined text, length] of each of its runs.
    const offsets = [];
    let so = 0;
    let jo = 0;
    for (const run of runs) {
      if (run.stream === stream) {
        offsets.push([so, jo, run.text.length]);
        so += run.text.length;
      }
      jo += run.text.length;
    }
    const v = redact.stripMapped(runs.filter((run) => run.stream === stream).map((run) => run.text).join(''));
    for (const { a, b, label } of redact.ranges(v.text)) {
      textWork();
      const ra = v.at(a)[0];
      const rb = v.at(b - 1)[1];
      // The first run that ends after ra: offsets are in order, so the runs a range touches are
      // found without walking the runs before it.
      let lo = 0;
      let hi = offsets.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid][0] + offsets[mid][2] > ra) hi = mid;
        else lo = mid + 1;
      }
      for (let k = lo; k < offsets.length && offsets[k][0] < rb; k++) {
        const [s0, j0, len] = offsets[k];
        const x = Math.max(ra, s0);
        let y = Math.min(rb, s0 + len);
        // The line ending at a run's end stays, so the other stream's next line is not joined onto
        // the piece: the piece ends at the view's newline for it. That newline stands for the LF,
        // also when a CR, an escape or other controls come before it.
        if (y === s0 + len && rb > y && raw[j0 + len - 1] === '\n') {
          let e = first((i) => view.at(i)[0] >= j0 + len);
          while (e > 0 && lineBreak(e - 1) && view.at(e - 1)[0] > j0 + x - s0) e--;
          if (e < n && view.at(e)[0] < j0 + len && lineBreak(e)) y = view.at(e)[0] - j0 + s0;
          else {
            y--;
            while (y > x && raw[j0 + y - s0 - 1] === '\r') y--;
          }
        }
        if (x >= y || ownedHas(j0 + x - s0, j0 + y - s0)) continue;
        const [f, l] = toView(j0 + x - s0, j0 + y - s0);
        if (f < l && !inside(f, l)) more.push({ a: f, b: l, label });
      }
    }
  }
  if (!more.length) return applyRanges(view.text, own);
  // The redactor runs once more over the result, so whatever the placeholders put next to each other is read too.
  return redact(applyRanges(view.text, [...own, ...more]));
}

function killTree(child, signal, mark) {
  if (process.platform === 'win32') {
    windowsKillTree(child);
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

// What a gate command left behind is stopped and the gate checks that nothing is left before it
// goes on: the command's cgroup where it has one (lib/containment.js stopScope), its Windows job
// object (windowsJob), else its process group and the processes that carry its run mark, which
// a process that clears its environment and leaves the group escapes; the gate's reaper
// (reapLeaks) is the backstop there. Returns the evidence, { backend, empty, remaining? }, for a
// gate command (gate true) or a cleanup that left something; null otherwise.
async function contain(child, mark, job, gate) {
  if (!child.pid) return null;
  const scoped = await child.stopScope?.();
  if (scoped) return scoped;
  if (job) return job.cleanup();
  if (process.platform === 'win32') return gate ? { backend: 'process-tree', empty: null } : null;
  const deadline = performance.now() + TERM_GRACE_MS;
  for (;;) {
    let group = true;
    try { process.kill(-child.pid, 0); } catch { group = false; }
    const others = strays(child.pid, mark);
    if (!group && !others.length) return gate ? { backend: 'process-group', empty: true } : null;
    if (performance.now() >= deadline) {
      return { backend: 'process-group', empty: false, remaining: [...(group ? [`group ${child.pid}`] : []), ...others] };
    }
    killTree(child, 'SIGKILL', mark);
    await new Promise((resolve) => setTimeout(resolve, CHECK_MS));
  }
}

// A Windows quoting of one argument as the C runtime reads it back.
function windowsArgument(arg) {
  if (arg && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === '\\') { slashes++; continue; }
    out += char === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${char}`;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

// A Windows gate command runs under lib/gate-job.ps1 in a job object with kill-on-close, which
// holds every process it starts, orphans included. cleanup() reads the wrapper's report of the
// job emptied after the command; without one the wrapper was killed and closing its handle
// stopped the job.
function windowsJob(command) {
  const file = path.join(__dirname, '..', 'gate-job.ps1');
  require('../runtime').requireFile(file);
  const line = [windowsArgument(command.cmd), ...(command.windowsVerbatimArguments ? command.args : command.args.map(windowsArgument))].join(' ');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-crane-job-'));
  const report = path.join(dir, 'report.json');
  return {
    command: { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file,
      Buffer.from(line, 'utf8').toString('base64'), String(process.pid), report] },
    cleanup() {
      let found = null;
      try { found = JSON.parse(fs.readFileSync(report, 'utf8')); } catch { /* The wrapper was killed before it reported. */ }
      fs.rmSync(dir, { recursive: true, force: true });
      return found ? { backend: 'job', empty: found.empty === true, ...(found.empty ? {} : { remaining: found.remaining }) }
        : { backend: 'job', empty: null };
    },
  };
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
// timeout), plus `output`: stdout and stderr joined by whole lines (lineJoiner), and `runs`, the same
// text as runs of lines tagged with the stream that wrote them (redactJoined). spawnSync kills only
// the shell on timeout and leaves the test runner it started running, so the command gets its
// own process group here and the whole group is stopped on timeout and after exit. `cores` raises
// the shell's soft core limit to its hard one, so a native crash under it leaves a core
// (lib/native-crash.js); the caller still records `cmd` as given.
const CORE_LIMIT = 'ulimit -S -c "$(ulimit -H -c)" 2>/dev/null; ';
function treeExec(cmd, args, opts = {}) {
  if (opts.cores && opts.shell && process.platform !== 'win32') cmd = `${CORE_LIMIT}${cmd}`;
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
    const all = runBuffer(keep);
    const afterTimeout = tailBuffer(keep);
    const lines = lineJoiner((text, stream) => { all.push(text, stream); if (timedOut) afterTimeout.push(text); }, keep);
    let child;
    let job = null;
    const mark = win ? null : `TOWERCRANE_GATE_RUN_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
    try {
      assertUnlocked(cmd);
      let command = spawnCommand(cmd, args || [], opts);
      const contained = opts.resources && !require('../containment').fixtureLaunch(opts.env || process.env);
      if (contained && opts.shell) {
        command = win ? { cmd: 'cmd.exe', args: ['/d', '/s', '/c', `"${cmd}"`], windowsVerbatimArguments: true }
          : { cmd: '/bin/sh', args: ['-c', cmd] };
      }
      if (contained && win) {
        job = windowsJob(command);
        command = job.command;
      }
      const launch = contained ? require('../containment').spawn : spawn;
      child = launch(command.cmd, command.args, {
        cwd: opts.cwd,
        env: mark ? { ...withoutRunMarks(opts.env || process.env), [mark]: '1' } : opts.env,
        shell: contained ? false : opts.shell,
        resources: opts.resources,
        preserveManaged: false,
        detached: !win,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: command.windowsVerbatimArguments,
      });
    } catch (error) {
      job?.cleanup();
      resolve({ status: null, signal: null, stdout: '', stderr: '', output: '', error });
      return;
    }
    // The host governor measures the command's group with the gate that started it.
    if (child.pid) opts.onSpawn?.(child.pid, child.containment);
    child.on('containmentReady', scope => opts.onSpawn?.(child.pid, scope));
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
      const resourceReason = !timedOut && spawnError?.code !== 'ABORT_ERR' ? child.resourceReason : undefined;
      if (resourceReason) {
        error = Object.assign(new Error(child.resourceReason), { code: child.resourceReason });
      }
      if (!error && timedOut) {
        error = new Error(`timed out after ${opts.timeout} ms`);
        error.code = 'ETIMEDOUT';
      }
      const output = all.value;
      const result = {
        status: exit ? exit.code : null,
        signal: exit ? exit.signal : null,
        stdout: out.value,
        stderr: err.value,
        output,
        // Keeping the tail drops the start silently, and an omitted overlong line drops its text, so
        // a shorter output than the command wrote may have lost lines a reader looks for.
        truncated: seen > output.length,
        runs: all.runs,
        containment: child.containment,
        resource_reason: resourceReason,
        ...(timedOut ? { timeoutOutput, timeoutDiagnostics: afterTimeout.value } : {}),
        error: error || undefined,
      };
      // Resolved only once nothing the command started is left, so the gate deletes its directory after them.
      contain(child, mark, job, !!opts.resources).then((cleanup) => resolve(cleanup ? { ...result, cleanup } : result));
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
    let seen = 0;
    child.stdout.on('data', (d) => { activity++; seen += d.length; out.push(d); lines.push('out', d); });
    child.stderr.on('data', (d) => { activity++; seen += d.length; err.push(d); lines.push('err', d); });
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
    truncated: res.truncated === true,
    runs: Array.isArray(res.runs) ? res.runs : null,
    timeoutOutput: res.timeoutOutput == null ? null : String(res.timeoutOutput),
    timeoutDiagnostics: res.timeoutDiagnostics == null ? null : String(res.timeoutDiagnostics),
    error,
    containment: res.containment,
    resource_reason: res.resource_reason,
    timedOut: Boolean(error && error.code === 'ETIMEDOUT'),
    missing: Boolean(error && error.code === 'ENOENT'),
  };
}

// A command killed by a signal failed in its runner, not in the code under test. A shell reports
// the signal as exit 128 plus its number, so both forms count.
function killed(r) {
  return !!r.resource_reason || !!r.signal || (Number.isInteger(r.status) && r.status > 128 && r.status <= 192);
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
    resources: opts?.resources || (opts?.processTree ? require('../containment').resolveGate(ctx.project) : undefined),
    signal: opts?.cleanup && ctx.signal?.aborted ? undefined : ctx.signal || opts?.signal }));
}

// A shell command line with a timeout; the default runner stops the whole process tree.
async function shell(ctx, command, opts = {}) {
  const run = ctx.exec || treeExec;
  return normalize(await run(command, [], { encoding: 'utf8', shell: true, ...opts,
    resources: require('../containment').resolveGate(ctx.project),
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
    reapLeaks(ctx, tmp, [], 'start');
    parent = fs.mkdtempSync(path.join(tmp, gateTmp.GATE_PREFIX));
    // The pid namespace and start ticks let the reaper tell this gate's end from a reused pid.
    fs.writeFileSync(path.join(parent, OWNER_FILE), `${JSON.stringify({ pid: process.pid, ...require('../processes').identity(process.pid), started: Date.now() })}\n`);
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
  // A test run the gate's command starts asks the host governor for its threads (lib/test-grants.js).
  env[TestGrants.MARK] = TestGrants.mark({ stateDir: ctx.stateDir, ...(ctx.testGrant || { task: ctx.task?.id ?? null, kind: 'gate' }) });
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
    // Whatever this gate's commands left running dies before its directory goes.
    reapLeaks(ctx, tmp, [parent], 'end');
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
  const minutes = Math.max(...['tests', 'clean', 'host_probe'].map((type) => timeouts.minutes(project || {}, type)));
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

// The backstop behind each command's containment (lib/reaper.js): processes that name a gate or
// test directory that is deleted or whose owner exited, and at the end this gate's own, are
// killed, and ctx.onReap records them as an event. A failure to look is logged; it never fails
// the gate.
function reapLeaks(ctx, tmp, finished, phase) {
  const Reaper = require('../reaper');
  let processes;
  try {
    processes = Reaper.reap({ roots: [{ root: tmp, kind: 'gate' }, { root: Reaper.testRoot(ctx.tmpEnv || process.env), kind: 'test' }], finished });
  } catch (e) {
    if (ctx.log) ctx.log(`could not look for leaked processes: ${e.message}`);
    return;
  }
  if (!processes.length) return;
  if (ctx.log) ctx.log(`killed ${processes.length} leaked ${processes.length === 1 ? 'process' : 'processes'} at gate ${phase}: ${listSome(processes.map((p) => `${p.pid} (${p.reason} ${p.dir})`), 3)}`);
  try { ctx.onReap?.({ phase, processes }); } catch (e) { if (ctx.log) ctx.log(`could not record leaked processes: ${e.message}`); }
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
  stripEscapes,
  stripFor,
  redactJoined,
  joinOutputs,
  createRedactor,
  secretValue,
  shellQuote,
  treeExec,
  CORE_LIMIT,
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
  underWorktreeLock,
  withWorktree,
  sweepStale,
  removeTree,
  listSome,
};
