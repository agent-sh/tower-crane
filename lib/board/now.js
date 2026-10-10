'use strict';

// The shell every page shares (the bar, the status sentence, the spend line)
// and the front room: the queue, the floor, and what is next and recent.

const M = require('./model');
const X = require('./parts');

const { esc, command, cmd, glyph, status, time, span, age, leaseText, taskLink, rungText, bar } = X;

const ROOMS = [['now', 'Now'], ['review', 'Review'], ['plan', 'Plan'], ['spend', 'Spend'], ['history', 'History']];

// Where a room lives: a path in serve, a fragment in the snapshot.
const roomHref = (room, opts) => (opts.live ? (room === 'now' ? '/' : `/${room}`) : `#${room}`);

function sentenceText(m) {
  const s = m.sentence;
  // Running agents whose usage is unknown are counted out loud, never as zero.
  const nc = s.not_counted ? `, ${s.not_counted} not counted` : '';
  const parts = [s.need ? `${s.need} need${s.need === 1 ? 's' : ''} you` : 'Nothing needs you', `${s.working} working${s.budget == null ? nc : ''}`];
  if (s.budget != null) parts.push(`${s.budget}% budget${nc}`);
  return parts.join(' · ');
}

function title(m) {
  return `${sentenceText(m)} · ${m.project.name}, ${X.PRODUCT}`;
}

function bar0(m, opts) {
  const s = m.sentence;
  const nav = ROOMS.map(([id, label]) => {
    const n = id === 'now' ? s.need : id === 'review' ? s.review : 0;
    const cls = id === 'now' ? (s.now ? ' alarm' : ' attn') : '';
    const count = n ? `<span class="count${cls}" aria-label="${n} ${id === 'now' ? 'need you' : 'to review'}">${n}</span>` : '';
    return `<a href="${roomHref(id, opts)}" data-room="${id}"${opts.room === id ? ' aria-current="page"' : ''}>${label}${count}</a>`;
  }).join('') + (opts.live ? `<a href="/settings" data-room="settings"${opts.room === 'settings' ? ' aria-current="page"' : ''}>Settings</a>` : '');
  const conn = opts.live
    ? `<span class="conn" data-conn="connecting" role="status">Connecting</span>`
    : `<span class="conn" data-conn="snapshot">Snapshot from ${time(m.generated_at, m.generated_at)} UTC</span>`;
  return `<header class="bar" data-region="bar">
<div class="brand">${X.MARK(s.need > 0)}<span class="product">${X.PRODUCT}</span><span class="project" title="${esc(m.project.goal)}">${esc(m.project.name)}</span></div>
<nav class="rooms" aria-label="Rooms">${nav}</nav>
<div class="state">${conn}<button type="button" class="theme" data-theme-toggle aria-label="Theme: follows the system; switch">Auto</button></div>
</header>`;
}

function spendLine(m) {
  const sp = m.spend;
  const fresh = sp.fresh_s != null ? `live, ${age(sp.fresh_s)} old` : sp.rate_from === 'recorded' ? 'recorded in the last hour' : '';
  const nc = sp.not_counted ? `, ${sp.not_counted} running agent${sp.not_counted === 1 ? '' : 's'} not counted` : '';
  const used = sp.budget_tokens
    ? `${bar(sp.tokens, sp.budget_tokens, 'tokens against budget', sp.live.length ? 'live' : '')}<b>${X.pct(sp.tokens, sp.budget_tokens)}%</b> of ${esc(M.compact(sp.budget_tokens))} tokens`
    : `<b>${esc(M.compact(sp.tokens))}</b> tokens, no budget`;
  const hrs = sp.budget_hours ? ` ${bar(sp.minutes / 60, sp.budget_hours, 'hours against budget')}<b>${X.pct(sp.minutes / 60, sp.budget_hours)}%</b> of ${esc(sp.budget_hours)} h` : '';
  const rate = sp.rate_per_hour != null ? `<b>${esc(M.compact(sp.rate_per_hour))}</b> tokens/h${fresh ? ` <span class="t3">${esc(fresh)}</span>` : ''}` : `no spend in the last hour`;
  const proj = sp.projection_ms != null ? `budget lasts <b>${esc(span(sp.projection_ms))}</b> at this rate` : sp.budget_tokens ? 'no rate to project from' : 'no token budget to project';
  const t = sp.top[0];
  const top = t ? `top ${taskLink(t.id)} <b>${esc(M.compact(t.tokens))}</b>${t.median ? ` <span class="t3">(${esc(t.tier)} median ${esc(M.compact(t.median))})</span>` : ''}` : 'nothing spent yet';
  return `<section class="spendline" aria-label="Spend"><span data-spend="used">${used}${hrs}</span><span data-spend="rate">${rate}${esc(nc)}</span><span data-spend="projection">${proj}</span><span data-spend="top">${top}</span></section>`;
}

function lead(m, opts) {
  const s = m.sentence;
  const link = (href, text, cls = '') => `<a href="${href}"${cls ? ` class="${cls}"` : ''}>${text}</a>`;
  const parts = [];
  if (s.need) parts.push(`${link('#queue', `${s.need} need${s.need === 1 ? 's' : ''} you`)}${s.now ? ` <span class="now">(${s.now} now)</span>` : ''}`);
  else parts.push('<span class="calm">Nothing needs you</span>');
  const nc = s.not_counted ? `, ${s.not_counted} not counted` : '';
  parts.push(link('#floor', `${s.working} working${s.budget == null ? nc : ''}`));
  if (s.budget != null) parts.push(link(roomHref('spend', opts), `${s.budget}% budget${nc}`));
  return `<div class="lead" data-region="lead"><h1 class="sentence" data-status><span class="vh">${esc(m.project.name)}: </span>${parts.join('<span class="sep" aria-hidden="true"> · </span><span class="vh">, </span>')}</h1>${spendLine(m)}</div>`;
}

// ---- queue items ----

const TIER = { now: ['now', 'Now'], turn: ['turn', 'Your turn'] };

function head(q, kind, extra, m) {
  const [g, word] = TIER[q.tier];
  return `<div class="qhead"><span class="tier">${glyph(g)}${word}</span><span class="kind">${kind}</span>${extra || ''}${q.at ? `<span>${time(q.at, m.generated_at)}</span>` : ''}</div>`;
}

function consequence(blocks) {
  if (!blocks.length) return 'No task waits on it.';
  return blocks.map((b) => (b.now
    ? `Answering lets <b>${taskLink(b.id)} ${esc(b.title)}</b> start: everything else it needs is done.`
    : `${taskLink(b.id)} ${esc(b.title)} waits on it, and also on ${b.waits.map((w) => taskLink(w)).join(', ')}.`)).join(' ');
}

function noteField(label) {
  return `<input class="input inline-field" name="note" autocomplete="off" aria-label="${esc(label)}" placeholder="${esc(label)}">`;
}

function decisionItem(q, m, opts) {
  let act;
  if (opts.owner) {
    const buttons = q.options.length
      ? q.options.map((o) => `<button class="btn${o === q.recommendation ? ' primary' : ''}" type="submit" name="choice" value="${esc(o)}">${esc(o)}${o === q.recommendation ? '<span class="rec"> recommended</span>' : ''}</button>`).join('')
      : `<input class="input inline-field" name="choice" required autocomplete="off" aria-label="Answer" placeholder="Answer"><button class="btn primary" type="submit">Answer</button>`;
    act = `<div class="acts"><form data-api="/api/decisions/${esc(q.id)}/answer" data-done="Answered ${esc(q.id)}" data-next class="acts" style="margin:0;flex:1 1 auto">${q.options.length ? noteField('Context for the answer (optional)') : ''}${buttons}<output></output></form>
<details class="more"><summary>Comment</summary><form data-api="/api/decisions/${esc(q.id)}/comments" data-done="Comment sent"><label class="field">Comment without answering<textarea name="text" required></textarea></label><div class="acts"><button class="btn" type="submit">Send comment</button></div><output></output></form></details></div>`;
  } else {
    act = (q.options.length ? q.options : [q.recommendation || 'ANSWER']).map((o) => cmd(command('answer', q.id, '--choice', o, '--agent', 'owner'))).join('');
  }
  const notes = q.notes.length ? `<p class="why">${q.notes.length} comment${q.notes.length === 1 ? '' : 's'}; latest from ${esc(q.notes.at(-1).agent)}: ${esc(q.notes.at(-1).text)}</p>` : '';
  return `<li class="qi" data-tier="${q.tier}" data-kind="decision" data-key="${esc(q.id)}" aria-labelledby="q-${esc(q.id)}">
${head(q, `Decision ${esc(q.id)}`, `<span>asked by ${esc(q.asked_by)}</span>`, m)}
<h3 class="q" id="q-${esc(q.id)}">${esc(q.question)}</h3>
<p class="conseq">${consequence(q.blocks)}</p>
${q.recommendation ? `<p class="why">Recommended: <b>${esc(q.recommendation)}</b>${q.why ? `, because ${esc(q.why)}` : ''}</p>` : q.why ? `<p class="why">${esc(q.why)}</p>` : ''}${notes}
${act}
</li>`;
}

// The command that makes an escalated change, where the request names one.
function changeCommand(q) {
  const c = q.escalation.change || {};
  if (q.escalation.settings.includes('budget.raise') && c.scope) {
    const flag = c.what === 'hours' ? '--budget-hours' : '--budget-tokens';
    const to = String(Math.ceil(Number(c.limit) * 1.5));
    return c.scope === 'project' ? command('project', 'set', flag, to, '--agent', 'owner') : command('task', 'update', c.scope, flag, to, '--agent', 'owner');
  }
  const flags = Object.entries(c);
  if (!flags.length || !flags.every(([k]) => /^[a-z][a-z-]+$/.test(k))) return null;
  return command('project', 'set', ...flags.flatMap(([k, v]) => [`--${k}`, typeof v === 'string' ? v : JSON.stringify(v)]), '--agent', 'owner');
}

const raw = (q, rows) => `<details class="more"><summary>Recorded request</summary><p class="why">${rows}.</p><div class="cmd"><code>${esc(JSON.stringify(q.escalation))}</code></div></details>`;

function approvalItem(q, m, opts) {
  const change = changeCommand(q);
  const rows = q.settings.map((s) => `<b>${esc(s.key)}</b> is ${s.class === 'owner-required' ? '<span class="class-word">yours</span>' : '<span class="class-word">orchestrator may change</span>'}${s.use ? `: ${esc(s.use)}` : ''}`).join('; ');
  const act = opts.owner
    ? `<div class="acts">${change ? cmd(change) : ''}<form data-api="/api/decisions/${esc(q.id)}/answer" data-done="Answered ${esc(q.id)}" data-next class="acts" style="margin:0;flex:1 1 auto"><button class="btn primary" type="submit" name="choice" value="approved">I made the change</button><button class="btn" type="submit" name="choice" value="declined">Decline</button><output></output></form>${raw(q, rows)}</div>`
    : `${change ? cmd(change) : ''}${cmd(command('answer', q.id, '--choice', 'approved', '--agent', 'owner'))}`;
  return `<li class="qi" data-tier="${q.tier}" data-kind="approval" data-key="${esc(q.id)}" aria-labelledby="q-${esc(q.id)}">
${head(q, `Approval ${esc(q.id)}`, `<span>asked by ${esc(q.asked_by)}</span>`, m)}
<h3 class="q sentence-q" id="q-${esc(q.id)}">${esc(q.sentence)}</h3>
<p class="conseq">Only you can make it: run the change, then record your answer.</p>
${act}${opts.owner ? '' : raw(q, rows)}
</li>`;
}

function ownerItem(q, m, opts) {
  const act = opts.owner
    ? `<form data-api="/api/tasks/${esc(q.id)}/owner-done" data-done="${esc(q.id)} marked done" data-next><div class="acts">${noteField('What was done (optional)')}<button class="btn primary" type="submit">Mark done</button><a class="btn quiet" href="#${esc(q.id)}">Open ${esc(q.id)}</a></div><output></output></form>`
    : cmd(command('owner-done', q.id, '--agent', 'owner'));
  return `<li class="qi" data-tier="${q.tier}" data-kind="owner" data-key="owner-${esc(q.id)}" aria-labelledby="q-owner-${esc(q.id)}">
${head(q, `Owner task on ${taskLink(q.id)}`, '', m)}
<h3 class="q" id="q-owner-${esc(q.id)}">${esc(q.needs)}</h3>
<p class="conseq">${q.now ? `Marking it done lets <b>${esc(q.id)} ${esc(q.title)}</b> start${q.unblocks ? `, which unblocks ${q.unblocks} more` : ''}.` : `${esc(q.id)} ${esc(q.title)} also waits on its dependencies.`}</p>
${act}
</li>`;
}

function messageItem(q, m, opts) {
  const act = opts.owner && q.reply
    ? `<form data-api="/api/tasks/${esc(q.task)}/message" data-done="Reply sent to ${esc(q.agent)}" data-next><div class="acts"><input class="input inline-field" name="text" required autocomplete="off" aria-label="Reply to ${esc(q.agent)}" placeholder="Reply to ${esc(q.agent)}"><button class="btn primary" type="submit">Reply</button>${q.task ? `<a class="btn quiet" href="#${esc(q.task)}">Open ${esc(q.task)}</a>` : ''}</div><output></output></form>`
    : cmd(command('msg', '--to', q.agent, ...(q.task ? ['--task', q.task] : []), 'your reply', '--agent', 'owner'));
  return `<li class="qi" data-tier="${q.tier}" data-kind="message" data-key="${esc(q.key)}">
${head(q, `Message from ${esc(q.agent)}${q.task ? ` on ${taskLink(q.task)}` : ''}`, '', m)}
<p class="q quote">${esc(q.text)}</p>
${act}
</li>`;
}

const RULE = { spend: 'Spend', rate: 'Burn rate', stale: 'Usage not reported', lease: 'Lease ran out', progress: 'No progress', reworks: 'Rework loop' };

function stopControl(r, opts, where) {
  if (!opts.owner || !r || !r.stoppable) return '';
  const cap = Math.max(0, (r.spend.tokens || 0) - 1);
  return `<details class="act-stop" data-disclosure="stop-${where}-${esc(r.id)}"><summary class="btn danger">Stop</summary>
<div class="confirm" role="group" aria-labelledby="stop-${where}-${esc(r.id)}"><h4 id="stop-${where}-${esc(r.id)}">Stop ${esc(r.id)} at what it has spent?</h4>
<dl><dt>What stops</dt><dd>${esc(r.agent)} and its process group, at the supervisor's next usage reading. It is not retried.</dd>
<dt>How</dt><dd>${esc(r.id)}'s token budget is set to ${esc(M.compact(r.spend.tokens))}, the same as ${esc(command('task', 'update', r.id, '--budget-tokens', String(cap)))}.</dd>
<dt>What is kept</dt><dd>The claim until the process exits, the worktree, its commits and the spend record.</dd>
<dt>Then</dt><dd>${esc(r.id)} waits on you: raising its budget lets it run again.</dd></dl>
<form data-api="/api/tasks/${esc(r.id)}/budget" data-done="${esc(r.id)} stops at its next reading"><input type="hidden" name="tokens" value="${cap}"><div class="acts"><button class="btn danger" type="submit">Stop ${esc(r.id)}</button><button class="btn" type="button" data-close-details>Keep running</button></div><output></output></form></div></details>`;
}

function runawayItem(q, m, opts) {
  const row = m.floor.find((r) => r.id === q.id);
  return `<li class="qi" data-tier="now" data-kind="runaway" data-key="${esc(q.key)}">
${head(q, `${glyph('runaway')}${RULE[q.rule] || 'Runaway'} on ${taskLink(q.id)}`, `<span>${esc(q.agent)}</span>`, m)}
<h3 class="q">${esc(q.id)} ${esc(q.title)}</h3>
<p class="conseq">${esc(q.agent)} ${esc(q.text)}.</p>
<div class="acts"><a class="btn quiet" href="#${esc(q.id)}">Open ${esc(q.id)}</a></div>
${q.stop ? stopControl(row, opts, 'queue') || (opts.owner ? '' : cmd(command('task', 'update', q.id, '--budget-tokens', String(Math.max(0, ((row && row.spend.tokens) || 0) - 1)), '--agent', 'owner'))) : ''}
</li>`;
}

function stuckItem(q, m) {
  return `<li class="qi" data-tier="now" data-kind="stuck" data-key="${esc(q.key)}">
${head(q, `Stuck: ${taskLink(q.id)}`, '', m)}
<h3 class="q">${esc(q.id)} ${esc(q.title)}</h3>
<p class="conseq">${esc(q.rule === 'lease' ? `${q.text.replace(/^lease/, 'Lease')}; ${q.id} cannot be claimed until it is released.` : `${q.text}; the claim is held until it is released.`)}</p>
${q.fix ? cmd(command(...q.fix)) : ''}
</li>`;
}

function budgetItem(q) {
  const fmt = q.unit === 'tokens' ? M.compact : (h) => span(h * 3600000);
  return `<li class="qi" data-tier="now" data-kind="budget" data-key="${esc(q.key)}">
<div class="qhead"><span class="tier">${glyph('now')}Now</span><span class="kind">Budget</span></div>
<h3 class="q">${esc(q.what)} at ${q.percent}%</h3>
<p class="conseq">${esc(fmt(q.used))} used of ${esc(fmt(q.limit))}${q.projection_ms != null ? `; at this rate it runs out in ${esc(span(q.projection_ms))}` : ''}${q.not_counted ? `; ${q.not_counted} running agent${q.not_counted === 1 ? ' is' : 's are'} not counted` : ''}. Raise the budget, or move expensive tasks down a rung in Spend.</p>
${cmd(command('project', 'set', q.flag, String(Math.ceil(q.limit * 1.5)), '--agent', 'owner'))}
</li>`;
}

function queueBand(m, opts) {
  const q = m.queue;
  const draw = { decision: decisionItem, approval: approvalItem, owner: ownerItem, message: messageItem, runaway: runawayItem, stuck: stuckItem, budget: budgetItem };
  const body = q.length
    ? `<ol class="queue-list">${q.map((x) => draw[x.kind](x, m, opts)).join('\n')}</ol>`
    : '<p class="calmline">Nothing needs you. Decisions, approvals, owner tasks and runaways appear here.</p>';
  return `<section class="band queue" id="queue" aria-labelledby="h-queue" data-region="queue">
<h2 class="bandh" id="h-queue">Needs you${q.length ? ` <span class="count${m.sentence.now ? ' alarm' : ' attn'}">${q.length}</span>` : ''}${m.sentence.now ? `<span class="aside">${m.sentence.now} now, ${m.sentence.turn} your turn</span>` : ''}</h2>
${body}
</section>`;
}

// ---- the floor ----

function usageCell(r) {
  const u = r.usage;
  if (u.state === 'live') return `<div class="usage" data-usage data-live-state="live" data-at="${esc(u.at)}"${u.stale_ms ? ` data-stale-ms="${u.stale_ms}"` : ''}><b>${esc(M.compact(u.tokens))}</b>${X.spark(u.spark)}<span class="fresh">live, ${esc(age(u.age_s))} old</span></div>`;
  if (u.state === 'stale') return `<div class="usage" data-usage data-live-state="stale"><span class="old">${u.tokens == null ? 'unknown' : esc(M.compact(u.tokens))}</span><span>stale, ${esc(age(u.age_s))} old</span></div>`;
  if (u.state === 'unavailable') return `<div class="usage" data-usage data-live-state="unavailable"><span>usage unknown until exit</span></div>`;
  return `<div class="usage" data-usage data-live-state="exit"><span>${r.spend.tokens ? `${esc(M.compact(r.spend.tokens))} recorded, ` : ''}usage reported at exit</span></div>`;
}

function stopState(r) {
  if (!r.stopped) return '';
  const why = r.stop_breaches.map((b) => `${b.what} budget ${b.what === 'hours' ? `${b.limit} h` : M.compact(b.limit)}`).join(', ');
  return r.stopped === 'stopping'
    ? `<p class="stopstate">${glyph('stopping', 'stopping')}Stopping at its ${esc(why)}: the supervisor is ending the process.</p>`
    : `<p class="stopstate">${glyph('stopping', 'stopped')}Stopped at its ${esc(why)}. The process exited; the claim is held until it is released.</p>${X.cmd(command('release', r.id, '--reason', 'stopped at its budget', '--agent', 'owner'))}`;
}

function agentRow(r, m, opts) {
  const rung = r.rung ? rungText(r.rung) : r.tier;
  const flags = r.flags.length ? ` <span class="flagmark">${glyph('now', 'flagged')}in the queue: ${r.flags.map((f) => RULE[f].toLowerCase()).join(', ')}</span>` : '';
  const lease = `<div class="lease${r.lease.warn ? ' warn' : ''}" data-until="${esc(r.lease.until)}" data-since="${esc(r.lease.since || '')}"><span class="track"><span class="fill" style="width:${Math.round(r.lease.frac * 100)}%"></span></span><span class="lt">${esc(leaseText(r.lease, opts.live))}</span></div>`;
  const last = r.last ? `<p class="last">${esc(r.last.text.length > 220 ? `${r.last.text.slice(0, 219)}…` : r.last.text)}<span class="meta">${time(r.last.at, m.generated_at)}</span></p>` : '';
  const message = opts.owner && !r.stopped
    ? `<details class="act-message" data-disclosure="message-${esc(r.id)}"><summary class="btn">Message</summary><div class="panel-in"><form data-api="/api/tasks/${esc(r.id)}/message" data-done="Message sent to ${esc(r.agent)}"><div class="acts" style="margin:0"><input class="input inline-field" name="text" required autocomplete="off" aria-label="Message to ${esc(r.agent)}" placeholder="Message to ${esc(r.agent)}"><button class="btn primary" type="submit">Send</button></div><p class="meta">${esc(r.delivery)}</p><output></output></form></div></details>`
    : '';
  const acts = message || (opts.owner && r.stoppable) ? `<div class="row-acts">${message}${stopControl(r, opts, 'row')}</div>` : '';
  return `<article class="agent${r.flags.length ? ' flagged' : ''}${r.stopped ? ' stopped' : ''}" data-key="agent-${esc(r.id)}" id="agent-${esc(r.id)}" aria-labelledby="a-${esc(r.id)}">
<div class="arow">${r.stopped ? glyph('stopping', 'stopped') : status('in_progress')}<a class="title" href="#${esc(r.id)}" id="a-${esc(r.id)}" data-identity="now-task-${esc(r.id)}"><span class="id">${esc(r.id)}</span>${esc(r.title)}</a>
<p class="facts">${esc(r.agent)} · ${esc(rung)} · ${esc(r.phase ? r.phase.label : 'working')}${r.run ? `, ${esc(r.run.label)}` : ''}${flags}</p>
${lease}${usageCell(r)}${acts}</div>
${last}${stopState(r)}
</article>`;
}

function floorBand(m, opts) {
  const rows = m.floor.map((r) => agentRow(r, m, opts)).join('\n');
  const waiting = m.waiting.map((w) => `<article class="agent stopped" data-key="stopped-${esc(w.id)}"><div class="arow">${glyph('stopping', 'stopped')}<a class="title" href="#${esc(w.id)}"><span class="id">${esc(w.id)}</span>${esc(w.title)}</a><p class="facts">stopped, waiting on you: ${esc(w.text)} (${esc(w.decision)})</p></div></article>`).join('\n');
  const empty = `<p class="calmline">No agent holds a task. ${m.ready.length ? `${m.ready.length} task${m.ready.length === 1 ? ' is' : 's are'} ready for the orchestrator to dispatch.` : 'Nothing is ready to start.'}</p>`;
  return `<section class="band floor" id="floor" aria-labelledby="h-floor" data-region="floor">
<h2 class="bandh" id="h-floor">At work${m.floor.length ? ` <span class="count">${m.floor.length}</span>` : ''}<span class="aside">lease left, usage and the latest word from each agent</span></h2>
${m.floor.length || m.waiting.length ? `<div class="floor-list">${rows}${waiting}</div>` : empty}
</section>`;
}

// ---- next and recent ----

function readyRow(r, m) {
  const held = r.held ? (m.sheets.find((s) => s.id === r.id) || {}).claim : null;
  return `<li class="row" data-key="r-${esc(r.id)}">${r.rework ? status('rework') : status('ready')}<a href="#${esc(r.id)}" data-identity="now-task-${esc(r.id)}"><span class="t"><span class="id">${esc(r.id)}</span>${esc(r.title)}</span></a><span class="meta">${esc(r.tier)}, ${esc(r.kind)} ${esc(r.size)}${r.unblocks ? `, unblocks ${r.unblocks}` : ''}${r.rework ? ', <span class="why">rework</span>' : ''}${held ? `, <span class="why">ready once ${esc(held.agent)}'s expired claim is released</span>` : ''}</span></li>`;
}

function blockedRow(b) {
  const reasons = b.reasons.map((x) => esc(x.replace(/\((in_progress|todo|rework|submitted|cancelled)\)$/, (all, st) => `(${st.replace('_', ' ')})`).replace(/^depends on /, 'after ').replace(/^waits for decision (D\d+):.*/, 'waits for decision $1').replace(/^needs owner: .*/, 'waits for the owner')));
  return `<li class="row" data-key="b-${esc(b.id)}">${status('blocked')}<a href="#${esc(b.id)}" data-identity="now-task-${esc(b.id)}"><span class="t"><span class="id">${esc(b.id)}</span>${esc(b.title)}</span></a><span class="meta"><span class="${b.owner ? 'owner' : 'why'}">${reasons.slice(0, 3).join(', ')}${reasons.length > 3 ? `, and ${reasons.length - 3} more` : ''}</span></span></li>`;
}

function evRow(x, m) {
  const text = esc(x.text).replace(/(?<![\w-])T\d+(?![\w-])/g, (id, offset) => (m.display.has(id) ? `<a href="#${id}" data-mention="${offset}">${id}</a>` : id));
  return `<li class="ev${x.tone ? ` ${x.tone}` : ''}${x.owner ? ' owner' : ''}" data-event="${esc(x.key)}" data-at="${esc(x.at)}" data-kind="${esc(x.kind)}" data-task="${esc(x.task || '')}">${time(x.at, m.generated_at)}<span class="txt">${text}</span></li>`;
}

const PER_GROUP = 8;

function recentPanel(m, opts) {
  const groups = m.groups.map((g) => {
    const items = m.digest.filter((x) => x.group === g.key);
    if (!items.length) return '';
    const more = items.length > PER_GROUP ? `<p class="meta"><a href="${roomHref('history', opts)}">${items.length - PER_GROUP} more in History</a></p>` : '';
    return `<section class="group" data-group="${g.key}" data-key="group-${g.key}"><h3>${esc(g.label)} <span class="count">${items.length}</span></h3><ol class="feed">${items.slice(0, PER_GROUP).map((x) => evRow(x, m)).join('')}</ol>${more}</section>`;
  }).join('');
  return `<div class="recent" data-region="recent"><p class="digest-sum" data-since-sum>The newest ${m.digest.length} events, grouped by what they mean.</p>${m.digest.length ? `<div class="groups">${groups}</div>` : '<p class="empty">Nothing has happened yet.</p>'}</div>`;
}

function nextPanel(m) {
  const ready = m.ready.length ? `<ol class="rows">${m.ready.map((r) => readyRow(r, m)).join('')}</ol>` : '<p class="empty">Nothing is ready.</p>';
  const blocked = m.blocked.length ? `<ul class="rows">${m.blocked.map(blockedRow).join('')}</ul>` : '<p class="empty">Nothing is blocked.</p>';
  return `<div data-region="next"><h3 class="grouph">Ready <span class="t3">${m.ready.length}, by what they unblock</span></h3>${ready}<h3 class="grouph">Blocked <span class="t3">${m.blocked.length}</span></h3>${blocked}</div>`;
}

function lowerBand(m, opts) {
  const n = m.ready.length + m.blocked.length;
  return `<section class="band lower" aria-label="Next and recent">
<div class="tablist" role="tablist" aria-label="Next and recent"><button type="button" role="tab" id="tab-next" aria-controls="p-next" aria-selected="true" data-tab="next">Next <span class="count">${n}</span></button><button type="button" role="tab" id="tab-recent" aria-controls="p-recent" aria-selected="false" data-tab="recent" tabindex="-1">Recent <span class="count">${m.digest.length}</span></button></div>
<div class="panels"><div role="tabpanel" id="p-next" aria-labelledby="tab-next"><h2 class="bandh">Up next</h2>${nextPanel(m)}</div><div role="tabpanel" id="p-recent" aria-labelledby="tab-recent"><h2 class="bandh" data-since-title>Recent</h2>${recentPanel(m, opts)}</div></div>
</section>`;
}

function nowRoom(m, opts) {
  if (!m.total) {
    return `<section id="now" class="room" aria-labelledby="h-now"><div class="roomh"><h2 id="h-now">No tasks yet</h2><p>Tower Crane keeps the plan here once tasks exist. Add the first task, or import a plan:</p></div>
${cmd(command('task', 'add', '--title', 'First task', '--acceptance', 'what done means'))}
${cmd(command('plan', 'import', 'plan.json'))}
</section>`;
  }
  return `<section id="now" class="room" aria-labelledby="h-now"><h2 id="h-now" class="vh">Now</h2>
<div class="now-grid">
${queueBand(m, opts)}
${floorBand(m, opts)}
${lowerBand(m, opts)}
</div></section>`;
}

module.exports = { bar: bar0, lead, title, sentenceText, nowRoom, evRow, roomHref, ROOMS, stopControl };
