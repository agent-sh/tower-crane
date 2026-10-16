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
// before a token would otherwise take its first character as an escape). A secret found in any of
// those views that the exact matches did not remove whole makes the file missed, and the caller
// does not copy it.
const os = require('node:os');
const { TOKEN_SHAPES } = require('./ci-log-text');

const VARIANTS = [
  { name: 'with escapes and controls removed', escapes: true, put: false },
  { name: 'with escapes removed and controls made spaces', escapes: true, put: true },
  { name: 'with controls removed', escapes: false, put: false },
];

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
// track, also the source range [from, to) of each unit kept, a space standing for its control run.
function clean(u, { escapes, put }, track) {
  const out = u instanceof Uint16Array ? new Uint16Array(u.length) : new Uint8Array(u.length);
  const from = track ? new Int32Array(u.length) : null;
  const to = track ? new Int32Array(u.length) : null;
  let n = 0;
  let run = -1;
  let runEnd = -1;
  for (let i = 0; i < u.length;) {
    const c = u[i];
    if (escapes && c === ESC) {
      const end = escapeEnd(u, i);
      if (end > 0) { i = end; continue; }
    }
    if (control(c)) {
      if (run < 0) run = i;
      runEnd = ++i;
      continue;
    }
    if (run >= 0) {
      if (put) {
        if (track) { from[n] = run; to[n] = runEnd; }
        out[n++] = 0x20;
      }
      run = -1;
    }
    if (track) { from[n] = i; to[n] = i + 1; }
    out[n++] = c;
    i++;
  }
  // A trailing run makes no space: nothing after it could join a secret.
  return { units: out.subarray(0, n), from, to };
}

const LE = os.endianness() === 'LE';
const asText = (u) => {
  if (u instanceof Uint8Array) return Buffer.from(u.buffer, u.byteOffset, u.length).toString('latin1');
  const b = Buffer.from(u.buffer, u.byteOffset, u.length * 2);
  return (LE ? b : Buffer.from(b).swap16()).toString('utf16le');
};
const wide = (s) => Uint16Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const narrow = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));

// Source spans [start, end, label, env] of the secrets in text: every occurrence of every literal,
// overlapping ones included, and the secret part of every token shape, found in mode (lib/ci-log-text.js).
function spans(text, literals, mode) {
  const out = [];
  for (const [needle, label] of literals) {
    if (!needle) continue;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) out.push([at, at + needle.length, label, true]);
  }
  for (const { find, label } of TOKEN_SHAPES) {
    for (const [, start, end] of find(text, mode)) out.push([start, end, label, false]);
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
    for (const variant of VARIANTS) {
      const needles = view.literals.map(([needle, label]) => [asText(clean(needle, variant).units), label]);
      // An AWS key glued to the next word only once a control between them goes, as in
      // `AKIA...\x00DONE`, ends at its 16th character, where the exact match ends it.
      const found = spans(asText(clean(view.units, variant).units), needles, 'join');
      if (!found.length) continue;
      // Source ranges are tracked only when something shows, which a file with no secret never pays.
      const { from, to } = clean(view.units, variant, true);
      for (const [a, b] of found) {
        const [start, end] = view.bytes(from[a], to[b - 1]);
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
