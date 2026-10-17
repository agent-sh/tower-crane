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
// before a token would otherwise take its first character as an escape). Two more variants remove
// escapes gently, as lib/escape-views.js does for text, when an escape is lossy (it keeps a final
// byte or leaves a string unterminated): a stray ESC or an unterminated string loses only its
// introducer, so a token whose first character or head an escape would take, and which a second
// escape also splits, still shows. In one a two-character escape becomes a space, which keeps a
// word before the stray ESC apart from the token, and the other joins it. The gently cleaned units
// are also read across line breaks (acrossLines), for a secret split across lines. A secret found
// in any of those views that the exact matches did not remove whole makes the file missed, and the
// caller does not copy it.
//
// Files reach 64 MiB, so no view keeps a map per unit: one scratch array serves every view, a find
// is mapped back to its bytes by a later pass, variants that would read the same text are skipped,
// and a UTF-16 view is first read as a one-byte probe (see narrow in redactBinary).
const os = require('node:os');
const { tokenMatches, TOKEN_LEAD, shapeMatches } = require('./ci-log-text');
const { gentleEscape, acrossLines, mayJoin, valueSpans } = require('./escape-views');

const VARIANTS = [
  { name: 'with escapes and controls removed', escapes: true, put: false },
  { name: 'with escapes removed and controls made spaces', escapes: true, put: true },
  { name: 'with controls removed', escapes: false, put: false },
  { name: 'with escapes removed gently', gentle: 'escape' },
  { name: 'with escapes removed gently and joined', gentle: 'join' },
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

// Cleans units (bytes or UTF-16 code units), removing escapes and controls as the variant says, and
// returns { n, the count kept, lossy, whether a gentle variant kept a final or left a string
// unterminated, whole, whether it removed and replaced nothing, so the units are as they were }. The options say what the pass records: out takes the kept units; seen.escapes
// counts the escapes removed; finals takes the kept positions whose source is a final byte a
// gentle variant keeps, or the control run a space stands for when that run starts at one; and
// want, kept positions in ascending order, gets the source range [from, to) of each, a space
// standing for its whole control run. Mapping a find back in a later pass, only when something
// shows, keeps memory to the finds instead of a map per unit.
function clean(u, { escapes, put, gentle }, { out = null, seen = null, finals = null, want = null, from = null, to = null } = {}) {
  const at = (k) => u[k];
  const wants = want ? want.length : 0;
  let w = 0;
  let n = 0;
  let run = -1;
  let runEnd = -1;
  let runFinal = false;
  let spaced = false;
  let lossy = false;
  let whole = true;
  // Finals come in increasing order and the scan resumes at each, so a unit is a final exactly
  // when it is the last one recorded.
  let lastFinal = -1;
  for (let i = 0; i < u.length;) {
    const c = u[i];
    if (gentle && c === ESC) {
      const [end, final, two, open] = gentleEscape(at, u.length, i, false);
      whole = false;
      if (run < 0) { run = i; runFinal = i === lastFinal; }
      runEnd = end;
      spaced ||= gentle === 'escape' && two;
      if (final) lastFinal = end;
      lossy ||= final || open;
      i = end;
      continue;
    }
    if (escapes && c === ESC) {
      const end = escapeEnd(u, i);
      if (end > 0) {
        if (seen) seen.escapes++;
        whole = false;
        i = end;
        continue;
      }
    }
    if (control(c)) {
      if (run < 0) { run = i; runFinal = i === lastFinal; }
      runEnd = ++i;
      whole = false;
      continue;
    }
    if (run >= 0) {
      if (put || spaced) {
        if (out) out[n] = 0x20;
        if (finals && runFinal) finals.push(n);
        if (w < wants && want[w] === n) {
          from[w] = run;
          to[w] = runEnd;
          if (++w === wants) return { n: n + 1, lossy, whole: false };
        }
        n++;
      }
      run = -1;
      spaced = false;
    }
    if (out) out[n] = c;
    if (finals && i === lastFinal) finals.push(n);
    if (w < wants && want[w] === n) {
      from[w] = i;
      to[w] = i + 1;
      if (++w === wants) return { n: n + 1, lossy, whole: false };
    }
    n++;
    i++;
  }
  // A trailing run makes no space: nothing after it could join a secret.
  return { n, lossy, whole };
}

const cleaned = (u, variant) => {
  const out = new u.constructor(u.length);
  return out.subarray(0, clean(u, variant, { out }).n);
};

const LE = os.endianness() === 'LE';
// The first n units of u as a string. Only scratch or a fresh array is swapped in place on a
// big-endian host.
const asText = (u, n = u.length) => {
  if (u instanceof Uint8Array) return Buffer.from(u.buffer, u.byteOffset, n).toString('latin1');
  const b = Buffer.from(u.buffer, u.byteOffset, n * 2);
  return (LE ? b : b.swap16()).toString('utf16le');
};
const wide = (s) => Uint16Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

// A growable list of Int32 columns, so that millions of spans cost a few bytes each.
function columns(...keys) {
  let size = 1024;
  const list = { length: 0 };
  for (const key of keys) list[key] = new Int32Array(size);
  list.push = (...values) => {
    if (list.length === size) {
      size *= 2;
      for (const key of keys) {
        const grown = new Int32Array(size);
        grown.set(list[key]);
        list[key] = grown;
      }
    }
    keys.forEach((key, k) => { list[key][list.length] = values[k]; });
    list.length++;
  };
  return list;
}
const spanList = () => columns('start', 'end', 'tag');

// The secrets in text, with tag an index into labels: every occurrence of every literal, overlapping
// ones included, and the secret part of every token shape. labels starts with the literals' labels,
// so a tag below their count is an environment value, and gains the shapes'.
function spans(text, literals, labels) {
  const out = spanList();
  literals.forEach(([needle], k) => {
    if (!needle) return;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) out.push(at, at + needle.length, k);
  });
  tokenMatches(text, 'redact', (at, start, end, label) => {
    if (end <= start) return;
    let t = labels.indexOf(label, literals.length);
    if (t < 0) t = labels.push(label) - 1;
    out.push(start, end, t);
  });
  return out;
}

// Overlapping and touching spans as one, tagged by its first environment value, else its first
// shape, as the text redactor prefers a variable's name. Spans are taken by start, the longer
// first, then in the order found.
function merge(list, literals) {
  const { start, end, tag } = list;
  const order = Uint32Array.from({ length: list.length }, (_, i) => i);
  order.sort((x, y) => start[x] - start[y] || end[y] - end[x] || x - y);
  const merged = spanList();
  for (const i of order) {
    const last = merged.length - 1;
    if (last >= 0 && start[i] <= merged.end[last]) {
      merged.end[last] = Math.max(merged.end[last], end[i]);
      if (tag[i] < literals && merged.tag[last] >= literals) merged.tag[last] = tag[i];
    } else {
      merged.push(start[i], end[i], tag[i]);
    }
  }
  return merged;
}

// Index of the first value in the sorted list a[0, n) that is at least p.
function lowerBound(a, n, p) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The source ranges [a, b) of the found spans of kept positions in a view, as columns, each without
// a kept final byte at either edge, since a final next to a token may be an escape's and not the
// token's; a span of finals alone is dropped. units() gives the view's units afresh. One pass finds
// the finals, another maps the sorted, distinct positions the spans start and end at, whatever
// order the spans came in. A pair array per span held 110 MB for 1.6M tokens split across lines.
function sources(units, variant, found) {
  const finals = columns('at');
  if (variant.gentle) clean(units(), variant, { finals });
  const final = (p) => {
    const k = lowerBound(finals.at, finals.length, p);
    return k < finals.length && finals.at[k] === p;
  };
  const kept = columns('a', 'b');
  for (let k = 0; k < found.length; k++) {
    let a = found.start[k];
    let b = found.end[k];
    while (a < b && final(a)) a++;
    while (b > a && final(b - 1)) b--;
    if (a < b) kept.push(a, b);
  }
  const out = columns('a', 'b');
  if (!kept.length) return out;
  const want = new Int32Array(kept.length * 2);
  for (let k = 0; k < kept.length; k++) {
    want[2 * k] = kept.a[k];
    want[2 * k + 1] = kept.b[k] - 1;
  }
  want.sort();
  let m = 0;
  for (let k = 0; k < want.length; k++) if (!m || want[k] !== want[m - 1]) want[m++] = want[k];
  const at = want.subarray(0, m);
  const from = new Int32Array(m);
  const to = new Int32Array(m);
  clean(units(), variant, { want: at, from, to });
  for (let k = 0; k < kept.length; k++) out.push(from[lowerBound(at, m, kept.a[k])], to[lowerBound(at, m, kept.b[k] - 1)]);
  return out;
}

// Fill bytes for a UTF-16 view's probe: C1 controls that start no escape.
const FILLS = [0x80, 0x81, 0x82, 0x83, 0x84, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f];

// Whether valueSpans could find literal in units: it starts a search only at the literal's first
// character followed by its second or by a control or line break. This reads the units without
// making a string of them.
function mayHold(units, literal) {
  if (literal.length < 2) return false;
  const [first, second] = literal;
  for (let k = units.indexOf(first); k >= 0; k = units.indexOf(first, k + 1)) {
    const d = k + 1 < units.length ? units[k + 1] : -1;
    if (d === second || (d >= 0 && d <= 0x08) || (d >= 0x0a && d <= 0x1f) || (d >= 0x7f && d <= 0x9f)) return true;
  }
  return false;
}

// The views of a buffer: name, units(scratch), which gives its units (a UTF-16 view is built in
// scratch, and built again after a cleanup in place), the literals in its encoding, and the byte
// range of a unit range. A UTF-16 code unit below 0x80 has a zero byte, so the UTF-16 views run only
// when the buffer has a NUL byte, which every token shape and ASCII value needs there, or a value is
// not ASCII.
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
  const labels = literals.map(([, label]) => label);
  // The bytes as latin1: what the exact matches read, and the byte view's raw text.
  let exact = buffer.toString('latin1');
  const removed = merge(spans(exact, literals, labels), literals.length);
  const covered = (start, end) => {
    const k = lowerBound(removed.start, removed.length, start + 1) - 1;
    return k >= 0 && removed.start[k] <= start && end <= removed.end[k];
  };
  // One array for every view and variant. The byte view is cleaned into it; a UTF-16 view is built
  // in it and cleaned in place, which works since the cleanup never writes ahead of its read.
  const scratch = new ArrayBuffer(buffer.length + (buffer.length & 1));
  // A UTF-16 view's units rewritten in place one byte each, each run of units above 0xff made one
  // fill byte, a C1 control no value holds: the view's own text when no unit is above 0xff, at half
  // the size. Otherwise a probe, often far shorter. The token shapes' prefixes, word characters and
  // bodies are ASCII, and a JavaScript regular expression without the u flag never folds a
  // character above 0x7f into ASCII, so a shape matches in the probe wherever it matches in the
  // view; a value whose units are all below 0x100 shows in it wherever it does there, since the
  // fill byte is one more control between its characters. A cleanup whose probe shows nothing is
  // not made a UTF-16 string: V8 counts one at half its size when it decides to collect, so dead
  // ones piled up.
  const narrow = (u, n, fill) => {
    const b = new Uint8Array(u.buffer, u.byteOffset, n);
    let m = 0;
    let exactly = true;
    let gap = false;
    for (let k = 0; k < n; k++) {
      const c = u[k];
      if (c <= 0xff) {
        b[m++] = c;
        gap = false;
      } else {
        exactly = false;
        if (!gap) b[m++] = fill;
        gap = true;
      }
    }
    return { text: Buffer.from(b.buffer, b.byteOffset, m).toString('latin1'), exactly };
  };
  for (const view of views(buffer, values)) {
    const fresh = () => view.units(scratch);
    const raw = fresh();
    const bytes = raw === buffer;
    const escaped = raw.indexOf(ESC) >= 0;
    const broken = raw.indexOf(0x0a) >= 0;
    const used = new Set(view.literals.flatMap(([needle]) => [...needle]));
    const fill = FILLS.find((c) => !used.has(c));
    const probes = !bytes && fill !== undefined && view.literals.every(([needle]) => needle.every((c) => c <= 0xff));
    // The view's units as text, made once: a cleanup that leaves them whole reads it too.
    let rawText = bytes ? exact : null;
    let rawProbe = null;
    // The probe of the raw units, or null when the text itself is no bigger.
    const probe = () => {
      if (!probes || rawText !== null) return null;
      if (rawProbe === null) {
        const one = narrow(fresh(), raw.length, fill);
        if (one.exactly) rawText = one.text;
        else rawProbe = one.text;
      }
      return rawProbe;
    };
    const whole = () => {
      // A probe of units no higher than 0xff is the text itself.
      if (rawText === null) probe();
      if (rawText === null) rawText = asText(fresh());
      return rawText;
    };
    const missed = (list, name) => {
      for (let k = 0; k < list.length; k++) if (!covered(...view.bytes(list.a[k], list.b[k]))) return { missed: `a secret ${view.name} ${name}` };
      return false;
    };
    // The text of a cleanup, its units in scratch.
    const cleanup = (variant, seen) => {
      const units = fresh();
      const out = bytes ? new Uint8Array(scratch, 0, buffer.length) : units;
      const pass = clean(units, variant, { out, seen });
      if (bytes) return { ...pass, probe: null, text: () => (pass.whole ? whole() : asText(out, pass.n)) };
      if (!probes) return { ...pass, probe: null, text: () => asText(out, pass.n) };
      const one = narrow(out, pass.n, fill);
      if (one.exactly) return { ...pass, probe: null, text: () => one.text };
      // The probe took the units' place, so the text cleans them again.
      return { ...pass, probe: one.text, text: () => {
        const again = fresh();
        clean(again, variant, { out: again });
        return asText(again, pass.n);
      } };
    };
    const mayShow = (probe, needles) => {
      if (probe === null) return true;
      if (needles.some(([needle]) => needle && probe.includes(needle))) return true;
      let any = false;
      tokenMatches(probe, 'redact', () => { any = true; });
      return any;
    };
    // A value with no control in it is the same in every variant but the gentle ones.
    const plain = view.literals.every(([needle]) => !needle.some(control));
    const seen = { escapes: 0 };
    let same = false;
    let lossy = false;
    for (const variant of VARIANTS) {
      if (variant.gentle && !escaped) continue;
      if (variant.gentle === 'join' && !lossy) continue;
      // With no escape or control in the view, the first three variants read the same text, and the
      // byte view reads the text the exact matches read, so whatever shows there was removed.
      // Without an escape, removing controls alone reads what removing both read.
      if (same && !variant.gentle) continue;
      if (plain && variant === VARIANTS[2] && !seen.escapes) continue;
      const needles = view.literals.map(([needle, label]) => {
        const c = cleaned(needle, variant);
        return [asText(c), label];
      });
      const pass = cleanup(variant, variant === VARIANTS[0] ? seen : null);
      if (variant === GENTLE) lossy = pass.lossy;
      if (variant.gentle && !lossy) continue;
      if (variant === VARIANTS[0] && plain && pass.whole) {
        same = true;
        if (bytes) continue;
      }
      if (!mayShow(pass.probe, needles)) continue;
      const found = spans(pass.text(), needles, needles.map(([, label]) => label));
      const result = found.length > 0 && missed(sources(fresh, variant, found), variant.name);
      if (result) return result;
    }
    // An environment value however escapes, controls and line breaks split it (valueSpans). The
    // search stops at the first span the exact matches miss.
    for (const [needle] of view.literals) {
      if (!mayHold(fresh(), needle)) continue;
      const rough = probe();
      if (rough !== null) {
        let shows = false;
        valueSpans(rough, asText(needle), () => (shows = true));
        if (!shows) continue;
      }
      let miss = false;
      valueSpans(whole(), asText(needle), (a, b) => (miss = !covered(...view.bytes(a, b))));
      if (miss) return { missed: `a secret ${view.name} with escapes, controls and line breaks inside an environment value` };
    }
    if (broken) {
      // A secret split across lines, read in the gently cleaned units (lib/escape-views.js).
      const found = columns('start', 'end');
      // The probe reads the same as the text here: token characters, line breaks and prefixes are ASCII.
      const pass = cleanup(GENTLE);
      if (mayJoin(pass.probe ?? pass.text(), TOKEN_LEAD)) acrossLines(pass.text(), shapeMatches, TOKEN_LEAD, (at, start, end) => found.push(start, end));
      const result = found.length > 0 && missed(sources(fresh, GENTLE, found), 'with escapes removed gently and line breaks removed');
      if (result) return result;
    }
    exact = null;
  }
  if (!removed.length) return { body: buffer };
  const markers = new Map();
  const marker = (t) => {
    if (!markers.has(t)) markers.set(t, Buffer.from(`[redacted:${labels[t]}]`, 'latin1'));
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
