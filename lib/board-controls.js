'use strict';

const S = require('./state');
const P = require('./project');
const L = require('./ladder');
const T = require('./tasks');
const D = require('./decisions');
const A = require('./authority');
const View = require('./board/view');
const Model = require('./board/model');
const { CSS } = require('./board/style');
const { POSITION } = require('./board/position');
const { TOKEN } = require('./board/token');
const { preserve } = require('./board/identity');
const { usage, refuse } = require('./util');

// This is the board's routing surface. Command definitions validate the input;
// Authority.enforce in each handler remains the only permission check.
const COMMANDS = ['project set', 'ladder set', 'ladder harness', 'ladder save-user', 'browser-kit set', 'task update',
  'gates prioritize', 'decision delegate', 'owner-done', 'release', 'interrupt', 'accept', 'spawn', 'ask'];
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const esc = View.esc;
const text = (v) => v === undefined ? 'null' : typeof v === 'string' ? v : JSON.stringify(v);
const at = (doc, key) => key.split('.').reduce((v, k) => v?.[k], doc);
const cli = () => require('../bin/tower-crane');
const spec = (name) => cli().COMMANDS.find((c) => c.name === name);

// Ladder fields are stored with underscores; some CLI flags spell them with a
// hyphen (web_mcp is --web-mcp).
function rungFlags() {
  const flags = Object.keys(spec('ladder set').flags);
  return Object.fromEntries(L.FIELDS.map((f) => [f, flags.find((k) => k.replace(/-/g, '_') === f)]));
}

function parse(body) {
  if (!object(body) || !COMMANDS.includes(body.command) || !object(body.flags) || !Array.isArray(body.pos)
    || body.pos.some((p) => typeof p !== 'string') || Object.keys(body).some((k) => !['command', 'flags', 'pos'].includes(k))) {
    throw usage('send {command, flags, pos} for a board control');
  }
  const cmd = spec(body.command);
  const tokens = [];
  for (const [key, value] of Object.entries(body.flags)) {
    const flag = Object.hasOwn(cmd.flags || {}, key) && cmd.flags[key];
    if (!flag) throw usage(`unknown option ${key} for ${cmd.name}`);
    if (flag.type === 'bool') {
      if (value !== true) throw usage(`${key} must be true`);
      tokens.push(`--${key}`);
    } else {
      const values = flag.type === 'multi' ? value : [value];
      if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) throw usage(`${key} must contain string values`);
      for (const v of values) tokens.push(`--${key}`, v);
    }
  }
  const flags = cli().parseOptions(tokens, cmd.flags || {}, cmd.name).flags;
  const positional = cmd.pos || [];
  if (body.pos.length !== positional.length) throw usage(`${cmd.name} needs ${positional.join(', ') || 'no positional arguments'}`);
  for (const k of cmd.required || []) if (flags[k] === undefined) throw usage(`${cmd.name} needs ${k}`);
  if (cmd.name === 'spawn' && (flags.role !== 'orchestrator' || !flags.task || flags.wait || flags.ready || flags['dry-run'])) {
    throw usage('delegation starts an orchestrator; send task and role: orchestrator');
  }
  if (cmd.name === 'ask' && (flags.question !== undefined || flags.option || [flags.setting].flat().join() !== 'publish')) {
    throw usage('this control requests publish; answer other decisions in the decision list');
  }
  return { cmd, flags, pos: body.pos };
}

async function execute(ctx, body) {
  const { cmd, flags, pos } = parse(body);
  const request = { command: cmd.name, flags: body.flags, pos };
  try {
    const result = await cmd.run({ ...ctx, flags, pos, request, requestApproval: true });
    return { ok: true, data: result?.data, message: result?.text };
  } catch (e) {
    if (e.decision) return { ok: true, decision: e.decision, message: e.message };
    throw e;
  }
}

// The board body that applies an approved decision, or null when the approval
// is the orchestrator's to use. The board applies only what the owner asked
// for from Controls, the one place the owner opens an escalation. An
// orchestrator's escalation is approved for its own repeat, which its refusal
// tells it to run; applying it here would leave that repeat a used approval and
// a new decision. A publish request is approved for the orchestrator, which
// publishes.
function replay(d) {
  const request = d.request;
  if (d.asked_by !== 'owner' || !object(request) || request.command === 'ask') return null;
  try { parse(request); } catch { return null; }
  return request;
}

async function answer(ctx, body) {
  if (!object(body) || typeof body.decision !== 'string' || ![A.APPROVE, A.DECLINE].includes(body.choice)) throw usage('send decision and choice: approve or decline');
  const before = D.getDecision(S.loadState(ctx.stateDir), body.decision);
  if (before.approval_request !== true) throw usage('use the board answer form for this decision');
  if (before.applied || before.answer === A.DECLINE) throw refuse(`${before.id} has already been handled`);
  const apply = replay(before);
  if (before.status === 'open') D.answer({ ...ctx, pos: [before.id], flags: { choice: body.choice } });
  else if (body.choice !== A.APPROVE || before.answer !== A.APPROVE || !apply) throw refuse(`${before.id} is already answered`);
  if (body.choice === A.APPROVE && apply) return execute(ctx, apply);
  return { ok: true, message: body.choice === A.APPROVE ? 'Approved. The orchestrator uses this approval when it repeats the request.' : 'Declined.' };
}

function controlFor(setting) {
  const project = Object.entries(P.FLAG_SETTINGS).find(([, s]) => s === setting);
  if (project) return `project-${project[0]}`;
  if (setting.startsWith('budget.')) return 'project-budget-hours';
  if (setting === 'ladder.save_user') return 'save-user';
  if (setting === 'ladder.fallbacks') return 'personal';
  if (setting.startsWith('ladder.')) return 'rung';
  if (setting === 'task.interrupt') return 'interrupt';
  if (setting.startsWith('task.')) return 'task';
  if (setting.startsWith('waive.')) return 'waivers';
  return { 'gates.priority': 'gates-prioritize', 'decision.delegate': 'decision-delegate', 'claim.release': 'release',
    delegation: 'delegation', browser_kit: 'browser-kit', publish: 'publish' }[setting];
}

function data(ctx) {
  const st = S.loadState(ctx.stateDir);
  return {
    authority: A.rows().map((row) => ({ ...row, control: controlFor(row.setting) })),
    project: st.project, ladder: P.showData(L.resolve(st.project, ctx.env)),
    browser_kit: require('./browser-kit').show(ctx).data.servers,
    decisions: st.decisions.decisions,
    tasks: st.tasks.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, display: T.displayStatus(st, t),
      kind: t.kind, tier: t.tier, needs_owner: t.needs_owner, ci_local: t.ci_local, budget: t.budget ?? null,
      blocked: T.blockReasons(st, t), gates: T.gateReport(t, st.events, st).missing })),
  };
}

// optional inputs are left out of the request while empty.
function field(name, label, value = '', choices, optional = false) {
  const input = choices
    ? `<select name="${esc(name)}">${choices.map((v) => `<option${v === value ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`
    : `<input name="${esc(name)}" value="${esc(value)}" autocomplete="off" spellcheck="false"${optional ? ' data-optional' : ''}>`;
  return `<label>${esc(label)}${input}</label>`;
}

function form(id, command, title, fields, hint = '', fixed = {}) {
  return `<form id="${esc(id)}" data-command="${esc(command)}" data-fixed="${esc(JSON.stringify(fixed))}">
<h3>${esc(title)}</h3>${hint ? `<p class="hint">${esc(hint)}</p>` : ''}${fields}
<div class="actions"><button type="submit">Save</button><span class="result" role="status"></span></div></form>`;
}

function render(ctx, token, version, owner) {
  const st = S.loadState(ctx.stateDir);
  const d = data(ctx);
  const help = (name, key) => spec(name).flags[key].help;
  const project = Object.entries({ 'budget-hours': 'budget.hours', 'budget-tokens': 'budget.tokens', ...P.FLAG_SETTINGS });
  const projectForms = project.map(([flag, setting]) => {
    const current = at(d.project, setting);
    const choices = ['merge-admin', 'merge-keep-branch', 'tests-expensive'].includes(flag) ? ['null', 'false', 'true']
      : flag === 'tests-mode' ? ['null', 'prove', 'run-only', 'none'] : null;
    return form(`project-${flag}`, 'project set', setting, field(flag, 'Value', flag === 'paused' ? current || '' : text(current), choices), help('project set', flag));
  }).join('');
  const tasks = d.tasks.map((t) => t.id);
  const taskSelect = field('$pos', 'Task', tasks[0], tasks);
  const open = d.decisions.filter((x) => x.status === 'open').map((x) => x.id);
  const rung = form('rung', 'ladder set', 'Rung settings', field('$pos', 'Rung', 'easy', L.RUNGS)
    + field('$field', 'Setting', 'model', L.FIELDS) + field('$value', 'Value', ''), 'Select a rung and setting to see its current value. Empty clears that field.');
  const personal = form('personal', 'ladder set', 'Personal fallbacks', field('$pos', 'Rung', 'easy', L.RUNGS)
    + field('fallbacks', 'Routes (JSON array)', JSON.stringify(d.ladder.ladder.easy.fallbacks || [])), 'Routes run in priority order and apply to this rung in every project. [] keeps none; empty removes your setting.')
    + form('save-user', 'ladder save-user', 'Save ladder as personal defaults', '', 'New projects start from this ladder.');
  const task = form('task', 'task update', 'Task settings', taskSelect + field('$field', 'Setting', 'kind', ['kind', 'tier', 'needs-owner', 'ci-local', 'budget-hours', 'budget-tokens', 'status'])
    + field('$value', 'Value', ''), 'The current value loads when you select a task or setting. Empty needs-owner clears its blocker; status cancelled cancels the task.');
  const actions = form('release', 'release', 'Release a claim', taskSelect + field('reason', 'Reason'), 'Releasing a claim does not stop its process. Interrupt it instead while it still runs.')
    + form('interrupt', 'interrupt', 'Interrupt a running task', taskSelect, 'Stops its supervisor and process group and releases the claim. The revision and worktree stay for the next dispatch.')
    + form('owner-done', 'owner-done', 'Mark owner work done', taskSelect, 'Clears the task\'s owner blocker.')
    + form('gates-prioritize', 'gates prioritize', 'Prioritize gate work', taskSelect + field('reason', 'Reason'), help('gates prioritize', 'reason'))
    + form('waivers', 'accept', 'Accept with gate waivers', taskSelect + field('waive', 'Gates (JSON array)', '["review"]') + field('reason', 'Reason'), 'Other gates still have to pass. Owner-required waivers open a decision.')
    + form('delegation', 'spawn', 'Delegate orchestration', field('task', 'Task', tasks[0], tasks), 'Starts a new orchestrator with authority over this project.', { role: 'orchestrator' })
    + form('decision-delegate', 'decision delegate', 'Delegate a decision', field('$pos', 'Decision', open[0], open)
      + field('answerers', 'Answerers (JSON array)', '', null, true) + field('technical', 'Technical (true or false)', '', null, true), 'Names the agents that may answer an open decision, or marks it technical.');
  const requests = d.decisions.filter((r) => r.approval_request === true && (r.status === 'open' || r.answer === A.APPROVE && !r.applied));
  const decisions = requests.map((r) => {
    const applies = r.status === 'open' || replay(r);
    return `<article class="decision"><h3>${esc(r.id)} · ${esc(r.escalation.settings.join(', '))}</h3>
<p>${esc(r.question)}</p><pre>${esc(JSON.stringify(r.request || r.escalation.change, null, 2))}</pre>
${owner && applies ? `<form data-decision="${esc(r.id)}"><button name="choice" value="${A.APPROVE}">${r.status === 'open' ? 'Approve' : 'Apply approved change'}</button>${r.status === 'open' ? `<button name="choice" value="${A.DECLINE}">Decline</button>` : ''}<span class="result" role="status"></span></form>` : r.status === 'answered' ? '<p>Approved. Waiting for the orchestrator to apply this request.</p>' : ''}</article>`;
  }).join('');
  const blocked = d.tasks.filter((t) => t.blocked.length || t.status === 'submitted').map((t) => `<li><a href="./#${t.id}">${t.id} ${esc(t.title)}</a>: ${esc([...t.blocked, ...(t.status === 'submitted' ? t.gates : [])].join('; ') || 'all gates passed')}</li>`).join('');
  const registry = d.authority.map((row) => `<tr><td><a href="#${row.control}">${esc(row.setting)}</a></td><td>${esc(row.class)}</td><td>${requests.filter((r) => r.escalation.settings.includes(row.setting)).map((r) => `<a href="#decisions">${r.id}</a>`).join(', ') || '-'}</td></tr>`).join('');
  const extra = form('browser-kit', 'browser-kit set', 'Browser kit', field('servers', 'MCP server names (JSON array)', JSON.stringify(d.browser_kit)), 'Personal setting for every project. [] disables the kit.')
    + form('publish', 'ask', 'Approve a publication', field('change', 'Publication details (JSON)', '{}'), 'Records your approval to publish outside the repository. The orchestrator publishes and uses it by asking with the same details.', { setting: ['publish'] });
  const content = `<section id="decisions"><h2>Pending approvals</h2>${decisions || '<p>No pending approvals.</p>'}<p><a href="./#board">Answer project decisions on the board</a></p></section>
<section><h2>Blocked work</h2><ul>${blocked || '<li>No blocked work.</li>'}</ul></section>
<section id="project"><h2>Project settings</h2><div class="control-grid">${projectForms}</div></section>
<section id="agents"><h2>Agents and personal settings</h2><p><a href="settings">Edit the ladder table and task tiers</a></p><div class="control-grid">${rung}${personal}${extra}</div></section>
<section id="tasks"><h2>Task controls</h2><div class="control-grid">${task}${actions}</div></section>
<section id="authority"><h2>Authority table</h2><div class="panel"><table><thead><tr><th>Setting</th><th>Authority</th><th>Pending</th></tr></thead><tbody>${registry}</tbody></table></div></section>`;
  const loaded = { version, ladder: d.ladder, tasks: d.tasks, rung_flags: rungFlags() };
  return preserve(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
${owner ? `<meta name="tower-crane-token" content="${esc(token)}">` : ''}<title>Controls, ${esc(st.project.name)}</title><link rel="icon" href="${View.favicon(requests.length > 0)}"><style>${CSS}
.controls{max-width:1320px}.controls section{margin-bottom:32px}.controls h2{margin-bottom:16px}.control-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}.control-grid form,.decision{padding:20px;background:var(--plate);border:1px solid var(--rule);border-radius:var(--r)}.controls h3{font-size:15px;margin:0 0 8px}.controls .hint{font-size:13px;color:var(--ink-2);margin-bottom:12px}.controls label{display:block;margin:8px 0;font-size:13px}.controls input,.controls select{display:block;width:100%;padding:8px;margin-top:4px;background:var(--plate-2);color:var(--ink);border:1px solid var(--rule-2);border-radius:var(--r);font:13px var(--mono)}.controls button{padding:7px 14px;background:var(--ink);color:var(--plate);border:1px solid var(--ink);border-radius:var(--r);cursor:pointer}.controls button:disabled{opacity:.5}.controls .actions{margin-top:12px}.controls .result{display:block;font-size:13px;margin-top:8px}.controls .error{color:var(--fault)}.controls pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px var(--mono);margin:12px 0}.controls table{width:100%;text-align:left;font-size:13px}.controls td,.controls th{padding:8px;border-bottom:1px solid var(--rule)}.controls ul{padding-left:20px}.controls li{margin:8px 0}.control-nav{display:flex;flex-wrap:wrap;gap:20px;margin:20px 0}.controls :target{scroll-margin-top:20px}.controls [hidden]{display:none}
.controls .decision button{margin-right:8px}
</style></head><body>${View.SYMBOLS}${View.topBar(Model.build(st), { live: true, base: './', current: 'controls' })}
<main class="controls"><div class="viewh"><h2>Project controls</h2><p>${owner ? 'Operational changes save immediately. Owner-required changes open an approval below.' : 'Read-only. Start serve with explicit owner identity to edit.'}</p></div>
<nav class="control-nav" aria-label="Control sections"><a href="#decisions">Approvals (${requests.length})</a><a href="#project">Project</a><a href="#agents">Agents</a><a href="#tasks">Tasks</a><a href="#authority">Authority table</a></nav>
<p id="stale" role="status" hidden>Changes are waiting. Your edits are preserved. <button id="reload">Reload</button></p>
${owner ? content : content.replace(/<form\b[^>]*>[\s\S]*?<\/form>/g, '')}</main>
<script id="controls-data" type="application/json">${View.json(loaded)}</script><script>${SCRIPT}</script></body></html>`);
}

const SCRIPT = `
(() => {
  const token = ${TOKEN};
  const position = ${POSITION}; position.restoreReload();
  const loaded = JSON.parse(document.getElementById('controls-data').textContent);
  const forms = [...document.querySelectorAll('form')];
  let saving = false;
  const stale = document.getElementById('stale');
  const controls = f => [...f.querySelectorAll('input,select')];
  const reset = f => controls(f).forEach(el => el.dataset.initial = el.value);
  const dirty = f => controls(f).some(el => el.value !== el.dataset.initial);
  const value = v => v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  const TASK_KEYS = {'needs-owner':'needs_owner','ci-local':'ci_local'};
  function populate(f) {
    const pos = f.elements.namedItem('$pos')?.value;
    const key = f.elements.namedItem('$field')?.value;
    if (f.id === 'rung') f.elements.namedItem('$value').value = value(loaded.ladder.ladder[pos]?.[key]);
    if (f.id === 'personal') f.elements.fallbacks.value = value(loaded.ladder.ladder[pos]?.fallbacks);
    if (f.id === 'task') {
      const task = loaded.tasks.find(t => t.id === pos);
      const v = key === 'budget-hours' ? task?.budget?.hours ?? null : key === 'budget-tokens' ? task?.budget?.tokens ?? null : task?.[TASK_KEYS[key] || key];
      f.elements.namedItem('$value').value = value(v);
    }
  }
  // After a save while other forms hold edits, the page stays, so the values
  // the selectors load have to be the saved ones, not the page's originals.
  async function refresh() {
    const res = await fetch('/api/controls', {cache:'no-store'});
    if (!res.ok) return;
    const fresh = await res.json();
    Object.assign(loaded, {version:fresh.version, ladder:fresh.ladder, tasks:fresh.tasks});
    forms.forEach(f => { if (!dirty(f)) { populate(f); reset(f); } });
  }
  forms.forEach(f => {
    populate(f); reset(f);
    f.addEventListener('change', e => { if (['$pos','$field'].includes(e.target.name)) populate(f); });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      if (saving) return;
      let body, route = '/api/controls';
      const result = f.querySelector('.result'); result.classList.remove('error');
      try {
        if (f.dataset.decision) { route += '/answer'; body = {decision:f.dataset.decision,choice:e.submitter.value}; }
        else {
          const flags = JSON.parse(f.dataset.fixed);
          let pos = [];
          controls(f).forEach(el => {
            if (el.name === '$pos') pos = [el.value];
            else if (el.name.startsWith('$') || el.hasAttribute('data-optional') && !el.value.trim()) return;
            else flags[el.name] = el.name === 'waive' ? JSON.parse(el.value) : el.value;
          });
          if (f.id === 'personal' && !flags.fallbacks.trim()) { delete flags.fallbacks; flags.clear = ['fallbacks']; }
          if (f.elements.namedItem('$field')) {
            const key = f.elements.namedItem('$field').value, v = f.elements.namedItem('$value').value;
            if (f.id === 'rung' && !v.trim()) flags.clear = [key];
            else flags[f.id === 'rung' ? loaded.rung_flags[key] : key] = v;
          }
          body = {command:f.dataset.command,flags,pos};
        }
        saving = true;
        const buttons = [...f.querySelectorAll('button,input,select')]; buttons.forEach(b => b.disabled = true);
        result.textContent = 'Saving...';
        try {
          const res = await fetch(route, {method:'POST',headers:{'content-type':'application/json','x-tower-crane-token':token,'x-tower-crane-version':loaded.version},body:JSON.stringify(body)});
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          loaded.version = data.version;
          reset(f);
          result.textContent = data.message || 'Saved.';
          if (!forms.some(dirty)) { position.reload(); return; }
          await refresh();
          stale.hidden = false;
        } finally { buttons.forEach(b => b.disabled = false); saving = false; }
      } catch (error) { result.textContent = error.message; result.classList.add('error'); }
    });
  });
  document.getElementById('reload').onclick = () => position.reload();
  const stream = new EventSource('/events'), conn = document.querySelector('.conn');
  stream.onopen = () => { conn.dataset.conn = 'live'; conn.textContent = 'Live'; };
  stream.onerror = () => { conn.dataset.conn = 'lost'; conn.textContent = 'Reconnecting'; };
  stream.addEventListener('reload', e => {
    if (JSON.parse(e.data).version === loaded.version || saving) return;
    if (forms.some(dirty)) stale.hidden = false;
    else position.reload();
  });
})();
`;

module.exports = { data, render, execute, answer, replay };
