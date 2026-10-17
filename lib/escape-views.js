'use strict';

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

// Kept stretches of a view: stretch k starts at view index v[k] and source index s[k].
function stretches() {
  let v = new Int32Array(64);
  let s = new Int32Array(64);
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
      if (n === v.length) {
        const grow = (a) => { const b = new Int32Array(a.length * 2); b.set(a); return b; };
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
  let a = new Int32Array(16);
  let n = 0;
  return {
    add(i) {
      if (n === a.length) {
        const b = new Int32Array(a.length * 2);
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
// ESC too), and with ESC or an 8-bit introducer, the whole CSI sequence, a two-character escape
// with or without its final, a terminated string, or a string's introducer alone. Nothing for a character that starts none.
function junkAt(text, k) {
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

// At most this many escapes, controls and line breaks may stand between two of a value's
// characters.
const VALUE_GAP = 1024;

// The spans [start, end) of text where literal's characters appear in order with only escapes,
// controls and line breaks between them (junkAt), each read either way where a terminal could
// read it as an escape or as text: a lone ESC before a value's character may take it, or not. This
// finds an environment value however escapes, controls and line breaks split it. A pair of
// position and matched length that led nowhere from one start leads nowhere from a later one, so
// the searches share what they visited, each pair is read once, and pairs behind the current
// start, which no later search reaches, are dropped. An exact occurrence needs no search. Given
// each, every span goes to each(start, end) instead of a list, and the search stops when it
// returns true: a binary artifact needs only the first span its exact matches miss, and a list of
// 3.2M spans held 290 MB.
function valueSpans(text, literal, each = null) {
  const m = literal.length;
  const out = [];
  const emit = each || ((start, end) => { out.push([start, end]); });
  if (m < 2) return out;
  const escape = (ch) => ch.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&').replace(/[\x00-\x1f\x7f-\x9f]/g, (x) => `\\x${x.charCodeAt(0).toString(16).padStart(2, '0')}`);
  // A start: the first character, then the second or a control.
  const re = new RegExp(`${escape(literal[0])}(?=${escape(literal[1])}|[\\x00-\\x08\\x0a-\\x1f\\x7f-\\x9f])`, 'g');
  const seen = new Set();
  for (let r = re.exec(text); r; r = re.exec(text)) {
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
      const [k, i, last] = stack.pop();
      if (i === m) {
        end = k;
        break;
      }
      const key = k * (m + 1) + i;
      if (seen.has(key) || k - last > VALUE_GAP) continue;
      seen.add(key);
      for (const e of junkAt(text, k)) stack.push([e, i, last]);
      if (text[k] === literal[i]) stack.push([k + 1, i + 1, k + 1]);
    }
    if (end > 0) {
      if (emit(start, end) === true) return out;
      re.lastIndex = end;
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
    const kept = stretches();
    const parts = [];
    let len = 0;
    // One character before from, which tells a word boundary.
    let o = from > 0 ? from - 1 : 0;
    while (o < n && len < size) {
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

// cleaned is the cleanup of raw, { text, src(i) } with src giving the raw index of each character.
// Returns cleaned.text with every secret that a gentle view of raw shows, and that no pattern finds
// in the cleaned text, put back whole so the redactor finds it: the cleaned characters from the
// secret's span are replaced by the span's text in the gentle view without line breaks. A secret
// whose characters the cleanup removed entirely stays removed. The gentle view is read only when an
// escape is lossy; otherwise the cleaned text stands for it, since the cleanup's own copies show
// every secret it would. Secrets split across lines come from acrossLines: environment values, and
// token shapes with a fixed prefix (a header value runs to its line's end).
function reveal(raw, cleaned, literals, scan, lead) {
  const controls = CONTROL.test(raw);
  const breaks = raw.includes('\n') || raw.includes('\r');
  if (!controls && !breaks) return cleaned.text;
  const lossy = controls && lossyIn(raw);
  const base = lossy ? gentleView(raw) : { text: cleaned.text, src: cleaned.src, finals: NO_FINALS };
  // Environment values are found in raw itself, however they are split, and stand as themselves.
  const found = [];
  for (const literal of literals) for (const [a, b] of valueSpans(raw, literal)) found.push({ a, b, s: a, ta: a, tb: b, literal: true, put: literal });
  if (lossy) for (const h of secretsIn(base, [], scan)) found.push(h);
  const unspaced = lossy && unspace(base);
  if (unspaced) for (const h of secretsIn(unspaced, [], scan)) found.push(h);
  if (breaks) {
    for (const v of unspaced ? [base, unspaced] : [base]) {
      for (const [at, start, end, split] of acrossLines(v.text, scan, lead)) found.push({ ...secretAt(v, at, start, end, false), split });
    }
  }
  if (!found.length) return cleaned.text;
  const out = cleaned.text;
  // The cleaned text's own secrets, as merged ranges of its indices, and the same with each
  // match's header, as in `Authorization: Bearer `, only once a token split inside its prefix
  // needs them.
  const shown = [];
  const literalSpans = [];
  const matches = scan(out);
  for (const [, start, end] of matches) shown.push([start, end]);
  for (const literal of literals) {
    for (let k = out.indexOf(literal); k >= 0; k = out.indexOf(literal, k + literal.length)) literalSpans.push([k, k + literal.length]);
  }
  for (const range of literalSpans) shown.push(range);
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
  const withHeaders = () => (headed ??= merge(matches.map(([at, , end]) => [at, end]).concat(literalSpans)));
  // Whether any of ranges meets cleaned indices [f, l].
  const meets = (ranges, f, l) => {
    let k = rangeAt(ranges, f);
    if (ranges[k] && ranges[k][1] <= f) k++;
    return Boolean(ranges[k] && ranges[k][0] <= l);
  };
  // Environment value spans by start, with the furthest end up to each, to tell an overlap.
  const values = found.filter((h) => h.put).sort((x, y) => x.a - y.a);
  const reach = [];
  for (const v of values) reach.push(Math.max(reach.at(-1) ?? -1, v.b));
  const meetsValue = (a, b) => {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[mid].a < b) lo = mid + 1;
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
    // secret, a token or header the cleaned text shows or an environment value, its joined text
    // would cut that one and leave part of it to the text.
    if (h.split) {
      if (meetsValue(h.a, h.b)) return false;
      if (meets(withHeaders(), firstFrom(out.length, cleaned.src, h.a), firstFrom(out.length, cleaned.src, h.b) - 1)) return false;
    }
    return true;
  });
  if (!needed.length) return out;
  needed.sort((x, y) => x.a - y.a);
  const groups = [];
  for (const { a, b, put } of needed) {
    const last = groups.at(-1);
    if (last && a < last.b) {
      // An environment value stands as itself only when its span holds the whole group.
      if (put && a <= last.a && b >= last.b) last.put = put;
      else if (!(last.put && a >= last.a && b <= last.b)) last.put = null;
      last.b = Math.max(last.b, b);
    } else {
      groups.push({ a, b, put });
    }
  }
  // Each secret's text comes from the view without line breaks or the spaces at sites.
  const whole = joinLines(unspaced || base);
  const word = (ch) => /\w/.test(ch ?? '');
  const parts = [];
  let last = '';
  let prev = 0;
  for (const { a, b, put: value } of groups) {
    const f = firstFrom(out.length, cleaned.src, a);
    const l = firstFrom(out.length, cleaned.src, b) - 1;
    if (f > l) continue;
    const put = value || whole.text.slice(firstFrom(whole.text.length, whole.src, a), firstFrom(whole.text.length, whole.src, b));
    if (f > prev) last = out[f - 1];
    parts.push(out.slice(prev, f));
    // A word character on either side would end the token's word boundary.
    if (word(last) && word(put[0])) parts.push(' ');
    parts.push(put);
    if (word(put.at(-1)) && word(out[l + 1])) parts.push(' ');
    last = put.at(-1);
    prev = l + 1;
  }
  parts.push(out.slice(prev));
  return parts.join('');
}

module.exports = { gentleEscape, sortedSet, acrossLines, mayJoin, valueSpans, reveal, tokenCharacter };
