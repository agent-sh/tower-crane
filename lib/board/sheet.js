'use strict';

// A task sheet: everything about one task, over whichever room is open.

const L = require('../ladder');
const M = require('./model');
const X = require('./parts');
const { stopControl } = require('./now');

const { esc, command, cmd, glyph, status, time, leaseText, rungText, LABEL } = X;

// Where the task sits in claim, work, submit, gates, accept, merge, as a length.
function phaseTrack(phase) {
  return `<ol class="phase" aria-label="Phase: ${esc(phase.label)}">${M.PHASES.map((p, i) => `<li class="${i < phase.step ? 'done' : i === phase.step ? 'now' : ''}"${i === phase.step ? ' aria-current="step"' : ''}><span>${p}</span></li>`).join('')}</ol>`;
}

function receipts(s, m) {
  const word = { pass: 'passed', fail: 'failed', missing: 'not yet run', waived: 'waived' };
  return `<ul class="receipts">${s.gates.map((g) => {
    const what = g.state === 'pass' ? g.proved : g.state === 'waived' ? `no software proof: ${g.waiver && g.waiver.reason ? g.waiver.reason : 'waived'}` : g.reason;
    return `<li class="receipt${g.state === 'waived' ? ' waived' : g.state === 'fail' ? ' fail' : ''}"><span class="pip ${g.state}">${esc(g.type)} ${word[g.state]}</span><span class="what">${esc(what || '')}${g.sha ? ` at <span class="mono">${esc(g.sha.slice(0, 7))}</span>` : ''}${g.agent ? ` by ${esc(g.agent)}` : ''}</span>${g.command ? `<span class="cmdline">${esc(g.command)}</span>` : ''}</li>`;
  }).join('')}</ul>`;
}

function sheet(s, m, opts) {
  const facts = [`<span>${esc(s.kind)}, size ${esc(s.size)}</span>`, `<span>tier <b>${esc(s.tier)}</b>${s.rung ? ` (${esc(rungText(s.rung))})` : ''}</span>`, `<span>revision ${esc(s.revision)}</span>`];
  if (s.claim) facts.push(`<span>held by <b>${esc(s.claim.agent)}</b>${s.expired ? ', lease ran out' : ''}</span>`);
  if (s.submitted_by && s.stored !== 'in_progress') facts.push(`<span>submitted by <b>${esc(s.submitted_by)}</b></span>`);
  if (s.pr) facts.push(`<span>PR #${esc(s.pr)}</span>`);
  if (s.stack) facts.push(`<span>stack after ${esc(s.stack.parent)}, base ${esc(s.stack.base)}</span>`);
  if (s.github_stack != null) facts.push(`<span>GitHub stack ${esc(JSON.stringify(s.github_stack))}</span>`);
  if (s.sha) facts.push(`<span>at <b class="mono">${esc(s.sha.slice(0, 7))}</b></span>`);
  const secs = [];
  if (s.needs) {
    secs.push(`<section class="sec"><h3>Waits on you</h3><div class="box"><p>${esc(s.needs)}</p>${opts.owner ? `<form data-api="/api/tasks/${esc(s.id)}/owner-done" data-done="${esc(s.id)} marked done"><div class="acts"><input class="input inline-field" name="note" autocomplete="off" aria-label="What was done (optional)" placeholder="What was done (optional)"><button class="btn primary" type="submit">Mark done</button></div><output></output></form>` : cmd(command('owner-done', s.id, '--agent', 'owner'))}</div></section>`);
  }
  if (s.blockers.length) {
    // The reason kind and its own task or decision id survive sibling removal.
    const blocker = (b) => `<li data-key="sheet-${esc(s.id)}-blocker-${esc(b.split(/[:(,]/, 1)[0].trim())}">${esc(b).replace(/(?<![\w-])T\d+(?![\w-])/g, (id, offset) => (m.display.has(id) ? `<a href="#${id}" class="id" data-mention="${offset}">${id}</a>` : id))}</li>`;
    secs.push(`<section class="sec"><h3>Blocked by</h3><ul class="blockers box">${s.blockers.map(blocker).join('')}</ul></section>`);
  }
  if (s.phase) {
    const r = s.row;
    const usage = r ? (r.usage.state === 'live' ? `${M.compact(r.usage.tokens)} tokens, live, ${X.age(r.usage.age_s)} old` : r.usage.state === 'stale' ? `${r.usage.tokens == null ? 'unknown' : M.compact(r.usage.tokens)} tokens, stale, ${X.age(r.usage.age_s)} old` : r.usage.state === 'unavailable' ? 'usage unknown until exit' : 'usage reported at exit') : '';
    secs.push(`<section class="sec"><h3>Now</h3><div class="box">${phaseTrack(s.phase)}<p>${esc(s.phase.label)}${s.run ? `, ${esc(s.run.label)}` : ''}</p>${s.claim && !s.expired ? `<div class="lease" data-until="${esc(s.claim.until)}" data-since="${esc(s.claim.since || '')}"><span class="lt">${esc(leaseText({ left: Date.parse(s.claim.until) - m.now, until: s.claim.until }, opts.live))}</span></div>` : ''}${usage ? `<p class="meta">${esc(usage)}</p>` : ''}${s.branch ? `<p class="meta">branch <span class="mono">${esc(s.branch)}</span></p>` : ''}${r && r.flags.length ? `<p class="flagmark">${glyph('now', 'flagged')}flagged: ${esc(r.flags.join(', '))}</p>` : ''}${stopControl(r, opts, 'sheet')}</div></section>`);
  }
  secs.push(`<section class="sec"><h3>Acceptance</h3><ul class="accept box">${s.acceptance.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></section>`);
  if (s.gates) {
    const missing = s.gates.filter((g) => g.state !== 'pass' && g.state !== 'waived').map((g) => g.type);
    const override = s.stored === 'submitted' && missing.length
      ? `<details class="more"><summary>Accept with waivers at the terminal</summary><p class="why">A waiver satisfies a gate without software proof and stays in the record. The board cannot waive.</p>${cmd(command('accept', s.id, ...missing.flatMap((g) => ['--waive', g]), '--reason', 'why this gate does not apply', '--agent', 'owner'))}</details>` : '';
    secs.push(`<section class="sec"><h3>Gates${s.sha ? ` at <span class="mono">${esc(s.sha.slice(0, 7))}</span>` : ''}</h3>${receipts(s, m)}${override}</section>`);
  }
  if (s.ledger.length) {
    const entry = (e) => {
      const rc = Array.isArray(e.commands) && e.commands.length
        ? `<details data-disclosure="receipts"><summary>${e.commands.length} command${e.commands.length === 1 ? '' : 's'} ran</summary>${e.commands.map((c) => `<div class="rcpt">${esc([c.command, ...(c.args || [])].join(' '))}${c.cwd ? `\nin ${esc(c.cwd)}` : ''}\nexit ${esc(c.status ?? '-')}${c.signal ? `, signal ${esc(c.signal)}` : ''}</div>`).join('')}</details>` : '';
      const ref = e.ref ? (/^https:\/\//.test(e.ref) ? `<a href="${esc(e.ref)}" rel="noreferrer noopener" target="_blank">link</a>` : `<span class="mono">${esc(e.ref)}</span>`) : '';
      const sum = e.summary ? `<div class="sum">${esc(e.summary)}</div>` : '';
      return `<div class="entry" data-key="evidence-${esc(e.key)}"><div><span class="type${e.ok === false ? ' fail' : ''}">${esc(e.type)} ${e.type === 'note' ? '' : e.waived ? 'waived' : e.ok ? 'ok' : 'failed'}</span></div><div class="by">${esc(e.agent)} ${time(e.at, m.generated_at)}${ref ? `, ${ref}` : ''}${e.counts ? '' : e.type !== 'note' && e.why ? ` <span class="nocount">(does not count: ${esc(e.why)})</span>` : ''}</div>${sum}${rc}</div>`;
    };
    secs.push(`<section class="sec"><h3>Evidence by commit</h3><div class="ledger">${s.ledger.map((g, i) => `<details data-disclosure="commit-${esc(g.key)}"${i === 0 ? ' open' : ''}><summary><span class="mono">${esc(g.sha === '-' ? 'no commit' : g.sha.slice(0, 7))}</span>${g.current ? '<span class="tag live">submitted head</span>' : '<span class="tag">older</span>'}<span class="t3">${g.entries.length} entr${g.entries.length === 1 ? 'y' : 'ies'}</span></summary>${g.entries.map(entry).join('')}</details>`).join('')}</div></section>`);
  }
  const thread = s.thread.length
    ? `<div class="thread">${s.thread.slice(-30).map((x) => `<div class="msg${x.owner ? ' owner' : ''}${x.fault ? ' fault' : ''}"><header><span class="who">${esc(x.agent)}</span>${x.to ? `<span>to ${esc(x.to)}</span>` : ''}${time(x.at, m.generated_at)}</header><p>${esc(x.text)}</p></div>`).join('')}</div>${s.thread.length > 30 ? `<p class="meta">${s.thread.length - 30} earlier messages are in History.</p>` : ''}`
    : '<p class="empty">No messages on this task.</p>';
  const toAgent = opts.owner && s.claim && !s.expired
    ? `<form data-api="/api/tasks/${esc(s.id)}/message" data-done="Message sent to ${esc(s.claim.agent)}"><label class="field">Message to ${esc(s.claim.agent)}<input name="text" required autocomplete="off"></label><p class="meta">${esc(s.row ? s.row.delivery : '')}</p><div class="acts"><button class="btn primary" type="submit">Send to ${esc(s.claim.agent)}</button></div><output></output></form>`
    : '';
  const comment = opts.owner
    ? `<form data-api="/api/tasks/${esc(s.id)}/comments" data-done="Comment sent to the orchestrator"><label class="field">Comment to the orchestrator<textarea name="text" required></textarea></label><div class="acts"><button class="btn" type="submit">Send comment</button></div><output></output></form>`
    : cmd(command('task', 'note', s.id, 'your comment', '--agent', 'owner'));
  secs.push(`<section class="sec"><h3>Conversation</h3>${thread}<div class="box" style="margin-top:var(--s2)">${toAgent}${comment}</div></section>`);
  const sp = s.spend;
  if (sp.entries.length) {
    secs.push(`<section class="sec"><h3>Spend: ${esc(M.compact(sp.tokens))} tokens, ${esc(X.hours(sp.minutes))}</h3><div class="tbl-wrap" data-scroll="spend"><table class="tbl"><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Rung</th><th scope="col">Model</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Cached</th><th scope="col" class="num">Time</th></tr></thead><tbody>${sp.entries.slice().reverse().map((e) => `<tr><td>${time(e.at, m.generated_at)}</td><td>${esc(e.agent)}</td><td>${esc(e.rung || '-')}</td><td class="mono">${esc(e.model || (e.profile ? `profile ${e.profile}` : '-'))}</td><td class="num">${e.tokens == null ? '<span class="t3">not reported</span>' : `${esc(M.compact(e.tokens))}${e.live ? ' <span class="t3">live</span>' : ''}`}</td><td class="num">${e.cached == null ? '-' : esc(M.compact(e.cached))}</td><td class="num">${e.minutes ? `${esc(e.minutes)} min` : '-'}</td></tr>`).join('')}</tbody></table></div></section>`);
  }
  const link = (x) => `<li>${status(x.status)}<a href="#${esc(x.id)}"><span class="id">${esc(x.id)}</span> <span class="t">${esc(x.title)}</span></a></li>`;
  secs.push(`<section class="sec split2"><div><h3>Depends on</h3>${s.depends_on.length ? `<ul class="links">${s.depends_on.map(link).join('')}</ul>` : '<p class="empty">Nothing.</p>'}</div><div><h3>Unblocks</h3>${s.dependents.length ? `<ul class="links">${s.dependents.map(link).join('')}</ul>` : '<p class="empty">Nothing.</p>'}</div></section>`);
  if (opts.owner && s.stored !== 'cancelled') {
    const tier = `<form data-api="/api/tiers" data-kind="tier" data-task="${esc(s.id)}" data-base="${esc(s.tier)}" data-done="${esc(s.id)} tier saved"><label class="field">Tier, the rung that does this task<select name="tier">${L.TIERS.map((t) => `<option${t === s.tier ? ' selected' : ''}>${t}</option>`).join('')}</select></label><div class="acts"><button class="btn" type="submit">Save tier</button></div><output></output></form>`;
    const back = s.stored === 'submitted' || s.stored === 'accepted'
      ? `<form data-api="/api/tasks/${esc(s.id)}/rework" data-done="${esc(s.id)} sent back"><label class="field">Send back for rework: what to fix<textarea name="reason" required></textarea></label><div class="acts"><button class="btn danger" type="submit">Send back</button></div><output></output></form>` : '';
    secs.push(`<section class="sec"><h3>Change</h3><div class="box">${tier}${back}</div></section>`);
  }
  secs.push(`<section class="sec"><h3>At the terminal</h3>${cmd(command('task', 'show', s.id))}</section>`);
  // A ready task with an expired claim says so in its header, not only below.
  const shown = s.status === 'ready' && s.claim && s.expired ? `ready once ${s.claim.agent}'s expired claim is released` : LABEL[s.status];
  return `<article id="${esc(s.id)}" class="sheet" aria-labelledby="h-${esc(s.id)}" data-key="sheet-${esc(s.id)}">
<a class="scrim" href="#" tabindex="-1" aria-hidden="true"></a>
<div class="panel" role="dialog" aria-labelledby="h-${esc(s.id)}">
<header class="shead"><div class="top">${status(s.status)}<span>${esc(shown)}${s.reworks ? `, sent back ${s.reworks} time${s.reworks === 1 ? '' : 's'}` : ''}${s.unblocks ? `, unblocks ${s.unblocks}` : ''}</span><a class="close" href="#" data-close aria-label="Close ${esc(s.id)}">Close</a></div>
<h2 id="h-${esc(s.id)}" tabindex="-1"><span class="id">${esc(s.id)}</span>${esc(s.title)}</h2>
<p class="facts">${facts.join('')}</p></header>
<div class="sbody" data-scroll="body">${secs.join('\n')}</div>
</div>
</article>`;
}

module.exports = { sheet };
