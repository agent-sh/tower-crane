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
//
// Files reach 64 MiB, so no view keeps a map per unit: one scratch array serves every view, a find
// is mapped back to its bytes by a second pass, and views that would read the same text are skipped.
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

// Writes units (bytes or UTF-16 code units) with escapes and controls removed, as the variant says,
// into out, and returns how many were kept, counting the escapes it removed in seen. Given map instead, the spans lo to hi of a span list
// whose starts and ends are kept positions, each ascending, it rewrites them in place as source
// positions, a space standing for its whole control run. Mapping in a second pass, only when
// something shows, keeps memory to the spans found instead of a map per unit.
function clean(u, { escapes, put }, out, map, seen) {
  let ps = map ? map.lo : 0;
  let pe = ps;
  const hi = map ? map.hi : 0;
  const starts = map?.list.start;
  const ends = map?.list.end;
  // Maps kept position n, from source range [from, to); true once every span is mapped.
  const mark = (n, from, to) => {
    while (ps < hi && starts[ps] === n) starts[ps++] = from;
    while (pe < hi && ends[pe] - 1 === n) ends[pe++] = to;
    return pe === hi;
  };
  let n = 0;
  let run = -1;
  let runEnd = -1;
  for (let i = 0; i < u.length;) {
    const c = u[i];
    if (escapes && c === ESC) {
      const end = escapeEnd(u, i);
      if (end > 0) {
        if (seen) seen.escapes++;
        i = end;
        continue;
      }
    }
    if (control(c)) {
      if (run < 0) run = i;
      runEnd = ++i;
      continue;
    }
    if (run >= 0) {
      if (put) {
        if (!map) out[n] = 0x20;
        else if (mark(n, run, runEnd)) return n + 1;
        n++;
      }
      run = -1;
    }
    if (!map) out[n] = c;
    else if (mark(n, i, i + 1)) return n + 1;
    n++;
    i++;
  }
  // A trailing run makes no space: nothing after it could join a secret.
  return n;
}

const cleaned = (u, variant) => {
  const out = new u.constructor(u.length);
  return out.subarray(0, clean(u, variant, out));
};

const LE = os.endianness() === 'LE';
// The first n units of out as a string. out is scratch, so a big-endian host swaps it in place.
const asText = (out, n) => {
  if (out instanceof Uint8Array) return Buffer.from(out.buffer, out.byteOffset, n).toString('latin1');
  const b = Buffer.from(out.buffer, out.byteOffset, n * 2);
  return (LE ? b : b.swap16()).toString('utf16le');
};
const wide = (s) => Uint16Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

// Spans as parallel lists, 12 bytes each however many a file holds: start, end and tag, the index
// of the literal that matched or the literal count plus the shape's index. groups holds the index
// range [lo, hi) of each literal's and each shape's spans, whose starts and ends both ascend: a
// literal's occurrences share a length, and a global regex's matches do not overlap.
function spanList() {
  let size = 1024;
  const list = { start: new Int32Array(size), end: new Int32Array(size), tag: new Int32Array(size), length: 0, groups: [] };
  list.push = (a, b, t) => {
    if (list.length === size) {
      size *= 2;
      for (const key of ['start', 'end', 'tag']) {
        const grown = new Int32Array(size);
        grown.set(list[key]);
        list[key] = grown;
      }
    }
    list.start[list.length] = a;
    list.end[list.length] = b;
    list.tag[list.length++] = t;
  };
  return list;
}

// The secrets in text: every occurrence of every literal, overlapping ones included, and the secret
// part of every token shape.
function spans(text, literals) {
  const out = spanList();
  const group = (lo) => { if (out.length > lo) out.groups.push([lo, out.length]); };
  literals.forEach(([needle], k) => {
    if (!needle) return;
    const lo = out.length;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) out.push(at, at + needle.length, k);
    group(lo);
  });
  TOKEN_SHAPES.forEach(({ re, prefix }, k) => {
    const lo = out.length;
    for (const m of text.matchAll(re)) {
      const start = m.index + (prefix ? m[1].length : 0);
      const end = m.index + m[0].length;
      if (end > start) out.push(start, end, literals.length + k);
    }
    group(lo);
  });
  return out;
}

// Overlapping and touching spans as one, tagged by its first literal (an environment value), else
// its first shape, as the text redactor prefers a variable's name. The groups are merged in order of
// start, the longer span first and the earlier group on a tie.
function merge(list, literals) {
  const { start, end, tag, groups } = list;
  const at = groups.map(([lo]) => lo);
  const merged = spanList();
  for (;;) {
    let g = -1;
    for (let k = 0; k < groups.length; k++) {
      const i = at[k];
      if (i >= groups[k][1]) continue;
      const j = g < 0 ? -1 : at[g];
      if (j < 0 || start[i] < start[j] || (start[i] === start[j] && end[i] > end[j])) g = k;
    }
    if (g < 0) return merged;
    const i = at[g]++;
    const last = merged.length - 1;
    if (last >= 0 && start[i] <= merged.end[last]) {
      merged.end[last] = Math.max(merged.end[last], end[i]);
      if (tag[i] < literals && merged.tag[last] >= literals) merged.tag[last] = tag[i];
    } else {
      merged.push(start[i], end[i], tag[i]);
    }
  }
}

// The views of a buffer: name, units (a function, since a UTF-16 view is built in scratch), the
// literals in its encoding, and the byte range of a unit range. A UTF-16 code unit below 0x80 has a
// zero byte, so the UTF-16 views run only when the buffer has a NUL byte, which every token shape and
// ASCII value needs there, or a value is not ASCII.
function* views(buffer, values) {
  yield {
    name: 'as bytes',
    units: () => buffer,
    literals: values.map(([value, label]) => [new Uint8Array(Buffer.from(value, 'utf8')), label]),
    bytes: (a, b) => [a, b],
  };
  if (!buffer.includes(0) && values.every(([value]) => /^[\x00-\x7f]*$/.test(value))) return;
  const literals = values.map(([value, label]) => [wide(value), label]);
  for (const [name, big] of [['UTF-16LE', false], ['UTF-16BE', true]]) {
    for (const off of [0, 1]) {
      const units = (scratch) => {
        const u = new Uint16Array(scratch, 0, (buffer.length - off) >> 1);
        for (let k = 0, p = off; k < u.length; k++, p += 2) {
          u[k] = big ? (buffer[p] << 8) | buffer[p + 1] : buffer[p] | (buffer[p + 1] << 8);
        }
        return u;
      };
      yield { name: `as ${name}${off ? ' from its second byte' : ''}`, units, literals, bytes: (a, b) => [off + 2 * a, off + 2 * b] };
    }
  }
}

// buffer redacted at its exact byte matches, or `missed` naming a view where a secret shows that
// those matches did not remove. values are [value, label] pairs.
function redactBinary(buffer, values) {
  const literals = values.map(([value, label]) => [Buffer.from(value, 'utf8').toString('latin1'), label]);
  const removed = merge(spans(buffer.toString('latin1'), literals), literals.length);
  const covered = (start, end) => {
    let lo = 0;
    let hi = removed.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (removed.start[mid] <= start) lo = mid;
      else hi = mid - 1;
    }
    return removed.length > 0 && removed.start[lo] <= start && end <= removed.end[lo];
  };
  // One array for every view and variant. The byte view is cleaned into it; a UTF-16 view is built
  // in it and cleaned in place, which works since the cleanup never writes ahead of its read, and
  // built again for each variant and each mapping pass.
  const scratch = new ArrayBuffer(buffer.length + (buffer.length & 1));
  for (const view of views(buffer, values)) {
    // A value with no control in it is the same in every variant.
    const plain = view.literals.every(([needle]) => !needle.some(control));
    const seen = { escapes: 0 };
    for (const variant of VARIANTS) {
      // Without an escape, removing controls alone reads what removing both read.
      if (plain && !variant.escapes && !seen.escapes) break;
      const needles = view.literals.map(([needle, label]) => {
        const c = cleaned(needle, variant);
        return [asText(c, c.length), label];
      });
      const units = view.units(scratch);
      const out = units === buffer ? new Uint8Array(scratch, 0, buffer.length) : units;
      const kept = clean(units, variant, out, null, variant === VARIANTS[0] ? seen : null);
      // With no escape or control in the view, every variant reads the same text. The byte view
      // then is the text the exact matches read, so whatever shows there was removed.
      const untouched = plain && variant === VARIANTS[0] && kept === units.length;
      if (untouched && units === buffer) break;
      const found = spans(asText(out, kept), needles);
      for (const [lo, hi] of found.groups) {
        clean(view.units(scratch), variant, null, { list: found, lo, hi });
        for (let k = lo; k < hi; k++) {
          const [start, end] = view.bytes(found.start[k], found.end[k]);
          if (!covered(start, end)) return { missed: `a secret ${view.name} ${variant.name}` };
        }
      }
      if (untouched) break;
    }
  }
  if (!removed.length) return { body: buffer };
  const label = (t) => (t < literals.length ? literals[t][1] : TOKEN_SHAPES[t - literals.length].label);
  const markers = new Map();
  const marker = (t) => {
    if (!markers.has(t)) markers.set(t, Buffer.from(`[redacted:${label(t)}]`, 'latin1'));
    return markers.get(t);
  };
  let size = buffer.length;
  for (let k = 0; k < removed.length; k++) size += marker(removed.tag[k]).length - (removed.end[k] - removed.start[k]);
  const body = Buffer.allocUnsafe(size);
  let at = 0;
  let put = 0;
  for (let k = 0; k < removed.length; k++) {
    put += buffer.copy(body, put, at, removed.start[k]);
    put += marker(removed.tag[k]).copy(body, put);
    at = removed.end[k];
  }
  buffer.copy(body, put, at);
  return { body };
}

module.exports = { redactBinary };
