'use strict';

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
// find(text) gives every match of the expression in its comment, as [at, start, end]: the match
// runs from at, and the secret from start, after a header such as `Authorization: Bearer `. A run
// glued to more word characters, such as `ghp_<36>_backup` or an AWS key with a seventeenth letter,
// has no end boundary, and the expression skipped it or, for a Slack token with dashes, stopped at
// the last dash: the secret, or its last part, stayed in the text. Such a run goes whole instead,
// and the word after it stays.
const code = (text, i) => (i < text.length ? text.charCodeAt(i) : -1);
const alnum = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const word = (c) => alnum(c) || c === 0x5f;
// JavaScript's \s.
const space = (c) => (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0xa0 || c === 0x1680
  || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f
  || c === 0x3000 || c === 0xfeff;

// `lead` then `[body]{min,max}\b`, the run as long as the class and the end boundary allow. lead
// is a global expression of fixed length that starts with \b. Unless strict, a run of at least min
// glued to a word character, or longer than max, is the match up to its end instead. A run is
// scanned once: a later lead inside it reuses its end and its last word boundary, so a failed match
// does not rescan it.
function prefixed(lead, body, min, max = Infinity) {
  return (text, strict = false) => {
    const out = [];
    const re = new RegExp(lead.source, lead.flags);
    const boundary = (p) => word(code(text, p - 1)) !== word(code(text, p));
    let runFrom = 0;
    let runTo = -1;
    let last = -1;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const from = m.index + m[0].length;
      if (from < runFrom || from >= runTo) {
        runFrom = from;
        runTo = from;
        while (body(code(text, runTo))) runTo++;
        last = -1;
      }
      const hi = Math.min(runTo, from + max);
      let end = -1;
      if (!strict && runTo - from >= min && (word(code(text, runTo)) || runTo - from > max)) {
        end = runTo;
      } else if (hi === runTo) {
        // The run's last word boundary, found once from its end.
        if (last < 0) for (last = runTo; last > runFrom && !boundary(last); last--);
        if (last > runFrom) end = last;
      } else {
        for (end = hi; end > from && !boundary(end); end--);
      }
      if (end >= from + min && end > from) {
        out.push([m.index, m.index, end]);
        re.lastIndex = end;
      } else {
        re.lastIndex = m.index + 1;
      }
    }
    return out;
  };
}

// (\bauthorization:\s*(?:(?:bearer|basic|token)\s+)?)\S+ ignoring case; the header is group 1.
function authorization(text) {
  const out = [];
  const re = /\bauthorization:/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let start = m.index + m[0].length;
    while (space(code(text, start))) start++;
    const scheme = /^(?:bearer|basic|token)/i.exec(text.slice(start, start + 6));
    if (scheme && space(code(text, start + scheme[0].length))) {
      let after = start + scheme[0].length;
      while (space(code(text, after))) after++;
      // With nothing after the spaces, the scheme word itself is the \S+.
      if (after < text.length) start = after;
    }
    if (start >= text.length) {
      re.lastIndex = m.index + 1;
      continue;
    }
    let end = start;
    while (end < text.length && !space(code(text, end))) end++;
    out.push([m.index, start, end]);
    re.lastIndex = end;
  }
  return out;
}

const TOKEN_SHAPES = [
  // \bgh[pousr]_[A-Za-z0-9]{20,}\b
  { find: prefixed(/\bgh[pousr]_/g, alnum, 20), label: 'GITHUB_TOKEN' },
  // \bgithub_pat_[A-Za-z0-9_]{20,}\b
  { find: prefixed(/\bgithub_pat_/g, word, 20), label: 'GITHUB_TOKEN' },
  // \bsk-[A-Za-z0-9_-]{8,}\b ignoring case
  { find: prefixed(/\bsk-/gi, (c) => word(c) || c === 0x2d, 8), label: 'API_KEY' },
  // \b(?:AKIA|ASIA)[0-9A-Z]{16}\b
  { find: prefixed(/\b(?:AKIA|ASIA)/g, (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a), 16, 16), label: 'AWS_ACCESS_KEY_ID' },
  // \bxox[a-z]-[A-Za-z0-9-]{10,}\b ignoring case
  { find: prefixed(/\bxox[a-z]-/gi, (c) => alnum(c) || c === 0x2d, 10), label: 'SLACK_TOKEN' },
  { find: authorization, label: 'AUTHORIZATION' },
];

function redactTokenShapes(text) {
  let out = String(text);
  for (const { find, label } of TOKEN_SHAPES) {
    const matches = find(out);
    if (!matches.length) continue;
    const parts = [];
    let from = 0;
    for (const [, start, end] of matches) {
      parts.push(out.slice(from, start), `[redacted:${label}]`);
      from = end;
    }
    parts.push(out.slice(from));
    out = parts.join('');
  }
  return out;
}

// The text with each control run replaced by pick(run), and for each of its characters the index
// in the source it came from; a replacement maps to its run's start.
function view(src, runs, pick) {
  const parts = [];
  const map = new Int32Array(src.length);
  let n = 0;
  let from = 0;
  for (const run of runs) {
    parts.push(src.slice(from, run.at));
    for (let i = from; i < run.at; i++) map[n++] = i;
    const put = pick(run);
    if (put) {
      parts.push(put);
      map[n++] = run.at;
    }
    from = run.end;
  }
  parts.push(src.slice(from));
  for (let i = from; i < src.length; i++) map[n++] = i;
  return { text: parts.join(''), map };
}

// Source spans [start, end) of the token shapes, and of the literals when given, in a view.
function found(v, literals, strict) {
  const spans = [];
  for (const { find } of TOKEN_SHAPES) {
    for (const [, a, b] of find(v.text, strict)) spans.push([v.map[a], v.map[b - 1] + 1]);
  }
  for (const literal of literals) {
    for (let at = v.text.indexOf(literal); at >= 0; at = v.text.indexOf(literal, at + literal.length)) {
      spans.push([v.map[at], v.map[at + literal.length - 1] + 1]);
    }
  }
  return spans;
}

// Marks each run that lies inside one of the spans.
function markInside(runs, spans, key) {
  if (!spans.length) return;
  spans.sort((x, y) => x[0] - y[0]);
  const merged = [spans[0]];
  for (const [a, b] of spans.slice(1)) {
    const last = merged.at(-1);
    if (a < last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let s = 0;
  for (const run of runs) {
    while (s < merged.length && merged[s][1] <= run.at) s++;
    if (s < merged.length && merged[s][0] < run.at && run.end <= merged[s][1]) run[key] = true;
  }
}

// A control run goes, as on a terminal, which also reads text a Windows tool prints in UTF-16
// (a NUL after every character) as plain text. A carriage return ends a line instead, as a progress
// bar's redraw does: CRLF becomes LF, and one that ends the text goes. Two exceptions keep the
// redaction patterns working, since they see the cleaned text. A run inside a token shape, or
// inside one of the literals (the redactor's environment values), found in a copy with every run
// removed, goes even when it is a carriage return, so `ghp_ABCD\x1b\x7fEFGH...` stays whole. That
// copy finds only tokens with an end boundary: there a token glued to the next word would take the
// run between them, and `AKIA...\rDONE` would lose its line break. A token glued in the cleaned
// text is still redacted, since the redactor finds it there. A run at the edge of a token shape
// found in a copy with every run made a space, and inside none, becomes a space, so
// `AKIA...\x00DONE` keeps the word boundary its pattern needs. The tokens stay for the redactor,
// which matches environment values before token shapes and labels each by its variable.
function stripEscapes(text, literals = []) {
  const src = String(text ?? '').replace(TERMINAL_ESCAPE, '');
  if (!HAS_STRAY_CONTROL.test(src)) return src;
  const runs = [];
  for (const m of src.matchAll(STRAY_CONTROL)) {
    const at = m.index;
    const end = at + m[0].length;
    const cr = m[0][0] === '\r';
    runs.push({ at, end, plain: cr && (m[0].endsWith('\n') || end < src.length) ? '\n' : '', cr, inside: false });
  }
  // Line breaks stay in the joined copy, so a token found there never spans two lines.
  const joined = view(src, runs, (run) => (run.cr && src[run.end - 1] === '\n' ? '\n' : ''));
  markInside(runs, found(joined, literals.filter(Boolean), true), 'inside');
  const spaced = view(src, runs, (run) => run.plain || ' ');
  const edges = new Set();
  for (const [a, b] of found(spaced, [])) {
    edges.add(a);
    edges.add(b);
  }
  return view(src, runs, (run) => {
    if (run.inside) return run.cr && src[run.end - 1] === '\n' ? '\n' : '';
    if (!run.plain && (edges.has(run.end) || edges.has(run.at))) return ' ';
    return run.plain;
  }).text;
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

module.exports = { stripEscapes, cleanOutput, redactTokenShapes, TOKEN_SHAPES };
