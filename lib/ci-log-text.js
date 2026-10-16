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
// file names and commit SHAs match them too. A shape with a header (prefix: true) captures the
// header in its first group, and only the rest is the secret.
const TOKEN_SHAPES = [
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: 'GITHUB_TOKEN' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: 'GITHUB_TOKEN' },
  { re: /\bsk-[A-Za-z0-9_-]{8,}\b/gi, label: 'API_KEY' },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, label: 'AWS_ACCESS_KEY_ID' },
  { re: /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/gi, label: 'SLACK_TOKEN' },
  { re: /(\bauthorization:\s*(?:(?:bearer|basic|token)\s+)?)\S+/gi, label: 'AUTHORIZATION', prefix: true },
];

function redactTokenShapes(text) {
  let out = String(text);
  for (const { re, label, prefix } of TOKEN_SHAPES) out = out.replace(re, prefix ? `$1[redacted:${label}]` : `[redacted:${label}]`);
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
function found(v, literals) {
  const spans = [];
  for (const { re, prefix } of TOKEN_SHAPES) {
    for (const m of v.text.matchAll(re)) {
      const a = m.index + (prefix ? m[1].length : 0);
      const b = m.index + m[0].length;
      if (b > a) spans.push([v.map[a], v.map[b - 1] + 1]);
    }
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
// removed, goes even when it is a carriage return, so `ghp_ABCD\x1b\x7fEFGH...` stays whole. A run
// at the edge of a token shape found in a copy with every run made a space, and inside none,
// becomes a space, so `AKIA...\x00DONE` keeps the word boundary its pattern needs. The tokens stay
// for the redactor, which matches environment values before token shapes and labels each by its
// variable.
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
  markInside(runs, found(joined, literals.filter(Boolean)), 'inside');
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
