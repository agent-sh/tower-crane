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
// The characters of a token shape's run: letters, digits, _ and -.
const tokenCharacter = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x2d;
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
// takes only a backslash) or a string without its terminator. The cleanup's own views show every
// secret in text without one.
const TWO_CHARACTER = /\x1b(?:[ -/]+[0-~]|[0-OQ-WYZ`-~])/;
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

// A view with its newlines removed too, and crosses(at, end), whether view characters [at, end)
// had a newline between them.
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
function secretsIn(v, literals, scan, only = () => true) {
  const out = [];
  const add = (at, start, end, literal) => {
    if (end <= start || !only(at, end)) return;
    let i = start;
    let j = end;
    while (i < j && v.finals.has(v.src(i))) i++;
    while (j > i && v.finals.has(v.src(j - 1))) j--;
    out.push({ a: v.src(at), b: v.src(end - 1) + 1, s: v.src(start), ta: i < j ? v.src(i) : -1, tb: i < j ? v.src(j - 1) + 1 : -1, literal });
  };
  for (const [at, start, end] of scan(v.text)) add(at, start, end, false);
  for (const literal of literals) {
    if (!literal) continue;
    for (let k = v.text.indexOf(literal); k >= 0; k = v.text.indexOf(literal, k + literal.length)) add(k, k, k + literal.length, true);
  }
  return out;
}

// cleaned is the cleanup of raw, { text, src(i) } with src giving the raw index of each character.
// Returns cleaned.text with every secret that a gentle view of raw shows, and that no pattern finds
// in the cleaned text, put back whole so the redactor finds it: the cleaned characters from the
// secret's span are replaced by the span's text in the gentle view without line breaks. A secret
// whose characters the cleanup removed entirely stays removed. The gentle view is read only when an
// escape is lossy; otherwise the cleaned text stands for it, since the cleanup's own copies show
// every secret it would. Line breaks count only inside a fixed-prefix token shape or an environment
// value, and not where the part before the break is a whole token shape by itself: a header value
// runs to the line end, and a token at a line's end would otherwise take the next line's first word.
function reveal(raw, cleaned, literals, scan) {
  const controls = CONTROL.test(raw);
  const breaks = raw.includes('\n') || raw.includes('\r');
  if (!controls && !breaks) return cleaned.text;
  const lossy = controls && lossyIn(raw);
  const base = lossy ? gentleView(raw) : { text: cleaned.text, src: cleaned.src, finals: NO_FINALS };
  const lits = literals.map((l) => (lossy ? gentleView(l).text : l)).filter(Boolean);
  const found = lossy ? secretsIn(base, lits, scan) : [];
  const unspaced = lossy && unspace(base);
  if (unspaced) for (const h of secretsIn(unspaced, lits, scan)) found.push(h);
  const joined = joinLines(base);
  if (joined !== base) {
    // The end of the shortest token shape in base at each start, to tell a whole head.
    let heads = null;
    for (const h of secretsIn(joined, lits.map((l) => l.replaceAll('\n', '')).filter(Boolean), scan, joined.crosses)) {
      const lineAt = raw.slice(h.a, h.b).search(/[\r\n]/);
      if (lineAt < 0 || (!h.literal && h.s > h.a)) continue;
      if (!h.literal) {
        if (!heads) {
          heads = new Map();
          for (const p of secretsIn(base, [], scan)) heads.set(p.a, Math.min(heads.get(p.a) ?? Infinity, p.b));
        }
        if ((heads.get(h.a) ?? Infinity) <= h.a + lineAt) continue;
      }
      found.push(h);
    }
  }
  if (!found.length) return cleaned.text;
  const out = cleaned.text;
  // The cleaned text's own secrets, as merged ranges of its indices.
  const shown = [];
  for (const [, start, end] of scan(out)) shown.push([start, end]);
  for (const literal of literals) {
    for (let k = out.indexOf(literal); k >= 0; k = out.indexOf(literal, k + literal.length)) shown.push([k, k + literal.length]);
  }
  shown.sort((x, y) => x[0] - y[0]);
  const covered = [];
  for (const [a, b] of shown) {
    const last = covered.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else covered.push([a, b]);
  }
  const needed = found.filter((h) => {
    if (h.ta < 0) return false;
    const f = firstFrom(out.length, cleaned.src, h.ta);
    const l = firstFrom(out.length, cleaned.src, h.tb) - 1;
    if (f > l) return false;
    let lo = 0;
    let hi = covered.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (covered[mid][0] <= f) lo = mid;
      else hi = mid - 1;
    }
    const range = covered[lo];
    return !(range && range[0] <= f && l < range[1]);
  });
  if (!needed.length) return out;
  needed.sort((x, y) => x.a - y.a);
  const groups = [];
  for (const { a, b } of needed) {
    const last = groups.at(-1);
    if (last && a < last.b) last.b = Math.max(last.b, b);
    else groups.push({ a, b });
  }
  // Each secret's text comes from the view without line breaks or the spaces at sites.
  const whole = unspaced ? joinLines(unspaced) : joined;
  const word = (ch) => /\w/.test(ch ?? '');
  const parts = [];
  let last = '';
  let prev = 0;
  for (const { a, b } of groups) {
    const f = firstFrom(out.length, cleaned.src, a);
    const l = firstFrom(out.length, cleaned.src, b) - 1;
    if (f > l) continue;
    const put = whole.text.slice(firstFrom(whole.text.length, whole.src, a), firstFrom(whole.text.length, whole.src, b));
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

module.exports = { gentleEscape, sortedSet, reveal };
