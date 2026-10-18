'use strict';

const { textWork, textMap } = require('./text-redaction-budget');

// Views of terminal text for finding the secrets that escape removal hides. The cleanup in
// lib/ci-log-text.js reads text as a terminal does: a lone ESC or `ESC (` takes the character after
// it as the end of a two-character escape, and an OSC string without its terminator takes the rest
// of its line. When the characters taken belong to a token that a second escape also splits, what
// is left matches no pattern and the token's pieces reach the log. A token split across two lines
// matches none either. These views remove an escape only where nothing else can be lost: a CSI
// sequence with its final byte and a terminated string go whole, an unterminated string loses only
// its introducer, and a two-character escape loses only its ESC and intermediate bytes, keeping the
// character after them (its final). One view also removes line breaks.

const ESC = 0x1b;
const BEL = 0x07;

// The characters of a token shape's run: letters, digits, _ and -.
const tokenCharacter = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x2d;

// The escape that starts at unit i, ESC or, with c1, an 8-bit CSI or string introducer, as
// [end, final, two, open]: units [i, end) go; two marks a two-character escape, final says the unit
// at end is its final byte, which stays, and open marks a string without its terminator, of which
// only the introducer goes. at(k) reads unit k of n. memo holds, per string kind, the end of the
// last body scan that found no terminator: a later string of that kind starting inside it finds
// none either, so the body is not scanned again and many unterminated strings stay linear.
function gentleEscape(at, n, i, c1, memo) {
  textWork();
  const c = at(i);
  let kind;
  let body;
  if (c === ESC) {
    const d = i + 1 < n ? at(i + 1) : -1;
    if (d === 0x5d) kind = 'osc';
    else if (d === 0x50 || d === 0x58 || d === 0x5e || d === 0x5f) kind = 'string';
    else if (d === 0x5b) kind = 'csi';
    else {
      let j = i + 1;
      while (j < n && at(j) >= 0x20 && at(j) <= 0x2f) j++;
      return [j, j < n && at(j) >= 0x30 && at(j) <= 0x7e, true, false];
    }
    body = i + 2;
  } else if (c1 && c === 0x9d) {
    kind = 'osc';
    body = i + 1;
  } else if (c1 && (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f)) {
    kind = 'string';
    body = i + 1;
  } else if (c1 && c === 0x9b) {
    kind = 'csi';
    body = i + 1;
  } else {
    return [i + 1, false, false, false];
  }
  if (kind === 'csi') {
    // `ESC [` right before a token reads as a CSI whose final byte is the token's first letter, as
    // a lone ESC does; a CSI without parameters such as `ESC [m` before a word reads the same, so
    // its letter stays as a final.
    const f = body < n ? at(body) : -1;
    if (((f >= 0x41 && f <= 0x5a) || (f >= 0x61 && f <= 0x7a)) && body + 1 < n && tokenCharacter(at(body + 1))) return [body, true, true, false];
    let j = body;
    while (j < n && at(j) >= 0x30 && at(j) <= 0x3f) j++;
    while (j < n && at(j) >= 0x20 && at(j) <= 0x2f) j++;
    return [j < n && at(j) >= 0x40 && at(j) <= 0x7e ? j + 1 : body, false, false, false];
  }
  if (memo && body < (memo[kind] ?? -1)) return [body, false, false, true];
  let j = body;
  for (; j < n; j++) {
    const u = at(j);
    if (u === ESC || u === 0x0a || (c1 && u === 0x9c) || (kind === 'osc' && u === BEL)) break;
  }
  if (j < n) {
    const u = at(j);
    if (u === BEL || u === 0x9c) return [j + 1, false, false, false];
    if (u === ESC && j + 1 < n && at(j + 1) === 0x5c) return [j + 2, false, false, false];
  }
  if (memo) memo[kind] = j;
  return [body, false, false, true];
}

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

// Kept stretches of a view: stretch k starts at view index v[k] and source index s[k]. Each push
// costs units of the text budget.
function stretches(units = 1) {
  let v = textMap(64);
  let s = textMap(64);
  let n = 0;
  // The index of the last stretch that starts at or before view index i.
  const find = (i) => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (v[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return {
    push(at, from) {
      textWork(units);
      if (n === v.length) {
        const grow = (a) => { const b = textMap(a.length * 2); b.set(a); return b; };
        v = grow(v);
        s = grow(s);
      }
      v[n] = at;
      s[n++] = from;
    },
    find,
    start: (k) => v[k],
    // The source index of view index i.
    src: (i) => {
      const k = find(i);
      return s[k] + (i - v[k]);
    },
  };
}

// Source indices in increasing order, with has(i).
function sortedSet() {
  let a = textMap(16);
  let n = 0;
  return {
    add(i) {
      textWork();
      if (n === a.length) {
        const b = textMap(a.length * 2);
        b.set(a);
        a = b;
      }
      a[n++] = i;
    },
    has(i) {
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid] < i) lo = mid + 1;
        else hi = mid;
      }
      return lo < n && a[lo] === i;
    },
    get size() {
      return n;
    },
    values() {
      return a.subarray(0, n);
    },
  };
}
const NO_FINALS = { has: () => false };

// A view of text with escapes removed gently and the other controls removed. A removed run with a
// two-character escape becomes one space, since its final byte may start a token right after a
// word (`a\x1bghp_...`); sites lists the view indices of the spaces put between two token
// characters, which unspace() removes again for a token that a second such escape splits. A
// carriage return run ends a line, as in the cleanup. Returns { text, src(i), the source index of
// view character i, finals, the source indices of kept final bytes, sites, lossy, true when an
// escape kept a final or left a string body that the cleanup would remove }.
function gentleView(source) {
  if (!CONTROL.test(source)) return { text: source, src: (i) => i, finals: NO_FINALS, sites: null, lossy: false };
  const n = source.length;
  const at = (k) => source.charCodeAt(k);
  const memo = {};
  const kept = stretches();
  const parts = [];
  const finals = sortedSet();
  const sites = sortedSet();
  let lossy = false;
  let last = -1;
  let len = 0;
  let from = 0;
  let gap = -1;
  let spaced = false;
  const put = (text, src) => {
    kept.push(len, src);
    parts.push(text);
    len += text.length;
    last = text.charCodeAt(text.length - 1);
  };
  const keep = (to) => {
    if (to <= from) return;
    if (gap >= 0 && spaced) {
      if (tokenCharacter(last) && tokenCharacter(at(from))) sites.add(len);
      put(' ', gap);
    }
    gap = -1;
    spaced = false;
    put(source.slice(from, to), from);
  };
  const drop = (i, end, spaces) => {
    keep(i);
    if (gap < 0) gap = i;
    spaced ||= spaces;
    from = end;
  };
  const stop = new RegExp(CONTROLS.source, 'g');
  for (let m = stop.exec(source); m; m = stop.exec(source)) {
    const i = m.index;
    const c = at(i);
    let end;
    if (c === ESC || c >= 0x80) {
      const [to, final, two, open] = gentleEscape(at, n, i, true, memo);
      drop(i, to, two);
      if (final) finals.add(to);
      lossy ||= final || open;
      end = to;
    } else if (c === 0x0d) {
      end = i;
      while (end < n && at(end) === 0x0d) end++;
      if (end < n && at(end) === 0x0a) end++;
      keep(i);
      gap = -1;
      spaced = false;
      put('\n', i);
      from = end;
    } else {
      end = i + 1;
      drop(i, end, false);
    }
    stop.lastIndex = end;
  }
  keep(n);
  return { text: parts.join(''), src: kept.src, finals, sites, lossy };
}

// The view with the spaces at its sites removed, or null without any.
function unspace(v) {
  if (!v.sites?.size) return null;
  const kept = stretches();
  const parts = [];
  let len = 0;
  let from = 0;
  for (const k of v.sites.values()) {
    kept.push(len, from);
    parts.push(v.text.slice(from, k));
    len += k - from;
    from = k + 1;
  }
  kept.push(len, from);
  parts.push(v.text.slice(from));
  return { text: parts.join(''), src: (i) => v.src(kept.src(i)), finals: v.finals };
}

// Whether an escape in raw is lossy: a two-character escape with a final byte (ESC \ aside, which
// takes only a backslash), a CSI without parameters whose final letter a token character follows,
// or a string without its terminator. The cleanup's own views show every
// secret in text without one.
const TWO_CHARACTER = /\x1b(?:[\x20-\x2f]+[\x30-\x7e]|[\x30-\x4f\x51-\x57\x59\x5a\x60-\x7e])|(?:\x1b\[|\x9b)[A-Za-z][\w-]/;
const STRING = /\x1b[\]PX^_]|[\x90\x98\x9d-\x9f]/g;
function lossyIn(raw) {
  if (TWO_CHARACTER.test(raw)) return true;
  const at = (k) => raw.charCodeAt(k);
  const memo = {};
  const re = new RegExp(STRING.source, 'g');
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const [end, , , open] = gentleEscape(at, raw.length, m.index, true, memo);
    if (open) return true;
    re.lastIndex = end;
  }
  return false;
}

// A view with its newlines removed too, crosses(at, end), whether view characters [at, end) had a
// newline between them, and breakAt(i), whether one stood right before view character i.
function joinLines(v) {
  if (!v.text.includes('\n')) return v;
  let kept = null;
  const lines = () => {
    if (!kept) {
      kept = stretches();
      let len = 0;
      let from = 0;
      for (let k = v.text.indexOf('\n'); k >= 0; k = v.text.indexOf('\n', from)) {
        // Every stretch is pushed, an empty one too, so each newline starts a new stretch.
        kept.push(len, from);
        len += k - from;
        from = k + 1;
      }
      kept.push(len, from);
    }
    return kept;
  };
  return {
    text: v.text.replaceAll('\n', ''),
    src: (i) => v.src(lines().src(i)),
    crosses: (at, end) => lines().find(at) !== lines().find(end - 1),
    breakAt: (i) => {
      const k = lines().find(i);
      return k > 0 && lines().start(k) === i;
    },
    finals: v.finals,
    lossy: v.lossy,
  };
}

// The first index i of a view of length count whose source index src(i) is at least s.
function firstFrom(count, src, s) {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (src(mid) < s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The secrets in a view, in source indices: the match [a, b), its secret from s, and the secret
// [ta, tb) without a kept final byte at either edge (ta is -1 when nothing else is left), since a
// final next to a token may be an escape's and not the token's. scan(text) gives the token shapes
// as [at, start, end]; literals are the environment values, cleaned the same way.
function secretsIn(v, literals, scan) {
  const out = [];
  for (const [at, start, end] of scan(v.text)) if (end > start) out.push(secretAt(v, at, start, end, false));
  for (const literal of literals) {
    if (!literal) continue;
    for (let k = v.text.indexOf(literal); k >= 0; k = v.text.indexOf(literal, k + literal.length)) out.push(secretAt(v, k, k, k + literal.length, true));
  }
  return out;
}

function secretAt(v, at, start, end, literal) {
  let i = start;
  let j = end;
  while (i < j && v.finals.has(v.src(i))) i++;
  while (j > i && v.finals.has(v.src(j - 1))) j--;
  return { a: v.src(at), b: v.src(end - 1) + 1, s: v.src(start), ta: i < j ? v.src(i) : -1, tb: i < j ? v.src(j - 1) + 1 : -1, literal };
}

// The ends of the escapes a terminal could read at unit k of text: a control on its own (a lone
// ESC too), and with ESC or an 8-bit introducer, a CSI sequence or a two-character escape, each
// with or without its final, a terminated string, or a string's introducer alone. Nothing for a
// character that starts none.
function junkAt(text, k, more = true) {
  const c = text.charCodeAt(k);
  const ends = [];
  if (!((c <= 0x1f && c !== 0x09) || (c >= 0x7f && c <= 0x9f))) return ends;
  if (c !== ESC && !(c >= 0x80 && c <= 0x9f)) {
    ends.push(k + 1);
    return ends;
  }
  // valueSpans tries the last end first: the readings only the value's own characters make
  // possible go first, then the control alone, then the escape as a terminal reads it.
  const n = text.length;
  const at = (j) => text.charCodeAt(j);
  const whole = [];
  if (c === ESC && k + 1 < n && at(k + 1) !== 0x5b && at(k + 1) !== 0x5d && at(k + 1) !== 0x50 && at(k + 1) !== 0x58 && at(k + 1) !== 0x5e && at(k + 1) !== 0x5f) {
    // A two-character escape, with its final or without, whose intermediate bytes may be a
    // value's characters too (`ESC (` before `.` or `-`).
    let j = k + 1;
    while (j < n && at(j) >= 0x20 && at(j) <= 0x2f) j++;
    if (more) for (let e = k + 2; e < j; e++) { textWork(); ends.push(e); }
    if (j > k + 1) whole.push(j);
    if (j < n && at(j) >= 0x30 && at(j) <= 0x7e) whole.push(j + 1);
  } else {
    const [end, , , open] = gentleEscape(at, n, k, true);
    const csi = c === 0x9b || (c === ESC && at(k + 1) === 0x5b);
    if (csi) {
      // A CSI with its final, or ending anywhere from its introducer on: a value's digits after
      // `ESC [` read as parameters and its next character as the final. Without a final, as
      // before a line break, the cleanup keeps the `[` and the parameters as text.
      let j = c === ESC ? k + 2 : k + 1;
      while (j < n && at(j) >= 0x30 && at(j) <= 0x3f) j++;
      while (j < n && at(j) >= 0x20 && at(j) <= 0x2f) j++;
      if (more) for (let e = c === ESC ? k + 2 : k + 1; e <= j; e++) { textWork(); ends.push(e); }
      if (j < n && at(j) >= 0x40 && at(j) <= 0x7e) whole.push(j + 1);
    } else {
      // A string's introducer alone: a value may go on in its body, which a terminal hides.
      if (c === ESC) ends.push(k + 2);
      if (!open && end > k + 1) whole.push(end);
    }
  }
  ends.push(k + 1);
  for (const e of whole) ends.push(e);
  return ends;
}

// At most this many escapes, controls and line breaks may stand between two of a value's
// characters.
const VALUE_GAP = 1024;

// The body [from, to) of the string (OSC, DCS, SOS, PM or APC) that starts at unit k of text, up
// to its terminator, the next ESC or the line's end, or null. A terminal hides the body, so a
// value's characters in it, after text that is not the value's, are hidden on screen and shown in
// the raw bytes.
function stringBody(text, k) {
  const c = text.charCodeAt(k);
  const d = text.charCodeAt(k + 1);
  let osc;
  let from;
  if (c === ESC && d === 0x5d) [osc, from] = [true, k + 2];
  else if (c === ESC && (d === 0x50 || d === 0x58 || d === 0x5e || d === 0x5f)) [osc, from] = [false, k + 2];
  else if (c === 0x9d) [osc, from] = [true, k + 1];
  else if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) [osc, from] = [false, k + 1];
  else return null;
  let to = from;
  for (; to < text.length; to++) {
    const u = text.charCodeAt(to);
    if (u === ESC || u === 0x0a || u === 0x9c || (osc && u === BEL)) break;
  }
  return [from, to];
}

// valueSpans without more: each escape read only as a terminal reads it or as a lone control,
// the search the cleanup has always made, so what it finds stands as it was.
function terminalEnds(text, k) {
  const c = text.charCodeAt(k);
  const ends = [];
  if (!((c <= 0x1f && c !== 0x09) || (c >= 0x7f && c <= 0x9f))) return ends;
  ends.push(k + 1);
  if (c === ESC || (c >= 0x80 && c <= 0x9f)) {
    const n = text.length;
    const at = (j) => text.charCodeAt(j);
    // A two-character escape with its final, a CSI with its final, or a terminated string.
    if (c === ESC && k + 1 < n && at(k + 1) !== 0x5b && at(k + 1) !== 0x5d && at(k + 1) !== 0x50 && at(k + 1) !== 0x58 && at(k + 1) !== 0x5e && at(k + 1) !== 0x5f) {
      let j = k + 1;
      while (j < n && at(j) >= 0x20 && at(j) <= 0x2f) j++;
      if (j > k + 1) ends.push(j);
      if (j < n && at(j) >= 0x30 && at(j) <= 0x7e) ends.push(j + 1);
    } else {
      const [end, , , open] = gentleEscape(at, n, k, true);
      const csi = c === 0x9b || (c === ESC && at(k + 1) === 0x5b);
      if (csi) {
        let j = c === ESC ? k + 2 : k + 1;
        while (j < n && at(j) >= 0x30 && at(j) <= 0x3f) j++;
        while (j < n && at(j) >= 0x20 && at(j) <= 0x2f) j++;
        if (j < n && at(j) >= 0x40 && at(j) <= 0x7e) ends.push(j + 1);
      } else {
        if (!open && end > k + 1) ends.push(end);
        // A string's introducer alone: a value may go on in its body, which a terminal hides.
        if (c === ESC) ends.push(k + 2);
      }
    }
  }
  return ends;
}

function terminalSpans(text, literal, each = null) {
  textWork(1 + Math.ceil(text.length / 4096));
  const m = literal.length;
  const out = [];
  const emit = each || ((start, end) => { out.push([start, end]); });
  if (m < 2) return out;
  const escape = (ch) => ch.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&').replace(/[\x00-\x1f\x7f-\x9f]/g, (x) => `\\x${x.charCodeAt(0).toString(16).padStart(2, '0')}`);
  // A start: the first character, then the second or a control.
  const re = new RegExp(`${escape(literal[0])}(?=${escape(literal[1])}|[\\x00-\\x08\\x0a-\\x1f\\x7f-\\x9f])`, 'g');
  const seen = new Set();
  for (let r = re.exec(text); r; r = re.exec(text)) {
    textWork();
    const start = r.index;
    if (text.startsWith(literal, start)) {
      if (emit(start, start + m) === true) return out;
      re.lastIndex = start + m;
      continue;
    }
    for (const key of seen) {
      if (key >= start * (m + 1)) break;
      seen.delete(key);
    }
    // [position, matched length, end of the last matched character]
    const stack = [[start + 1, 1, start + 1]];
    let end = -1;
    while (stack.length) {
      textWork();
      const [k, i, last] = stack.pop();
      if (i === m) {
        end = k;
        break;
      }
      const key = k * (m + 1) + i;
      if (seen.has(key) || k - last > VALUE_GAP) continue;
      seen.add(key);
      for (const e of terminalEnds(text, k)) stack.push([e, i, last]);
      if (text[k] === literal[i]) stack.push([k + 1, i + 1, k + 1]);
    }
    if (end > 0) {
      if (emit(start, end) === true) return out;
      re.lastIndex = end;
    }
  }
  return out;
}

// The spans [start, end) of text where literal's characters appear in order with only escapes,
// controls and line breaks between them (junkAt), each read either way where a terminal could
// read it as an escape or as text: a lone ESC before a value's character may take it, or not. This
// finds an environment value however escapes, controls and line breaks split it. A pair of
// position and matched length that led nowhere from one start leads nowhere from a later one, so
// the searches share what they visited, each pair is read once, and pairs behind the current
// start, which no later search reaches, are dropped. An exact occurrence needs no search. Given
// each, every span goes to each(start, end) instead of a list, and the search stops when it
// returns true: a binary artifact needs only the first span its exact matches miss, and a list of
// 3.2M spans held 290 MB. With more, a value's own characters may also stand where a terminal
// reads an escape's parameters, intermediate bytes or final, or a string's body; without it,
// each escape is read only as a terminal reads it or as a lone control.
function valueSpans(text, literal, each = null, more = true, skip = null) {
  if (!more) return terminalSpans(text, literal, each);
  textWork(1 + Math.ceil(text.length / 4096));
  let skipAt = 0;
  const m = literal.length;
  const out = [];
  const emit = each || ((start, end, shared) => { out.push([start, end, shared]); });
  if (m < 2) return out;
  const escape = (ch) => ch.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&').replace(/[\x00-\x1f\x7f-\x9f]/g, (x) => `\\x${x.charCodeAt(0).toString(16).padStart(2, '0')}`);
  // A start: the first character, then the second or a control.
  const re = new RegExp(`${escape(literal[0])}(?=${escape(literal[1])}|[\\x00-\\x08\\x0a-\\x1f\\x7f-\\x9f])`, 'g');
  const seen = new Set();
  // The characters the last span found took as the value's own: a later span inside it may not
  // start at one, as no occurrence starts on another's character.
  // Two buffers of m, swapped: allocating one per span cost more than the search.
  let used = textMap(m);
  let usedLength = 0;
  let spare = textMap(m);
  // Whether the used characters hold x.
  const holds = (x) => {
    let lo = 0;
    let hi = usedLength;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (used[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo < usedLength && used[lo] === x;
  };
  let sk = textMap(64);
  let si = textMap(64);
  let sl = textMap(64);
  let sn = textMap(64);
  let nodeAt = textMap(64);
  let nodeUp = textMap(64);
  for (let r = re.exec(text); r; r = re.exec(text)) {
    textWork();
    const start = r.index;
    if (usedLength && holds(start)) continue;
    // skip: spans already found, sorted, where no search starts.
    if (skip) {
      while (skipAt < skip.length && skip[skipAt][1] <= start) skipAt++;
      if (skipAt < skip.length && skip[skipAt][0] <= start) continue;
    }
    if (text.startsWith(literal, start)) {
      let shared = false;
      for (let k = start; k < start + m && !shared && usedLength; k++) shared = holds(k);
      usedLength = 0;
      if (emit(start, start + m, shared) === true) return out;
      re.lastIndex = start + m;
      continue;
    }
    for (const key of seen) {
      if (key >= start * (m + 1)) break;
      seen.delete(key);
    }
    // The search stack, as parallel arrays: position, matched length, end of the last matched
    // character, and the node of the last matched character; node n holds a matched character's
    // position (nodeAt) and the node before it (nodeUp).
    let top = 0;
    let nodes = 0;
    const push = (k, i, last, node) => {
      if (top === sk.length) {
        const grow = (a) => { const b = textMap(a.length * 2); b.set(a); return b; };
        sk = grow(sk);
        si = grow(si);
        sl = grow(sl);
        sn = grow(sn);
      }
      sk[top] = k;
      si[top] = i;
      sl[top] = last;
      sn[top++] = node;
    };
    const node = (k, up) => {
      if (nodes === nodeAt.length) {
        const grow = (a) => { const b = textMap(a.length * 2); b.set(a); return b; };
        nodeAt = grow(nodeAt);
        nodeUp = grow(nodeUp);
      }
      nodeAt[nodes] = k;
      nodeUp[nodes] = up;
      return nodes++;
    };
    push(start + 1, 1, start + 1, node(start, -1));
    let end = -1;
    let taken = -1;
    while (top > 0) {
      textWork();
      top--;
      const k = sk[top];
      const i = si[top];
      const last = sl[top];
      const chain = sn[top];
      if (i === m) {
        end = k;
        taken = chain;
        break;
      }
      const key = k * (m + 1) + i;
      if (seen.has(key) || k - last > VALUE_GAP) continue;
      seen.add(key);
      // A value that goes on inside a string's body, after text a terminal hides with it, or after
      // the body, at its terminator or the line break that ends it. Pushed first, these readings
      // are tried last: the search takes the first span it completes, and an escape read the way
      // a terminal reads it, as junkAt gives last, leaves no character of the value outside it.
      const c = text.charCodeAt(k);
      const control = (c <= 0x1f && c !== 0x09) || (c >= 0x7f && c <= 0x9f);
      const body = more && control && stringBody(text, k);
      if (body) {
        const to = Math.min(body[1], last + VALUE_GAP);
        if (body[1] <= last + VALUE_GAP) push(body[1], i, last, chain);
        // The nearest is tried first, so a value ends as soon as it can.
        const at = [];
        for (let e = text.indexOf(literal[i], body[0]); e >= 0 && e < to; e = text.indexOf(literal[i], e + 1)) at.push(e);
        for (let n = at.length - 1; n >= 0; n--) push(at[n], i, last, chain);
      }
      if (control) for (const e of junkAt(text, k, more)) push(e, i, last, chain);
      if (text[k] === literal[i]) push(k + 1, i + 1, k + 1, node(k, chain));
    }
    if (end > 0) {
      // shared: the span takes a character the last one took too.
      let shared = false;
      let n = m;
      for (let c = taken; c >= 0; c = nodeUp[c]) {
        spare[--n] = nodeAt[c];
        shared ||= usedLength > 0 && holds(nodeAt[c]);
      }
      [used, spare] = [spare, used];
      usedLength = m;
      if (emit(start, end, shared) === true) return out;
      // The search goes on inside the span: a reading that took a string's body or an escape's
      // bytes may hold the head of the value's next occurrence. What the found search visited
      // led somewhere, so it is forgotten.
      seen.clear();
    }
  }
  return out;
}

// A join across lines stops after this many characters or line breaks, so a short token prefix
// before lines of letters and digits takes a few of them and not the rest of the file. The longest
// token shapes, API keys with a project prefix, run to about 200 characters.
const JOIN_CHARACTERS = 256;
const JOIN_BREAKS = 8;
// Text is read with its line breaks removed a window at a time, not as one copy: a copy and its
// map of 22M lines took 1.3 GiB for a 64 MiB file. A token tried in a window reads at most two runs
// of JOIN_CHARACTERS after its prefix, so a window holds JOIN_AHEAD characters past the last place
// it tries one.
const JOIN_WINDOW = 1 << 16;
const JOIN_AHEAD = 1024;

// Calls visit(w, from, limit) for windows of text with its line breaks removed, in order: w.text is
// the window, w.src(i) the text index of its character i, w.breakAt(i) whether a line break stood
// right before it and w.end the text index after it. visit reads w from index from, tries what
// starts before limit, and returns the text index to go on from, past the last place it tried.
function joinedWindows(text, visit) {
  const n = text.length;
  const size = JOIN_WINDOW + JOIN_AHEAD;
  for (let from = 0; from < n;) {
    // A window's lines are freed with it and cost a slice and an indexOf each, so a line costs an
    // eighth of a unit: a log of short or empty lines stays within the budget its length allows.
    const kept = stretches(0);
    const parts = [];
    let len = 0;
    // One character before from, which tells a word boundary.
    let o = from > 0 ? from - 1 : 0;
    while (o < n && len < size) {
      textWork(0.125);
      // A search in the part that fits, so a long line is not searched again for each window.
      const room = text.slice(o, o + size - len);
      const k = room.indexOf('\n');
      const piece = k < 0 ? room : room.slice(0, k);
      if (piece.length) {
        kept.push(len, o);
        parts.push(piece);
        len += piece.length;
      }
      o += k < 0 ? room.length : k + 1;
    }
    const src = kept.src;
    const w = {
      text: parts.join(''),
      src,
      breakAt: (i) => {
        const s = src(i);
        return s > 0 && text.charCodeAt(s - 1) === 0x0a;
      },
      end: Math.min(o, n),
    };
    const done = o >= n;
    const next = visit(w, firstFrom(len, src, from), done ? len : len - JOIN_AHEAD);
    if (done) return;
    from = Math.max(next, from + 1);
  }
}

// Whether a line break may fall inside a token prefix of length len that starts at view index p,
// when it falls right before index q. Only one may, with at least two of the prefix's characters
// before it or three after it: a line that ends in the one letter `s` and a line that starts with
// `K-long` are two words, while `g` then a line `hp_` and 20 more characters is a GitHub token.
const splitPrefix = (p, q, len) => q - p >= 2 || p + len - q >= 3;

// The token shapes in text that a newline splits, as [at, start, end] index spans of text with a
// newline inside. A shape is tried at each place one of its prefixes (lead) starts at a word
// boundary or right after a removed newline, over the run of token characters from there, cut at
// each removed newline in turn: a removed newline is a word boundary, so `x\nAKIA...` and a line
// that starts with a letter after the token do not glue onto it. The shortest cut that holds a
// whole token wins; a token whole before its first newline is left to the text as it is, since its
// line may end there. A prefix with a newline inside, where splitPrefix allows it, is tried in a
// second pass of its own, with the newline as its first cut: a token it finds does not hide one the
// first pass finds after it. Environment values split across lines are found by valueSpans. Each
// span is [at, start, end, split], split true for a token found in the second pass; given each, it
// goes to each(at, start, end, split) instead of a list.
function acrossLines(text, scan, lead, each = null) {
  const out = [];
  const emit = each || ((at, start, end, split) => { out.push([at, start, end, split]); });
  if (!text.includes('\n')) return out;
  const re = new RegExp(lead.source, 'gi');
  // Per pass, the text index its next token may start at.
  const resume = [0, 0];
  joinedWindows(text, (w, from, limit) => {
    const J = w.text;
    const next = resume.map((s) => firstFrom(J.length, w.src, s));
    let at = from;
    for (;;) {
      re.lastIndex = at;
      const m = re.exec(J);
      if (!m || m.index >= limit) break;
      const p = m.index;
      const len = m[0].length;
      at = p + 1;
      const s = w.src(p);
      if (s > 0 && /\w/.test(text[s - 1]) && !w.breakAt(p)) continue;
      // The newlines inside the prefix choose the pass.
      const inside = w.src(p + len - 1) - s - (len - 1);
      if (inside > 1 || p < next[inside]) continue;
      if (inside === 1) {
        let q = p + 1;
        while (!w.breakAt(q)) q++;
        if (!splitPrefix(p, q, len)) continue;
      }
      const cuts = [];
      let q = p;
      while (q < J.length && q - p < JOIN_CHARACTERS && cuts.length < JOIN_BREAKS && tokenCharacter(J.charCodeAt(q))) {
        q++;
        if (q < J.length && w.breakAt(q) && tokenCharacter(J.charCodeAt(q))) {
          // A line that starts with a token or a header is its own: joined, `ASIAPACIFIC` before
          // `AUTHORIZATION: ...` would take the header into an AWS key and expose its value.
          if (scan(J.slice(q, q + JOIN_CHARACTERS)).some(([k]) => k === 0)) break;
          cuts.push(q);
        }
      }
      if (!cuts.length) continue;
      if (q > cuts.at(-1)) cuts.push(q);
      for (const cut of cuts) {
        let end = -1;
        for (const [k, start, e] of scan(J.slice(p, cut))) if (k === 0 && start === 0) end = Math.max(end, e);
        if (end < 0) continue;
        if (p + end > cuts[0]) {
          emit(s, s, w.src(p + end - 1) + 1, inside === 1);
          next[inside] = p + end;
        }
        break;
      }
    }
    for (let k = 0; k < 2; k++) {
      const i = Math.max(next[k], limit);
      resume[k] = i < J.length ? w.src(i) : w.end;
    }
    return Math.min(...resume);
  });
  return out;
}

// Whether acrossLines could find a token in text: it needs a prefix (lead) whose run of token
// characters, a newline inside the prefix included, reaches a newline with a token character after
// it. A prefix inside a run already read ends where that run ends, so each run is read once.
function mayJoin(text, lead) {
  if (!text.includes('\n')) return false;
  const n = text.length;
  const re = new RegExp(lead.source, 'gi');
  let found = false;
  joinedWindows(text, (w, from, limit) => {
    const J = w.text;
    let next = from;
    while (!found) {
      re.lastIndex = next;
      const m = re.exec(J);
      if (!m || m.index >= limit) break;
      let k = w.src(m.index) + 1;
      let broke = false;
      for (; k < n; k++) {
        const c = text.charCodeAt(k);
        if (c === 0x0a) broke = true;
        else if (!tokenCharacter(c)) break;
        else if (broke) {
          found = true;
          break;
        }
      }
      if (found) return n;
      if (k >= w.end) return k;
      next = Math.max(firstFrom(J.length, w.src, k), m.index + 1);
    }
    if (found) return n;
    next = Math.max(next, limit);
    return next < J.length ? w.src(next) : w.end;
  });
  return found;
}

// The places in text where an escape glues an `Authorization:` header to a word before it: the
// escape goes without a trace, so in the cleaned text the header has no word boundary and no
// pattern finds its value. A chain of escapes counts as one.
const HEADER = /authorization:/gi;
function gluedHeaderStarts(text) {
  const out = [];
  const re = new RegExp(HEADER.source, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const p = m.index;
    // Walk back over the escapes that end right before the header.
    let q = p;
    for (let r = q - 1; r >= 0 && r >= q - 64; r--) {
      const c = text.charCodeAt(r);
      if (c !== ESC && !(c >= 0x80 && c <= 0x9f)) continue;
      if (junkAt(text, r).includes(q)) {
        q = r;
        r = q;
      }
    }
    if (q < p && q > 0 && /\w/.test(text[q - 1])) out.push(p);
  }
  return out;
}

// The header matches [at, start, end] that start at the given places of text, in order, read as if
// a space stood before each, up to the line's end. Each is read only as far as the header pattern
// does: its word, the spaces and scheme word after it, and its value to the next space, however
// long. A header inside the value of the one before it, whose own value runs to the same end, is
// part of that value and is not read again: a line of glued headers with no space is one value,
// and reading it once per header took minutes. Given each, every match goes to each(at, start, end)
// instead of a list, and the reading stops when it returns true: a list of 2M matches took a
// 64 MiB binary artifact over its memory budget.
const HEADER_WORD = 'authorization:'.length;
function headersAt(text, starts, scan, each = null) {
  const out = [];
  const emit = each || ((at, start, end) => { out.push([at, start, end]); });
  const n = text.length;
  // Spaces as the pattern's \s reads them, but not past the line's end.
  const blank = (i) => i < n && text[i] !== '\n' && /\s/.test(text[i]);
  const runEnd = (i) => {
    while (i < n && !/\s/.test(text[i])) i++;
    return i;
  };
  // The value [from, to) of the last header read.
  let from = -1;
  let to = -1;
  let sorted = true;
  for (let k = 1; sorted && k < starts.length; k++) sorted = starts[k - 1] <= starts[k];
  for (const p of sorted ? starts : [...starts].sort((x, y) => x - y)) {
    let v = p + HEADER_WORD;
    if (from <= p && v < to) {
      // Inside that value no space stands, so this header's value runs to its end too, unless a
      // scheme word ends right there and the value is the run after it.
      const scheme = /^(?:bearer|basic|token)/i.exec(text.slice(v, v + 6));
      if (!scheme || v + scheme[0].length < to) continue;
    }
    while (blank(v)) v++;
    let end = runEnd(v);
    const scheme = /^(?:bearer|basic|token)/i.exec(text.slice(v, v + 6));
    if (scheme && blank(v + scheme[0].length)) {
      let w = v + scheme[0].length;
      while (blank(w)) w++;
      end = Math.max(end, runEnd(w));
    }
    for (const [at, start, e] of scan(` ${text.slice(p, end)}`)) {
      if (at !== 1 || e <= start) continue;
      [from, to] = [p + start - 1, p + e - 1];
      if (emit(p, from, to) === true) return out;
    }
  }
  return out;
}

// The header values in text whose header an escape glues to a word, as [at, start, end], or to each.
const gluedHeaders = (text, scan, each = null) => headersAt(text, gluedHeaderStarts(text), scan, each);

// The first index i of a view of length count whose source index src(i) is at least s, as
// firstFrom gives it, with every 64th source index kept, so most of the search reads an array.
function positions(count, src) {
  const STEP = 64;
  let marks = null;
  // The last answers, by source index: the same span ends are looked up again and again.
  const keys = textMap(4096).fill(-1);
  const values = textMap(4096);
  // The last answer: most lookups come in order, a few indices on, and a short walk from it
  // reads src in order.
  let lastS = -1;
  let lastI = 0;
  return (s) => {
    const slot = s & 4095;
    if (keys[slot] === s) return values[slot];
    keys[slot] = s;
    let i = -1;
    if (lastS >= 0 && s >= lastS) {
      let k = lastI;
      for (let steps = 0; steps < 16 && k < count && src(k) < s; steps++) k++;
      if (k >= count || src(k) >= s) i = k;
    }
    if (i < 0) i = find(s);
    lastS = s;
    lastI = i;
    return (values[slot] = i);
  };
  function find(s) {
    if (!marks) {
      marks = textMap(Math.ceil(count / STEP));
      for (let k = 0; k < marks.length; k++) marks[k] = src(k * STEP);
    }
    let lo = 0;
    let hi = marks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return 0;
    let x = (lo - 1) * STEP + 1;
    let y = Math.min(count, lo * STEP);
    while (x < y) {
      const mid = (x + y) >> 1;
      if (src(mid) < s) x = mid + 1;
      else y = mid;
    }
    return x;
  }
}

// A search over items by range [a(item), b(item)): meet(x, y, visit) calls visit on each item that
// meets [x, y), until visit returns true, and says whether one did.
function rangeSearch(list, a, b) {
  let items = null;
  let size = 0;
  let tree = null;
  // Built on the first search: items by start, and a tree of the furthest end under each node,
  // so a search reads only the subtrees that reach x, whatever one long item reaches.
  const build = () => {
    items = list.slice();
    let sorted = true;
    for (let k = 1; sorted && k < items.length; k++) sorted = a(items[k - 1]) <= a(items[k]);
    if (!sorted) items.sort((p, q) => a(p) - a(q));
    size = 1;
    while (size < items.length) size *= 2;
    tree = new Float64Array(2 * size).fill(-Infinity);
    for (let k = 0; k < items.length; k++) tree[size + k] = b(items[k]);
    for (let k = size - 1; k > 0; k--) tree[k] = Math.max(tree[2 * k], tree[2 * k + 1]);
  };
  // The subtrees left to read, as node and first item, shared by searches a visit starts: each
  // search reads from where the stack stood when it began.
  let stack = textMap(256);
  let top = 0;
  return (x, y, visit) => {
    if (!items) build();
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a(items[mid]) < y) lo = mid + 1;
      else hi = mid;
    }
    // Items [0, lo) start before y; visit those that end after x, from the last.
    if (lo === 0) return false;
    const base = top;
    const push = (node, from) => {
      if (top + 2 > stack.length) {
        const grown = textMap(stack.length * 2);
        grown.set(stack);
        stack = grown;
      }
      stack[top++] = node;
      stack[top++] = from;
    };
    push(1, 0);
    while (top > base) {
      textWork();
      const from = stack[--top];
      const node = stack[--top];
      if (from >= lo || tree[node] <= x) continue;
      if (node >= size) {
        if (visit(items[node - size]) === true) {
          top = base;
          return true;
        }
        continue;
      }
      // The width of node's subtree: size at the root, halved at each level.
      const half = size >> (31 - Math.clz32(node)) >> 1;
      push(2 * node, from);
      push(2 * node + 1, from + half);
    }
    return false;
  };
}

// cleaned is the cleanup of raw, { text, src(i) } with src giving the raw index of each character.
// Returns cleaned.text with every secret that a gentle view of raw shows, and that no pattern finds
// in the cleaned text, put back whole so the redactor finds it: the cleaned characters from the
// secret's span are replaced by the span's text in the gentle view without line breaks. A secret
// whose characters the cleanup removed entirely stays removed. The gentle view is read only when an
// escape is lossy; otherwise the cleaned text stands for it, since the cleanup's own copies show
// every secret it would. Secrets split across lines come from acrossLines: environment values, and
// token shapes with a fixed prefix (a header value runs to its line's end).
//
// With `mapped`, returns { text, at(i) }: at(i) is the raw span [start, end) text character i stands
// for. A secret put back stands for its whole raw span, and a space put beside it for none. shared
// holds the views, value spans and secrets found in the views that revealTerminal reads the same
// way, for a call on the same raw text and literals; each reveal copies what it changes.
function reveal(raw, cleaned, literals, scan, lead, mapped = false, shared = {}) {
  const toOut = positions(cleaned.text.length, cleaned.src);
  const plain = () => (mapped ? { text: cleaned.text, at: (i) => { const r = cleaned.src(i); return [r, r + 1]; } } : cleaned.text);
  const controls = CONTROL.test(raw);
  const breaks = raw.includes('\n') || raw.includes('\r');
  if (!controls && !breaks) return plain();
  const lossy = controls && lossyIn(raw);
  const base = lossy ? (shared.base ??= gentleView(raw)) : { text: cleaned.text, src: cleaned.src, finals: NO_FINALS };
  // Environment values are found in raw itself, however they are split, and stand as themselves.
  const found = [];
  // A value found only where its own characters stand in an escape's parameters, intermediate
  // bytes, final or string body (valueSpans with more) counts where the cleaned text shows its
  // head and it takes no character a token the cleaned text shows needs.
  const reads = (shared.reads ??= literals.map((literal) => terminalSpans(raw, literal)));
  let shownTokens = null;
  const cutsToken = (a, b) => {
    if (!shownTokens) {
      // The tokens the cleaned text shows, also once its values are masked: a value's marker
      // gives the token glued after it a word boundary.
      const text = cleaned.text;
      const masks = [];
      for (const literal of literals) for (let k = text.indexOf(literal); k >= 0; k = text.indexOf(literal, k + literal.length)) masks.push([k, k + literal.length]);
      for (const spans of reads) {
        for (const [x, y] of spans) {
          const f = toOut(x);
          const l = toOut(y);
          if (f < l) masks.push([f, l]);
        }
      }
      masks.sort((x, y) => x[0] - y[0]);
      let masked = '';
      let at = 0;
      for (const [x, y] of masks) {
        if (y <= at) continue;
        masked += text.slice(at, Math.max(at, x)) + '#'.repeat(y - Math.max(at, x));
        at = y;
      }
      masked += text.slice(at);
      shownTokens = rangeSearch([...(shared.matches ??= scan(text)), ...(masks.length ? scan(masked) : [])].filter(([k, start]) => k === start), (m) => m[0], (m) => m[2]);
    }
    const f = toOut(a);
    const l = toOut(b);
    return shownTokens(f, l, ([x]) => {
      if (x >= f) return true;
      const left = cleaned.text.slice(x, f);
      return !scan(left).some(([k, start, e]) => k === 0 && start === 0 && e === left.length);
    });
  };
  const escapes = /[\x1b\x80-\x9f]/.test(raw);
  literals.forEach((literal, n) => {
    const read = reads[n];
    const spans = read.slice();
    let k = 0;
    for (const [a, b] of escapes ? valueSpans(raw, literal, null, true, read) : []) {
      while (k < read.length && read[k][1] <= a) k++;
      if (k < read.length && read[k][0] < b) continue;
      const f = toOut(a);
      if (f < cleaned.text.length && cleaned.src(f) === a && !cutsToken(a, b)) spans.push([a, b]);
    }
    for (let k = 0; k < spans.length; k++) {
      const [a, b, shared] = spans[k];
      found.push({ a, b, s: a, ta: a, tb: b, literal: true, put: literal, more: k >= read.length, shared });
    }
  });
  if (lossy) for (const h of (shared.baseSecrets ??= secretsIn(base, [], scan))) found.push({ ...h });
  const unspaced = lossy && (shared.unspaced ??= unspace(base));
  if (unspaced) for (const h of (shared.unspacedSecrets ??= secretsIn(unspaced, [], scan))) found.push({ ...h });
  // A header an escape glues to a word, read in the cleaned text with a space put before it.
  if (controls) {
    const starts = [];
    for (const p of gluedHeaderStarts(raw)) {
      const f = toOut(p);
      if (f > 0 && cleaned.src(f) === p && /\w/.test(cleaned.text[f - 1])) starts.push(f);
    }
    for (const [f, start, end] of headersAt(cleaned.text, starts, scan)) {
      const s = cleaned.src(start);
      const b = cleaned.src(end - 1) + 1;
      found.push({ a: cleaned.src(f), b, s, ta: s, tb: b, literal: false, glued: [f, end] });
    }
  }
  if (breaks) {
    for (const v of unspaced ? [base, unspaced] : [base]) {
      for (const [at, start, end, split] of (shared[v === base ? 'baseLines' : 'unspacedLines'] ??= acrossLines(v.text, scan, lead))) found.push({ ...secretAt(v, at, start, end, false), split, view: v });
    }
  }
  // A value found with more stands alone, but for a token before it that stays whole without the
  // characters they share: grouped with another secret, the view's text put back would show a
  // string's body the cleaned text hides. One that does not is dropped before anything reads it.
  if (found.some((h) => h.more)) {
    const near = rangeSearch(found, (h) => h.a, (h) => h.b);
    // The token as its view shows it, without line breaks, up to where the value starts.
    const joinedViews = new Map();
    const whole = (o, h) => {
      const v0 = o.view || unspaced || base;
      if (!joinedViews.has(v0)) joinedViews.set(v0, joinLines(v0));
      const v = joinedViews.get(v0);
      const t = v.text.slice(firstFrom(v.text.length, v.src, o.a), firstFrom(v.text.length, v.src, h.a));
      return t.length > 0 && scan(t).some(([k, start, e]) => k === 0 && start === 0 && e === t.length);
    };
    // The secrets the cleaned text shows, its values masked or not (values found with more left
    // unmasked): a value found with more must not take a character of one. Only a token that
    // starts before the value and stays whole without the characters they share may meet it.
    const text = cleaned.text;
    const at = (i) => toOut(i);
    const masks = [];
    for (const literal of literals) for (let k = text.indexOf(literal); k >= 0; k = text.indexOf(literal, k + literal.length)) masks.push([k, k + literal.length]);
    const visible = masks.map(([x, y]) => [x, x, y]);
    for (const h of found) if (h.literal && !h.more && at(h.a) < at(h.b)) masks.push([at(h.a), at(h.b)]);
    masks.sort((x, y) => x[0] - y[0]);
    let masked = '';
    let to = 0;
    for (const [x, y] of masks) {
      if (y <= to) continue;
      masked += text.slice(to, Math.max(to, x)) + '#'.repeat(y - Math.max(to, x));
      to = y;
    }
    masked += text.slice(to);
    const shownAt = rangeSearch([...(shared.matches ??= scan(text)), ...(masks.length ? scan(masked) : []), ...visible], (m) => m[0], (m) => m[2]);
    const takes = (h) => {
      const f = at(h.a);
      const l = at(h.b);
      return f < l && shownAt(f, l, ([x, start, y]) => {
        if (x !== start || x >= f) return true;
        const left = text.slice(x, f);
        return !scan(left).some(([k, s0, e]) => k === 0 && s0 === 0 && e === left.length) || y > l;
      });
    };
    const drop = new Set(found.filter((h) => h.more && (takes(h) || near(h.a, h.b, (o) => o !== h && !(!o.put && o.s === o.a && o.a < h.a && whole(o, h))))));
    if (drop.size) {
      let n = 0;
      for (const h of found) if (!drop.has(h)) found[n++] = h;
      found.length = n;
    }
  }
  if (!found.length) return plain();
  // By start, once: the searches over them and the lists made from them then need no sort.
  found.sort((x, y) => x.a - y.a);
  const out = cleaned.text;
  // The cleaned text's own secrets, as merged ranges of its indices, and the same with each
  // match's header, as in `Authorization: Bearer `, only once a token split inside its prefix
  // needs them.
  const shown = [];
  const literalSpans = [];
  const matches = (shared.matches ??= scan(out));
  for (const [, start, end] of matches) shown.push([start, end]);
  for (const literal of literals) {
    for (let k = out.indexOf(literal); k >= 0; k = out.indexOf(literal, k + literal.length)) literalSpans.push([k, k + literal.length]);
  }
  for (const [a, b] of literalSpans) shown.push([a, b]);
  const merge = (list) => {
    list.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const [a, b] of list) {
      const last = merged.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    return merged;
  };
  // The last of ranges that starts at or before i, or the first.
  const rangeAt = (ranges, i) => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ranges[mid][0] <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const covered = merge(shown);
  let headed = null;
  // The matches of the cleaned text with its environment values masked, those it shows whole and
  // those found split by escapes and line breaks: the redactor takes the values first, and a
  // value's marker can give the token glued after it a word boundary.
  let masked = null;
  const maskedMatches = () => {
    if (masked) return masked;
    const masks = literalSpans.map(([a, b]) => [a, b]);
    for (const h of found) {
      if (!h.literal || h.more) continue;
      const f = toOut(h.ta);
      const l = toOut(h.tb);
      if (f < l) masks.push([f, l]);
    }
    if (!masks.length) return (masked = []);
    const parts = [];
    let at = 0;
    for (const [a, b] of merge(masks)) {
      parts.push(out.slice(at, a), '#'.repeat(b - a));
      at = b;
    }
    parts.push(out.slice(at));
    return (masked = scan(parts.join('')));
  };
  const withHeaders = () => {
    if (headed) return headed;
    // A header's own words, not its value: a split token that goes on from inside a value keeps
    // the header whole and lengthens the value, which runs to the next space.
    const list = matches.map(([at, start, end]) => [at, start > at ? start : end]);
    for (const [a, b] of literalSpans) list.push([a, b]);
    for (const [k, start, end] of maskedMatches()) list.push([k, start > k ? start : end]);
    return (headed = merge(list));
  };
  const views = new Map();
  const viewOf = (v = unspaced || base) => {
    if (!views.has(v)) views.set(v, joinLines(v));
    return views.get(v);
  };
  const isToken = (t) => t.length > 0 && scan(t).some(([k, start, e]) => k === 0 && start === 0 && e === t.length);
  // A header an escape glues to a token: the token's run takes the header word. The word goes back
  // to the header where what is left of the run is still a whole token. Any other secret the
  // header meets keeps it as it is.
  const foundAt = rangeSearch(found, (h) => h.a, (h) => h.b);
  let matchesAt = null;
  for (const g of found) {
    if (!g.glued) continue;
    const fa = toOut(g.a);
    const fz = toOut(g.b) - 1;
    matchesAt ??= rangeSearch([...matches, ...maskedMatches()], (m) => m[0], (m) => m[2]);
    g.ok = !matchesAt(fa, fz + 1, ([at, start, end]) => !(at === start && at < fa && end === fa + 13 && isToken(out.slice(at, fa))));
    const trims = [];
    if (g.ok) {
      g.ok = !foundAt(g.a, g.b, (o) => {
        if (o === g || o.glued) return false;
        const v = viewOf(o.view);
        const slice = (a, b) => v.text.slice(firstFrom(v.text.length, v.src, a), firstFrom(v.text.length, v.src, b));
        if (!o.put && o.s === o.a && o.a < g.a && o.b === g.a + 13 && isToken(slice(o.a, g.a))) {
          trims.push(o);
          return false;
        }
        return true;
      });
    }
    if (!g.ok) continue;
    for (const o of trims) {
      o.b = g.a;
      o.tb = Math.min(o.tb, g.a);
    }
  }
  // Whether any of ranges meets cleaned indices [f, l].
  const meets = (ranges, f, l) => {
    let k = rangeAt(ranges, f);
    if (ranges[k] && ranges[k][1] <= f) k++;
    return Boolean(ranges[k] && ranges[k][0] <= l);
  };
  // The other secrets the views found, environment values and tokens or headers a view recovers
  // after an escape takes a character, by start, with the furthest end up to each.
  const others = found.filter((h) => !h.split && !h.glued && !h.more).map((h) => ({ a: h.a, b: !h.put && h.s > h.a ? h.s : h.b })).sort((x, y) => x.a - y.a);
  const reach = [];
  for (const o of others) reach.push(Math.max(reach.at(-1) ?? -1, o.b));
  // Whether one of others meets source range [a, b).
  const meetsOther = (a, b) => {
    let lo = 0;
    let hi = others.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (others[mid].a < b) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && reach[lo - 1] > a;
  };
  const needed = found.filter((h) => {
    if (h.ta < 0) return false;
    const f = toOut(h.ta);
    const l = toOut(h.tb) - 1;
    if (f > l) return false;
    const range = covered[rangeAt(covered, f)];
    if (range && range[0] <= f && l < range[1]) return false;
    // A value that shares a character with the occurrence before it is left out where its put-back
    // would cut a secret the cleaned text shows, as that occurrence can be.
    if (h.shared && covered.length) {
      const [x0, y0] = covered[rangeAt(covered, f)];
      const [x1, y1] = covered[rangeAt(covered, l)];
      if ((x0 < f && y0 > f) || (x1 <= l && y1 > l + 1)) return false;
    }
    if (h.glued) return h.ok;
    // A token whose prefix a line break splits stands only on its own. Put back over another
    // secret, a token or header the cleaned text or a view shows or an environment value, its
    // joined text would cut that one and leave part of it to the text.
    if (h.split) {
      if (meetsOther(h.a, h.b)) return false;
      if (meets(withHeaders(), toOut(h.a), toOut(h.b) - 1)) return false;
    }
    return true;
  });
  if (!needed.length) return plain();
  const group = (list) => {
    const groups = [];
    for (const h of list) {
      textWork();
      const { a, b, put } = h;
      const last = groups.at(-1);
      if (last && a < last.b) {
        // An environment value stands as itself only when its span holds the whole group.
        if (put && a <= last.a && b >= last.b) last.put = put;
        else if (!(last.put && a >= last.a && b <= last.b)) last.put = null;
        last.b = Math.max(last.b, b);
        last.items.push(h);
      } else {
        groups.push({ a, b, put, items: [h] });
      }
    }
    return groups;
  };
  const groups = group(needed.sort((x, y) => x.a - y.a));
  // Each secret's text comes from the view without line breaks or the spaces at sites.
  const whole = joinLines(unspaced || base);
  const joined = new Map();
  const slice = (v, a, b) => v.text.slice(firstFrom(v.text.length, v.src, a), firstFrom(v.text.length, v.src, b));
  // A group of tokens split inside their prefixes, which meet no other secret, as each token from
  // the view it was found in, apart: put back as one string, a fixed-length shape could take the
  // next token's first character, and the next token would not be redacted. The same token found
  // in two views goes once, from the view where it runs longest.
  const apart = (items) => {
    const pieces = [];
    for (const h of items) {
      const last = pieces.at(-1);
      if (last && h.a === last.a) {
        if (h.b > last.b) Object.assign(last, { b: h.b, view: h.view });
      } else {
        pieces.push({ a: h.a, b: h.b, view: h.view });
      }
    }
    return pieces.map(({ a, b, view }) => {
      if (!joined.has(view)) joined.set(view, joinLines(view));
      return slice(joined.get(view), a, b);
    }).join(' ');
  };
  const word = (ch) => /\w/.test(ch ?? '');
  // The cleaned text of a group of glued headers, from its first header to its last value's end,
  // with a space before each header after the first, as each was read. Joining each header's own
  // text repeated what they share, and a line of them overflowed a string.
  const gluedStarts = (members) => [...new Set(members.map((h) => h.glued[0]))].sort((x, y) => x - y);
  const gluedText = (members) => {
    const starts = gluedStarts(members);
    const end = members.reduce((e, h) => Math.max(e, h.glued[1]), 0);
    const parts = [];
    for (let k = 0; k < starts.length; k++) parts.push(out.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : end));
    return parts.join(' ');
  };
  // A group's text, and for one taken from the view, the view index of its first character.
  const putOf = ({ a, b, put, items: members }) => {
    if (put) return [put, -1];
    if (members.every((h) => h.glued)) return [gluedText(members), -1];
    // Values that overlap, as two readings of escapes between them can make them: each as itself.
    if (members.every((h) => h.put)) return [members.map((h) => h.put).join(''), -1];
    if (members.every((h) => h.split)) return [apart(members), -1];
    const from = firstFrom(whole.text.length, whole.src, a);
    return [whole.text.slice(from, firstFrom(whole.text.length, whole.src, b)), from];
  };
  // An environment value the text shows in pieces, as a view keeps an escape's final in it or a
  // put-back puts a space at a word boundary inside it: its characters that no token the text
  // shows holds go, and the value stands as itself where the first of them stood. A token that
  // shares characters with it keeps them; a header's value may not be redacted as one, as when
  // a token glued before the header takes its word. cut(i) is the value whose characters hold
  // source index i, or null.
  let cut = () => null;
  // Whether a cut meets source indices [x, y].
  let meetsCut = () => false;
  {
    // Only a value that a group put back as view text meets, and that the text around the group,
    // with the spaces put at word boundaries, shows neither whole nor inside a secret the redactor
    // finds there.
    const shows = (v, g) => {
      const f = toOut(g.a);
      const l = toOut(g.b) - 1;
      if (f > l) return true;
      const [put, from] = putOf(g);
      const fv = Math.min(f, toOut(v.a));
      const lv = Math.max(l, toOut(v.b) - 1);
      const before = out.slice(fv, f) + (f > 0 && word(out[f - 1]) && word(put[0]) ? ' ' : '');
      const after = (word(put.at(-1)) && word(out[l + 1]) ? ' ' : '') + out.slice(l + 1, lv + 1);
      const text = before + put + after;
      if (text.includes(v.put)) return true;
      if (from < 0) return false;
      const at = (i) => {
        if (i < g.a) return toOut(i) - fv;
        if (i > g.b) return before.length + put.length + after.length - (lv + 1 - toOut(i));
        return before.length + firstFrom(whole.text.length, whole.src, i) - from;
      };
      const x = at(v.a);
      const y = at(v.b);
      return scan(text).some(([, start, end]) => start <= x && y <= end);
    };
    const env = found.filter((h) => h.put);
    const envAt = rangeSearch(env, (h) => h.a, (h) => h.b);
    const groupAt = rangeSearch(groups, (g) => g.a, (g) => g.b);
    // Values that share characters are left to the redactor, which takes them in turn.
    const alone = (h) => !envAt(h.a, h.b, (v) => v !== h);
    // Nor a value that a token the cleaned text shows holds whole: the redactor takes the token,
    // which covers the value, so a cut would break the token and show part of it.
    const tokenAt = rangeSearch(matches.filter(([at, start]) => at === start), (m) => m[0], (m) => m[2]);
    const inToken = (h) => { const f = toOut(h.a); const l = toOut(h.b); return f < l && tokenAt(f, l, ([, x, y]) => x <= f && y >= l); };
    const values = env.filter((h) => alone(h) && !inToken(h) && groupAt(h.a, h.b, (g) => !g.put && !shows(h, g)));
    if (values.length) {
      // A token the cleaned text shows, its values masked or not, holds its characters unless a
      // value lies whole in it: the redactor takes the value first and leaves the token's run in
      // pieces.
      const holds = [];
      const hold = (x, y) => {
        if (!envAt(x, y, (v) => x <= v.a && v.b <= y)) holds.push([x, y]);
      };
      for (const h of needed) if (!h.put && h.s === h.a) hold(h.a, h.b);
      for (const [at, start, end] of [...matches, ...maskedMatches()]) if (at === start) hold(cleaned.src(at), cleaned.src(end - 1) + 1);
      // And on the lines of each value, the tokens with the other values masked: masked too, the
      // value would take a token's character it shares.
      // The window read around a value: its line, at most JOIN_CHARACTERS * 4 characters to either
      // side, starting after a space so that no token is read from its middle.
      const around = JOIN_CHARACTERS * 4;
      for (const v of values) {
        const f = toOut(v.a);
        const l = toOut(v.b);
        let from = Math.max(out.lastIndexOf('\n', f - 1) + 1, f - around);
        if (from > 0 && out[from - 1] !== '\n') {
          const space = out.slice(from, f).search(/\s/);
          from = space < 0 ? f : from + space + 1;
        }
        let to = out.indexOf('\n', l);
        if (to < 0 || to > l + around) to = Math.min(out.length, l + around);
        const chars = out.slice(from, to).split('');
        const mask = (x, y) => {
          for (let k = Math.max(x, from); k < Math.min(y, to); k++) chars[k - from] = '#';
        };
        const sx = cleaned.src(from);
        const sy = to < out.length ? cleaned.src(to) : Infinity;
        envAt(sx, sy, (o) => {
          if (o !== v) mask(toOut(o.a), toOut(o.b));
        });
        let line = chars.join('');
        for (let k = line.indexOf(v.put); k >= 0; k = line.indexOf(v.put, k + 1)) {
          if (k + from < f + v.put.length && k + from + v.put.length > f) continue;
          line = line.slice(0, k) + '#'.repeat(v.put.length) + line.slice(k + v.put.length);
        }
        for (const [at, start, end] of scan(line)) if (at === start) hold(cleaned.src(from + at), cleaned.src(from + end - 1) + 1);
      }
      const held = merge(holds);
      const cuts = [];
      for (const v of values) {
        let at = v.a;
        for (let k = rangeAt(held, at); at < v.b && k < held.length; k++) {
          const [x, y] = held[k];
          if (y <= at) continue;
          if (x >= v.b) break;
          if (x > at) cuts.push([at, x, v]);
          at = Math.max(at, y);
        }
        if (at < v.b) cuts.push([at, v.b, v]);
      }
      cuts.sort((x, y) => x[0] - y[0]);
      const reach = [];
      for (const [, y] of cuts) reach.push(Math.max(reach.at(-1) ?? -1, y));
      // The number of cuts that start at or before i.
      const upTo = (i) => {
        let lo = 0;
        let hi = cuts.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cuts[mid][0] <= i) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      };
      cut = (i) => {
        for (let k = upTo(i) - 1; k >= 0 && reach[k] > i; k--) if (i < cuts[k][1]) return cuts[k][2];
        return null;
      };
      meetsCut = (x, y) => {
        const k = upTo(y) - 1;
        return k >= 0 && reach[k] > x;
      };
    }
  }
  const parts = [];
  // For `mapped`: [text start, out start or -1, raw start, raw end] of each part.
  const pieces = [];
  let length = 0;
  // pad: a value put in place of its cut pieces, which needs a word boundary after it.
  let pad = null;
  const add = (text, o, a, b) => {
    if (!text) return;
    if (pad && word(text[0])) {
      const [pa, pb] = pad;
      pad = null;
      add(' ', -1, pa, pb);
    }
    pad = null;
    if (mapped) pieces.push([length, o, a, b]);
    parts.push(text);
    length += text.length;
  };
  // Text whose character i stands for source index src(i), with the pieces of a value cut out
  // and the value put once where its first piece stood. o is the out index of character 0, or -1.
  const placed = new Set();
  const addCut = (text, src, o, a, b) => {
    if (!text || !meetsCut(Math.min(src(0), src(text.length - 1)), Math.max(src(0), src(text.length - 1)))) {
      add(text, o, a, b);
      return;
    }
    let from = 0;
    for (let i = 0; i < text.length; i++) {
      const v = cut(src(i));
      if (!v) continue;
      add(text.slice(from, i), o < 0 ? -1 : o + from, a, b);
      if (!placed.has(v)) {
        placed.add(v);
        // Word boundaries on both sides, so the redactor finds the value here and not glued to the
        // characters a token kept before it.
        if (word(parts.at(-1)?.at(-1)) && word(v.put[0])) add(' ', -1, v.a, v.a);
        add(v.put, -1, v.a, v.b);
        if (word(v.put.at(-1))) pad = [v.b, v.b];
      }
      from = i + 1;
    }
    add(text.slice(from), o < 0 ? -1 : o + from, a, b);
  };
  const addOut = (from, to) => addCut(out.slice(from, to), (i) => cleaned.src(from + i), from, 0, 0);
  let last = '';
  let prev = 0;
  // The tokens the cleaned text shows, with its values masked or not, by start: a group of values
  // that starts or ends inside one takes the rest of it too, so its text does not cut the token,
  // as a value found with escapes read another way can start at a token's last character.
  const tokens = [...matches, ...(found.some((h) => h.put) ? maskedMatches() : [])].filter(([at, start]) => at === start).map(([at, , end]) => [at, end]).sort((x, y) => x[0] - y[0]);
  const straddle = (i) => {
    let lo = 0;
    let hi = tokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid][0] < i) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo - 1; k >= 0 && k >= lo - 4; k--) if (tokens[k][1] > i) return tokens[k];
    return null;
  };
  // A group of values inside a header's value, as the cleaned text shows it with its values
  // masked or not, puts no space next to it: the value runs to the next space, and a space would
  // leave the rest of it to the text.
  const insideHeader = rangeSearch([...matches, ...(found.some((h) => h.put) ? maskedMatches() : [])].filter(([at, start]) => start > at), (m) => m[1], (m) => m[2]);
  for (let gi = 0; gi < groups.length; gi++) {
    textWork();
    const g = groups[gi];
    const { a, b } = g;
    // Where the next group starts, which a group taking a token's rest must not reach.
    const next = gi + 1 < groups.length ? toOut(groups[gi + 1].a) : out.length;
    let f = toOut(a);
    let l = toOut(b) - 1;
    if (f > l) continue;
    let [put, from] = putOf(g);
    // Only a group of values: a token's own group puts it apart from a run its escape glued on.
    const values = g.items.every((h) => h.put);
    let head = values ? straddle(f) : null;
    const tail = values ? straddle(l + 1) : null;
    // A run the token's shape took on past the token, glued to the value, loses nothing it needs.
    if (head && isToken(out.slice(head[0], f))) head = null;
    // The token's characters keep their place in the text, so no space goes next to them.
    const before = Boolean(head && head[0] >= prev);
    const after = Boolean(tail && tail[0] <= l && tail[1] <= next);
    if (before || after) {
      let text = put;
      if (before) {
        text = out.slice(head[0], f) + text;
        f = head[0];
      }
      if (after) {
        text += out.slice(l + 1, tail[1]);
        l = tail[1] - 1;
      }
      [put, from] = [text, -1];
    }
    if (f > prev) last = out[f - 1];
    addOut(prev, f);
    const header = values && insideHeader(f, l + 1, ([, start, end]) => start <= f && l + 1 < end);
    // A word character on either side would end the token's word boundary.
    if (!before && !header && word(last) && word(put[0])) add(' ', -1, a, a);
    // A put-back the cleaned text already shows as it is, as a glued header, stands for its own
    // characters.
    if (from < 0 && g.items.every((h) => h.glued) && !before && !after) {
      // Each piece of the cleaned text stands for its own characters, and a space for none.
      const starts = gluedStarts(g.items);
      for (let k = 0; k < starts.length; k++) {
        const to = k + 1 < starts.length ? starts[k + 1] : l + 1;
        if (k > 0) add(' ', -1, cleaned.src(starts[k]), cleaned.src(starts[k]));
        add(out.slice(starts[k], to), starts[k], 0, 0);
      }
    } else if (from < 0 && put === out.slice(f, l + 1)) add(put, f, 0, 0);
    else if (from < 0) add(put, -1, a, b);
    else addCut(put, (i) => whole.src(from + i), -1, a, b);
    last = put.at(-1);
    // The space then also stands before a group that starts right after this one.
    if (!after && !header && word(last) && word(out[l + 1])) {
      add(' ', -1, b, b);
      last = ' ';
    }
    prev = l + 1;
  }
  addOut(prev, out.length);
  const text = parts.join('');
  if (!mapped) return text;
  // The piece the last call found: calls mostly come in order.
  let hint = 0;
  const at = (i) => {
    let lo = hint;
    if (!(pieces[lo][0] <= i && (lo + 1 === pieces.length || i < pieces[lo + 1][0]))) {
      lo = 0;
      let hi = pieces.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (pieces[mid][0] <= i) lo = mid;
        else hi = mid - 1;
      }
    }
    hint = lo;
    const [t0, o, a, b] = pieces[lo];
    if (o < 0) return [a, b];
    const r = cleaned.src(o + i - t0);
    return [r, r + 1];
  };
  return { text, at };
}

// reveal as it reads each escape: only as a terminal does or as a lone control (terminalSpans), with
// none of a value's own characters inside an escape. Its put-backs differ from reveal's where a
// value's characters an escape could take overlap a token or another value, and either reading
// can redact characters the other shows; lib/gates/common.js redacts what either redacts.
function revealTerminal(raw, cleaned, literals, scan, lead, mapped = false, shared = {}) {
  const plain = () => (mapped ? { text: cleaned.text, at: (i) => { const r = cleaned.src(i); return [r, r + 1]; } } : cleaned.text);
  const controls = CONTROL.test(raw);
  const breaks = raw.includes('\n') || raw.includes('\r');
  if (!controls && !breaks) return plain();
  const lossy = controls && lossyIn(raw);
  const base = lossy ? (shared.base ??= gentleView(raw)) : { text: cleaned.text, src: cleaned.src, finals: NO_FINALS };
  // Environment values are found in raw itself, however they are split, and stand as themselves.
  const found = [];
  const reads = (shared.reads ??= literals.map((literal) => terminalSpans(raw, literal)));
  literals.forEach((literal, n) => {
    for (const [a, b] of reads[n]) found.push({ a, b, s: a, ta: a, tb: b, literal: true, put: literal });
  });
  if (lossy) for (const h of (shared.baseSecrets ??= secretsIn(base, [], scan))) found.push({ ...h });
  const unspaced = lossy && (shared.unspaced ??= unspace(base));
  if (unspaced) for (const h of (shared.unspacedSecrets ??= secretsIn(unspaced, [], scan))) found.push({ ...h });
  if (breaks) {
    for (const v of unspaced ? [base, unspaced] : [base]) {
      for (const [at, start, end, split] of (shared[v === base ? 'baseLines' : 'unspacedLines'] ??= acrossLines(v.text, scan, lead))) found.push({ ...secretAt(v, at, start, end, false), split, view: v });
    }
  }
  if (!found.length) return plain();
  const out = cleaned.text;
  // The cleaned text's own secrets, as merged ranges of its indices, and the same with each
  // match's header, as in `Authorization: Bearer `, only once a token split inside its prefix
  // needs them.
  const shown = [];
  const literalSpans = [];
  const matches = (shared.matches ??= scan(out));
  for (const [, start, end] of matches) shown.push([start, end]);
  for (const literal of literals) {
    for (let k = out.indexOf(literal); k >= 0; k = out.indexOf(literal, k + literal.length)) literalSpans.push([k, k + literal.length]);
  }
  for (const [a, b] of literalSpans) shown.push([a, b]);
  const merge = (list) => {
    list.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const [a, b] of list) {
      const last = merged.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    return merged;
  };
  // The last of ranges that starts at or before i, or the first.
  const rangeAt = (ranges, i) => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ranges[mid][0] <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const covered = merge(shown);
  let headed = null;
  // The redactor takes environment values first, and a value's marker can give the token glued
  // after it a word boundary, so the matches of the text with its values masked count too: those
  // the cleaned text shows whole, and those found split by escapes and line breaks.
  const withHeaders = () => {
    if (headed) return headed;
    const list = matches.map(([at, , end]) => [at, end]);
    const masks = [];
    for (const [a, b] of literalSpans) {
      list.push([a, b]);
      masks.push([a, b]);
    }
    for (const h of found) {
      if (!h.literal) continue;
      const f = firstFrom(out.length, cleaned.src, h.ta);
      const l = firstFrom(out.length, cleaned.src, h.tb);
      if (f < l) masks.push([f, l]);
    }
    if (masks.length) {
      const parts = [];
      let at = 0;
      for (const [a, b] of merge(masks)) {
        parts.push(out.slice(at, a), '#'.repeat(b - a));
        at = b;
      }
      parts.push(out.slice(at));
      for (const [k, , end] of scan(parts.join(''))) list.push([k, end]);
    }
    return (headed = merge(list));
  };
  // Whether any of ranges meets cleaned indices [f, l].
  const meets = (ranges, f, l) => {
    let k = rangeAt(ranges, f);
    if (ranges[k] && ranges[k][1] <= f) k++;
    return Boolean(ranges[k] && ranges[k][0] <= l);
  };
  // The other secrets the views found, environment values and tokens or headers a view recovers
  // after an escape takes a character, by start, with the furthest end up to each.
  const others = found.filter((h) => !h.split).sort((x, y) => x.a - y.a);
  const reach = [];
  for (const o of others) reach.push(Math.max(reach.at(-1) ?? -1, o.b));
  // Whether one of others meets source range [a, b).
  const meetsOther = (a, b) => {
    let lo = 0;
    let hi = others.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (others[mid].a < b) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && reach[lo - 1] > a;
  };
  const needed = found.filter((h) => {
    if (h.ta < 0) return false;
    const f = firstFrom(out.length, cleaned.src, h.ta);
    const l = firstFrom(out.length, cleaned.src, h.tb) - 1;
    if (f > l) return false;
    const range = covered[rangeAt(covered, f)];
    if (range && range[0] <= f && l < range[1]) return false;
    // A token whose prefix a line break splits stands only on its own. Put back over another
    // secret, a token or header the cleaned text or a view shows or an environment value, its
    // joined text would cut that one and leave part of it to the text.
    if (h.split) {
      if (meetsOther(h.a, h.b)) return false;
      if (meets(withHeaders(), firstFrom(out.length, cleaned.src, h.a), firstFrom(out.length, cleaned.src, h.b) - 1)) return false;
    }
    return true;
  });
  if (!needed.length) return plain();
  needed.sort((x, y) => x.a - y.a);
  const groups = [];
  for (const h of needed) {
    const { a, b, put } = h;
    const last = groups.at(-1);
    if (last && a < last.b) {
      // An environment value stands as itself only when its span holds the whole group.
      if (put && a <= last.a && b >= last.b) last.put = put;
      else if (!(last.put && a >= last.a && b <= last.b)) last.put = null;
      last.b = Math.max(last.b, b);
      last.items.push(h);
    } else {
      groups.push({ a, b, put, items: [h] });
    }
  }
  // Each secret's text comes from the view without line breaks or the spaces at sites.
  const whole = joinLines(unspaced || base);
  const joined = new Map();
  const slice = (v, a, b) => v.text.slice(firstFrom(v.text.length, v.src, a), firstFrom(v.text.length, v.src, b));
  // A group of tokens split inside their prefixes, which meet no other secret, as each token from
  // the view it was found in, apart: put back as one string, a fixed-length shape could take the
  // next token's first character, and the next token would not be redacted. The same token found
  // in two views goes once, from the view where it runs longest.
  const apart = (items) => {
    const pieces = [];
    for (const h of items) {
      const last = pieces.at(-1);
      if (last && h.a === last.a) {
        if (h.b > last.b) Object.assign(last, { b: h.b, view: h.view });
      } else {
        pieces.push({ a: h.a, b: h.b, view: h.view });
      }
    }
    return pieces.map(({ a, b, view }) => {
      if (!joined.has(view)) joined.set(view, joinLines(view));
      return slice(joined.get(view), a, b);
    }).join(' ');
  };
  const word = (ch) => /\w/.test(ch ?? '');
  const parts = [];
  // For `mapped`: [text start, out start or -1, raw start, raw end] of each part.
  const pieces = [];
  let length = 0;
  const add = (text, o, a, b) => {
    if (!text) return;
    if (mapped) pieces.push([length, o, a, b]);
    parts.push(text);
    length += text.length;
  };
  let last = '';
  let prev = 0;
  for (const { a, b, put: value, items } of groups) {
    const f = firstFrom(out.length, cleaned.src, a);
    const l = firstFrom(out.length, cleaned.src, b) - 1;
    if (f > l) continue;
    const put = value || (items.every((h) => h.split) ? apart(items) : slice(whole, a, b));
    if (f > prev) last = out[f - 1];
    add(out.slice(prev, f), prev, 0, 0);
    // A word character on either side would end the token's word boundary.
    if (word(last) && word(put[0])) add(' ', -1, a, a);
    add(put, -1, a, b);
    last = put.at(-1);
    // The space then also stands before a group that starts right after this one.
    if (word(last) && word(out[l + 1])) {
      add(' ', -1, b, b);
      last = ' ';
    }
    prev = l + 1;
  }
  add(out.slice(prev), prev, 0, 0);
  const text = parts.join('');
  if (!mapped) return text;
  const at = (i) => {
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pieces[mid][0] <= i) lo = mid;
      else hi = mid - 1;
    }
    const [t0, o, a, b] = pieces[lo];
    if (o < 0) return [a, b];
    const r = cleaned.src(o + i - t0);
    return [r, r + 1];
  };
  return { text, at };
}

module.exports = { gentleEscape, sortedSet, acrossLines, mayJoin, valueSpans, gluedHeaders, reveal, revealTerminal, tokenCharacter };
