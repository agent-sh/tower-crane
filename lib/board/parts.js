'use strict';

// Pieces every room draws: escaping, commands, glyphs, times and lengths.

const M = require('./model');

const PRODUCT = 'Tower Crane';
const CLI = Object.keys(require('../../package.json').bin)[0];

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// JSON inside a script element: nothing in it may close the element.
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

const LABEL = { ready: 'ready', blocked: 'blocked', in_progress: 'in progress', submitted: 'submitted', rework: 'rework', accepted: 'accepted', cancelled: 'cancelled' };
const ORDER = ['accepted', 'submitted', 'in_progress', 'rework', 'ready', 'blocked', 'cancelled'];

// Shell words: quoted only when they need it, so commands read naturally.
const arg = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, "'\\''")}'`);
const command = (...words) => [CLI, ...words.map(arg)].join(' ');

function cmd(text, label = 'Copy') {
  return `<div class="cmd"><code>${esc(text)}</code><button type="button" data-copy="${esc(text)}" aria-label="Copy command: ${esc(text)}">${label}</button></div>`;
}

// ---- glyphs: a shape per status, and the marks the queue adds ----

const SYMBOLS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="g-ready" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/></symbol>
<symbol id="g-blocked" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 1.6"/></symbol>
<symbol id="g-in_progress" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 1.5a4.5 4.5 0 0 1 0 9z" fill="currentColor"/></symbol>
<symbol id="g-submitted" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="6" r="2" fill="currentColor"/></symbol>
<symbol id="g-accepted" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5.25" fill="currentColor"/></symbol>
<symbol id="g-rework" viewBox="0 0 12 12"><path d="M10.5 6A4.5 4.5 0 1 1 7.6 1.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.4 0.4 9.6 1.9 7 4.2z" fill="currentColor"/></symbol>
<symbol id="g-cancelled" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.8 9.2 9.2 2.8" stroke="currentColor" stroke-width="1.5"/></symbol>
<symbol id="g-now" viewBox="0 0 12 12"><path d="M6 0.8 11.5 11H0.5z" fill="currentColor"/><path d="M6 4.2v3.4M6 8.6v1" stroke="var(--on-alarm, #fff)" stroke-width="1.3"/></symbol>
<symbol id="g-turn" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor"/></symbol>
<symbol id="g-runaway" viewBox="0 0 12 12"><path d="M1.2 9.5a4.8 4.8 0 1 1 9.6 0" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 9.5 9.2 4.4" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="9.5" r="1.2" fill="currentColor"/></symbol>
<symbol id="g-stopping" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="4" y="4" width="4" height="4" fill="currentColor"/></symbol>
</defs></svg>`;

const glyph = (s, label) => `<svg class="g g-${s}" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}><use href="#g-${s}"/></svg>`;
const status = (s) => glyph(s, LABEL[s]);

const MARK = (signal) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 22V5M2 5h20M7 5 12 1.5 17 5M7 9l4-4M7 13l4-4" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="1.5" y="5.8" width="3.5" height="2.6" fill="currentColor"/><path d="M17 5v6" stroke="currentColor" stroke-width="1.2"/><rect x="14.5" y="11" width="5" height="4" fill="${signal ? '#f2b705' : 'currentColor'}"${signal ? ' stroke="#7a5100"' : ''}/></svg>`;

function favicon(signal) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1a1916"/><path d="M10 29V8M4 8h24M10 8l6-4 6 4M10 13l5-5" fill="none" stroke="#eceae6" stroke-width="2"/><path d="M22 8v7" stroke="#eceae6" stroke-width="1.6"/><rect x="18.5" y="15" width="7" height="6" fill="${signal ? '#f2b705' : '#8f8b82'}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ---- time ----

function clock(iso, nowIso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (String(iso).slice(0, 10) === String(nowIso).slice(0, 10)) return hm;
  return `${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()} ${hm}`;
}

// The client rewrites these as relative times; a snapshot keeps the UTC clock.
const time = (iso, nowIso, cls = '') => `<time datetime="${esc(iso)}"${cls ? ` class="${cls}"` : ''} title="${esc(String(iso).replace('T', ' ').slice(0, 16))} UTC">${clock(iso, nowIso)}</time>`;

function span(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 && h < 10 ? `${h} h ${m % 60} min` : `${h} h`;
}

function age(s) {
  if (s == null) return '';
  if (s < 90) return `${s} s`;
  return span(s * 1000);
}

// Relative times go stale in a snapshot opened later, so it states the clock time.
function leaseText(lease, live) {
  if (!live) return `lease ${lease.left > 0 ? 'until' : 'ran out at'} ${clock(lease.until, new Date().toISOString())} UTC`;
  return lease.left > 0 ? `lease ends in ${span(lease.left)}` : `lease ran out ${span(lease.left)} ago`;
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const hours = (min) => (min ? `${Math.round((min / 60) * 10) / 10} h` : '-');

// ---- pieces ----

function taskLink(id, label = id, cls = 'id') {
  return `<a href="#${esc(id)}" class="${cls}">${esc(label)}</a>`;
}

function rungText(r) {
  if (!r) return '';
  return [r.harness, r.model].filter(Boolean).join(' ') + (r.effort ? `, ${r.effort}` : '');
}

// A quantity as a length (P7); near and over are words beside it, not color alone.
function bar(used, limit, label, cls = '') {
  if (limit == null || !(limit > 0)) return '';
  const p = (used / limit) * 100;
  const state = p > 100 ? ' over' : p >= 90 ? ' near' : '';
  return `<span class="bar-len${state}${cls ? ` ${cls}` : ''}" role="img" aria-label="${esc(label)}: ${Math.round(p)}%"><span style="width:${Math.min(100, Math.max(0, Math.round(p)))}%"></span></span>`;
}

const GATE_WORD = { pass: 'passed', fail: 'failed', missing: 'not yet', waived: 'waived' };

function pips(gates) {
  if (!gates || !gates.length) return '';
  return `<ul class="pips" aria-label="Gates">${gates.map((g) => `<li class="pip ${g.state}" title="${esc(g.reason || '')}">${esc(g.type)} <span>${GATE_WORD[g.state]}</span></li>`).join('')}</ul>`;
}

// The newest readings as a short line of tokens per reading.
function spark(values) {
  if (!values || values.length < 2) return '';
  const max = Math.max(1, ...values);
  const step = 64 / (values.length - 1);
  const pts = values.map((v, i) => `${Math.round(i * step * 10) / 10},${Math.round((17 - (v / max) * 15) * 10) / 10}`).join(' ');
  return `<svg class="spark" viewBox="0 0 64 18" role="img" aria-label="tokens per reading, newest ${esc(M.compact(values.at(-1)))}"><polyline points="${pts}"/></svg>`;
}

module.exports = { PRODUCT, CLI, esc, json, LABEL, ORDER, arg, command, cmd, SYMBOLS, glyph, status, MARK, favicon, clock, time, span, age, leaseText, pct, hours, taskLink, rungText, bar, pips, spark, GATE_WORD };
