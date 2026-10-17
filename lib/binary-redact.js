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
const { gentleEscape, acrossLines, mayJoin, valueSpans, gluedHeaders } = require('./escape-views');

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
// want, distinct kept positions in ascending order, gets the source range of each, its start in
// from and its end in to, a space standing for its whole control run. Either may be left out or be
// want itself, since a position is read before its range is written. Mapping a find back in a
// later pass, only when something shows, keeps memory to the finds instead of a map per unit.
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
          if (from) from[w] = run;
          if (to) to[w] = runEnd;
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
      if (from) from[w] = i;
      if (to) to[w] = i + 1;
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

// Adds the span [start, end) of a view to out (see spans), without its kept final bytes at either
// edge (view.final), since a final next to a token may be an escape's and not the token's; a span
// of finals alone is dropped. A span that shares a unit with the last one joins it: spans that
// share a unit map to byte ranges that share a byte, so one merged exact match covers all of them
// exactly when one covers their union.
function keep(out, view, start, end) {
  while (start < end && view.final(start)) start++;
  while (end > start && view.final(end - 1)) end--;
  if (start === end) return;
  const last = out.length - 1;
  if (last >= 0 && start < out.end[last] && end > out.start[last]) {
    out.start[last] = Math.min(out.start[last], start);
    out.end[last] = Math.max(out.end[last], end);
  } else {
    out.push(start, end);
  }
}

// The secrets in text, with tag an index into labels: the occurrences of every literal and the
// secret part of every token shape. labels starts with the literals' labels, so a tag below their
// count is an environment value, and gains the shapes'. A value of repeated `a1` in a file of
// them occurs at every other byte, and 67M spans of two such values ran out of memory, so spans
// are merged as they are found. For the exact matches (no view), an occurrence that overlaps or
// touches the last span, an earlier occurrence of the same literal, extends it, and merge sorts
// the span as its first occurrence. For a view, spans go through keep.
function spans(text, literals, labels, view = null) {
  const out = view ? columns('start', 'end') : spanList();
  literals.forEach(([needle], k) => {
    if (!needle) return;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      const last = out.length - 1;
      if (view) keep(out, view, at, at + needle.length);
      else if (last >= 0 && out.tag[last] === k && at <= out.end[last]) out.end[last] = at + needle.length;
      else out.push(at, at + needle.length, k);
    }
  });
  tokenMatches(text, 'redact', (at, start, end, label) => {
    if (end <= start) return;
    let t = labels.indexOf(label, literals.length);
    if (t < 0) t = labels.push(label) - 1;
    if (view) keep(out, view, start, end);
    else out.push(start, end, t);
  });
  return out;
}

// Overlapping and touching spans as one, tagged by its first environment value, else its first
// shape, as the text redactor prefers a variable's name. Spans are taken by start, the longer
// first, then in the order found; a literal's span, its occurrences merged (spans), is taken as
// its first occurrence, which comes before the others in that order. lengths are the literals'.
function merge(list, lengths) {
  const literals = lengths.length;
  const { start, end, tag } = list;
  const first = (i) => (tag[i] < literals ? start[i] + lengths[tag[i]] : end[i]);
  const before = (x, y) => start[x] - start[y] || first(y) - first(x) || x - y;
  let sorted = true;
  for (let i = 1; sorted && i < list.length; i++) sorted = before(i - 1, i) < 0;
  // Spans found in order, as one value's or one shape's are, merge in place: the merged list never
  // writes ahead of its read.
  const order = sorted ? null : Uint32Array.from({ length: list.length }, (_, i) => i).sort(before);
  const merged = sorted ? list : spanList();
  let n = 0;
  for (let k = 0; k < list.length; k++) {
    const i = sorted ? k : order[k];
    if (n > 0 && start[i] <= merged.end[n - 1]) {
      merged.end[n - 1] = Math.max(merged.end[n - 1], end[i]);
      if (tag[i] < literals && merged.tag[n - 1] >= literals) merged.tag[n - 1] = tag[i];
    } else if (sorted) {
      merged.start[n] = start[i];
      merged.end[n] = end[i];
      merged.tag[n++] = tag[i];
    } else {
      merged.push(start[i], end[i], tag[i]);
      n++;
    }
  }
  merged.length = n;
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

// The view keep reads for a variant: final(p), whether kept position p is a final byte a gentle
// variant keeps. units() gives the view's units afresh. The finals are found at the first find, so
// a view that shows nothing makes no pass for them; the text being searched is a string by then.
function finalsOf(units, variant) {
  if (!variant.gentle) return { final: () => false };
  let finals = null;
  return {
    final: (p) => {
      if (finals === null) {
        finals = columns('at');
        clean(units(), variant, { finals });
      }
      const k = lowerBound(finals.at, finals.length, p);
      return k < finals.length && finals.at[k] === p;
    },
  };
}

// The found spans of kept positions in a view (keep) as source ranges [start, end). units() gives
// the view's units afresh. Spans out of order, as several values' and shapes' come, are sorted, and
// those that share a unit merged (keep). The starts then rise, and so do the last positions, so one
// pass maps the starts in place and another the last positions: millions of finds need no more
// memory than they hold.
function sources(units, variant, found) {
  let { start, end, length: n } = found;
  let sorted = true;
  for (let k = 1; sorted && k < n; k++) sorted = start[k - 1] < start[k] && end[k - 1] <= start[k];
  if (!sorted) {
    const order = Uint32Array.from({ length: n }, (_, k) => k).sort((x, y) => start[x] - start[y]);
    const a = new Int32Array(n);
    const b = new Int32Array(n);
    let m = 0;
    for (const k of order) {
      if (m > 0 && start[k] < b[m - 1]) {
        b[m - 1] = Math.max(b[m - 1], end[k]);
      } else {
        a[m] = start[k];
        b[m++] = end[k];
      }
    }
    [start, end, n] = [a, b, m];
  }
  start = start.subarray(0, n);
  end = end.subarray(0, n);
  clean(units(), variant, { want: start, from: start });
  for (let k = 0; k < n; k++) end[k]--;
  clean(units(), variant, { want: end, to: end });
  return { start, end, length: n };
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
        const u = new Uint16Array(scratch, 0, Math.max(0, buffer.length - off) >> 1);
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
  const removed = merge(spans(exact, literals, labels), literals.map(([needle]) => needle.length));
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
      for (let k = 0; k < list.length; k++) {
        if (!covered(...view.bytes(list.start[k], list.end[k]))) return { missed: `a secret ${view.name} ${name}` };
      }
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
      const found = spans(pass.text(), needles, needles.map(([, label]) => label), finalsOf(fresh, variant));
      const result = found.length > 0 && missed(sources(fresh, variant, found), variant.name);
      if (result) return result;
    }
    // An environment value however escapes, controls and line breaks split it (valueSpans), read
    // both with a value's characters inside escapes and with escapes only as a terminal reads
    // them, as the text path does. The search stops at the first span the exact matches miss.
    for (const [needle] of view.literals) {
      if (!mayHold(fresh(), needle)) continue;
      const rough = probe();
      if (rough !== null) {
        let shows = false;
        for (const more of [true, false]) if (!shows) valueSpans(rough, asText(needle), () => (shows = true), more);
        if (!shows) continue;
      }
      let miss = false;
      for (const more of [true, false]) if (!miss) valueSpans(whole(), asText(needle), (a, b) => (miss = !covered(...view.bytes(a, b))), more);
      if (miss) return { missed: `a secret ${view.name} with escapes, controls and line breaks inside an environment value` };
    }
    // A header value whose header an escape glues to a word (gluedHeaders).
    if (escaped) {
      const rough = probe();
      if (rough === null || /authorization:/i.test(rough)) {
        for (const [, s, b] of gluedHeaders(whole(), shapeMatches)) {
          if (!covered(...view.bytes(s, b))) return { missed: `a secret ${view.name} with an escape glued to a header` };
        }
      }
    }
    if (broken) {
      // A secret split across lines, read in the gently cleaned units (lib/escape-views.js), and,
      // when an escape is lossy, in those with the escape's space inside a token removed, where a
      // lone ESC's kept final is the token's character, and in those with every escape removed
      // whole, as when a real `ESC (B` and a line break split one token: the gentle view puts a
      // space and keeps the final there.
      for (const variant of lossy ? [GENTLE, VARIANTS[4], VARIANTS[0]] : [GENTLE]) {
        const found = columns('start', 'end');
        // The probe reads the same as the text here: token characters, line breaks and prefixes are ASCII.
        const pass = cleanup(variant);
        const view = finalsOf(fresh, variant);
        // The text is made once: made again for the join, it held a second copy, 64 MiB more.
        let text = pass.probe ?? pass.text();
        if (mayJoin(text, TOKEN_LEAD)) {
          if (pass.probe !== null) text = pass.text();
          acrossLines(text, shapeMatches, TOKEN_LEAD, (at, start, end) => keep(found, view, start, end));
        }
        text = null;
        const result = found.length > 0 && missed(sources(fresh, variant, found), `${variant.name.replace(/ and controls removed$/, ', controls').replace(/ and joined$/, ', joined,')} and line breaks removed`);
        if (result) return result;
      }
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
