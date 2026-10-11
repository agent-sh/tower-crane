'use strict';

// The board as one HTML document: the Board, Plan, History and Spend views
// and a sheet per task, drawn from model.js. render writes it as a snapshot;
// serve sends the same document with its token and the owner's forms.

const L = require('../ladder');
const M = require('./model');
const { CSS } = require('./style');
const { CLIENT } = require('./client');
const { preserve } = require('./identity');

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

// ---- glyphs ----

const SYMBOLS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="g-ready" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/></symbol>
<symbol id="g-blocked" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 1.6"/></symbol>
<symbol id="g-in_progress" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 1.5a4.5 4.5 0 0 1 0 9z" fill="currentColor"/></symbol>
<symbol id="g-submitted" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="6" r="2" fill="currentColor"/></symbol>
<symbol id="g-accepted" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5.25" fill="currentColor"/></symbol>
<symbol id="g-rework" viewBox="0 0 12 12"><path d="M10.5 6A4.5 4.5 0 1 1 7.6 1.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.4 0.4 9.6 1.9 7 4.2z" fill="currentColor"/></symbol>
<symbol id="g-cancelled" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.8 9.2 9.2 2.8" stroke="currentColor" stroke-width="1.5"/></symbol>
</defs></svg>`;

const glyph = (s, labelled = false) => `<svg class="g g-${s}" ${labelled ? `role="img" aria-label="${esc(LABEL[s])}"` : 'aria-hidden="true"'}><use href="#g-${s}"/></svg>`;

const MARK = (signal) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 22V5M2 5h20M7 5 12 1.5 17 5M7 9l4-4M7 13l4-4" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="1.5" y="5.8" width="3.5" height="2.6" fill="currentColor"/><path d="M17 5v6" stroke="currentColor" stroke-width="1.2"/><rect x="14.5" y="11" width="5" height="4" fill="${signal ? '#ffc800' : 'currentColor'}"${signal ? ' stroke="#c99a00"' : ''}/></svg>`;

function favicon(signal) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#14181c"/><path d="M10 29V8M4 8h24M10 8l6-4 6 4M10 13l5-5" fill="none" stroke="#e7ebee" stroke-width="2"/><path d="M22 8v7" stroke="#e7ebee" stroke-width="1.6"/><rect x="18.5" y="15" width="7" height="6" fill="${signal ? '#ffc800' : '#8c96a0'}"/></svg>`;
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

const time = (iso, nowIso, cls = '') => `<time datetime="${esc(iso)}"${cls ? ` class="${cls}"` : ''} title="${esc(String(iso).replace('T', ' ').slice(0, 16))} UTC">${clock(iso, nowIso)}</time>`;

function span(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 && h < 10 ? `${h} h ${m % 60} min` : `${h} h`;
}

// Relative times go stale in a snapshot opened later, so it states the clock time.
function leaseText(lease, live) {
  if (!live) return `lease ${lease.left > 0 ? 'until' : 'ran out at'} ${clock(lease.until, new Date().toISOString())} UTC`;
  return lease.left > 0 ? `lease ends in ${span(lease.left)}` : `lease ran out ${span(lease.left)} ago`;
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const hours = (min) => (min ? hoursAll(min) : '-');
const hoursAll = (min) => `${Math.round((min / 60) * 10) / 10} h`;

// ---- pieces ----

function taskLink(id, label = id) {
  return `<a href="#${esc(id)}" class="id">${esc(label)}</a>`;
}

function rungText(r) {
  if (!r) return '';
  return [r.harness, r.model].filter(Boolean).join(' ') + (r.effort ? `, ${r.effort}` : '');
}

function meter(used, budget, label) {
  if (budget == null) return '';
  const p = budget ? (used / budget) * 100 : used > 0 ? 101 : 0;
  const cls = p > 100 ? ' over' : p >= 90 ? ' near' : '';
  return `<span class="meter${cls}" title="${esc(label)}"><span class="track"><span class="fill" style="width:${Math.min(100, Math.round(p))}%"></span></span>${Math.round(p)}%</span>`;
}

function pips(gates) {
  if (!gates || !gates.length) return '';
  const word = { pass: 'passed', fail: 'failed', missing: 'not yet', waived: 'waived by the owner' };
  return `<ul class="pips" aria-label="Gates">${gates.map((g) => `<li class="pip ${g.state}" title="${esc(g.reason || '')}">${esc(g.type)}<span class="vh"> ${word[g.state]}</span></li>`).join('')}</ul>`;
}

function phaseTrack(phase) {
  if (!phase) return '';
  return `<ol class="phase" aria-label="Phase: ${esc(phase.label)}">${M.PHASES.map((p, i) => `<li class="${i < phase.step ? 'done' : i === phase.step ? 'now' : ''}"${i === phase.step ? ' aria-current="step"' : ''}>${p}</li>`).join('')}</ol>`;
}

// ---- top bar ----

function topBar(m, opts) {
  const c = m.counts;
  const shown = ORDER.filter((s) => c[s]);
  const rail = `<div class="rail" role="img" aria-label="${esc(shown.map((s) => `${c[s]} ${LABEL[s]}`).join(', '))} of ${m.total} tasks">${shown.map((s) => `<span class="r-${s}" style="flex:${c[s]}"></span>`).join('')}</div>`;
  const counts = `<ul class="counts">${shown.map((s) => `<li>${glyph(s)}<b>${c[s]}</b> ${LABEL[s]}</li>`).join('')}</ul>`;
  const sp = m.spend;
  const spend = `<span class="spendmini">${esc(M.compact(sp.tokens))} tokens${sp.budget_tokens != null ? ` of ${esc(M.compact(sp.budget_tokens))}` : ''}, ${esc(hoursAll(sp.minutes))}${sp.budget_hours != null ? ` of ${esc(sp.budget_hours)} h` : ''}${sp.live.length ? ` (${sp.live.length} running: <span data-live-summary>${esc(liveStates(sp))}</span>)` : ''}</span>`;
  const conn = opts.live
    ? '<span class="conn" data-conn="connecting" role="status">Connecting</span>'
    : `<span class="conn" data-conn="snapshot">Snapshot ${time(m.generated_at, m.generated_at)} UTC</span>`;
  const n = m.attention.count;
  const views = [['board', 'Board', n], ['plan', 'Plan'], ['history', 'History'], ['spend', 'Spend']];
  const nav = `<nav class="views" data-scroll="views" aria-label="Views">${views.map(([id, label, count]) => `<a href="${opts.base}#${id}" data-view="${id}">${label}${count ? `<span class="n" aria-label="${count} need you">${count}</span>` : ''}</a>`).join('')}${opts.live ? `<a href="settings" data-view="settings"${opts.current === 'settings' ? ' aria-current="page"' : ''}>Settings</a>` : ''}</nav>`;
  return `<header class="topbar" data-region="bar">
<div class="brand">${MARK(n > 0)}<span>${PRODUCT}</span></div>
<div class="proj"><h1>${esc(m.project.name)}</h1><p class="goal" title="${esc(m.project.goal)}">${esc(m.project.goal)}</p></div>
<div class="state">${spend}${conn}</div>
<div class="railbox">${rail}${counts}</div>
${nav}
</header>`;
}

// ---- board ----

function decisionPlate(d, m, opts) {
  const blocks = d.blocks.length
    ? `blocks ${d.blocks.map((b) => `${taskLink(b.id)}${b.now ? ' <em class="now">now</em>' : ''}`).join(', ')}`
    : 'blocks nothing';
  let act;
  if (opts.owner) {
    const buttons = d.options.length
      ? d.options.map((o) => `<button class="btn${o === d.recommendation ? ' primary' : ''}" type="submit" name="choice" value="${esc(o)}">${esc(o)}${o === d.recommendation ? '<span class="vh"> (recommended)</span>' : ''}</button>`).join('')
      : `<label class="field">Answer<input name="choice" required autocomplete="off"></label><button class="btn primary" type="submit">Answer</button>`;
    act = `<form data-api="/api/decisions/${esc(d.id)}/answer" data-done="Answered ${esc(d.id)}">
<div class="acts">${buttons}</div>
<details class="more"><summary>Add context to the answer</summary><label class="field">Context<input name="note" autocomplete="off"></label></details>
<output></output></form>
<details class="more"><summary>Comment without answering</summary><form data-api="/api/decisions/${esc(d.id)}/comments" data-done="Comment sent"><label class="field">Comment<textarea name="text" required></textarea></label><div class="acts"><button class="btn" type="submit">Send comment</button></div><output></output></form></details>`;
  } else {
    act = cmd(command('answer', d.id, '--choice', d.recommendation || d.options[0] || 'ANSWER', '--agent', 'owner'));
  }
  const notes = d.notes.length ? `<p class="why"><b>${d.notes.length} comment${d.notes.length === 1 ? '' : 's'}.</b> Latest from ${esc(d.notes[d.notes.length - 1].agent)}: ${esc(d.notes[d.notes.length - 1].text)}</p>` : '';
  return `<article class="plate signal" data-key="${esc(d.id)}" aria-labelledby="q-${esc(d.id)}">
<div class="head"><span class="kind">Decision ${esc(d.id)}</span><span>${blocks}</span><span>asked by ${esc(d.asked_by)} ${time(d.asked_at, m.generated_at)}</span></div>
<p class="q" id="q-${esc(d.id)}">${esc(d.question)}</p>
${d.why ? `<p class="why">${esc(d.why)}</p>` : ''}
${d.recommendation ? `<p class="rec">Recommended: <b>${esc(d.recommendation)}</b></p>` : ''}
${notes}${act}
</article>`;
}

function ownerPlate(t, m, opts) {
  const act = opts.owner
    ? `<form data-api="/api/tasks/${esc(t.id)}/owner-done" data-done="${esc(t.id)} marked done"><div class="acts"><button class="btn primary" type="submit">Mark done</button><a class="btn quiet" href="#${esc(t.id)}">Open ${esc(t.id)}</a></div><details class="more"><summary>Add a note to mark done with</summary><label class="field">What was done<input name="note" autocomplete="off"></label></details><output></output></form>`
    : cmd(command('owner-done', t.id, '--agent', 'owner'));
  return `<article class="plate signal" data-key="owner-${esc(t.id)}">
<div class="head"><span class="kind">Owner task</span><span>on ${taskLink(t.id)}${t.urgent ? ' <em class="now">blocking now</em>' : ''}</span></div>
<p class="q">${esc(t.needs)}</p>
<p class="why">${esc(t.title)}</p>
${act}
</article>`;
}

function messagePlate(x, m) {
  return `<article class="plate signal" data-key="msg-${esc(x.key)}">
<div class="head"><span class="kind">Message to you</span><span>from <span class="mono">${esc(x.agent)}</span>${x.task ? ` on ${taskLink(x.task)}` : ''}</span>${time(x.at, m.generated_at)}</div>
<p class="why">${esc(x.text)}</p>
</article>`;
}

function budgetPlates(m) {
  return m.attention.budget.map(({ what, used, limit, flag, unit, percent }) => {
    const fmt = unit === 'tokens' ? M.compact : (h) => span(h * 3600000);
    return `<article class="plate signal" data-key="budget-${flag}"><p class="q">${what} at ${percent}%</p><p class="why">${esc(fmt(used))} used of ${esc(fmt(limit))}. Raise the budget or move tiers down a rung in Settings.</p>${cmd(command('project', 'set', flag, String(Math.ceil(limit * 1.5))))}</article>`;
  });
}

function stuckPlate(s, m) {
  return `<article class="plate stuck" data-key="stuck-${esc(s.id)}-${esc(s.what)}">
<p class="t">${glyph('rework')} ${taskLink(s.id)} <span>${esc(s.title)}</span></p>
<p class="what">${esc(s.what)}${s.since ? ` ${time(s.since, m.generated_at)}` : ''}</p>
${cmd(command(...s.fix.match(/"[^"]*"|\S+/g).map((w) => w.replace(/^"|"$/g, ''))))}
</article>`;
}

function needsColumn(m, opts) {
  const a = m.attention;
  const budget = budgetPlates(m);
  const n = a.count;
  const groups = [];
  if (a.decisions.length) groups.push(`<h3 class="grouph">Decisions</h3>${a.decisions.map((d) => decisionPlate(d, m, opts)).join('\n')}`);
  if (a.owner.length) groups.push(`<h3 class="grouph">Owner tasks</h3>${a.owner.map((t) => ownerPlate(t, m, opts)).join('\n')}`);
  if (a.messages.length) groups.push(`<h3 class="grouph">Messages to you</h3>${a.messages.map((x) => messagePlate(x, m)).join('\n')}`);
  if (budget.length) groups.push(`<h3 class="grouph">Budget</h3>${budget.join('\n')}`);
  if (a.stuck.length) groups.push(`<h3 class="grouph">Stuck</h3>${a.stuck.map((s) => stuckPlate(s, m)).join('\n')}`);
  const empty = n ? '' : `<p class="empty">Nothing needs you. Decisions, owner tasks and messages to you appear here.</p>`;
  return `<section class="col col-need${n ? '' : ' calm'}" aria-labelledby="h-need" data-region="need">
<h2 class="colh" id="h-need">Needs you <span class="n">${n}</span>${a.stuck.length ? `<span class="aside">${a.stuck.length} stuck</span>` : ''}</h2>
${empty}${groups.join('\n')}
</section>`;
}

function workCard(w, m, opts) {
  const r = w.rung ? `${w.rung.name}: ${rungText(w.rung)}` : w.tier;
  const lease = w.lease ? `<div class="lease${w.lease.warn ? ' warn' : ''}" data-until="${esc(w.lease.until)}" data-since="${esc(w.lease.since || '')}"><span class="track"><span class="fill" style="width:${Math.round(w.lease.frac * 100)}%"></span></span><span class="lt">${esc(leaseText(w.lease, opts.live))}</span></div>` : '';
  const last = w.last ? `<blockquote class="last"><p>${esc(w.last.text)}</p><footer><span class="mono">${esc(w.last.agent)}</span> ${time(w.last.at, m.generated_at)}</footer></blockquote>` : '';
  const sp = w.spend;
  const cost = sp.tokens || sp.minutes ? `<p class="cost">${sp.tokens ? `${esc(M.compact(sp.tokens))} tokens` : ''}${sp.tokens && sp.minutes ? ', ' : ''}${sp.minutes ? esc(hours(sp.minutes)) : ''}${w.reworks ? `, sent back ${w.reworks} time${w.reworks === 1 ? '' : 's'}` : ''}</p>` : '';
  return `<article class="card${w.status === 'submitted' ? ' submitted' : ''}" data-key="${esc(w.id)}" aria-labelledby="w-${esc(w.id)}">
<p class="t" id="w-${esc(w.id)}">${glyph(w.status, true)}<a href="#${esc(w.id)}" class="title" data-identity="board-task-${esc(w.id)}"><span class="id">${esc(w.id)}</span> ${esc(w.title)}</a></p>
<p class="who"><span class="mono">${esc(w.agent || '-')}</span> on ${esc(r)}</p>
${phaseTrack(w.phase)}
<p class="status-line">${esc(w.phase ? w.phase.label : '')}${w.sha ? ` at <span class="mono">${esc(w.sha.slice(0, 7))}</span>` : ''}${w.pr ? `, PR #${esc(w.pr)}` : ''}${w.stack ? `, stack after ${esc(w.stack.parent)}` : ''}${w.github_stack?.id != null ? `, GitHub stack #${esc(w.github_stack.id)}` : ''}</p>
${w.run ? `<p class="status-line">Run: ${esc(w.run.label)}</p>` : ''}
${w.gates ? pips(w.gates) : lease}
${last}${cost}
</article>`;
}

function workColumn(m, opts) {
  const live = m.working.filter((w) => w.status === 'in_progress').length;
  const sub = m.working.length - live;
  const body = m.working.length
    ? `<div class="cards">${m.working.map((w) => workCard(w, m, opts)).join('\n')}</div>`
    : `<p class="empty">No agent holds a task. ${m.ready.length ? `${m.ready.length} task${m.ready.length === 1 ? ' is' : 's are'} ready for the orchestrator to dispatch.` : 'Nothing is ready to start.'}</p>`;
  return `<section class="col col-work" aria-labelledby="h-work" data-region="work">
<h2 class="colh" id="h-work">Working now <span class="n">${m.working.length}</span><span class="aside">${live} claimed, ${sub} in gates</span></h2>
${body}
</section>`;
}

function readyRow(r) {
  return `<li class="row" data-key="r-${esc(r.id)}">${glyph(r.rework ? 'rework' : 'ready')}<a href="#${esc(r.id)}" data-identity="board-task-${esc(r.id)}"><span class="t"><span class="id">${esc(r.id)}</span>${esc(r.title)}</span></a><span class="meta">${esc(r.tier)}, ${esc(r.kind)} ${esc(r.size)}${r.unblocks ? `, unblocks ${r.unblocks}` : ''}${r.rework ? ', <span class="why">rework</span>' : ''}</span></li>`;
}

function blockedRow(b) {
  const reasons = b.reasons.map((x) => esc(x.replace(/\((in_progress|todo|rework|submitted|cancelled)\)$/, (all, st) => `(${st.replace('_', ' ')})`).replace(/^depends on /, 'after ').replace(/^waits for decision (D\d+):.*/, 'waits for decision $1').replace(/^needs owner: .*/, 'waits for the owner')));
  return `<li class="row" data-key="b-${esc(b.id)}">${glyph('blocked')}<a href="#${esc(b.id)}" data-identity="board-task-${esc(b.id)}"><span class="t"><span class="id">${esc(b.id)}</span>${esc(b.title)}</span></a><span class="meta"><span class="${b.owner ? 'owner' : 'why'}">${reasons.slice(0, 3).join(', ')}${reasons.length > 3 ? `, and ${reasons.length - 3} more` : ''}</span></span></li>`;
}

function nextColumn(m) {
  const ready = m.ready.length ? `<ol class="rows">${m.ready.map(readyRow).join('')}</ol>` : '<p class="empty">Nothing is ready. Blocked tasks wait on what is listed beside them.</p>';
  const blocked = m.blocked.length ? `<ul class="rows">${m.blocked.map(blockedRow).join('')}</ul>` : '<p class="empty">Nothing is blocked.</p>';
  return `<section class="col col-next" aria-labelledby="h-next" data-region="next">
<h2 class="colh" id="h-next">Up next <span class="n">${m.ready.length}</span><span class="aside">ready first, by what they unblock</span></h2>
<div class="next-split"><div><h3 class="grouph" style="margin-top:0">Ready <span class="faint">${m.ready.length}</span></h3>${ready}</div><div><h3 class="grouph">Blocked <span class="faint">${m.blocked.length}</span></h3>${blocked}</div></div>
</section>`;
}

function evRow(x, m) {
  const text = esc(x.text).replace(/(?<![\w-])T\d+(?![\w-])/g, (id, offset) => (m.display.has(id) ? `<a href="#${id}" data-mention="${offset}">${id}</a>` : id));
  return `<li class="ev${x.tone ? ` ${x.tone}` : ''}${x.owner ? ' owner' : ''}" data-event="${esc(x.key)}" data-at="${esc(x.at)}" data-kind="${esc(x.kind)}" data-task="${esc(x.task || '')}">${time(x.at, m.generated_at)}<span class="txt">${text}</span></li>`;
}

function sinceColumn(m) {
  const body = m.digest.length ? `<ol class="feed" data-scroll="digest">${m.digest.map((x) => evRow(x, m)).join('')}</ol>` : '<p class="empty">Nothing has happened yet.</p>';
  return `<section class="col col-since" aria-labelledby="h-since" data-region="since">
<div class="since-head"><h2 class="colh" id="h-since"><span data-since-title>Recent</span><span class="aside" data-since-when></span></h2>
<p class="since-sum" data-since-sum>The newest ${m.digest.length} events, without bookkeeping.</p></div>
${body}
</section>`;
}

function boardView(m, opts) {
  if (!m.total) {
    return `<section id="board" class="view" aria-label="Board"><div class="viewh"><h2>No tasks yet</h2></div>
<p class="muted">Tower Crane keeps the plan here once tasks exist. Add the first task, or import a plan:</p>
${cmd(command('task', 'add', '--title', 'First task', '--acceptance', 'what done means'))}
${cmd(command('plan', 'import', 'plan.json'))}
</section>`;
  }
  return `<section id="board" class="view" aria-label="Board"><div class="board">
${needsColumn(m, opts)}
${workColumn(m, opts)}
${nextColumn(m)}
${sinceColumn(m)}
</div></section>`;
}

// ---- plan ----

const NODE_W = 236;
const NODE_H = 54;
const COL_GAP = 56;
const ROW_GAP = 12;
const PAD = 12;

function depths(tasks) {
  const byKey = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map();
  const visiting = new Set();
  const of = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const dep of byKey.get(id).depends_on) if (byKey.has(dep)) d = Math.max(d, of(dep) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const t of tasks) of(t.id);
  return depth;
}

// Columns by dependency depth; within a column, tasks sit near the average
// row of what they depend on, which keeps most edges short.
function layout(tasks) {
  const depth = depths(tasks);
  const cols = [];
  for (const t of tasks) (cols[depth.get(t.id)] ||= []).push(t);
  const row = new Map();
  cols.forEach((col, c) => {
    if (c > 0) {
      const bary = (t) => {
        const rs = t.depends_on.filter((d) => row.has(d)).map((d) => row.get(d));
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => bary(a) - bary(b));
    }
    col.forEach((t, i) => row.set(t.id, i));
  });
  const pos = new Map(tasks.map((t) => [t.id, { x: PAD + depth.get(t.id) * (NODE_W + COL_GAP), y: PAD + row.get(t.id) * (NODE_H + ROW_GAP) }]));
  const rows = Math.max(1, ...cols.map((c) => (c ? c.length : 0)));
  return { pos, cols, width: PAD * 2 + cols.length * NODE_W + Math.max(0, cols.length - 1) * COL_GAP, height: PAD * 2 + rows * NODE_H + (rows - 1) * ROW_GAP };
}

const trunc = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function planView(m) {
  if (!m.total) return '<section id="plan" class="view" aria-label="Plan"><p class="empty">No tasks yet.</p></section>';
  const { pos, cols, width, height } = layout(m.tasks);
  const needs = new Set([...m.attention.decisions.flatMap((d) => d.blocks.map((b) => b.id)), ...m.attention.owner.map((t) => t.id)]);
  const edges = [];
  for (const t of m.tasks) {
    const to = pos.get(t.id);
    for (const d of t.depends_on) {
      const from = pos.get(d);
      if (!from) continue;
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x - 3;
      const y2 = to.y + NODE_H / 2;
      const dx = Math.max(20, (x2 - x1) / 2);
      const done = m.display.get(d) === 'accepted' || m.display.get(d) === 'cancelled';
      edges.push(`<path class="edge${done ? ' done' : ''}" data-from="${esc(d)}" data-to="${esc(t.id)}" d="M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}" marker-end="url(#arrow)"/>`);
    }
  }
  const nodes = m.tasks.map((t) => {
    const p = pos.get(t.id);
    const s = m.display.get(t.id);
    return `<a href="#${esc(t.id)}" class="node s-${s}" data-id="${esc(t.id)}" transform="translate(${p.x} ${p.y})" aria-label="${esc(`${t.id} ${t.title}, ${LABEL[s]}, tier ${t.tier}`)}">
<rect class="box" width="${NODE_W}" height="${NODE_H}" rx="2"/>${needs.has(t.id) ? `<rect class="flag" x="${NODE_W - 12}" y="0" width="12" height="12"/>` : ''}
<use href="#g-${s}" x="10" y="10" width="12" height="12" class="g-${s}"/>
<text class="nid" x="28" y="20.5">${esc(t.id)}</text><text class="nmeta" x="${NODE_W - (needs.has(t.id) ? 18 : 10)}" y="20" text-anchor="end">${esc(LABEL[s])}, ${esc(t.tier)}</text>
<text class="ntitle" x="10" y="41">${esc(trunc(t.title, 33))}</text></a>`;
  });
  const legend = ['ready', 'blocked', 'in_progress', 'submitted', 'rework', 'accepted', 'cancelled'].map((s) => `<li>${glyph(s)}${LABEL[s]}</li>`).join('');
  const layers = cols.map((col, i) => `<div class="layer"><h3 class="grouph">${i === 0 ? 'No dependencies' : `Layer ${i + 1}, after layer ${i}`}</h3><ul class="rows">${[...col].sort((a, b) => (a.id < b.id ? -1 : 1)).map((t) => `<li class="row">${glyph(m.display.get(t.id))}<a href="#${esc(t.id)}"><span class="t"><span class="id">${esc(t.id)}</span>${esc(t.title)}</span></a><span class="meta">${LABEL[m.display.get(t.id)]}, ${esc(t.tier)}${t.depends_on.length ? `, after ${t.depends_on.map(esc).join(', ')}` : ''}</span></li>`).join('')}</ul></div>`).join('');
  return `<section id="plan" class="view" aria-labelledby="h-plan" data-region="plan">
<div class="viewh"><h2 id="h-plan">Plan</h2><p>${m.total} tasks in ${cols.length} layer${cols.length === 1 ? '' : 's'}. A task starts once everything it depends on is accepted. A yellow corner marks a task that waits on you.</p></div>
<div class="plan-tools"><ul class="legend">${legend}</ul><label><input type="checkbox" data-hide-done> Dim accepted and cancelled</label></div>
<div class="plan-wrap" data-scroll="graph"><svg class="graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Task dependency graph">
<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="arrow" d="M0 0L8 4L0 8z"/></marker></defs>
${edges.join('\n')}
${nodes.join('\n')}
</svg></div>
<div class="layers">${layers}</div>
</section>`;
}

// ---- history ----

const DAY = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

function historyView(m) {
  const kinds = [['main', 'Without bookkeeping'], ['all', 'All'], ['flow', 'Claims and handoffs'], ['gates', 'Gates'], ['decisions', 'Decisions'], ['messages', 'Messages'], ['owner', 'Owner'], ['trouble', 'Trouble'], ['plan', 'Plan and bookkeeping']];
  const filters = `<fieldset class="filters" style="border:0;padding:0;margin:0 0 var(--s4)"><legend class="vh">Show</legend>${kinds.map(([k, label], i) => `<input type="radio" name="hf" id="hf-${k}" value="${k}"${i === 0 ? ' checked' : ''}><label for="hf-${k}">${label}</label>`).join('')}<label class="field" for="hf-task">Task<input id="hf-task" placeholder="T7" autocomplete="off" spellcheck="false"></label></fieldset>`;
  const days = [];
  for (const x of m.history) {
    const day = String(x.at).slice(0, 10);
    if (!days.length || days[days.length - 1].day !== day) days.push({ day, items: [] });
    days[days.length - 1].items.push(x);
  }
  const body = days.length ? days.map((d) => `<section class="day" data-key="day-${esc(d.day)}"><h3>${esc(Number.isNaN(Date.parse(d.day)) ? d.day : DAY.format(new Date(d.day)))}</h3><ol class="feed">${d.items.map((x) => evRow(x, m)).join('')}</ol></section>`).join('') : '<p class="empty">No events yet.</p>';
  const capped = m.events_total > m.history.length ? `<p class="history-note">Showing the newest ${m.history.length} of ${m.events_total} events. The full log is events.jsonl in the state directory.</p>` : '';
  // The filters sit outside the live region, so an update keeps the choice.
  return `<section id="history" class="view" aria-labelledby="h-history">
<div class="viewh"><h2 id="h-history">History</h2><p>Every change, newest first, in UTC days. Times are UTC in a snapshot opened without scripts.</p></div>
${filters}<div data-region="history">${body}${capped}</div>
</section>`;
}

// ---- spend ----

function liveStates(sp) {
  return [...new Set(sp.live.map((l) => l.state))].join(', ');
}

function spendView(m) {
  const sp = m.spend;
  const maxRung = Math.max(1, ...sp.by_rung.map((r) => r.tokens));
  const maxTask = Math.max(1, ...sp.by_task.map((r) => r.tokens));
  const maxModel = Math.max(1, ...sp.by_model.map((r) => r.tokens));
  const cachedShare = sp.input ? `${pct(sp.cached, sp.input)}% of input from cache` : 'no input breakdown reported';
  const totals = `<div class="totals">
<div class="total"><p class="muted">Tokens</p><p class="big">${esc(M.compact(sp.tokens))}</p><p class="sub">${sp.input || sp.output ? `${esc(M.compact(sp.input))} in, ${esc(M.compact(sp.output))} out, ${cachedShare}` : 'no breakdown reported'}</p>${sp.budget_tokens != null ? `<p class="sub">Budget ${esc(M.compact(sp.budget_tokens))} ${meter(sp.tokens, sp.budget_tokens, 'tokens against budget')}</p>` : '<p class="sub">No token budget set</p>'}</div>
<div class="total"><p class="muted">Agent time</p><p class="big">${esc(hoursAll(sp.minutes))}</p><p class="sub">reported by agents, summed across tasks</p>${sp.budget_hours != null ? `<p class="sub">Budget ${esc(sp.budget_hours)} h ${meter(sp.minutes / 60, sp.budget_hours, 'hours against budget')}</p>` : '<p class="sub">No time budget set</p>'}</div>
<div class="total" data-live="${esc(liveStates(sp))}"><p class="muted">Running now</p><p class="big">${sp.live.length}</p><p class="sub">${sp.live.length ? `usage read while agents run, <span data-live-summary>${esc(liveStates(sp))}</span>; in the totals until exit replaces it` : 'no agent is running'}</p></div>
<div class="total"><p class="muted">Spawns without usage</p><p class="big">${sp.spawns_without_usage}</p><p class="sub">${sp.spawns_without_usage ? 'their tokens are not in these totals' : 'every spawn reported its tokens'}</p></div>
</div>`;
  const rungRows = sp.by_rung.map((r) => `<tr><th scope="row">${esc(r.key === 'unrecorded' ? 'not recorded' : r.key)}</th><td class="muted">${esc(rungText(r.rung) || '-')}</td><td class="num">${r.entries}</td><td class="num">${esc(M.compact(r.tokens))}</td><td class="barcell"><div class="share"><span style="width:${pct(r.tokens, maxRung)}%"></span></div></td><td class="num">${r.input ? `${pct(r.cached, r.input)}%` : '-'}</td><td class="num">${esc(hours(r.minutes))}</td></tr>`).join('');
  const modelRows = sp.by_model.map((r) => `<tr><th scope="row" class="mono">${esc(r.key === 'unrecorded' ? 'not recorded' : r.key)}</th><td class="num">${r.entries}</td><td class="num">${esc(M.compact(r.tokens))}</td><td class="barcell"><div class="share"><span style="width:${pct(r.tokens, maxModel)}%"></span></div></td><td class="num">${esc(hours(r.minutes))}</td></tr>`).join('');
  const taskRow = (r) => `<tr><th scope="row"><a href="#${esc(r.id)}" class="id" data-identity="spend-task-${esc(r.id)}">${esc(r.id)}</a> <span style="font-weight:400">${esc(trunc(r.title, 64))}</span></th><td>${glyph(r.status)} ${LABEL[r.status]}</td><td class="muted">${esc(r.tier)}</td><td class="num">${esc(M.compact(r.tokens))}</td><td class="barcell"><div class="share"><span style="width:${pct(r.tokens, maxTask)}%"></span></div></td><td class="num">${esc(hours(r.minutes))}</td><td class="num">${r.reworks || ''}</td></tr>`;
  const head = '<thead><tr><th scope="col">Task</th><th scope="col">Status</th><th scope="col">Tier</th><th scope="col" class="num">Tokens</th><th scope="col"><span class="vh">Share</span></th><th scope="col" class="num">Time</th><th scope="col" class="num">Sent back</th></tr></thead>';
  const ladder = m.ladder.error
    ? `<tr><td colspan="5" class="muted">${esc(m.ladder.error)}</td></tr>`
    : L.RUNGS.map((n) => {
      const r = L.rungOf(m.ladder, n);
      const what = r.harness === 'command' ? JSON.stringify(r.command) : [r.model, r.profile && `profile ${r.profile}`, r.provider && `provider ${r.provider}`].filter(Boolean).join(', ');
      return `<tr data-rung="${n}"><th scope="row">${n}</th><td>${esc(m.ladder.ladder[n].harness_from === 'default' ? `${r.harness} (default)` : r.harness)}</td><td>${esc(what || '-')}</td><td>${esc(r.effort || '-')}</td><td class="muted">${esc(L.USES[n])}</td></tr>`;
    }).join('');
  const age = (l) => (l.age_s < 120 ? `${l.age_s}s` : `${Math.round(l.age_s / 60)}m`);
  const liveRows = sp.live.map((l) => `<tr data-live-state="${esc(l.state)}" data-live-at="${esc(l.at)}" data-live-stale-at="${esc(l.stale_at)}"><th scope="row"><a href="#${esc(l.task)}" class="id">${esc(l.task)}</a> <span class="mono">${esc(l.agent)}</span></th><td>${esc(l.harness || '-')}</td><td class="num">${l.tokens == null ? 'unavailable' : esc(M.compact(l.tokens))}</td><td class="live-state">${esc(l.state)}</td><td class="num live-age">${esc(age(l))} ago</td></tr>`).join('');
  const top = sp.by_task.slice(0, 20);
  const rest = sp.by_task.slice(20);
  return `<section id="spend" class="view" aria-labelledby="h-spend" data-region="spend">
<div class="viewh"><h2 id="h-spend">Spend</h2><p>Tokens and agent time as agents and spawns reported them, and the ladder that decides what runs each rung. Tower Crane records usage, not prices.</p></div>
${totals}
<div class="tables">
${liveRows ? `<div class="tbl-wrap wide" data-scroll="live"><table class="tbl"><caption>Live: usage of running agents and when it was last read</caption><thead><tr><th scope="col">Agent</th><th scope="col">Harness</th><th scope="col" class="num">Tokens</th><th scope="col">Freshness</th><th scope="col" class="num">Read</th></tr></thead><tbody>${liveRows}</tbody></table></div>` : ''}
<div class="tbl-wrap" data-scroll="rung"><table class="tbl"><caption>By rung</caption><thead><tr><th scope="col">Rung</th><th scope="col">Runs on now</th><th scope="col" class="num">Reports</th><th scope="col" class="num">Tokens</th><th scope="col"><span class="vh">Share</span></th><th scope="col" class="num">Cached</th><th scope="col" class="num">Time</th></tr></thead><tbody>${rungRows || '<tr><td colspan="7" class="muted">No usage reported yet.</td></tr>'}</tbody></table></div>
<div class="tbl-wrap" data-scroll="model"><table class="tbl"><caption>By model</caption><thead><tr><th scope="col">Model</th><th scope="col" class="num">Reports</th><th scope="col" class="num">Tokens</th><th scope="col"><span class="vh">Share</span></th><th scope="col" class="num">Time</th></tr></thead><tbody>${modelRows || '<tr><td colspan="5" class="muted">No usage reported yet.</td></tr>'}</tbody></table></div>
<div class="tbl-wrap wide" data-scroll="ladder"><table class="tbl"><caption>Ladder: what each rung runs</caption><thead><tr><th scope="col">Rung</th><th scope="col">Harness</th><th scope="col">Model or profile</th><th scope="col">Effort</th><th scope="col">Used for</th></tr></thead><tbody>${ladder}</tbody></table></div>
<div class="tbl-wrap wide" data-scroll="task"><table class="tbl"><caption>By task, most tokens first</caption>${head}<tbody>${top.map(taskRow).join('') || '<tr><td colspan="7" class="muted">No usage reported yet.</td></tr>'}</tbody></table>
${rest.length ? `<details class="more" data-disclosure="more-tasks"><summary>${rest.length} more tasks</summary><table class="tbl">${head}<tbody>${rest.map(taskRow).join('')}</tbody></table></details>` : ''}</div>
</div>
</section>`;
}

// ---- task sheets ----

function sheet(s, m, opts) {
  const facts = [`<span>${esc(s.kind)}, size ${esc(s.size)}</span>`, `<span>tier <b>${esc(s.tier)}</b>${s.rung ? ` (${esc(rungText(s.rung))})` : ''}</span>`, `<span>revision ${esc(s.revision)}</span>`];
  if (s.claim) facts.push(`<span>held by <b class="mono">${esc(s.claim.agent)}</b>${s.expired ? ', lease ran out' : ''}</span>`);
  if (s.submitted_by && s.stored !== 'in_progress') facts.push(`<span>submitted by <b class="mono">${esc(s.submitted_by)}</b></span>`);
  if (s.pr) facts.push(`<span>PR #${esc(s.pr)}</span>`);
  if (s.stack) facts.push(`<span>stack after ${esc(s.stack.parent)}, base ${esc(s.stack.base)}</span>`);
  if (s.github_stack != null) facts.push(`<span>GitHub stack ${esc(JSON.stringify(s.github_stack))}</span>`);
  if (s.sha) facts.push(`<span>at <b class="mono">${esc(s.sha.slice(0, 7))}</b></span>`);
  const secs = [];
  if (s.needs) {
    secs.push(`<section class="sec"><div class="plate signal"><div class="head"><span class="kind">Waits on the owner</span></div><p class="q">${esc(s.needs)}</p>${opts.owner ? `<form data-api="/api/tasks/${esc(s.id)}/owner-done" data-done="${esc(s.id)} marked done"><label class="field">What was done (optional)<input name="note" autocomplete="off"></label><div class="acts"><button class="btn primary" type="submit">Mark done</button></div><output></output></form>` : cmd(command('owner-done', s.id, '--agent', 'owner'))}</div></section>`);
  }
  if (s.blockers.length) {
    // The reason kind and its own task or decision id survive sibling removal.
    const blocker = (b) => `<li data-key="sheet-${esc(s.id)}-blocker-${esc(b.split(/[:(,]/, 1)[0].trim())}">${esc(b).replace(/(?<![\w-])T\d+(?![\w-])/g, (id, offset) => (m.display.has(id) ? `<a href="#${id}" class="id" data-mention="${offset}">${id}</a>` : id))}</li>`;
    secs.push(`<section class="sec"><h3>Blocked by</h3><ul class="blockers box">${s.blockers.map(blocker).join('')}</ul></section>`);
  }
  if (s.phase) secs.push(`<section class="sec"><h3>Now</h3><div class="box">${phaseTrack(s.phase)}<p class="status-line">${esc(s.phase.label)}</p>${s.run ? `<p class="status-line">Run: ${esc(s.run.label)}</p>` : ''}${s.claim && !s.expired ? `<div class="lease" data-until="${esc(s.claim.until)}" data-since="${esc(s.claim.since || '')}"><span class="lt">${esc(leaseText({ left: Date.parse(s.claim.until) - m.now, until: s.claim.until }, opts.live))}</span></div>` : ''}${s.branch ? `<p class="cost">branch <span class="mono">${esc(s.branch)}</span></p>` : ''}</div></section>`);
  secs.push(`<section class="sec"><h3>Acceptance</h3><ul class="accept box">${s.acceptance.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></section>`);
  if (s.gates) {
    const word = { pass: 'passed', fail: 'failed', missing: 'missing', waived: 'waived' };
    const rows = s.gates.map((g) => `<tr><th scope="row"><span class="pip ${g.state}">${esc(g.type)}</span></th><td>${word[g.state]}</td><td class="muted">${esc(g.reason || '')}</td></tr>`).join('');
    const missing = s.gates.filter((g) => g.state !== 'pass' && g.state !== 'waived').map((g) => g.type);
    const override = s.stored === 'submitted' && missing.length
      ? `<details class="more"><summary>Owner override at the terminal</summary><p class="cost">A waiver satisfies a gate without software proof and stays in the record. The board cannot waive.</p>${cmd(command('accept', s.id, ...missing.flatMap((g) => ['--waive', g]), '--reason', 'why this gate does not apply', '--agent', 'owner'))}</details>` : '';
    secs.push(`<section class="sec"><h3>Gates${s.sha ? ` at <span class="mono">${esc(s.sha.slice(0, 7))}</span>` : ''}</h3><div class="tbl-wrap" data-scroll="gates"><table class="tbl gates-tbl"><tbody>${rows}</tbody></table></div>${override}</section>`);
  }
  if (s.ledger.length) {
    const entry = (e) => {
      const long = String(e.summary || '').length > 420 || String(e.summary || '').split('\n').length > 6;
      const receipts = Array.isArray(e.commands) && e.commands.length
        ? `<details class="receipts" data-disclosure="receipts"><summary>${e.commands.length} command${e.commands.length === 1 ? '' : 's'} ran</summary>${e.commands.map((c) => `<div class="receipt">${esc([c.command, ...(c.args || [])].join(' '))}${c.cwd ? `\nin ${esc(c.cwd)}` : ''}\nexit ${esc(c.status ?? '-')}${c.signal ? `, signal ${esc(c.signal)}` : ''}</div>`).join('')}</details>` : '';
      const ref = e.ref ? (/^https:\/\//.test(e.ref) ? `<a href="${esc(e.ref)}" rel="noreferrer noopener" target="_blank">link</a>` : `<span class="mono">${esc(e.ref)}</span>`) : '';
      // A long summary is drawn once, clipped; the toggle below it unclips it.
      const sum = e.summary ? `<div class="sum${long ? ' long' : ''}">${esc(e.summary)}</div>${long ? '<details class="more2" data-disclosure="summary" style="grid-column:2"><summary>Show the whole summary</summary></details>' : ''}` : '';
      return `<div class="entry" data-key="evidence-${esc(e.key)}"><div><span class="type${e.ok === false ? ' fail' : ''}">${esc(e.type)} ${e.type === 'note' ? '' : e.waived ? 'waived' : e.ok ? 'ok' : 'failed'}</span></div><div class="by"><span class="mono">${esc(e.agent)}</span> ${time(e.at, m.generated_at)}${ref ? `, ${ref}` : ''}${e.counts ? '' : e.type !== 'note' && e.why ? ` <span class="nocount">(does not count: ${esc(e.why)})</span>` : ''}</div>${sum}${receipts}</div>`;
    };
    secs.push(`<section class="sec"><h3>Evidence by commit</h3><div class="ledger">${s.ledger.map((g, i) => `<details data-disclosure="commit-${esc(g.key)}"${i === 0 ? ' open' : ''}><summary><span class="mono">${esc(g.sha === '-' ? 'no commit' : g.sha.slice(0, 7))}</span>${g.current ? '<span class="tag live">submitted head</span>' : '<span class="tag">older</span>'}<span class="faint">${g.entries.length} entr${g.entries.length === 1 ? 'y' : 'ies'}</span></summary>${g.entries.map(entry).join('')}</details>`).join('')}</div></section>`);
  }
  const thread = s.thread.length
    ? `<div class="thread">${s.thread.slice(-30).map((x) => `<div class="msg${x.owner ? ' owner' : ''}${x.fault ? ' fault' : ''}"><header><span class="mono">${esc(x.agent)}</span>${x.to ? `<span>to ${esc(x.to)}</span>` : ''}${time(x.at, m.generated_at)}</header><p>${esc(x.text)}</p></div>`).join('')}</div>${s.thread.length > 30 ? `<p class="cost">${s.thread.length - 30} earlier messages are in History.</p>` : ''}`
    : '<p class="empty">No messages on this task.</p>';
  const comment = opts.owner
    ? `<form data-api="/api/tasks/${esc(s.id)}/comments" data-done="Comment sent to the orchestrator"><label class="field">Comment to the orchestrator<textarea name="text" required></textarea></label><div class="acts"><button class="btn" type="submit">Send comment</button></div><output></output></form>`
    : cmd(command('task', 'note', s.id, 'your comment', '--agent', 'owner'));
  secs.push(`<section class="sec"><h3>Conversation</h3>${thread}${comment}</section>`);
  const sp = s.spend;
  if (sp.entries.length) {
    secs.push(`<section class="sec"><h3>Spend: ${esc(M.compact(sp.tokens))} tokens, ${esc(hours(sp.minutes))}</h3><div class="tbl-wrap" data-scroll="spend"><table class="tbl"><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Rung</th><th scope="col">Model</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Cached</th><th scope="col" class="num">Time</th></tr></thead><tbody>${sp.entries.slice().reverse().map((e) => `<tr><td>${time(e.at, m.generated_at)}</td><td class="mono">${esc(e.agent)}</td><td>${esc(e.rung || '-')}</td><td class="mono">${esc(e.model || (e.profile ? `profile ${e.profile}` : '-'))}</td><td class="num">${e.tokens == null ? '<span class="faint">not reported</span>' : esc(M.compact(e.tokens))}</td><td class="num">${e.cached == null ? '-' : esc(M.compact(e.cached))}</td><td class="num">${e.minutes ? `${esc(e.minutes)} min` : '-'}</td></tr>`).join('')}</tbody></table></div></section>`);
  }
  const link = (x) => `<li>${glyph(x.status)}<a href="#${esc(x.id)}"><span class="id">${esc(x.id)}</span> <span class="t">${esc(x.title)}</span></a></li>`;
  secs.push(`<section class="sec split2"><div><h3>Depends on</h3>${s.depends_on.length ? `<ul class="links">${s.depends_on.map(link).join('')}</ul>` : '<p class="empty">Nothing.</p>'}</div><div><h3>Unblocks</h3>${s.dependents.length ? `<ul class="links">${s.dependents.map(link).join('')}</ul>` : '<p class="empty">Nothing.</p>'}</div></section>`);
  if (opts.owner && s.stored !== 'cancelled') {
    const tier = `<form data-api="/api/tiers" data-kind="tier" data-task="${esc(s.id)}" data-base="${esc(s.tier)}" data-done="${esc(s.id)} tier saved"><label class="field">Tier, the rung that does this task<select name="tier">${L.TIERS.map((t) => `<option${t === s.tier ? ' selected' : ''}>${t}</option>`).join('')}</select></label><div class="acts"><button class="btn" type="submit">Save tier</button></div><output></output></form>`;
    const back = s.stored === 'submitted' || s.stored === 'accepted'
      ? `<form data-api="/api/tasks/${esc(s.id)}/rework" data-done="${esc(s.id)} sent back"><label class="field">Send back for rework: what to fix<textarea name="reason" required></textarea></label><div class="acts"><button class="btn danger" type="submit">Send back</button></div><output></output></form>` : '';
    secs.push(`<section class="sec"><h3>Change</h3><div class="box">${tier}${back}</div></section>`);
  }
  secs.push(`<section class="sec"><h3>At the terminal</h3>${cmd(command('task', 'show', s.id))}</section>`);
  return `<article id="${esc(s.id)}" class="sheet" aria-labelledby="h-${esc(s.id)}" data-key="sheet-${esc(s.id)}">
<a class="scrim" href="#" tabindex="-1" aria-hidden="true"></a>
<div class="panel" role="dialog" aria-labelledby="h-${esc(s.id)}">
<header class="shead"><div class="top">${glyph(s.status)}<span>${LABEL[s.status]}${s.reworks ? `, sent back ${s.reworks} time${s.reworks === 1 ? '' : 's'}` : ''}${s.unblocks ? `, unblocks ${s.unblocks}` : ''}</span><a class="close" href="#" data-close aria-label="Close ${esc(s.id)}">&#215;</a></div>
<h2 id="h-${esc(s.id)}" tabindex="-1"><span class="id">${esc(s.id)}</span>${esc(s.title)}</h2>
<p class="facts">${facts.join('')}</p></header>
<div class="sbody" data-scroll="body">${secs.join('\n')}</div>
</div>
</article>`;
}

// ---- document ----

// opts: { live, owner, token, version, base }
function page(m, opts = {}) {
  opts = { live: false, owner: false, base: '', ...opts };
  const n = m.attention.count;
  const boot = { live: opts.live, owner: opts.owner, version: opts.version || null, generated_at: m.generated_at, project: m.project.name, attention: n, icon: [favicon(false), favicon(true)], cli: CLI };
  return preserve(`<!doctype html>
<html lang="en" data-view="board">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${opts.live ? `<meta name="tower-crane-token" content="${esc(opts.token)}">\n` : ''}<title>${n ? `(${n}) ` : ''}${esc(m.project.name)}, ${PRODUCT}</title>
<link rel="icon" href="${favicon(n > 0)}">
<style>${CSS}</style>
</head>
<body class="fit">
<a class="skip" href="#main">Skip to the board</a>
${SYMBOLS}
${topBar(m, opts)}
<main id="main" tabindex="-1">
<div class="notice" role="status" data-notice></div>
${boardView(m, opts)}
${planView(m)}
${historyView(m)}
${spendView(m)}
</main>
<div data-region="sheets">${m.sheets.map((s) => sheet(s, m, opts)).join('\n')}</div>
<div class="toast" role="status" aria-live="polite" data-toast></div>
<script type="application/json" id="boot">${json(boot)}</script>
<script>${CLIENT}</script>
</body>
</html>
`);
}

module.exports = { page, topBar, PRODUCT, CLI, esc, glyph, SYMBOLS, MARK, favicon, LABEL, json };
