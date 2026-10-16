'use strict';

// Redaction for a file that is not UTF-8 text, such as a local CI artifact with a NUL byte or an
// invalid byte. Decoding it would turn its invalid bytes into U+FFFD, so only exact byte matches are
// replaced: read as latin1, each byte is one character, the environment values' UTF-8 bytes and the
// ASCII token shapes are found there, and every other byte is written back as it was.
//
// An exact match misses a secret with other bytes between its characters: a NUL after each one in
// UTF-16 text, a carriage return or a color escape inside a token. Such a file is not redacted in
// place. Its bytes are read again as latin1, UTF-16LE and UTF-16BE at both byte alignments, each
// with escapes and controls removed, with escapes removed and control runs made a space (which keeps
// the word boundary a fixed-length shape needs), and with controls alone removed (a stray ESC byte
// before a token would otherwise take its first character as an escape). Three more variants
// remove escapes gently, as lib/escape-views.js does for text: a stray ESC or an unterminated
// string loses only its introducer, so a token whose first character or head an escape would take,
// and which a second escape also splits, still shows. In one a two-character escape becomes a
// space, which keeps a word before the stray ESC apart from the token; one joins it; and one also
// removes line breaks, for a token split across two lines. The first two run only when an escape
// is lossy, keeping a final byte or leaving a string unterminated, since otherwise they show what
// the first variant shows. A secret found in any of those views that the exact
// matches did not remove whole makes the file missed, and the caller does not copy it.
const os = require('node:os');
const { TOKEN_SHAPES } = require('./ci-log-text');
const { gentleEscape, sortedSet } = require('./escape-views');

const VARIANTS = [
  { name: 'with escapes and controls removed', escapes: true, put: false },
  { name: 'with escapes removed and controls made spaces', escapes: true, put: true },
  { name: 'with controls removed', escapes: false, put: false },
  { name: 'with escapes removed gently', gentle: 'escape' },
  { name: 'with escapes removed gently and joined', gentle: 'join' },
  // Line breaks count only inside a fixed-prefix token shape or an environment value, and not
  // where the part before the break is a whole token shape by itself (lines below).
  { name: 'with escapes removed gently and line breaks removed', gentle: 'escape', lines: true },
];
const GENTLE = VARIANTS[3];

const ESC = 0x1b;
// Every C0 control but tab and newline, DEL and every C1 control. Each goes on its own: 0x90 or 0x9d
// is not read as an 8-bit string introducer, since in these views it is half of a character such as
// U+2190 or a UTF-8 continuation byte, and reading it as one removed the rest of the line.
const control = (c) => (c <= 0x1f && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f);

// The end of the 7-bit escape at i, or -1: the forms of lib/ci-log-text.js TERMINAL_ESCAPE without
// the 8-bit ones. A string body stops at a newline or the next ESC.
function escapeEnd(u, i) {
  const n = u.length;
  const c = i + 1 < n ? u[i + 1] : -1;
  if (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) {
    let j = i + 2;
    const osc = c === 0x5d;
    while (j < n && u[j] !== ESC && u[j] !== 0x0a && !(osc && u[j] === 0x07)) j++;
    if (osc && u[j] === 0x07) return j + 1;
    return u[j] === ESC && u[j + 1] === 0x5c ? j + 2 : j;
  }
  if (c === 0x5b) {
    let j = i + 2;
    while (j < n && u[j] >= 0x30 && u[j] <= 0x3f) j++;
    while (j < n && u[j] >= 0x20 && u[j] <= 0x2f) j++;
    if (j < n && u[j] >= 0x40 && u[j] <= 0x7e) return j + 1;
  }
  let j = i + 1;
  while (j < n && u[j] >= 0x20 && u[j] <= 0x2f) j++;
  return j < n && u[j] >= 0x30 && u[j] <= 0x7e ? j + 1 : -1;
}

// units (bytes or UTF-16 code units) with escapes and controls removed as the variant says. With
// track, also the source range [from, to) of each unit kept, a space standing for its control run,
// and finals, the source indices of the final bytes a gentle variant keeps; lossy says whether a
// gentle variant kept a final or left a string unterminated.
function clean(u, { escapes, put, gentle, lines }, track) {
  const out = u instanceof Uint16Array ? new Uint16Array(u.length) : new Uint8Array(u.length);
  const from = track ? new Int32Array(u.length) : null;
  const to = track ? new Int32Array(u.length) : null;
  const finals = sortedSet();
  const at = (k) => u[k];
  let n = 0;
  let run = -1;
  let runEnd = -1;
  let spaced = false;
  let lossy = false;
  for (let i = 0; i < u.length;) {
    const c = u[i];
    if (gentle && c === ESC) {
      const [end, final, two, open] = gentleEscape(at, u.length, i, false);
      if (run < 0) run = i;
      runEnd = end;
      spaced ||= gentle === 'escape' && two;
      if (final && track) finals.add(end);
      lossy ||= final || open;
      i = end;
      continue;
    }
    if (escapes && c === ESC) {
      const end = escapeEnd(u, i);
      if (end > 0) { i = end; continue; }
    }
    if (control(c) || (lines && c === 0x0a)) {
      if (run < 0) run = i;
      runEnd = ++i;
      continue;
    }
    if (run >= 0) {
      if (put || spaced) {
        if (track) { from[n] = run; to[n] = runEnd; }
        out[n++] = 0x20;
      }
      run = -1;
      spaced = false;
    }
    if (track) { from[n] = i; to[n] = i + 1; }
    out[n++] = c;
    i++;
  }
  // A trailing run makes no space: nothing after it could join a secret.
  return { units: out.subarray(0, n), from, to, finals, lossy };
}

const LE = os.endianness() === 'LE';
const asText = (u) => {
  if (u instanceof Uint8Array) return Buffer.from(u.buffer, u.byteOffset, u.length).toString('latin1');
  const b = Buffer.from(u.buffer, u.byteOffset, u.length * 2);
  return (LE ? b : Buffer.from(b).swap16()).toString('utf16le');
};
const wide = (s) => Uint16Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const narrow = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));

// Source spans [start, end, label, env, headed] of the secrets in text: every occurrence of every
// literal, overlapping ones included, and the secret part of every token shape, headed when the
// shape has a header before it.
function spans(text, literals) {
  const out = [];
  for (const [needle, label] of literals) {
    if (!needle) continue;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) out.push([at, at + needle.length, label, true]);
  }
  for (const { re, label, prefix } of TOKEN_SHAPES) {
    for (const m of text.matchAll(re)) {
      const start = m.index + (prefix ? m[1].length : 0);
      const end = m.index + m[0].length;
      if (end > start) out.push([start, end, label, false, start > m.index]);
    }
  }
  return out;
}

// Overlapping and touching spans as one, labeled by its first environment value, else its first
// shape, as the text redactor prefers a variable's name.
function merge(list) {
  list.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const [start, end, label, env] of list) {
    const last = merged.at(-1);
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      if (env && !last.env) Object.assign(last, { label, env });
    } else {
      merged.push({ start, end, label, env });
    }
  }
  return merged;
}

// The views of a buffer: name, units, the literals in its encoding, and the byte range of a unit range.
function* views(buffer, values) {
  yield {
    name: 'as bytes',
    units: buffer,
    literals: values.map(([value, label]) => [narrow(Buffer.from(value, 'utf8').toString('latin1')), label]),
    bytes: (a, b) => [a, b],
  };
  for (const [name, big] of [['UTF-16LE', false], ['UTF-16BE', true]]) {
    for (const off of [0, 1]) {
      const units = new Uint16Array((buffer.length - off) >> 1);
      for (let k = 0, p = off; k < units.length; k++, p += 2) {
        units[k] = big ? (buffer[p] << 8) | buffer[p + 1] : buffer[p] | (buffer[p + 1] << 8);
      }
      yield {
        name: `as ${name}${off ? ' from its second byte' : ''}`,
        units,
        literals: values.map(([value, label]) => [wide(value), label]),
        bytes: (a, b) => [off + 2 * a, off + 2 * b],
      };
    }
  }
}

// buffer redacted at its exact byte matches, or `missed` naming a view where a secret shows that
// those matches did not remove. values are [value, label] pairs.
function redactBinary(buffer, values) {
  const removed = merge(spans(buffer.toString('latin1'), values.map(([value, label]) => [Buffer.from(value, 'utf8').toString('latin1'), label])));
  const covered = (start, end) => {
    let lo = 0;
    let hi = removed.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (removed[mid].start <= start) lo = mid;
      else hi = mid - 1;
    }
    const r = removed[lo];
    return !!r && r.start <= start && end <= r.end;
  };
  for (const view of views(buffer, values)) {
    const escaped = view.units.indexOf(ESC) >= 0;
    const broken = view.units.indexOf(0x0a) >= 0;
    // Source unit spans of the secrets a variant shows, a kept final byte at either edge left out,
    // since a final next to a token may be an escape's and not the token's.
    let lossy = null;
    // A gentle variant without a lossy escape shows what the first variant shows, so its secrets
    // are read only for the line check, which needs them (whole).
    const secrets = (variant, whole = false) => {
      const needles = view.literals.map(([needle, label]) => [asText(clean(needle, variant).units), label]);
      const cleaned = clean(view.units, variant);
      if (variant === GENTLE) lossy = cleaned.lossy;
      if (variant.gentle && !variant.lines && !whole && !lossy) return [];
      const found = spans(asText(cleaned.units), needles);
      if (!found.length) return [];
      // Source ranges are tracked only when something shows, which a file with no secret never pays.
      const { from, to, finals } = clean(view.units, variant, true);
      const out = [];
      for (let [a, b, , env, headed] of found) {
        while (a < b && finals.has(from[a])) a++;
        while (b > a && finals.has(from[b - 1])) b--;
        if (a < b) out.push({ start: from[a], end: to[b - 1], env, headed });
      }
      return out;
    };
    // The end of the shortest token shape at each start, to tell a whole head before a line break.
    let heads = null;
    for (const variant of VARIANTS) {
      if (variant.gentle && !(variant.lines ? broken : escaped)) continue;
      if (variant.gentle === 'join' && !lossy) continue;
      for (const s of secrets(variant)) {
        if (variant.lines && !s.env) {
          // lines: a header value runs to its line's end, and a token that ends its line would
          // otherwise take the next line's first word.
          const lineAt = view.units.subarray(s.start, s.end).indexOf(0x0a);
          if (lineAt < 0 || s.headed) continue;
          if (!heads) {
            heads = new Map();
            for (const p of secrets(GENTLE, true)) if (!p.env) heads.set(p.start, Math.min(heads.get(p.start) ?? Infinity, p.end));
          }
          if ((heads.get(s.start) ?? Infinity) <= s.start + lineAt) continue;
        }
        const [start, end] = view.bytes(s.start, s.end);
        if (!covered(start, end)) return { missed: `a secret ${view.name} ${variant.name}` };
      }
    }
  }
  if (!removed.length) return { body: buffer };
  const parts = [];
  let at = 0;
  for (const { start, end, label } of removed) {
    parts.push(buffer.subarray(at, start), Buffer.from(`[redacted:${label}]`, 'latin1'));
    at = end;
  }
  parts.push(buffer.subarray(at));
  return { body: Buffer.concat(parts) };
}

module.exports = { redactBinary };
