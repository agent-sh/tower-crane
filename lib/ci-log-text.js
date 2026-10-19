'use strict';

const { reveal, revealTerminal } = require('./escape-views');
const { textBudget, textWork, textMap } = require('./text-redaction-budget');

// One cleanup for every text that reaches a terminal, a prompt or the redaction patterns: CI logs,
// check output and gate output. It removes terminal escapes and then stray controls, keeping tabs
// and newlines. An escape or control inside a token hides it from the redaction patterns, so gates
// clean their output before redacting it.
//
// Escapes, in 7-bit and 8-bit (C1) forms: OSC strings (ESC ] or 0x9d, ended by BEL, ESC \ or 0x9c),
// DCS, SOS, PM and APC strings (ESC P, X, ^, _ or 0x90, 0x98, 0x9e, 0x9f, ended by ESC \ or 0x9c),
// CSI sequences (ESC [ or 0x9b) and two-character escapes such as a charset selection (ESC ( B).
// A string body stops at a newline or the next ESC, so an unterminated one cannot swallow later
// lines, and every scan ends within its line, which keeps the cleanup linear. An escape goes
// without a trace, as on a terminal, so a color change inside a token joins it back together.
const TERMINAL_ESCAPE = new RegExp([
  '(?:\\x1b\\]|\\x9d)[^\\x07\\x1b\\x9c\\n]*(?:\\x07|\\x1b\\\\|\\x9c)?',
  '(?:\\x1b[PX^_]|[\\x90\\x98\\x9e\\x9f])[^\\x1b\\x9c\\n]*(?:\\x1b\\\\|\\x9c)?',
  '(?:\\x1b\\[|\\x9b)[0-?]*[ -/]*[@-~]',
  '\\x1b[ -/]*[0-~]',
].join('|'), 'g');
// What is left: carriage returns, and every other C0 control except tab and newline, DEL and every
// C1 control, such as a lone ESC or an 8-bit introducer without a body.
const STRAY_CONTROL = /\r+\n?|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]+/g;
const HAS_STRAY_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

// Credential shapes, found by a prefix or a header. Bare hex and base64 runs are not: paths, long
// file names and commit SHAs match them too. Each shape is a scan rather than one regular
// expression: V8 ran `\bghp_[A-Za-z0-9]{20,}\b` with a backtracking stack that grows with the run,
// and a prefix before about 8 MiB of letters and digits threw a RangeError, which crashed a gate
// instead of redacting its output. A regular expression finds only the fixed-length prefix; the
// scan reads the run after it once, so a run of any length is redacted whole. Each shape's
// find(text, 'strict') gives the matches of the expression in its comment, as [at, start, end]:
// the match runs from at, and the secret from start, after a header such as
// `Authorization: Bearer `.
//
// By default a run glued to more word characters matches too: the expression needs a word boundary
// after the run, so it skipped `ghp_<36>_backup` or, for a Slack token with dashes, stopped at the
// last dash, and the secret, or its last part, stayed in the text. Such a run goes whole, and the
// word after it stays. An AWS key ends at its 16th character, since its ids are 4 + 16 characters,
// so `AKIA<16>XYZ` keeps `XYZ`.
const code = (text, i) => {
  if ((i & 4095) === 0) textWork();
  return i < text.length ? text.charCodeAt(i) : -1;
};
const alnum = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const word = (c) => alnum(c) || c === 0x5f;
const boundary = (text, p) => word(code(text, p - 1)) !== word(code(text, p));
// JavaScript's \s.
const space = (c) => (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0xa0 || c === 0x1680
  || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f
  || c === 0x3000 || c === 0xfeff;

// reusable(source, flags) gives search(use), which calls use with a global expression of source and
// flags at lastIndex 0. One is kept and reused: a log of many split tokens runs the shapes on short
// slices hundreds of thousands of times, and a new expression for each made most of its garbage. A
// search inside another gets its own.
function reusable(source, flags) {
  const kept = new RegExp(source, flags);
  let busy = false;
  return (use) => {
    const re = busy ? new RegExp(source, flags) : kept;
    const mine = re === kept;
    busy = true;
    re.lastIndex = 0;
    try {
      return use(re);
    } finally {
      if (mine) busy = false;
    }
  };
}

// `\b(?:lead)[body]{min,max}\b`, lead of fixed length. find scans the text; at(text, p), called
// after find on the same text, is the match of the same shape that starts at p without the leading
// \b, or null. The body run last read and its last word boundary are kept: a later lead inside the
// run, from the scan or after a glued match, reuses them, so a failed match does not rescan it. A
// bounded shape reads at most max + 1 characters of a run, which tells a run longer than max.
function prefixed(lead, flags, body, min, max = Infinity) {
  const anchored = new RegExp(lead, `y${flags}`);
  const search = reusable(`\\b(?:${lead})`, `g${flags}`);
  let runFrom = 0;
  let runTo = -1;
  let last = -1;
  const endOf = (text, from, mode) => {
    if (from < runFrom || from >= runTo || max !== Infinity) {
      runFrom = from;
      const limit = from + max + 1;
      for (runTo = from; runTo < limit && body(code(text, runTo));) runTo++;
      last = -1;
    }
    if (runTo - from < min) return -1;
    if (mode !== 'strict' && (runTo - from > max || word(code(text, runTo)))) return Math.min(runTo, from + max);
    if (runTo - from > max) {
      for (let end = from + max; end >= from + min; end--) if (boundary(text, end)) return end;
      return -1;
    }
    // The run's last word boundary, found once from its end.
    if (last < 0) for (last = runTo; last > runFrom && !boundary(text, last); last--);
    return last >= from + min ? last : -1;
  };
  const find = (text, mode = 'redact', each = null) => search((re) => {
    const out = [];
    runTo = -1;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const end = endOf(text, m.index + m[0].length, mode);
      if (end > 0 && each) each(m.index, m.index, end);
      else if (end > 0) out.push([m.index, m.index, end]);
      re.lastIndex = end > 0 ? end : m.index + 1;
    }
    return out;
  });
  const at = (text, p) => {
    anchored.lastIndex = p;
    const m = anchored.exec(text);
    const end = m ? endOf(text, p + m[0].length, 'redact') : -1;
    return end > 0 ? [p, p, end] : null;
  };
  return { find, at, lead };
}

// (\bauthorization:\s*(?:(?:bearer|basic|token)\s+)?)\S+ ignoring case; the header is group 1.
// Unless strict, the search goes on from the start of each value rather than its end, so a value
// that is itself a header, as in `Authorization: Authorization: SECRET`, does not hide the secret
// after it. The end of a value's run is kept, so nested headers do not rescan it; at(text, p) is
// called after find on the same text.
function authorization() {
  const anchored = /authorization:/iy;
  const search = reusable('\\bauthorization:', 'gi');
  let runFrom = 0;
  let runTo = -1;
  // The match whose header word ends at start, or null.
  const after = (text, at, start) => {
    while (space(code(text, start))) start++;
    const scheme = /^(?:bearer|basic|token)/i.exec(text.slice(start, start + 6));
    if (scheme && space(code(text, start + scheme[0].length))) {
      let next = start + scheme[0].length;
      while (space(code(text, next))) next++;
      // With nothing after the spaces, the scheme word itself is the \S+.
      if (next < text.length) start = next;
    }
    if (start >= text.length) return null;
    if (start < runFrom || start >= runTo) {
      runFrom = start;
      for (runTo = start; runTo < text.length && !space(code(text, runTo));) runTo++;
    }
    return [at, start, runTo];
  };
  const find = (text, mode = 'redact', each = null) => search((re) => {
    const out = [];
    runTo = -1;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const match = after(text, m.index, m.index + m[0].length);
      if (match && each) each(...match);
      else if (match) out.push(match);
      re.lastIndex = !match ? m.index + 1 : mode === 'strict' ? match[2] : match[1];
    }
    return out;
  });
  const at = (text, p) => {
    anchored.lastIndex = p;
    const m = anchored.exec(text);
    return m ? after(text, p, p + m[0].length) : null;
  };
  return { find, at };
}

const TOKEN_SHAPES = [
  // \bgh[pousr]_[A-Za-z0-9]{20,}\b
  { ...prefixed('gh[pousr]_', '', alnum, 20), label: 'GITHUB_TOKEN' },
  // \bgithub_pat_[A-Za-z0-9_]{20,}\b
  { ...prefixed('github_pat_', '', word, 20), label: 'GITHUB_TOKEN' },
  // \bsk-[A-Za-z0-9_-]{8,}\b ignoring case
  { ...prefixed('sk-', 'i', (c) => word(c) || c === 0x2d, 8), label: 'API_KEY' },
  // \b(?:AKIA|ASIA)[0-9A-Z]{16}\b
  { ...prefixed('AKIA|ASIA', '', (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a), 16, 16), label: 'AWS_ACCESS_KEY_ID' },
  // \bxox[a-z]-[A-Za-z0-9-]{10,}\b ignoring case
  { ...prefixed('xox[a-z]-', 'i', (c) => alnum(c) || c === 0x2d, 10), label: 'SLACK_TOKEN' },
  { ...authorization(), label: 'AUTHORIZATION' },
];
// The fixed prefixes of the shapes without a header, ignoring case: where a token split across lines
// can start (lib/escape-views.js acrossLines).
const TOKEN_LEAD = new RegExp(TOKEN_SHAPES.filter((s) => s.lead).map((s) => `(?:${s.lead})`).join('|'), 'i');

// Each token shape match in text as [at, start, end], as the redactor finds them: the match runs
// from at, and the secret from start, after a header such as `Authorization: Bearer `.
function shapeMatches(text) {
  return tokenMatches(text).map(([at, start, end]) => [at, start, end]);
}

// Every shape's matches in text, as [at, start, end, label], overlapping ones included. Unless
// strict, a match also starts right after a glued match, where the redacted run leaves a boundary:
// `AKIA<16>authorization: Bearer x` and `ghp_<36>xoxb-...` hide the second secret otherwise. Each
// such position is tried once, at most one shape's prefix fits it, and positions go in increasing
// order, so a run the shapes keep from one position serves the later ones. Given each, a shape's
// find and tokenMatches pass every match to each(at, start, end, label) instead of keeping a list:
// a list of 1.7M matches in a 64 MiB binary artifact held 290 MB.
function tokenMatches(text, mode = 'redact', each = null) {
  const out = [];
  const put = each || ((at, start, end, label) => out.push([at, start, end, label]));
  const emit = (at, start, end, label) => { textWork(); return put(at, start, end, label); };
  // A binary min-heap of the positions to try.
  const heap = [];
  const push = (v) => {
    heap.push(v);
    for (let i = heap.length - 1, j; i > 0 && heap[(j = (i - 1) >> 1)] > heap[i]; i = j) [heap[i], heap[j]] = [heap[j], heap[i]];
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        let m = i;
        for (const c of [2 * i + 1, 2 * i + 2]) if (c < heap.length && heap[c] < heap[m]) m = c;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  for (const { find, label } of TOKEN_SHAPES) {
    find(text, mode, (at, start, end) => {
      emit(at, start, end, label);
      if (mode !== 'strict' && word(code(text, end))) push(end);
    });
  }
  let tried = -1;
  while (heap.length) {
    textWork();
    const p = pop();
    if (p === tried) continue;
    tried = p;
    for (const { at, label } of TOKEN_SHAPES) {
      const match = at(text, p);
      if (!match) continue;
      emit(...match, label);
      if (word(code(text, match[2]))) push(match[2]);
    }
  }
  return out;
}

// Every shape is found in the same text and overlapping or touching secrets are replaced as one,
// labeled by the first. Replaced one shape at a time, a later shape matched across an earlier
// replacement and could take the header or prefix of a secret that then stayed in the text.
function redactTokenShapes(text) {
  const src = String(text);
  const spans = tokenSpansMerged(src);
  if (!spans.length) return src;
  const parts = [];
  let from = 0;
  for (const [start, end, label] of spans) {
    parts.push(src.slice(from, start), `[redacted:${label}]`);
    from = end;
  }
  parts.push(src.slice(from));
  return parts.join('');
}

// The [start, end, label] spans redactTokenShapes replaces, in order.
function tokenSpansMerged(src) {
  // Each match is kept once, as the span it becomes: a list of matches, a copy of each and a merged
  // copy held most of what a log of many secrets kept alive.
  const spans = [];
  tokenMatches(src, 'redact', (at, start, end, label) => { spans.push([start, end, label, spans.length]); });
  // At one start the longest wins, then the later shape, as a header wrapped a token before.
  spans.sort((x, y) => x[0] - y[0] || y[1] - x[1] || y[3] - x[3]);
  const merged = [];
  for (const span of spans) {
    const cur = merged.at(-1);
    if (cur && span[0] <= cur[1]) cur[1] = Math.max(cur[1], span[1]);
    else {
      span.length = 3;
      merged.push(span);
    }
  }
  return merged;
}

const RUN_CR = 1;
const RUN_BREAK = 2;
const RUN_INSIDE = 4;
const RUN_LITERAL = 8;

// Blocks keep three integers per run without one object per control. They grow to 768 KiB,
// then add blocks instead of copying the whole table during a resize.
function controlRuns() {
  const blocks = [];
  return {
    push(at, end, flags) {
      textWork(1 / 4);
      let block = blocks.at(-1);
      if (!block || block.length === block.data.length) {
        const capacity = block ? Math.min(block.data.length * 2, 3 * 65536) : 3 * 64;
        const data = textMap(capacity);
        block = { data, length: 0 };
        blocks.push(block);
      }
      block.data[block.length++] = at;
      block.data[block.length++] = end;
      block.data[block.length++] = flags;
    },
    each(visit) {
      for (const { data, length } of blocks) {
        for (let i = 0; i < length; i += 3) visit(data[i], data[i + 1], data[i + 2], data, i);
      }
    },
  };
}

// The text with each control run replaced by pick(at, end, flags), and for each character the index
// in the source it came from; a replacement maps to its run's start, except a kept LF.
function view(src, runs, pick, map) {
  const parts = [];
  const chunks = [];
  // Joining bounded groups releases slice references before the next group is collected.
  const add = (part) => {
    parts.push(part);
    if (parts.length === 16384) {
      chunks.push(parts.join(''));
      parts.length = 0;
    }
  };
  let n = 0;
  let from = 0;
  runs.each((at, end, flags) => {
    add(src.slice(from, at));
    for (let i = from; i < at; i++) map[n++] = i;
    const put = pick(at, end, flags);
    if (put) {
      add(put);
      // Escapes can stand between CR and LF in raw text. Mapping the kept LF to that CR would
      // let a value ending inside the escape take the next line's boundary with its put-back.
      map[n++] = put === '\n' && src[end - 1] === '\n' ? end - 1 : at;
    }
    from = end;
  });
  add(src.slice(from));
  for (let i = from; i < src.length; i++) map[n++] = i;
  map.fill(0, n);
  chunks.push(parts.join(''));
  return { text: chunks.join(''), map };
}

// Source spans [at, start, end) of the token shapes in a view: the match from at, the secret from
// start.
function tokenSpans(v) {
  return tokenMatches(v.text).map(([at, a, b]) => [v.map[at], v.map[a], v.map[b - 1] + 1]);
}

// Source spans [start, end) of the literals in a view.
function literalSpans(v, literals) {
  const spans = [];
  for (const literal of literals) {
    textWork(1 + Math.ceil(v.text.length / 4096));
    for (let at = v.text.indexOf(literal); at >= 0; at = v.text.indexOf(literal, at + literal.length)) {
      textWork();
      spans.push([v.map[at], v.map[at + literal.length - 1] + 1]);
    }
  }
  return spans;
}

// Marks each run that lies inside one of the spans.
function markInside(runs, spans, flag) {
  if (!spans.length) return;
  spans.sort((x, y) => x[0] - y[0]);
  const merged = [spans[0]];
  for (const [a, b] of spans.slice(1)) {
    const last = merged.at(-1);
    if (a < last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let s = 0;
  runs.each((at, end, flags, data, index) => {
    while (s < merged.length && merged[s][1] <= at) s++;
    if (s < merged.length && merged[s][0] < at && end <= merged[s][1]) data[index + 2] = flags | flag;
  });
}

// A control run goes, as on a terminal, which also reads text a Windows tool prints in UTF-16
// (a NUL after every character) as plain text. A carriage return ends a line instead, as a progress
// bar's redraw does: CRLF becomes LF, and one that ends the text goes. Exceptions keep the
// redaction patterns working, since they see the cleaned text:
// - A run inside a token shape, or inside one of the literals (the redactor's environment values),
//   found in a copy with every run removed, goes even when it is a carriage return, so
//   `ghp_ABCD\x1b\x7fEFGH...` stays whole, and so does `ghp_ABCD\rEFGH..._x`, whose run is glued
//   to the word after it. A run at a token's end is not inside it: `ghp_<token>\x00_x` keeps the
//   boundary, and an AWS key, at most 16 characters, ends before the run in `AKIA...\rDONE`.
// - Nor is a run inside a token when a token or header starts right after it in a copy with every
//   run made a space: joined, `ASIAPACIFIC\r` would take the `AUTHORIZATION:` header after it into
//   an AWS key and expose its value.
// - A run at the edge of a token shape or before its header in that copy, and inside none, becomes
//   a space, so `AKIA...\x00DONE` and `7\x85Authorization: ...` keep the word boundary their
//   patterns need.
// The tokens stay for the redactor, which matches environment values before token shapes and
// labels each by its variable.
//
// A secret this cleanup still hides, because an escape took some of its characters (a lone ESC its
// first, an unterminated OSC its head) while a second escape split it, or because a line break
// splits it, is put back whole from a view of the raw text that loses no character
// (lib/escape-views.js).
function stripEscapes(text, literals = []) {
  const raw = String(text ?? '');
  const values = literals.filter(Boolean);
  return textBudget(raw, () => reveal(raw, terminalText(raw, values), values, shapeMatches, TOKEN_LEAD));
}

// stripEscapes as { text, at(i) }, with at(i) the raw span [start, end) of text character i.
function stripEscapesMapped(text, literals = []) {
  const raw = String(text ?? '');
  const values = literals.filter(Boolean);
  return textBudget(raw, () => reveal(raw, terminalText(raw, values), values, shapeMatches, TOKEN_LEAD, true),
    (notice, reason) => ({ text: notice, at: () => [0, raw.length], unscannable: reason }));
}

// stripEscapesMapped, and the same from revealTerminal, which reads escapes only as a terminal does:
// a redactor redacts what either shows.
function stripEscapesViews(text, literals = []) {
  const raw = String(text ?? '');
  const values = literals.filter(Boolean);
  return textBudget(raw, () => {
    const cleaned = terminalText(raw, values);
    const shared = {};
    return [reveal(raw, cleaned, values, shapeMatches, TOKEN_LEAD, true, shared), revealTerminal(raw, cleaned, values, shapeMatches, TOKEN_LEAD, true, shared)];
  }, (notice, reason) => {
    const view = { text: notice, at: () => [0, raw.length], unscannable: reason };
    return [view, view];
  });
}

// Made apart from terminalText, whose scope holds every view of the text: a lookup made there kept
// them all alive as long as the cleaned text.
function rawIndex(raw) {
  let segments = null;
  // The segment the last lookup found: lookups mostly come in order.
  let hint = 0;
  // The raw index of src's character k, from the kept stretches between escapes, built when asked.
  const fromRaw = (k) => {
    if (!segments) {
      textWork(2);
      segments = { at: [0], raw: [0] };
      let n = 0;
      let from = 0;
      for (const m of raw.matchAll(TERMINAL_ESCAPE)) {
        textWork(2);
        n += m.index - from;
        from = m.index + m[0].length;
        segments.at.push(n);
        segments.raw.push(from);
      }
    }
    const at = segments.at;
    const last = at.length - 1;
    // The last segment that starts at or before k.
    const holds = (j) => at[j] <= k && (j === last || k < at[j + 1]);
    let lo = hint;
    if (!holds(lo)) {
      if (lo < last && holds(lo + 1)) {
        lo++;
      } else {
        lo = 0;
        let hi = last;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (at[mid] <= k) lo = mid;
          else hi = mid - 1;
        }
      }
    }
    hint = lo;
    return segments.raw[lo] + (k - at[lo]);
  };
  return fromRaw;
}

// fromRaw through map: the raw index of each character of a view of the text without escapes.
function throughMap(fromRaw, map) {
  return (i) => fromRaw(map[i]);
}

// The cleaned text, and src(i), the raw index of its character i.
function terminalText(raw, literals) {
  const src = raw.replace(TERMINAL_ESCAPE, '');
  const fromRaw = rawIndex(raw);
  if (!HAS_STRAY_CONTROL.test(src)) return { text: src, src: fromRaw };
  const runs = controlRuns();
  for (const m of src.matchAll(STRAY_CONTROL)) {
    const at = m.index;
    const end = at + m[0].length;
    const cr = m[0][0] === '\r';
    const lineBreak = cr && (m[0].endsWith('\n') || end < src.length);
    runs.push(at, end, (cr ? RUN_CR : 0) | (lineBreak ? RUN_BREAK : 0));
  }
  // Line breaks stay in the joined copy, so a token found there never spans two lines.
  // Each view's spans are consumed before the next view overwrites the same index buffer.
  const map = textMap(src.length);
  const joined = view(src, runs, (at, end, flags) => (flags & RUN_CR) && src[end - 1] === '\n' ? '\n' : '', map);
  markInside(runs, tokenSpans(joined).map(([, a, b]) => [a, b]), RUN_INSIDE);
  markInside(runs, literalSpans(joined, literals.filter(Boolean)), RUN_LITERAL);
  const spaced = view(src, runs, (at, end, flags) => flags & RUN_BREAK ? '\n' : ' ', map);
  const edges = new Set();
  const starts = new Set();
  for (const [at, a, b] of tokenSpans(spaced)) {
    edges.add(at);
    edges.add(a);
    edges.add(b);
    starts.add(at);
  }
  const out = view(src, runs, (at, end, flags) => {
    if ((flags & RUN_LITERAL) || ((flags & RUN_INSIDE) && !starts.has(end))) return (flags & RUN_CR) && src[end - 1] === '\n' ? '\n' : '';
    if (!(flags & RUN_BREAK) && (edges.has(end) || edges.has(at))) return ' ';
    return flags & RUN_BREAK ? '\n' : '';
  }, map);
  return { text: out.text, src: throughMap(fromRaw, out.map) };
}

// Check output is JSON, so its escaped controls become raw only after decoding.
function cleanOutput(value) {
  if (typeof value === 'string') return stripEscapes(value);
  if (Array.isArray(value)) return value.map(cleanOutput);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanOutput(item)]));
  }
  return value;
}

module.exports = { stripEscapes, stripEscapesMapped, stripEscapesViews, cleanOutput, redactTokenShapes, tokenSpansMerged, tokenMatches, shapeMatches, TOKEN_SHAPES, TOKEN_LEAD };
