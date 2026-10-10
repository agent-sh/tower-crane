'use strict';

// The rooms behind the front one: Review, Plan, Spend and History.

const L = require('../ladder');
const M = require('./model');
const X = require('./parts');
const { evRow, roomHref } = require('./now');

const { esc, command, cmd, glyph, status, time, span, age, taskLink, rungText, bar, pct, hours, LABEL } = X;

// ---- review ----

function receipt(g, m) {
  const word = { pass: 'passed', fail: 'failed', missing: 'not yet run', waived: 'waived' }[g.state];
  const what = g.state === 'pass' ? g.proved : g.state === 'waived' ? `no software proof: ${g.waiver && g.waiver.reason ? g.waiver.reason : 'waived'}` : g.state === 'fail' ? g.reason : g.reason;
  const by = g.agent ? ` by ${esc(g.agent)}${g.at ? ` ${time(g.at, m.generated_at)}` : ''}` : '';
  return `<li class="receipt${g.state === 'waived' ? ' waived' : g.state === 'fail' ? ' fail' : ''}"><span class="pip ${g.state}">${esc(g.type)} ${word}</span><span class="what">${esc(what || '')}${g.sha ? ` at <span class="mono">${esc(g.sha.slice(0, 7))}</span>` : ''}${by}</span>${g.command ? `<span class="cmdline">${esc(g.command)}</span>` : ''}</li>`;
}

function reviewRow(r, m, opts) {
  const rev = r.review;
  const finding = rev
    ? `<div class="finding"><b>${rev.ok ? 'Reviewer passed it' : 'Reviewer sent findings'}:</b> ${esc(rev.summary)}<span class="by">${esc(rev.agent)} ${time(rev.at, m.generated_at)}${rev.ref && /^https:\/\//.test(rev.ref) ? `, <a href="${esc(rev.ref)}" rel="noreferrer noopener" target="_blank">the review</a>` : ''}</span></div>`
    : '<div class="finding">No review at this commit yet.</div>';
  const waive = r.missing.length ? cmd(command('accept', r.id, ...r.missing.flatMap((g) => ['--waive', g]), '--reason', 'why this gate does not apply', '--agent', 'owner')) : cmd(command('accept', r.id, '--agent', 'owner'));
  const back = opts.owner
    ? `<form data-api="/api/tasks/${esc(r.id)}/rework" data-done="${esc(r.id)} sent back"><label class="field">Send back: what to fix<textarea name="reason" required></textarea></label><div class="acts"><button class="btn danger" type="submit">Send back</button>${r.pr ? `<a class="btn quiet" href="${esc(prUrl(m, r.pr))}" rel="noreferrer noopener" target="_blank">Open PR #${esc(r.pr)}</a>` : ''}</div><output></output></form>`
    : cmd(command('rework', r.id, '--reason', 'what to fix', '--agent', 'owner'));
  return `<article class="rv${r.verdict.ok ? '' : ' no'}" data-key="review-${esc(r.id)}" aria-labelledby="rv-${esc(r.id)}">
<h3 id="rv-${esc(r.id)}">${status('submitted')}<a href="#${esc(r.id)}" data-identity="review-task-${esc(r.id)}"><span class="id">${esc(r.id)}</span> ${esc(r.title)}</a></h3>
<p class="sub"><span class="verdict ${r.verdict.ok ? 'ok' : 'no'}">${glyph(r.verdict.ok ? 'accepted' : 'now', r.verdict.ok ? 'ready' : 'not ready')}${esc(r.verdict.text)}</span></p><p class="sub">Submitted by ${esc(r.submitted_by || '-')} at <span class="mono">${esc(String(r.sha || '').slice(0, 7))}</span>${r.at ? ` ${time(r.at, m.generated_at)}` : ''}${r.pr ? `, PR #${esc(r.pr)}` : ''}${r.reworks ? ` · sent back ${r.reworks} time${r.reworks === 1 ? '' : 's'} before` : ''}</p>
<div class="rv-grid"><div>${finding}
<h4 class="sec-h">Acceptance</h4><ul class="accept">${r.acceptance.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
${r.summary ? `<h4 class="sec-h">The worker's summary</h4><p class="t2" style="font-size:var(--t-dense);max-width:72ch">${esc(r.summary)}</p>` : ''}</div>
<div><h4 class="sec-h" style="margin-top:0">Gate receipts</h4><ul class="receipts">${r.gates.map((g) => receipt(g, m)).join('')}</ul>
${back}
<details class="more"><summary>Accept with waivers at the terminal</summary><p class="why">A waiver satisfies a gate without software proof and stays in the record. Waiving review is operational; every other waiver is yours.</p>${waive}</details></div></div>
</article>`;
}

function prUrl(m, pr) {
  return m.project.repo ? `https://github.com/${m.project.repo}/pull/${pr}` : `#`;
}

function reviewRoom(m, opts) {
  const rows = m.review.length ? `<div class="review-list" data-region="review">${m.review.map((r) => reviewRow(r, m, opts)).join('\n')}</div>` : '<div data-region="review"><p class="calmline">Nothing is waiting for review.</p></div>';
  const waivers = m.waivers.length
    ? `<h3 class="grouph" style="margin-top:var(--s5)">Accepted with waivers <span class="t3">${m.waivers.length}</span></h3><div class="waivers" data-region="waivers">${m.waivers.map((w) => `<div class="waiver" data-key="waiver-${esc(w.id)}-${esc(w.at)}">${glyph('turn', 'waiver')} ${taskLink(w.id)} ${esc(w.title)}: <b>${esc(w.gates.join(', '))} waived</b> by ${esc(w.agent)} ${time(w.at, m.generated_at)}${w.reason ? `. ${esc(w.reason)}` : ''}</div>`).join('')}</div>`
    : '';
  return `<section id="review" class="room" aria-labelledby="h-review">
<div class="roomh"><h2 id="h-review">Review</h2><p>Submitted work with its reviewer verdict and gate receipts at the submitted commit. A pass says what it proved; a waiver stays louder than a pass.</p></div>
${rows}${waivers}
</section>`;
}

// ---- plan ----

const NODE_W = 236;
const NODE_H = 56;
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

function planRoom(m) {
  if (!m.total) return '<section id="plan" class="room" aria-labelledby="h-plan"><div class="roomh"><h2 id="h-plan">Plan</h2></div><p class="empty">No tasks yet.</p></section>';
  const { pos, cols, width, height } = layout(m.tasks);
  const needs = new Set(m.queue.flatMap((q) => (q.kind === 'decision' ? q.blocks.map((b) => b.id) : q.kind === 'owner' ? [q.id] : [])));
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
    return `<a href="#${esc(t.id)}" class="node s-${s}" data-id="${esc(t.id)}" transform="translate(${p.x} ${p.y})" aria-label="${esc(`${t.id} ${t.title}, ${LABEL[s]}, tier ${t.tier}${needs.has(t.id) ? ', waits on you' : ''}`)}">
<rect class="box" width="${NODE_W}" height="${NODE_H}" rx="6"/>${needs.has(t.id) ? `<rect class="flag" x="${NODE_W - 14}" y="0" width="14" height="14" rx="3"/>` : ''}
<use href="#g-${s}" x="10" y="10" width="14" height="14" class="g-${s}"/>
<text class="nid" x="30" y="22">${esc(t.id)}</text><text class="nmeta" x="${NODE_W - (needs.has(t.id) ? 20 : 10)}" y="22" text-anchor="end">${esc(LABEL[s])}, ${esc(t.tier)}</text>
<text class="ntitle" x="10" y="44">${esc(trunc(t.title, 32))}</text></a>`;
  });
  const legend = ['ready', 'blocked', 'in_progress', 'submitted', 'rework', 'accepted', 'cancelled'].map((s) => `<li>${glyph(s)}${LABEL[s]}</li>`).join('');
  const layers = cols.map((col, i) => `<div class="layer"><h3 class="grouph">${i === 0 ? 'No dependencies' : `Layer ${i + 1}, after layer ${i}`}</h3><ul class="rows">${[...col].sort((a, b) => (a.id < b.id ? -1 : 1)).map((t) => `<li class="row">${glyph(m.display.get(t.id))}<a href="#${esc(t.id)}"><span class="t"><span class="id">${esc(t.id)}</span>${esc(t.title)}</span></a><span class="meta">${LABEL[m.display.get(t.id)]}, ${esc(t.tier)}${t.depends_on.length ? `, after ${t.depends_on.map(esc).join(', ')}` : ''}${needs.has(t.id) ? ', <span class="owner">waits on you</span>' : ''}</span></li>`).join('')}</ul></div>`).join('');
  return `<section id="plan" class="room" aria-labelledby="h-plan" data-region="plan">
<div class="roomh"><h2 id="h-plan">Plan</h2><p>${m.total} tasks in ${cols.length} layer${cols.length === 1 ? '' : 's'}. A task starts once everything it depends on is accepted. An amber corner marks a task that waits on you.</p></div>
<div class="plan-tools"><ul class="legend">${legend}</ul><label><input type="checkbox" data-hide-done> Dim accepted and cancelled</label></div>
<div class="plan-wrap" data-scroll="graph"><svg class="graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Task dependency graph">
<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="arrow" d="M0 0L8 4L0 8z"/></marker></defs>
${edges.join('\n')}
${nodes.join('\n')}
</svg></div>
<div class="layers">${layers}</div>
</section>`;
}

// ---- spend ----

function liveStates(sp) {
  return [...new Set(sp.live.map((l) => l.state))].join(', ');
}

function spendRoom(m, opts) {
  const sp = m.spend;
  const maxRung = Math.max(1, ...sp.by_rung.map((r) => r.tokens));
  const maxTask = Math.max(1, ...sp.by_task.map((r) => r.tokens));
  const maxModel = Math.max(1, ...sp.by_model.map((r) => r.tokens));
  const cachedShare = sp.input ? `${pct(sp.cached, sp.input)}% of input from cache` : 'no input breakdown reported';
  const fresh = sp.fresh_s != null ? `live, ${age(sp.fresh_s)} old` : sp.live.length ? `${liveStates(sp)}` : 'no agent is running';
  const strip = `<div class="strip">
<div class="stat"><p class="label">Tokens</p><p class="big">${esc(M.compact(sp.tokens))}${sp.budget_tokens ? ` <span class="t3" style="font-size:var(--t-body);font-weight:var(--w-body)">of ${esc(M.compact(sp.budget_tokens))}</span>` : ''}</p>${sp.budget_tokens ? bar(sp.tokens, sp.budget_tokens, 'tokens against budget', sp.live.length ? 'live' : '') : ''}<p class="sub">${sp.budget_tokens ? `${pct(sp.tokens, sp.budget_tokens)}% of the budget, running agents included` : 'no token budget set'}; ${esc(sp.input || sp.output ? `${M.compact(sp.input)} in, ${M.compact(sp.output)} out, ${cachedShare}` : 'no breakdown reported')}</p></div>
<div class="stat"><p class="label">Burn rate</p><p class="big">${sp.rate_per_hour != null ? `${esc(M.compact(sp.rate_per_hour))}<span class="t3" style="font-size:var(--t-body);font-weight:var(--w-body)"> tokens/h</span>` : 'none'}</p><p class="sub">${sp.rate_from === 'live' ? `from running agents' own readings, ${esc(fresh)}` : sp.rate_from === 'recorded' ? 'recorded in the last hour; no agent reports live' : 'no spend in the last hour'}${sp.not_counted ? `; ${sp.not_counted} running agent${sp.not_counted === 1 ? '' : 's'} not counted` : ''}</p></div>
<div class="stat"><p class="label">Projection</p><p class="big">${sp.projection_ms != null ? esc(span(sp.projection_ms)) : '-'}</p><p class="sub">${sp.projection_ms != null ? 'until the token budget runs out at this rate' : sp.budget_tokens ? 'no rate to project from' : 'no token budget to project'}</p></div>
<div class="stat"><p class="label">Agent time</p><p class="big">${esc(hours(sp.minutes))}</p>${sp.budget_hours ? bar(sp.minutes / 60, sp.budget_hours, 'hours against budget') : ''}<p class="sub">${sp.budget_hours ? `${pct(sp.minutes / 60, sp.budget_hours)}% of ${esc(sp.budget_hours)} h` : 'no time budget set'}</p></div>
${sp.spawns_without_usage ? `<div class="stat"><p class="label">Spawns without usage</p><p class="big">${sp.spawns_without_usage}</p><p class="sub">their tokens are not in these totals</p></div>` : ''}
</div>`;
  const tops = sp.top.length ? `<h3 class="grouph">Top spenders</h3><div class="tops">${sp.top.map((t) => {
    const move = t.cheaper && opts.owner
      ? `<form data-api="/api/tiers" data-kind="tier" data-task="${esc(t.id)}" data-base="${esc(t.tier)}" data-done="${esc(t.id)} moved to ${esc(t.cheaper)}"><input type="hidden" name="tier" value="${esc(t.cheaper)}"><button class="btn" type="submit">Move to ${esc(t.cheaper)}</button><output></output></form>`
      : t.cheaper ? cmd(command('task', 'update', t.id, '--tier', t.cheaper)) : '';
    return `<div class="top" data-key="top-${esc(t.id)}">${status(t.status)}<a href="#${esc(t.id)}" data-identity="spend-top-${esc(t.id)}">${esc(t.id)}</a><span>${esc(t.title)}</span><b>${esc(M.compact(t.tokens))}</b>${t.median ? `${t.cheaper ? bar(t.tokens, t.median * sp.norms.multiple, `against ${sp.norms.multiple} times the ${t.tier} median`) : ''}<span class="t3">${Math.round((t.tokens / t.median) * 10) / 10} times the ${esc(t.tier)} median of ${esc(M.compact(t.median))}</span>` : ''}${move}</div>`;
  }).join('')}</div>` : '';
  const rungRows = sp.by_rung.map((r) => `<tr><th scope="row">${esc(r.key === 'unrecorded' ? 'not recorded' : r.key)}</th><td class="t2">${esc(rungText(r.rung) || '-')}</td><td class="num">${r.entries}</td><td class="num">${esc(M.compact(r.tokens))}</td><td class="barcell"><div class="share"><span style="width:${pct(r.tokens, maxRung)}%"></span></div></td><td class="num">${r.input ? `${pct(r.cached, r.input)}%` : '-'}</td><td class="num">${esc(hours(r.minutes))}</td></tr>`).join('');
  const modelRows = sp.by_model.map((r) => `<tr><th scope="row" class="mono">${esc(r.key === 'unrecorded' ? 'not recorded' : r.key)}</th><td class="num">${r.entries}</td><td class="num">${esc(M.compact(r.tokens))}</td><td class="barcell"><div class="share"><span style="width:${pct(r.tokens, maxModel)}%"></span></div></td><td class="num">${esc(hours(r.minutes))}</td></tr>`).join('');
  const trunc64 = (s) => trunc(s, 64);
  const taskRow = (r) => `<tr><th scope="row"><a href="#${esc(r.id)}" class="id" data-identity="spend-task-${esc(r.id)}">${esc(r.id)}</a> <span style="font-weight:var(--w-body)">${esc(trunc64(r.title))}</span></th><td>${glyph(r.status)} ${LABEL[r.status]}</td><td class="t2">${esc(r.tier)}</td><td class="num">${esc(M.compact(r.tokens))}</td><td class="barcell"><div class="share"><span style="width:${pct(r.tokens, maxTask)}%"></span></div></td><td class="num">${esc(hours(r.minutes))}</td><td class="num">${r.reworks || ''}</td></tr>`;
  const head = '<thead><tr><th scope="col">Task</th><th scope="col">Status</th><th scope="col">Tier</th><th scope="col" class="num">Tokens</th><th scope="col"><span class="vh">Share</span></th><th scope="col" class="num">Time</th><th scope="col" class="num">Sent back</th></tr></thead>';
  const ladder = m.ladder.error
    ? `<tr><td colspan="5" class="t2">${esc(m.ladder.error)}</td></tr>`
    : L.RUNGS.map((n) => {
      const r = L.rungOf(m.ladder, n);
      const what = r.harness === 'command' ? JSON.stringify(r.command) : [r.model, r.profile && `profile ${r.profile}`, r.provider && `provider ${r.provider}`].filter(Boolean).join(', ');
      return `<tr data-rung="${n}"><th scope="row">${n}</th><td>${esc(m.ladder.ladder[n].harness_from === 'default' ? `${r.harness} (default)` : r.harness)}</td><td>${esc(what || '-')}</td><td>${esc(r.effort || '-')}</td><td class="t2">${esc(L.USES[n])}</td></tr>`;
    }).join('');
  const liveRows = sp.live.map((l) => `<tr data-live-state="${esc(l.state)}" data-live-at="${esc(l.at)}" data-live-stale-at="${esc(l.stale_at)}"><th scope="row"><a href="#${esc(l.task)}" class="id">${esc(l.task)}</a> ${esc(l.agent)}</th><td>${esc(l.harness || '-')}</td><td class="num">${l.tokens == null ? 'unknown until exit' : esc(M.compact(l.tokens))}</td><td class="live-state">${esc(l.state)}</td><td class="num live-age">${esc(age(l.age_s))} ago</td></tr>`).join('');
  const top = sp.by_task.slice(0, 20);
  const rest = sp.by_task.slice(20);
  return `<section id="spend" class="room" aria-labelledby="h-spend" data-region="spend">
<div class="roomh"><h2 id="h-spend">Spend</h2><p>Tokens and agent time as agents and spawns reported them, running agents included, and the ladder that decides what each rung runs. Tower Crane records usage, not prices.</p></div>
${strip}${tops}
<div class="tables">
${liveRows ? `<div class="tbl-wrap wide" data-scroll="live"><table class="tbl"><caption>Running now: usage read while agents run, and how old each reading is</caption><thead><tr><th scope="col">Agent</th><th scope="col">Harness</th><th scope="col" class="num">Tokens</th><th scope="col">Freshness</th><th scope="col" class="num">Read</th></tr></thead><tbody>${liveRows}</tbody></table></div>` : ''}
<div class="tbl-wrap" data-scroll="rung"><table class="tbl"><caption>By rung</caption><thead><tr><th scope="col">Rung</th><th scope="col">Runs on now</th><th scope="col" class="num">Reports</th><th scope="col" class="num">Tokens</th><th scope="col"><span class="vh">Share</span></th><th scope="col" class="num">Cached</th><th scope="col" class="num">Time</th></tr></thead><tbody>${rungRows || '<tr><td colspan="7" class="t2">No usage reported yet.</td></tr>'}</tbody></table></div>
<div class="tbl-wrap" data-scroll="model"><table class="tbl"><caption>By model</caption><thead><tr><th scope="col">Model</th><th scope="col" class="num">Reports</th><th scope="col" class="num">Tokens</th><th scope="col"><span class="vh">Share</span></th><th scope="col" class="num">Time</th></tr></thead><tbody>${modelRows || '<tr><td colspan="5" class="t2">No usage reported yet.</td></tr>'}</tbody></table></div>
<div class="tbl-wrap wide" data-scroll="ladder"><table class="tbl"><caption>Ladder: what each rung runs</caption><thead><tr><th scope="col">Rung</th><th scope="col">Harness</th><th scope="col">Model or profile</th><th scope="col">Effort</th><th scope="col">Used for</th></tr></thead><tbody>${ladder}</tbody></table></div>
<div class="tbl-wrap wide" data-scroll="task"><table class="tbl"><caption>By task, most tokens first</caption>${head}<tbody>${top.map(taskRow).join('') || '<tr><td colspan="7" class="t2">No usage reported yet.</td></tr>'}</tbody></table>
${rest.length ? `<details class="more" data-disclosure="more-tasks"><summary>${rest.length} more tasks</summary><table class="tbl">${head}<tbody>${rest.map(taskRow).join('')}</tbody></table></details>` : ''}</div>
</div>
</section>`;
}

// ---- history ----

const DAY = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

function historyRoom(m) {
  const kinds = [['main', 'Without bookkeeping'], ['all', 'All'], ['flow', 'Claims and handoffs'], ['gates', 'Gates'], ['decisions', 'Decisions'], ['messages', 'Messages'], ['owner', 'Owner'], ['settings', 'Settings'], ['trouble', 'Trouble'], ['plan', 'Plan and bookkeeping']];
  const filters = `<fieldset class="filters"><legend class="vh">Show</legend>${kinds.map(([k, label], i) => `<input type="radio" name="hf" id="hf-${k}" value="${k}"${i === 0 ? ' checked' : ''}><label for="hf-${k}">${label}</label>`).join('')}<label class="field" for="hf-task">Task<input id="hf-task" class="input" placeholder="T7" autocomplete="off" spellcheck="false"></label></fieldset>`;
  const days = [];
  for (const x of m.history) {
    const day = String(x.at).slice(0, 10);
    if (!days.length || days[days.length - 1].day !== day) days.push({ day, items: [] });
    days[days.length - 1].items.push(x);
  }
  const body = days.length ? days.map((d) => `<section class="day" data-key="day-${esc(d.day)}"><h3>${esc(Number.isNaN(Date.parse(d.day)) ? d.day : DAY.format(new Date(d.day)))}</h3><ol class="feed">${d.items.map((x) => evRow(x, m)).join('')}</ol></section>`).join('') : '<p class="empty">No events yet.</p>';
  const capped = m.events_total > m.history.length ? `<p class="history-note">Showing the newest ${m.history.length} of ${m.events_total} events. The full log is events.jsonl in the state directory.</p>` : '';
  // The filters sit outside the live region, so an update keeps the choice.
  return `<section id="history" class="room" aria-labelledby="h-history">
<div class="roomh"><h2 id="h-history">History</h2><p>Every change, newest first, in UTC days. Times are UTC in a snapshot opened without scripts.</p></div>
${filters}<div data-region="history">${body}${capped}</div>
</section>`;
}

module.exports = { reviewRoom, planRoom, spendRoom, historyRoom, roomHref };
