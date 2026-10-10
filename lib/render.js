'use strict';

const path = require('node:path');
const { byId, shortTime, truncate } = require('./util');
const S = require('./state');
const T = require('./tasks');
const L = require('./ladder');
const P = require('./processes');
const Runaway = require('./runaway');

const DISPLAY = ['ready', 'blocked', 'in_progress', 'submitted', 'rework', 'accepted', 'cancelled'];
const LABEL = { ready: 'ready', blocked: 'blocked', in_progress: 'in progress', submitted: 'submitted', rework: 'rework', accepted: 'accepted', cancelled: 'cancelled' };

// Mermaid has no theme tokens, so sketch.md carries fixed colors that read on
// both light and dark Markdown viewers.
const MERMAID = {
  ready: 'fill:#dff3e6,stroke:#1f7a4d,color:#14231a',
  blocked: 'fill:#ececea,stroke:#77776f,color:#22221f',
  in_progress: 'fill:#dde9fb,stroke:#1c5fb8,color:#14203a',
  submitted: 'fill:#efe3f9,stroke:#7f45b5,color:#2a1838',
  rework: 'fill:#fbe6d8,stroke:#b4541a,color:#3a1d0a',
  accepted: 'fill:#d8efef,stroke:#0f6e6e,color:#0d2a2a',
  cancelled: 'fill:#f3f3f1,stroke:#a3a39c,color:#6b6b66,stroke-dasharray:4 3',
};

// The views still draw when the user file is broken; the ladder table says why.
function ladderOrError(project) {
  try {
    return L.resolve(project);
  } catch (e) {
    return { error: e.message };
  }
}

function buildView(st, now = Date.now()) {
  const tasks = [...st.tasks.tasks].sort(byId);
  const display = new Map(tasks.map((t) => [t.id, T.displayStatus(st, t, now)]));
  const counts = Object.fromEntries(S.STATUSES.map((s) => [s, 0]));
  for (const t of tasks) counts[t.status] += 1;
  const ready = T.readyTasks(st, now);
  const runs = tasks.map((t) => ({ id: t.id, run: P.runPhase(st, t) })).filter((x) => x.run);
  counts.ready = ready.length;
  counts.blocked = T.blockedTasks(st, now).length;
  const inProgress = tasks
    .filter((t) => t.status === 'in_progress')
    .map((t) => ({ task: t, agent: t.claim.agent, until: t.claim.until, expired: T.leaseExpired(t, now), run: P.runPhase(st, t) }));
  const submitted = tasks.filter((t) => t.status === 'submitted').map((t) => ({ task: t, report: T.gateReport(t, st.events, st) }));
  const open = st.decisions.decisions.filter((d) => d.status === 'open').sort(byId);
  const owner = tasks.filter((t) => t.needs_owner && t.status !== 'accepted' && t.status !== 'cancelled');
  const minutes = tasks.reduce((s, t) => s + t.spend.minutes, 0);
  const tokens = tasks.reduce((s, t) => s + t.spend.tokens, 0);
  const missing = tasks.reduce((n, t) => n + T.missingUsage(t), 0);
  const live = tasks.flatMap((t) => T.liveSpend(t, now));
  return {
    project: st.project,
    ladder: ladderOrError(st.project),
    generated_at: new Date(now).toISOString(),
    tasks,
    display,
    counts,
    ready,
    runs,
    inProgress,
    submitted,
    open,
    owner,
    expired: inProgress.filter((x) => x.expired),
    spend: { minutes, hours: Math.round((minutes / 60) * 10) / 10, tokens, missing_usage: missing, live, budget_hours: st.project.budget.hours, budget_tokens: st.project.budget.tokens },
  };
}

function pct(used, budget) {
  if (budget == null) return '-';
  if (budget === 0) return used > 0 ? 'over' : '0%';
  return `${Math.round((used / budget) * 100)}%`;
}

function compact(n) {
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (n >= 1e3) return `${Math.round(n / 1e2) / 10}k`;
  return String(n);
}

function spendRows(v) {
  return [
    { what: 'Hours', spent: String(v.spend.hours), budget: v.spend.budget_hours == null ? '-' : String(v.spend.budget_hours), used: pct(v.spend.hours, v.spend.budget_hours) },
    { what: 'Tokens', spent: compact(v.spend.tokens), budget: v.spend.budget_tokens == null ? '-' : compact(v.spend.budget_tokens), used: pct(v.spend.tokens, v.spend.budget_tokens) },
    ...(v.spend.missing_usage ? [{ what: 'Spawns without usage', spent: String(v.spend.missing_usage), budget: '-', used: '-' }] : []),
  ];
}

// Each table is described once and drawn by both the Markdown and HTML writers.
function tables(v) {
  return [
    {
      title: 'Ready',
      head: ['Task', 'Title', 'Kind', 'Size', 'Tier', 'Unblocks'],
      rows: v.ready.map(({ task, unblocks }) => [task.id, task.title + (task.status === 'rework' ? ' (rework)' : ''), task.kind, task.size, task.tier, String(unblocks)]),
    },
    {
      title: 'In progress',
      head: ['Task', 'Title', 'Agent', 'Phase', 'Lease until'],
      rows: v.inProgress.map((x) => [x.task.id, x.task.title, x.agent, P.phaseText(x.run), x.expired ? `${shortTime(x.until)} (expired)` : shortTime(x.until)]),
    },
    {
      title: 'Runs',
      head: ['Task', 'Agent', 'Phase'],
      rows: v.runs.map((x) => [x.id, x.run.agent, P.phaseText(x.run)]),
    },
    {
      title: 'Submitted',
      head: ['Task', 'Title', 'Sha', 'PR', 'By', 'Gates'],
      rows: v.submitted.map(({ task, report }) => [
        task.id, task.title, task.sha ? task.sha.slice(0, 7) : '-', task.pr ? `#${task.pr}` : '-', task.submitted_by || '-',
        report.ok ? 'all pass' : `missing ${report.gates.filter((g) => !g.ok).map((g) => g.type).join(', ')}`,
      ]),
    },
    {
      title: 'Decisions open',
      head: ['Decision', 'Question', 'Options', 'Recommendation', 'Blocks'],
      rows: v.open.map((d) => [d.id, d.question + (d.why ? ` (${d.why})` : ''), d.options.join(', ') || '-', d.recommendation || '-', d.blocks.join(', ') || '-']),
    },
    {
      title: 'Needs owner',
      head: ['Task', 'Title', 'Owner must'],
      rows: v.owner.map((t) => [t.id, t.title, t.needs_owner]),
    },
    {
      title: 'Spend vs budget',
      head: ['', 'Spent', 'Budget', 'Used'],
      rows: spendRows(v).map((r) => [r.what, r.spent, r.budget, r.used]),
    },
    {
      title: 'Ladder',
      head: ['Rung', 'Harness', 'Model or profile', 'Effort'],
      rows: v.ladder.error ? [['-', v.ladder.error, '-', '-']] : L.RUNGS.map((n) => {
        const r = L.rungOf(v.ladder, n);
        const what = r.harness === 'command' ? JSON.stringify(r.command) : [r.model, r.profile && `profile ${r.profile}`].filter(Boolean).join(', ');
        return [n, v.ladder.ladder[n].harness_from === 'default' ? `${r.harness} (default)` : r.harness, what || '-', r.effort || '-'];
      }),
    },
  ];
}

// ---- Markdown ----

// Markdown viewers treat <word> as HTML and drop it, so titles keep their
// angle brackets as entities.
const mdText = (s) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mdCell = (s) => mdText(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
// Mermaid turns #name; into an HTML entity, which keeps quotes and angle
// brackets in titles from ending the label or reading as markup.
const mermaidLabel = (s) => String(s).replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/\r?\n/g, ' ');

function mermaid(v) {
  if (!v.tasks.length) return 'No tasks yet.';
  const lines = ['```mermaid', 'flowchart LR'];
  for (const t of v.tasks) lines.push(`  ${t.id}["${mermaidLabel(`${t.id}: ${truncate(t.title, 48)}`)}"]`);
  const ids = new Set(v.tasks.map((t) => t.id));
  for (const t of v.tasks) for (const d of t.depends_on) if (ids.has(d)) lines.push(`  ${d} --> ${t.id}`);
  for (const s of DISPLAY) {
    const members = v.tasks.filter((t) => v.display.get(t.id) === s).map((t) => t.id);
    if (!members.length) continue;
    lines.push(`  classDef ${s} ${MERMAID[s]}`);
    lines.push(`  class ${members.join(',')} ${s}`);
  }
  lines.push('```');
  return lines.join('\n');
}

function renderMarkdown(st, now) {
  const v = buildView(st, now);
  const p = v.project;
  const out = [`# ${mdText(p.name)}`, '', mdText(p.goal), '', `Rendered ${shortTime(v.generated_at)}${p.repo ? ` for ${p.repo}` : ''}, base \`${p.base}\`. ${countLine(v)}.`, '', mermaid(v), ''];
  for (const tb of tables(v)) {
    out.push(`## ${tb.title}`, '');
    if (!tb.rows.length) {
      out.push('None.', '');
      continue;
    }
    out.push(`| ${tb.head.map(mdCell).join(' | ')} |`, `|${tb.head.map(() => '---').join('|')}|`);
    for (const r of tb.rows) out.push(`| ${r.map(mdCell).join(' | ')} |`);
    out.push('');
  }
  return out.join('\n');
}

function countLine(v) {
  const c = v.counts;
  return [
    `${c.ready} ready`, `${c.blocked} blocked`, `${c.in_progress} in progress`, `${c.submitted} submitted`,
    `${c.rework} rework`, `${c.accepted} accepted`, `${c.cancelled} cancelled`,
  ].join(', ');
}

// ---- HTML ----

// The board (lib/board) draws sketch.html: the same document serve shows,
// without the token, the owner's forms or the live stream.
function renderHtml(st, now = Date.now(), opts = {}) {
  const Board = require('./board/model');
  const View = require('./board/view');
  return View.page(Board.build(st, { now }), opts);
}

function renderFiles(st) {
  const now = Date.now();
  const md = path.join(st.dir, 'sketch.md');
  const html = path.join(st.dir, 'sketch.html');
  S.writeAtomic(md, renderMarkdown(st, now));
  S.writeAtomic(html, renderHtml(st, now));
  return { md, html };
}

// Under the lock, like every write: a render that read the state before a
// concurrent write would otherwise publish that older state over the newer
// sketch the write just rendered.
function render(ctx) {
  const out = S.withLock(ctx.stateDir, () => renderFiles(S.loadState(ctx.stateDir)));
  return { data: out, text: `wrote ${out.md}\nwrote ${out.html}` };
}

function status(ctx) {
  const st = S.loadState(ctx.stateDir);
  const v = buildView(st);
  const exited = P.exitedClaims(st);
  const p = v.project;
  const lines = [`${p.name}: ${p.goal}`, countLine(v)];
  lines.push(v.ready.length ? `ready: ${v.ready.map(({ task }) => `${task.id} ${truncate(task.title, 40)}`).join('; ')}` : 'ready: none');
  const isPinned = (command) => typeof command === 'string' && command.trim().length > 0;
  const testsCommandPinned = isPinned(p.gates?.tests_cmd);
  const cleanupCommandPinned = isPinned(p.gates?.clean_cmd);
  const testsPolicy = require('./tests-policy').resolve(p, 'code');
  const missingGateCommands = [
    ...(testsPolicy.mode !== 'none' && !testsCommandPinned ? ['test'] : []),
    ...(!cleanupCommandPinned ? ['cleanup'] : []),
  ];
  if (!testsCommandPinned && !cleanupCommandPinned) lines.push('gates blocked: no pinned commands');
  else if (missingGateCommands.length === 1) lines.push(`gates blocked: no ${missingGateCommands[0]} command pinned`);
  if (v.inProgress.length) lines.push(`in progress: ${v.inProgress.map((x) => `${x.task.id} (${x.agent}${x.run ? `, ${P.phaseText(x.run)}` : ''})`).join(', ')}`);
  const runs = v.runs;
  if (runs.length) lines.push(`runs: ${runs.map((x) => `${x.id} ${P.phaseText(x.run)}`).join('; ')}`);
  const gateQueue = require('./automation').gateQueue(st);
  if (gateQueue.running.length) lines.push(`gate running: ${gateQueue.running.join(', ')}`);
  lines.push(`gate queue: ${require('./automation').describeQueue(gateQueue)}`);
  if (v.submitted.length) {
    lines.push(`submitted: ${v.submitted.map(({ task, report }) => `${task.id}${report.ok ? ' (gates pass)' : ` (missing ${report.gates.filter((g) => !g.ok).map((g) => g.type).join(', ')})`}`).join(', ')}`);
  }
  lines.push(v.open.length ? `open decisions: ${v.open.map((d) => `${d.id} ${d.question}${d.blocks.length ? ` (blocks ${d.blocks.join(', ')})` : ''}`).join('; ')}` : 'open decisions: none');
  if (v.owner.length) lines.push(`needs owner: ${v.owner.map((t) => `${t.id} ${t.needs_owner}`).join('; ')}`);
  // Detected gate commands the engine pinned and that still stand.
  const pinned = st.events.filter((e) => e.cmd === 'gates pin' && st.project.gates?.[e.detail.key] === e.detail.value
    && !st.events.some((later) => later.cmd === 'project set' && later.at >= e.at && later.detail[e.detail.key.replaceAll('_', '-')] !== undefined))
    .map((e) => ({ key: e.detail.key, value: e.detail.value, from: e.detail.from, agent: e.agent, at: e.at }));
  if (pinned.length) lines.push(`pinned gate commands: ${pinned.map((x) => `${x.key} ${JSON.stringify(x.value)} by ${x.agent} from ${x.from}`).join('; ')}`);
  const sr = spendRows(v);
  lines.push(`spend: ${sr.map((r) => `${r.spent} ${r.what.toLowerCase()}${r.budget !== '-' ? ` of ${r.budget} (${r.used})` : ''}`).join(', ')}`);
  for (const l of v.spend.live) lines.push(`live spend: ${T.liveText(l)}`);
  if (v.expired.length) lines.push(`expired leases: ${v.expired.map((x) => `${x.task.id} (${x.agent}, ${shortTime(x.until)})`).join(', ')}`);
  const run = Runaway.runaways(st, Date.now(), st.events);
  for (const f of run.flags) lines.push(`runaway: ${f.task} ${f.agent}: ${f.text}`);
  lines.push(...P.exitLines(exited));
  return {
    data: {
      project: { name: p.name, goal: p.goal },
      counts: v.counts,
      ready: v.ready.map(({ task, unblocks }) => ({ id: task.id, title: task.title, unblocks })),
      in_progress: v.inProgress.map((x) => ({ id: x.task.id, agent: x.agent, until: x.until, expired: x.expired, run: x.run })),
      runs,
      gate_queue: gateQueue,
      submitted: v.submitted.map(({ task, report }) => ({ id: task.id, sha: task.sha, gates_ok: report.ok, missing: report.missing })),
      decisions_open: v.open.map((d) => ({ id: d.id, question: d.question, blocks: d.blocks })),
      needs_owner: v.owner.map((t) => ({ id: t.id, title: t.title, needs_owner: t.needs_owner })),
      pinned_gates: pinned,
      spend: v.spend,
      expired_leases: v.expired.map((x) => ({ id: x.task.id, agent: x.agent, until: x.until })),
      exited_claims: exited,
      runaways: run.flags,
      runaway_norms: run.norms,
    },
    text: lines.join('\n'),
  };
}

module.exports = { buildView, renderMarkdown, renderHtml, renderFiles, render, status, LABEL };
