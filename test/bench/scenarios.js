'use strict';

// The scenarios of docs/human-experience.md 6.4, each a path a person takes on
// one build, ending in a state the CLI confirms. A scenario returns its counts
// (driver.Path.result), the pass bar's parts and the state it produced, so the
// mode-parity scenario can compare the board path with the CLI path.

const fs = require('node:fs');
const path = require('node:path');
const D = require('./driver');
const C = require('./checks');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, ms = 20000, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(step);
  }
}

// Page functions; selectors reach them as arguments (browser.call).
const textOf = (sel) => (document.querySelector(sel) || {}).textContent || '';
const exists = (sel) => !!document.querySelector(sel);

// Fully inside the viewport and inside every scrolling ancestor's visible box.
const shown = (sel) => {
  const el = document.querySelector(sel);
  if (!el || !el.getClientRects().length || getComputedStyle(el).visibility !== 'visible') return false;
  const r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight + 0.5 || r.left < 0 || r.right > innerWidth + 0.5) return false;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll|hidden)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1) { const q = p.getBoundingClientRect(); if (r.top < q.top - 0.5 || r.bottom > q.bottom + 0.5) return false; }
  }
  return true;
};

// What needs the owner in a state, independent of any build: open decisions,
// owner tasks, messages to the owner since the owner last wrote, and claims
// whose lease ran out.
function needs(s) {
  const tasks = s.read('tasks.json').tasks;
  const events = s.events();
  const lastOwner = events.findLast((e) => e.agent === 'owner');
  const keys = s.read('decisions.json').decisions.filter((d) => d.status === 'open').map((d) => d.id);
  for (const t of tasks) if (t.needs_owner && !['accepted', 'cancelled'].includes(t.status)) keys.push(`owner-${t.id}`);
  for (const e of events) if (e.cmd === 'msg' && e.detail.to === 'owner' && (!lastOwner || e.at > lastOwner.at)) keys.push(`msg-${e.id}`);
  for (const t of tasks) if (t.status === 'in_progress' && t.claim && Date.parse(t.claim.until) < Date.now()) keys.push(`stuck-${t.id}`);
  return keys;
}

// A selector for an item key: messages and stuck rows carry a suffix.
const itemSel = (T, key) => (key.startsWith('stuck-') ? T.item(key).replace(`="${key}"]`, `^="${key}"]`) : T.item(key));

// Timestamps, ids and the commit a twin fixture made differ by construction.
const strip = (e) => { const { at, id, ...rest } = e; const d = { ...rest.detail }; delete d.via; delete d.mode; delete d.sha; return { ...rest, detail: d }; };

async function h1(ctx) {
  const { b, T, url, s } = ctx;
  await D.load(b, url);
  const p = new D.Path(b);
  p.think();
  const keys = needs(s);
  const items = [];
  for (const key of keys) {
    const sel = itemSel(T, key);
    const present = await b.call(exists, sel);
    const first = present && await b.call(shown, sel);
    items.push({ key, present, first_viewport: !!first });
  }
  const title = await b.inPage('document.title');
  const n = Number((/^\((\d+)\)/.exec(title) || /^(\d+) needs? you/.exec(title) || [0, 0])[1]);
  if (ctx.shots) await D.shot(b, ctx.shots('H1'));
  // Reaching each item that starts below the fold, by wheel, is the path.
  const phone = ctx.size[0] < 500;
  // On a phone the bar is the count and the first item; elsewhere, every item.
  if (!phone) for (const it of items) if (it.present && !it.first_viewport) { await p.reveal(itemSel(T, it.key)); p.think(); }
  const r = p.result();
  const visible = items.filter((i) => i.first_viewport).length;
  const firstShown = items.length && items[0].first_viewport;
  const pass = items.every((i) => i.present) && n === keys.length && r.actions === 0
    && (phone ? firstShown : visible === items.length) && r.klm_s <= 3;
  return { ...r, items: items.length, present: items.filter((i) => i.present).length, first_viewport: visible, title_count: n, expected_count: keys.length, pass };
}

async function h2(ctx) {
  const { b, T, url, s } = ctx;
  await D.load(b, url);
  const p = new D.Path(b);
  if (T.noteOpen) await p.click(T.noteOpen('D1'));
  await p.click(T.note('D1'));
  await p.type('history must survive restarts');
  await p.click(T.option('D1', 'postgres'));
  const d = await waitFor(() => { const x = s.read('decisions.json').decisions.find((y) => y.id === 'D1'); return x.status === 'answered' && x; });
  await wait(600);
  const focus = await b.inPage(`(() => { const a = document.activeElement; const item = a && a.closest('[data-key]'); return item ? item.getAttribute('data-key') : a ? a.tagName : null; })()`);
  if (ctx.shots) await D.shot(b, ctx.shots('H2'));
  const r = p.result();
  const ok = !!d && d.answer === 'postgres' && d.note === 'history must survive restarts' && d.answered_by === 'owner';
  const nextItem = focus && /^(D\d|owner-|msg-|stuck-|runaway-|budget-)/.test(focus) && focus !== 'D1';
  const pass = ok && r.clicks <= 2 && r.scrolls === 0 && nextItem && r.klm_without_typing_s <= 6;
  return { ...r, answered: ok, focus_after: focus, pass, delta: d && { status: d.status, answer: d.answer, note: d.note, answered_by: d.answered_by, event: strip(s.events().findLast((e) => e.cmd === 'answer')) } };
}

async function h2a(ctx) {
  const { b, T, url } = ctx;
  await D.load(b, url);
  const text = await b.call(textOf, T.item('D3'));
  const sentence = /admin merges/i.test(text) && /\boff\b/i.test(text) && /\bon\b/i.test(text);
  const raw = /\{"merge-admin"/.test(text) && !sentence;
  return { sentence, raw_json: raw, applied: null, pass: false, note: 'approving applies the recorded request only with T89/T91 (not on this base): the owner makes the change and answers' };
}

async function h3(ctx) {
  const { b, T, url, s } = ctx;
  const id = s.ids.retry;
  await D.load(b, url);
  const p = new D.Path(b);
  let navigations = 0;
  if (T.reviewNav) { await p.click(T.reviewNav); navigations++; } else { await p.click(T.reviewEntry(id)); navigations++; }
  await wait(300);
  await p.reveal(T.finding(id));
  p.think();
  const finding = await b.call(textOf, T.finding(id));
  await p.click(T.rework(id));
  await p.type('ignore 429s from paused endpoints and honor Retry-After');
  await p.click(T.reworkSend(id));
  const t = await waitFor(() => { const x = s.read('tasks.json').tasks.find((y) => y.id === id); return x.status === 'rework' && x; });
  await wait(400);
  if (ctx.shots) await D.shot(b, ctx.shots('H3'));
  const r = p.result();
  const readable = /paused endpoint/.test(finding);
  const pass = !!t && readable && navigations <= 1 && r.clicks <= 3 + navigations && r.klm_without_typing_s <= 12;
  return { ...r, navigations, finding_readable: readable, sent_back: !!t, pass, delta: t && { status: t.status, note: t.notes.at(-1).text, event: strip(s.events().findLast((e) => e.cmd === 'rework')) } };
}

// The stub's own count of what it wrote: its session file, read after exit.
function stubTokens(s) {
  let total = 0;
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.jsonl') && p.includes(`${path.sep}projects${path.sep}`)) {
        for (const line of fs.readFileSync(p, 'utf8').trim().split('\n')) {
          try { const u = JSON.parse(line).message?.usage; if (u) total += (u.input_tokens || 0) + (u.output_tokens || 0); } catch { /* partial line */ }
        }
      }
    }
  };
  walk(path.join(s.state, 'homes'));
  return total;
}

function killTree(pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }

async function h4(ctx) {
  const { b, T, url, s } = ctx;
  const id = s.task;
  await D.load(b, url);
  const spawned = s.spawnAgent({ steps: 40, per: 1000000, every: 1000 });
  ctx.cleanup.push(() => killTree(spawned.pid));
  const readings = [];
  const rowText = () => b.call(textOf, T.agentTokens(id));
  const exited = () => s.events().some((e) => e.cmd === 'spawn exit' && e.task === id);
  // The rule's own threshold for this tier, from the project's history.
  const norms = require('../../lib/runaway').calibrate({ tasks: s.read('tasks.json') });
  const threshold = norms.multiple * norms.tiers.easy.median;
  let crossedAt = null;
  let flaggedAt = null;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    readings.push(await rowText());
    const live = s.events().filter((e) => e.cmd === 'spend live' && e.task === id && e.detail.tokens > threshold);
    if (!crossedAt && live.length) crossedAt = Date.parse(live[0].at);
    if (T.runaway && !flaggedAt && await b.call(exists, T.runaway(id))) flaggedAt = Date.now();
    if (flaggedAt || (crossedAt && Date.now() - crossedAt > 15000)) break;
    await wait(500);
  }
  const distinct = [...new Set(readings.filter(Boolean))];
  const rose = distinct.length >= 2 && !exited();
  if (ctx.shots) await D.shot(b, ctx.shots('H4-flagged'));
  let r = null; let stopped = null; let reconciled = null; let words = null; const rowWords = [];
  if (T.stopOpen && flaggedAt) {
    const p = new D.Path(b);
    await p.click(T.stopOpen(id));
    if (ctx.shots) await D.shot(b, ctx.shots('H4-confirm'));
    await p.click(T.stopSend(id));
    r = p.result();
    stopped = await waitFor(() => { const e = s.events(); return e.some((x) => x.cmd === 'budget stop' && x.task === id) && e.some((x) => x.cmd === 'spawn exit' && x.task === id) && e; }, 30000);
    // The row's own words for each state it passes through.
    words = await waitFor(async () => { const t = await b.call((row, stopped) => ((document.querySelector(row) || document.querySelector(stopped) || {}).querySelector?.('.stopstate') || {}).textContent || '', T.agentRow(id), `[data-key="stopped-${id}"]`); if (t && !rowWords.includes(t.trim())) rowWords.push(t.trim()); return /stopped/i.test(t) && t; }, 30000);
    if (ctx.shots) await D.shot(b, ctx.shots('H4-stopped'));
    reconciled = await waitFor(() => { const t = s.read('tasks.json').tasks.find((x) => x.id === id); return t.spend.entries.length && t.spend.entries.every((e) => !e.live) && t; }, 30000);
    if (!words) rowWords.push('(no stopped state shown)');
  }
  const ev = s.events();
  const retries = ev.filter((e) => e.cmd === 'spawn retry' && e.task === id).length;
  const recorded = reconciled ? reconciled.spend.tokens : null;
  const stubCount = reconciled ? stubTokens(s) : null;
  const latency = crossedAt && flaggedAt ? flaggedAt - crossedAt : null;
  const pass = rose && !!flaggedAt && latency !== null && latency <= 2500 && !!r && r.clicks <= 2 && !!stopped && !!words && retries === 0 && recorded !== null && recorded === stubCount;
  killTree(spawned.pid);
  return { rose_before_exit: rose, readings: distinct.slice(0, 6), flagged: !!flaggedAt, flag_latency_ms: latency, path: r, stopped: !!stopped, retries, recorded_tokens: recorded, stub_tokens: stubCount, row_words: rowWords, pass,
    delta: stopped && { budget: s.read('tasks.json').tasks.find((x) => x.id === id).budget, event: strip(ev.findLast((e) => e.cmd === 'task update' && e.task === id) || {}) } };
}

async function h4s(ctx) {
  const { b, T, url, s, variant } = ctx;
  const id = s.task;
  await D.load(b, url);
  const spawned = s.spawnAgent({});
  ctx.cleanup.push(() => killTree(spawned.pid));
  if (variant === 'stale') {
    // A running supervisor keeps its reading fresh; staleness is what the
    // board sees when the supervisor is gone and the agent still runs.
    const phase = await waitFor(() => s.events().find((e) => ['spawn', 'spawn phase'].includes(e.cmd) && e.task === id && e.detail.monitor_pid && s.events().some((x) => x.cmd === 'spend live' && x.task === id && x.detail.tokens)), 20000);
    if (phase) try { process.kill(phase.detail.monitor_pid, 'SIGKILL'); } catch { /* gone */ }
  }
  const want = variant === 'stale' ? /stale/i : /unknown until exit|unavailable/i;
  const text = await waitFor(async () => { const t = await b.call(textOf, T.agentRow(id)); return want.test(t) && t; }, 30000);
  const row = text || await b.call(textOf, T.agentRow(id));
  const zero = /(^|\s)0 tokens/.test(row);
  const flagged = T.runaway ? await waitFor(() => b.call(exists, T.runaway(id)), variant === 'stale' ? 8000 : 2000) : false;
  const sentence = T.sentence ? await b.call(textOf, T.sentence) : '';
  const counted = /not counted/i.test(sentence);
  if (ctx.shots) await D.shot(b, ctx.shots(`H4s-${variant}`));
  killTree(spawned.pid);
  const pass = !!text && !zero && (variant === 'stale' ? !!flagged : true) && counted;
  return { shown: !!text, row: row.replace(/\s+/g, ' ').trim().slice(0, 160), drawn_as_zero: zero, flagged: !!flagged, sentence_not_counted: counted, pass };
}

async function h5(ctx) {
  const { b, T, url, s } = ctx;
  const spawned = s.spawned || (s.spawned = s.spawnAgent({ steps: 3, per: 800000, every: 800, hold: 900000 }));
  ctx.cleanup.push(() => killTree(spawned.pid));
  await waitFor(() => s.events().some((e) => e.cmd === 'spend live' && e.detail.tokens >= 2.4e6), 30000);
  await D.load(b, url);
  await wait(500);
  const parts = {};
  for (const [k, sel] of Object.entries({ used: T.spend.used, rate: T.spend.rate, projection: T.spend.projection, top: T.spend.top })) {
    if (!sel) { parts[k] = { shown: false, text: '' }; continue; }
    const text = await b.call(textOf, sel);
    parts[k] = { shown: !!(await b.call(shown, sel)), text: text.replace(/\s+/g, ' ').trim().slice(0, 120) };
  }
  const fresh = /live|s old|s ago|min old/i.test(Object.values(parts).map((x) => x.text).join(' '));
  if (ctx.shots) await D.shot(b, ctx.shots('H5'));
  const phone = ctx.size[0] < 500;
  const pass = Object.values(parts).every((x) => (phone ? x.text : x.shown)) && fresh;
  return { parts, freshness_shown: fresh, pass };
}

async function h6(ctx) {
  const { b, T, url, s } = ctx;
  const id = s.ids.worker;
  await D.load(b, url);
  if (!T.messageOpen) return { pass: false, note: 'no path: the board reaches the orchestrator only (task comment); msg --to the agent is CLI-only' };
  const p = new D.Path(b);
  await p.click(T.messageOpen(id));
  await p.click(T.message(id), { think: false });
  await p.type('drain on SIGTERM first, then the tests');
  await p.click(T.messageSend(id));
  const e = await waitFor(() => s.events().findLast((x) => x.cmd === 'msg' && x.task === id && x.agent === 'owner'));
  if (ctx.shots) await D.shot(b, ctx.shots('H6'));
  const r = p.result();
  const ok = !!e && e.detail.to === `worker-${id}-1`;
  return { ...r, delivered_to: e && e.detail.to, pass: ok && r.clicks <= 3, delta: e && { event: strip(e) } };
}

async function h7(ctx) {
  const { b, T, url, s } = ctx;
  const events = s.events();
  const mark = events[events.length - 51].at;
  const since = events.slice(-50);
  const want = new Set();
  for (const e of since) {
    if (['accept', 'rework'].includes(e.cmd) && e.task) want.add(e.task);
    if (['ask', 'answer'].includes(e.cmd)) want.add(e.detail.decision || e.detail.id);
  }
  const key = `tower-crane:seen:${s.read('project.json').name}:/`;
  // Written from a same-origin page that runs no board script, so the board's
  // own pagehide write cannot replace the mark before the next load reads it.
  const look = async (at) => {
    await b.goto(new URL('/bench-storage', url).href);
    await b.call((k, v) => localStorage.setItem(k, v), key, at);
    await D.load(b, url);
  };
  await look(mark);
  const text = await b.call(textOf, T.digest);
  const named = [...want].filter((x) => new RegExp(`\\b${x}\\b`).test(text));
  const grouped = await b.call((sel) => document.querySelectorAll(sel).length, `${T.digest} [data-group]`);
  if (ctx.shots) await D.shot(b, ctx.shots('H7'));
  // Nothing new: the heading and the list must agree.
  const newest = events.at(-1).at;
  await look(newest);
  const calmText = await b.call(textOf, T.digest);
  const contradiction = /nothing new/i.test(calmText) && /since you looked/i.test(calmText) && /\bsince now\b/i.test(calmText);
  const pass = named.length === want.size && grouped > 0 && !contradiction;
  return { expected: [...want], named, grouped_by_meaning: grouped > 0, heading_contradiction: contradiction, pass };
}

async function h8(ctx) {
  const { b, T, url } = ctx;
  await D.load(b, url);
  await wait(1500);
  const hues = await b.call((attention) => {
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement('i'); document.body.appendChild(probe);
    const tokens = attention.map((t) => { probe.style.color = root.getPropertyValue(t).trim(); const c = getComputedStyle(probe).color; return [t, c]; }).filter(([, c]) => c && c !== 'rgb(0, 0, 0)' || false);
    probe.remove();
    const hits = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth || r.width * r.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.visibility !== 'visible' || el.closest('[hidden], .vh')) continue;
      const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
      const used = [own ? s.color : null, s.backgroundColor, parseFloat(s.borderLeftWidth) ? s.borderLeftColor : null, parseFloat(s.borderTopWidth) ? s.borderTopColor : null, el instanceof SVGElement ? s.fill : null];
      for (const [t, c] of tokens) if (used.includes(c)) hits.push(t + ' on ' + (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || el.tagName));
    }
    return [...new Set(hits)];
  }, T.attention);
  const m = await b.inPage(C.motion);
  const sentence = T.sentence ? await b.call(textOf, T.sentence) : await b.call(textOf, '.col-need');
  const calmWords = /nothing needs you/i.test(sentence);
  if (ctx.shots) await D.shot(b, ctx.shots('H8'));
  return { hue_hits: hues.slice(0, 6), hues: hues.length, motion_after_load: m.running, motion_samples: m.samples, says_nothing_needs_you: calmWords, pass: hues.length === 0 && m.running === 0 && calmWords };
}

// The same state changes through the CLI, as the orchestrator and the owner
// would make them without the board.
async function h9(ctx, board) {
  const { s } = ctx;
  const out = {};
  if (board.H2?.delta) {
    s.ok(['answer', 'D1', '--choice', 'postgres', '--note', 'history must survive restarts']);
    const d = s.read('decisions.json').decisions.find((y) => y.id === 'D1');
    out.H2 = same(board.H2.delta, { status: d.status, answer: d.answer, note: d.note, answered_by: d.answered_by, event: strip(s.events().findLast((e) => e.cmd === 'answer')) });
  }
  if (board.H3?.delta) {
    const id = s.ids.retry;
    s.ok(['rework', id, '--reason', 'ignore 429s from paused endpoints and honor Retry-After']);
    const t = s.read('tasks.json').tasks.find((y) => y.id === id);
    out.H3 = same(board.H3.delta, { status: t.status, note: t.notes.at(-1).text, event: strip(s.events().findLast((e) => e.cmd === 'rework')) });
  }
  if (board.H6?.delta) {
    const id = s.ids.worker;
    s.ok(['msg', '--to', `worker-${id}-1`, '--task', id, 'drain on SIGTERM first, then the tests']);
    out.H6 = same(board.H6.delta, { event: strip(s.events().findLast((e) => e.cmd === 'msg' && e.agent === 'owner')) });
  }
  const results = Object.values(out);
  return { compared: Object.keys(out), mismatches: Object.entries(out).filter(([, v]) => !v.same).map(([k, v]) => ({ scenario: k, diff: v.diff })), pass: results.length > 0 && results.every((v) => v.same) };
}

function same(a, b) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return { same: x === y, diff: x === y ? null : { board: a, cli: b } };
}

// One room at a time (6.5), by nav, direct link, a sheet opened inside the
// room, a cleared fragment and a live update.
async function oneRoom(ctx) {
  const { b, T, url, s } = ctx;
  const failures = [];
  const displayed = () => b.call((sel) => [...document.querySelectorAll(sel)].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id), T.roomSelector);
  const topIn = (room) => b.call((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return r.top >= -1 && r.top < innerHeight; }, T.room(room));
  const click = (sel) => b.call((q) => document.querySelector(q).click(), sel);
  const check = async (room, how) => {
    const d = await displayed();
    const top = await topIn(room);
    if (d.length !== 1 || d[0] !== room || !top) failures.push({ room, how, displayed: d, top_in_view: top });
  };
  let n = 0;
  for (const room of T.rooms) {
    await D.load(b, T.roomUrl(url, room));
    await check(room, 'direct link');
    for (const other of T.rooms) {
      if (other === room) continue;
      await click(T.nav(other));
      await wait(150);
      await click(T.nav(room));
      await wait(150);
      break;
    }
    await check(room, 'nav');
    const link = await b.call((sel) => { const a = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length); if (!a) return null; a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); if (location.hash !== a.getAttribute('href')) location.hash = a.getAttribute('href'); return a.getAttribute('href'); }, `${T.room(room)} a[href^="#T"], ${T.room(room)} a[href*="#T"]`);
    if (link) {
      await wait(250);
      await check(room, 'sheet opened inside');
      await b.inPage(`(() => { const c = document.querySelector('.sheet.open [data-close]'); if (c) c.click(); })()`);
      await wait(150);
    }
    await b.inPage(`location.hash = ''`);
    await wait(200);
    await check(room, 'cleared fragment');
    s.ok(['task', 'note', 'T1', `one room ${room} ${n++}`, '--agent', 'orchestrator']);
    const note = `one room ${room} ${n - 1}`;
    if (!await waitFor(() => b.call((t) => document.documentElement.hasAttribute('data-position-restored') && document.body.textContent.includes(t), note).catch(() => false), 20000, 50)) failures.push({ room, how: 'live update', error: 'no update' });
    await wait(200);
    await check(room, 'live update');
  }
  return { pass: failures.length === 0, checks: T.rooms.length * 5, failures };
}

// Keyboard: Tab reaches the scenario actions with a visible ring; Escape
// closes a sheet and returns focus.
async function keyboard(ctx) {
  const { b, T, url, s } = ctx;
  await D.load(b, url);
  const want = [T.option('D1', 'postgres'), T.note('D1')];
  if (T.messageOpen) want.push(T.messageOpen(s.ids.worker));
  const reached = new Map();
  const p = new D.Path(b);
  for (let i = 0; i < 260 && reached.size < want.length; i++) {
    await p.key('Tab');
    const hit = await b.call((sels) => {
      const a = document.activeElement; if (!a) return null;
      const i = sels.findIndex((x) => a.matches(x));
      if (i < 0) return null;
      const st = getComputedStyle(a);
      const ring = (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) >= 2) || (st.boxShadow && st.boxShadow !== 'none');
      return [i, ring];
    }, want);
    if (hit) reached.set(hit[0], hit[1]);
  }
  const missing = want.filter((_, i) => !reached.has(i));
  const noRing = want.filter((_, i) => reached.get(i) === false);
  // A sheet by keyboard: focus a task link, Enter, Escape.
  const sel = await b.inPage(`(() => { const a = [...document.querySelectorAll('a[href^="#T"]')].find((x) => x.getClientRects().length && !x.closest('.sheet')); a.focus(); a.setAttribute('data-bench-invoker', ''); return a.getAttribute('href'); })()`);
  await p.key('Enter');
  const opened = await waitFor(() => b.inPage(`!!document.querySelector('.sheet.open')`), 3000);
  await p.key('Escape');
  const closed = await waitFor(() => b.inPage(`!document.querySelector('.sheet.open')`), 3000);
  const back = await b.inPage(`document.activeElement && document.activeElement.hasAttribute('data-bench-invoker')`);
  return { pass: !missing.length && !noRing.length && !!opened && !!closed && back, tabs: p.result().keys, reached: reached.size, of: want.length, missing, no_ring: noRing, sheet: sel, sheet_opened: !!opened, escape_closed: !!closed, focus_returned: back };
}

async function checks(ctx) {
  const { b, T } = ctx;
  return {
    contrast: await b.inPage(C.contrast),
    color_alone: await b.call(C.colorAlone, T.glyphs, ['ready', 'blocked', 'in progress', 'submitted', 'rework', 'accepted', 'cancelled', 'working', 'stopped', 'paused', 'now', 'your turn', 'stale', 'live']),
    targets: await b.inPage(C.targets),
    names: await C.names(b),
    readability: await b.inPage(C.readability),
  };
}

module.exports = { h1, h2, h2a, h3, h4, h4s, h5, h6, h7, h8, h9, oneRoom, keyboard, checks, needs, waitFor, wait, killTree };
