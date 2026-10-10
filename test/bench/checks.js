'use strict';

// The accessibility and readability checks of docs/human-experience.md 6.5,
// computed in the page from computed styles and Chrome's accessibility tree.
// Each returns { pass, ... } with enough detail to find a failure.

// Shared page helpers: visibility, effective background and WCAG luminance.
const LIB = `
const vis = (el) => { if (!el || !el.getClientRects().length) return false; const s = getComputedStyle(el); return s.visibility === 'visible' && s.display !== 'none' && Number(s.opacity) > 0.05 && !el.closest('[hidden], [inert], [aria-hidden="true"]'); };
const inView = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
const over = (top, under) => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
const bgOf = (el) => {
  const layers = [];
  for (let e = el; e; e = e.parentElement) {
    const s = getComputedStyle(e);
    const c = parse(s.backgroundColor);
    if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    if (e === document.documentElement && (!c || c[3] < 1)) layers.push(parse(getComputedStyle(document.documentElement).backgroundColor) || [255, 255, 255, 1]);
  }
  let out = [255, 255, 255, 1];
  for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i], out);
  return out;
};
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const textNodes = (scope) => { const w = document.createTreeWalker(scope || document.body, NodeFilter.SHOW_TEXT); const out = []; for (let n; (n = w.nextNode());) if (n.textContent.trim() && n.parentElement && vis(n.parentElement) && !n.parentElement.closest('script, style, noscript, .vh, title')) out.push(n); return out; };
`;

const contrast = `(() => { ${LIB}
  const fails = []; let checked = 0;
  for (const n of textNodes()) {
    const el = n.parentElement;
    const r = el.getBoundingClientRect();
    if (!inView(r)) continue;
    const s = getComputedStyle(el);
    const svg = el instanceof SVGElement;
    const fg = parse(svg ? s.fill : s.color);
    if (!fg) continue;
    let bg = bgOf(svg ? el.closest('svg').parentElement : el);
    if (svg) { const box = el.closest('a, g')?.querySelector('rect.box'); const f = box && parse(getComputedStyle(box).fill); if (f && f[3] > 0) bg = over(f, bg); }
    const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    const got = ratio(over(fg, bg), bg);
    checked++;
    if (got + 0.005 < need) fails.push({ text: n.textContent.trim().slice(0, 40), ratio: Math.round(got * 100) / 100, need, color: s.color, bg: 'rgb(' + bg.slice(0, 3).map(Math.round).join(',') + ')' });
  }
  const seen = new Set();
  const unique = fails.filter((f) => { const k = f.color + f.bg; if (seen.has(k)) return false; seen.add(k); return true; });
  return { pass: fails.length === 0, checked, failures: fails.length, samples: unique.slice(0, 8) };
})()`;

// Every glyph that carries a status has a name or sits beside its word.
// Called with (glyphs, words).
const colorAlone = `(glyphs, words) => { ${LIB}
  const unlabeled = [];
  let checked = 0;
  for (const g of document.querySelectorAll(glyphs)) {
    if (!g.getClientRects().length || g.closest('[hidden]') || getComputedStyle(g).display === 'none' || g.closest('.sheet:not(.open):not(:target)')) continue;
    checked++;
    const named = g.getAttribute('aria-label') || g.querySelector('title');
    const row = g.closest('li, tr, article, p, a, .row, div');
    const text = row ? row.textContent.toLowerCase() : '';
    if (!named && !words.some((w) => text.includes(w))) unlabeled.push((row ? row.textContent : '').trim().slice(0, 50));
  }
  return { pass: unlabeled.length === 0, checked, unlabeled: unlabeled.length, samples: unlabeled.slice(0, 5) };
}`;

// WCAG 2.5.8: 24 by 24, or spaced so a 24 px circle on each does not meet
// another; links inside a sentence are exempt. Buttons are 32 px tall.
const targets = `(() => { ${LIB}
  const all = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, label[for], [role=button], [tabindex]:not([tabindex="-1"])')].filter((el) => vis(el) && inView(el.getBoundingClientRect()));
  const boxes = all.map((el) => {
    let r = el.getBoundingClientRect();
    if (el.matches('input[type=radio], input[type=checkbox]') && el.labels && el.labels[0] && vis(el.labels[0])) r = el.labels[0].getBoundingClientRect();
    return { el, r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }).filter((b) => b.r.width > 0 && b.r.height > 0 && !(b.el.matches('input[type=radio], input[type=checkbox]') && getComputedStyle(b.el).opacity === '0'));
  const inline = (el) => { if (!el.matches('a')) return false; const p = el.parentElement; if (!p) return false; const s = getComputedStyle(el); if (s.display !== 'inline') return false; const own = [...p.childNodes].filter((c) => c.nodeType === 3 && c.textContent.trim()).length; return own > 0; };
  const fails = []; const shortButtons = [];
  for (const b of boxes) {
    if (b.el.matches('button') && !b.el.closest('.cmd') && b.r.height < 31.5) shortButtons.push((b.el.textContent || b.el.getAttribute('aria-label') || '').trim().slice(0, 30));
    if (b.r.width >= 23.5 && b.r.height >= 23.5) continue;
    if (inline(b.el)) continue;
    const clash = boxes.some((o) => o !== b && Math.hypot(o.cx - b.cx, o.cy - b.cy) < 24 && !(o.el.contains(b.el) || b.el.contains(o.el)));
    if (clash) fails.push({ text: (b.el.textContent || b.el.getAttribute('aria-label') || b.el.tagName).trim().slice(0, 30), w: Math.round(b.r.width), h: Math.round(b.r.height) });
  }
  return { pass: fails.length === 0 && shortButtons.length === 0, checked: boxes.length, failures: fails.length, samples: fails.slice(0, 6), short_buttons: shortButtons.length, short_samples: shortButtons.slice(0, 4) };
})()`;

const motion = `(() => {
  const running = document.getAnimations().filter((a) => a.playState === 'running');
  return { pass: running.length === 0, running: running.length, samples: running.slice(0, 4).map((a) => (a.animationName || a.transitionProperty || 'animation') + ' on ' + (a.effect && a.effect.target ? a.effect.target.className || a.effect.target.tagName : '?')) };
})()`;

const readability = `(() => { ${LIB}
  const sizes = new Map(); let small = 0; let total = 0; const clipped = []; const long = [];
  const ctx2d = document.createElement('canvas').getContext('2d');
  for (const n of textNodes()) {
    const el = n.parentElement;
    if (!inView(el.getBoundingClientRect())) continue;
    const s = getComputedStyle(el);
    const px = Math.round(parseFloat(s.fontSize) * 10) / 10;
    const len = n.textContent.trim().length;
    sizes.set(px, (sizes.get(px) || 0) + len);
    total += len;
    if (px < 12) small += len;
  }
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || !inView(el.getBoundingClientRect()) || el.matches('svg, svg *, input, textarea, select, code, pre, .vh, .vh *')) continue;
    const s = getComputedStyle(el);
    const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (!own) continue;
    const hides = (v) => /hidden|clip/.test(v);
    if ((hides(s.overflowX) && el.scrollWidth > el.clientWidth + 1) || (hides(s.overflowY) && el.scrollHeight > el.clientHeight + 2) || (s.webkitLineClamp && s.webkitLineClamp !== 'none' && el.scrollHeight > el.clientHeight + 2)) clipped.push(el.textContent.trim().slice(0, 40));
    if (el.matches('p, li, blockquote, dd') && el.textContent.trim().length > 80) {
      const range = document.createRange(); range.selectNodeContents(el);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      // What a full line holds: the text's own width against the line box.
      if (lines > 1) {
        const text = el.textContent.replace(/\\s+/g, ' ').trim();
        ctx2d.font = s.fontWeight + ' ' + s.fontSize + ' ' + s.fontFamily;
        const box = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
        const per = text.length * box / ctx2d.measureText(text).width;
        if (per > 80) long.push({ text: text.slice(0, 30), chars: Math.round(per) });
      }
    }
  }
  const list = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
  const min = Math.min(...sizes.keys());
  const body = parseFloat(getComputedStyle(document.body).fontSize);
  const hscroll = document.documentElement.scrollWidth > innerWidth + 1;
  const pass = min >= 12 && sizes.size <= 6 && body >= 15 && !long.length && !clipped.length && !hscroll;
  return { pass, min_px: min, sizes: sizes.size, size_list: list.map(([s]) => s).sort((a, b) => a - b), body_px: body, under_12_share: total ? Math.round((small / total) * 1000) / 10 : 0, long_lines: long.length, long_samples: long.slice(0, 3), clipped: clipped.length, clipped_samples: clipped.slice(0, 5), horizontal_scroll: hscroll };
})()`;

// Share of the first viewport covered by content: a grid of points, each
// covered when what it hits has text, a control or a drawn surface of its own
// below the page's layout wrappers. Called with (wrappers).
const density = `(wrappers) => {
  const skip = new Set(['HTML', 'BODY', 'MAIN']);
  const wrap = (el) => el.matches(wrappers);
  const drawn = (el) => { const s = getComputedStyle(el); return (s.backgroundColor && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(s.backgroundColor)) || parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderLeftWidth) > 0; };
  let covered = 0; let n = 0;
  for (let y = 45; y < innerHeight; y += 90) for (let x = 40; x < innerWidth; x += 80) {
    n++;
    let el = document.elementFromPoint(x, y);
    let hit = false;
    for (; el && !skip.has(el.tagName); el = el.parentElement) {
      if (wrap(el)) break;
      if (el.matches('svg, svg *, button, input, select, textarea, a') || [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) || drawn(el)) { hit = true; break; }
    }
    if (hit) covered++;
  }
  const share = Math.round((covered / n) * 1000) / 10;
  return { pass: share >= 70, share };
}`;

// One h1, landmarks, a polite live region, and named controls from the AX tree.
async function names(b) {
  const page = await b.inPage(`(() => ({
    h1: document.querySelectorAll('h1').length,
    main: document.querySelectorAll('main').length,
    nav: document.querySelectorAll('nav').length,
    banner: document.querySelectorAll('header').length,
    polite: document.querySelectorAll('[aria-live="polite"], [role="status"]').length,
  }))()`);
  const { nodes } = await b.send('Accessibility.getFullAXTree');
  const roles = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'listbox', 'menuitem', 'tab', 'searchbox', 'spinbutton', 'slider', 'switch']);
  const unnamed = nodes.filter((n) => !n.ignored && roles.has(n.role && n.role.value) && !(n.name && String(n.name.value || '').trim()));
  const pass = page.h1 === 1 && page.main === 1 && page.nav >= 1 && page.polite >= 1 && unnamed.length === 0;
  return { pass, ...page, unnamed: unnamed.length, samples: unnamed.slice(0, 4).map((n) => n.role.value) };
}

module.exports = { contrast, colorAlone, targets, motion, readability, density, names };
