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
const { THEME_BOOT, THEME_TOGGLE } = require('./board/client');
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
// a new decision. The same holds once an orchestrator asked for the owner's
// request too (repeat_by). A publish request is approved for the orchestrator,
// which publishes.
function replay(d) {
  const request = d.request;
  if (d.asked_by !== 'owner' || d.repeat_by || !object(request) || request.command === 'ask') return null;
  try { parse(request); } catch { return null; }
  return request;
}

// When an orchestrator joined the owner's request, its repeat carries only the
// owner-required change, so the owner hears which other values did not apply.
// project set's change names its flags; other commands' changes have their own
// shape, so their note names every flag of a request with more than one.
function joinedNote(d) {
  const flags = Object.keys(object(d.request) && object(d.request.flags) ? d.request.flags : {});
  if (!d.repeat_by || !flags.length) return '';
  const rest = d.request.command === 'project set' && object(d.escalation.change)
    ? flags.filter((f) => !Object.hasOwn(d.escalation.change, f)) : flags.length > 1 ? flags : [];
  if (!rest.length) return '';
  return d.request.command === 'project set'
    ? ` Its repeat makes only ${d.escalation.settings.join(', ')}; ${rest.join(', ')} from your request did not apply, so save ${rest.length > 1 ? 'them' : 'it'} again.`
    : ` Its repeat makes only ${d.escalation.settings.join(', ')}; check ${rest.join(', ')} from your request and save what did not apply.`;
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
  return { ok: true, message: body.choice === A.APPROVE ? `Approved. The orchestrator uses this approval when it repeats the request.${joinedNote(before)}` : 'Declined.' };
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
  const now = Date.now();
  return {
    authority: A.rows().map((row) => ({ ...row, control: controlFor(row.setting) })),
    project: st.project, ladder: P.showData(L.resolve(st.project, ctx.env)),
    browser_kit: require('./browser-kit').show(ctx).data.servers,
    decisions: st.decisions.decisions,
    tasks: st.tasks.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, display: T.displayStatus(st, t),
      kind: t.kind, tier: t.tier, needs_owner: t.needs_owner, ci_local: t.ci_local, budget: t.budget ?? null,
      blocked: ['todo', 'rework'].includes(T.effectiveStatus(t, now)) ? T.blockReasons(st, t, now) : [], gates: T.gateReport(t, st.events, st).missing })),
  };
}

// optional inputs are left out of the request while empty.
function field(name, label, value = '', choices, optional = false) {
  const input = choices
    ? `<select name="${esc(name)}">${choices.map((v) => `<option${v === value ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`
    : `<input name="${esc(name)}" value="${esc(value)}" autocomplete="off" spellcheck="false"${optional ? ' data-optional' : ''}>`;
  return `<label class="field">${esc(label)}${input}</label>`;
}

function form(id, command, title, fields, hint = '', fixed = {}) {
  return `<form id="${esc(id)}" class="ctl" data-command="${esc(command)}" data-fixed="${esc(JSON.stringify(fixed))}">
<h4>${esc(title)}</h4>${hint ? `<p class="hint">${esc(hint)}</p>` : ''}${fields}
<div class="acts"><button class="btn primary" type="submit">Save</button><span class="result" role="status"></span></div></form>`;
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
    return `<article class="decision"><h4><span class="id">${esc(r.id)}</span> ${esc(r.escalation.settings.join(', '))}</h4>
<p>${esc(r.question)}</p><details class="more"><summary>The recorded request</summary><pre>${esc(JSON.stringify(r.request || r.escalation.change, null, 2))}</pre></details>
${owner && applies ? `<form data-decision="${esc(r.id)}" class="acts"><button class="btn primary" name="choice" value="${A.APPROVE}">${r.status === 'open' ? 'Approve' : 'Apply approved change'}</button>${r.status === 'open' ? `<button class="btn" name="choice" value="${A.DECLINE}">Decline</button>` : ''}<span class="result" role="status"></span></form>` : r.status === 'answered' ? `<p>Approved. Waiting for the orchestrator to apply this request.${esc(joinedNote(r))}</p>` : ''}</article>`;
  }).join('');
  const blocked = d.tasks.filter((t) => t.blocked.length || t.status === 'submitted').map((t) => `<li><a href="/#${t.id}"><span class="id">${t.id}</span> ${esc(t.title)}</a>: ${esc([...t.blocked, ...(t.status === 'submitted' ? t.gates : [])].join('; ') || 'all gates passed')}</li>`).join('');
  const registry = d.authority.map((row) => `<tr><td><a class="mono" href="#${row.control}">${esc(row.setting)}</a></td><td>${row.class === A.OWNER ? '<span class="class-word">yours</span>' : row.class === A.OPERATIONAL ? 'orchestrator may change' : esc(row.class)}</td><td>${requests.filter((r) => r.escalation.settings.includes(row.setting)).map((r) => `<a href="#decisions">${r.id}</a>`).join(', ') || '-'}</td></tr>`).join('');
  const extra = form('browser-kit', 'browser-kit set', 'Browser kit', field('servers', 'MCP server names (JSON array)', JSON.stringify(d.browser_kit)), 'Personal setting for every project. [] disables the kit.')
    + form('publish', 'ask', 'Approve a publication', field('change', 'Publication details (JSON)', '{}'), 'Records your approval to publish outside the repository. The orchestrator publishes and uses it by asking with the same details.', { setting: ['publish'] });
  const content = `<section id="decisions" aria-labelledby="h-decisions"><h3 id="h-decisions">Pending approvals</h3><div class="stack">${decisions || '<p class="t2">No pending approvals.</p>'}</div><p class="t2">Other decisions are answered in the queue on <a href="/">Now</a>.</p></section>
<section aria-labelledby="h-blocked"><h3 id="h-blocked">Blocked work</h3><ul class="blocked">${blocked || '<li class="t2">No blocked work.</li>'}</ul></section>
<section id="project" aria-labelledby="h-project"><h3 id="h-project">Project settings</h3><div class="control-grid">${projectForms}</div></section>
<section id="agents" aria-labelledby="h-agents"><h3 id="h-agents">Agents and personal settings</h3><p class="t2">The ladder table and task tiers are in <a href="/settings">Settings</a>.</p><div class="control-grid">${rung}${personal}${extra}</div></section>
<section id="tasks" aria-labelledby="h-tasks"><h3 id="h-tasks">Task controls</h3><div class="control-grid">${task}${actions}</div></section>
<section id="authority" aria-labelledby="h-authority"><h3 id="h-authority">Authority table</h3><div class="panel" data-scroll="authority"><table><thead><tr><th scope="col">Setting</th><th scope="col">Who may change it</th><th scope="col">Pending</th></tr></thead><tbody>${registry}</tbody></table></div></section>`;
  const loaded = { version, ladder: d.ladder, tasks: d.tasks, rung_flags: rungFlags() };
  const model = Model.build(st);
  return preserve(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${owner ? `<meta name="tower-crane-token" content="${esc(token)}">` : ''}
<title>Controls · ${esc(View.title(model))}</title>
<link rel="icon" href="${View.favicon(model.queue.length > 0)}">
<script>${THEME_BOOT}</script>
<style>${CSS}${STYLE}</style>
</head>
<body>
${View.SYMBOLS}
${View.bar(model, { live: true, room: 'controls' })}
${View.lead(model, { live: true, page: true })}
<main class="controls">
<div class="roomh"><h2>Controls</h2><p>${owner ? 'Every row of the authority table. Changes the orchestrator may make save at once; changes that are yours open an approval below.' : 'Read-only. Start tower-crane serve --agent owner to edit.'}</p></div>
<nav class="control-nav" aria-label="Control sections"><a href="#decisions">Approvals <span class="count">${requests.length}</span></a><a href="#project">Project</a><a href="#agents">Agents</a><a href="#tasks">Tasks</a><a href="#authority">Authority table</a></nav>
<div class="banner" id="stale" role="status" hidden>The state changed while you were editing. Your edits are kept. <button class="btn" type="button" id="reload">Reload</button></div>
${owner ? content : content.replace(/<form\b[^>]*>[\s\S]*?<\/form>/g, '')}
</main>
<script id="controls-data" type="application/json">${View.json(loaded)}</script><script>${THEME_TOGGLE}${SCRIPT}</script>
</body>
</html>`);
}

// The Controls room in the board's system: the same tokens, type steps,
// controls and plates as every other room (docs/design.md).
const STYLE = `
.controls { max-width: 1480px; }
.controls section { margin: 0 0 var(--s6); scroll-margin-top: var(--s4); }
.controls section > h3 { margin: 0 0 var(--s3); font-size: var(--t-item); font-weight: var(--w-strong); }
.controls section > p.t2 { margin: 0 0 var(--s3); font-size: var(--t-dense); }
.control-nav { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s4); margin: 0 0 var(--s5); font-size: var(--t-dense); }
.control-nav a { display: inline-flex; align-items: center; gap: var(--s1); min-height: 24px; color: var(--text-2); }
.control-nav a:hover { color: var(--text); }
.control-nav .count { height: 20px; min-width: 20px; font-size: var(--t-meta); }
.control-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: var(--s3); }
.ctl, .decision { display: grid; align-content: start; gap: var(--s2); padding: var(--s4); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-room); }
.ctl h4, .decision h4 { font-size: var(--t-body); font-weight: var(--w-strong); overflow-wrap: anywhere; }
.ctl .hint, .decision p { color: var(--text-2); font-size: var(--t-dense); max-width: var(--measure); }
.ctl .acts, .decision .acts { margin: var(--s1) 0 0; }
.controls .field input { font-family: var(--mono); font-size: var(--t-dense); }
.controls .field input:hover, .controls .field select:hover { border-color: var(--text-2); }
.controls .field select { appearance: none; padding-right: 26px; font-size: var(--t-dense); cursor: pointer; background-image: linear-gradient(45deg, transparent 50%, var(--text-2) 50%), linear-gradient(135deg, var(--text-2) 50%, transparent 50%); background-position: calc(100% - 14px) 52%, calc(100% - 9px) 52%; background-size: 5px 5px; background-repeat: no-repeat; }
.controls .result { flex-basis: 100%; color: var(--text-2); font-size: var(--t-dense); }
.controls .result:empty { display: none; }
.controls .result.error { padding: var(--s2) var(--s3); border-left: 3px solid var(--alarm); background: var(--alarm-wash); color: var(--text); }
.controls .stack { display: grid; gap: var(--s3); margin: 0 0 var(--s3); }
.decision pre { margin: var(--s2) 0 0; padding: var(--s2) var(--s3); background: var(--surface-2); border-radius: var(--r-item); font: var(--t-meta)/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.controls .blocked { display: grid; gap: var(--s2); font-size: var(--t-dense); }
.controls .blocked a { color: var(--text); }
.controls .panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-room); overflow-x: auto; }
.controls table { width: 100%; border-collapse: collapse; font-size: var(--t-dense); }
.controls th, .controls td { text-align: left; padding: var(--s2) var(--s3); border-top: 1px solid var(--line); vertical-align: middle; }
.controls thead th { border-top: 0; background: var(--surface-2); color: var(--text-2); font-size: var(--t-meta); font-weight: var(--w-strong); white-space: nowrap; }
.controls :target { outline: 2px solid var(--text); outline-offset: 2px; }
.banner { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin: 0 0 var(--s4); padding: var(--s2) var(--s3); border: 1px solid var(--line); border-left: 3px solid var(--live); border-radius: var(--r-item); background: var(--surface); font-size: var(--t-dense); }
.banner[hidden] { display: none; }
`;

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
