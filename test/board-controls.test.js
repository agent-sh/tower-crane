'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, BIN, HOOKS } = require('./helpers');
const { CHROME, openBrowser } = require('./browser');
const Authority = require('../lib/authority');

function fixture(t) {
  const h = makeRepo();
  h.servers = [];
  t.after(async () => {
    for (const { child, exited } of h.servers) { child.kill(); await exited; }
    await h.cleanup();
  });
  return h;
}

// keyed is the one-time owner link to the Controls page; the API calls here
// take the token from it first.
async function serve(t, h, agent = 'owner', { fetchToken = true } = {}) {
  const child = cp.spawn(process.execPath, ['--require', HOOKS, BIN, 'serve', '--port', '0', '--json', '--agent', agent],
    { cwd: h.repo, env: { ...h.env, HOOK_STATE: h.state, HOOK_PROCESSES_DIR: path.join(h.base, 'detached') } });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  h.servers.push({ child, exited });
  const printed = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (data) => {
      out += data;
      if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]));
    });
    child.once('exit', (code) => reject(new Error(`serve exited ${code}`)));
  });
  const { url } = printed;
  const keyed = `${url}controls${printed.open ? new URL(printed.open).search : ''}`;
  let token = '';
  if (fetchToken) token = /name="tower-crane-token" content="([^"]*)"/.exec(await (await fetch(keyed)).text())?.[1] || '';
  const post = async (body, route = 'api/controls', headers = {}) => {
    const res = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-crane-token': token, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return { url, keyed, post };
}

const request = (command, flags = {}, pos = []) => ({ command, flags, pos });
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const audits = (h) => events(h).filter((e) => e.cmd === 'setting');
const decisions = (h) => h.readState('decisions.json').decisions;
const as = (agent) => ({ env: { TOWER_CRANE_AGENT: agent } });

test('board controls cover the authority table and use the CLI authority and audit for changes and approvals', async (t) => {
  const h = fixture(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Board control', '--acceptance', 'runs']);
  const { url, post } = await serve(t, h);
  const res = await fetch(url + 'api/controls');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.authority.map((r) => r.setting), Object.keys(Authority.TABLE));
  for (const row of data.authority) assert.ok(row.control, row.setting);
  const page = await (await fetch(url + 'controls')).text();
  for (const row of data.authority) assert.ok(page.includes(`id="${row.control}"`), row.setting);
  let result = await post(request('project set', { workers: '3' }));
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(h.readState('project.json').limits.workers, 3);
  assert.deepEqual(audits(h).at(-1).detail, { command: 'project set', actor: 'owner', mode: 'board', settings: { 'limits.workers': 'operational' } });
  const before = audits(h).length;
  result = await post(request('project set', { 'merge-admin': 'true' }));
  assert.equal(result.data.decision, 'D1');
  assert.equal(h.readState('project.json').merge?.admin, undefined);
  assert.equal(audits(h).length, before);
  result = await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(h.readState('project.json').merge.admin, true);
  assert.equal(audits(h).length, before + 1);
  assert.equal(audits(h).at(-1).detail.approved_by, 'D1');
  assert.equal(decisions(h)[0].applied.by, 'owner');
  assert.equal((await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer')).status, 400);
  result = await post(request('project set', { 'merge-admin': 'false' }));
  await post({ decision: result.data.decision, choice: 'decline' }, 'api/controls/answer');
  assert.equal(h.readState('project.json').merge.admin, true);
  assert.equal((await post(request('project set', { workers: '0' }))).status, 400);
  assert.equal((await post(request('project set', { agent: 'orchestrator' }))).status, 400);
  assert.equal((await post(request('merge', {}, ['T1']))).status, 400);
  assert.equal((await post(request('project set', { workers: '9' }), 'api/controls', { 'x-tower-crane-version': 'outdated' })).status, 409);
  assert.equal(h.readState('project.json').limits.workers, 3);
});

test('project, ladder, personal and task controls persist through shared handlers, including pause and budget direction', async (t) => {
  const h = fixture(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A ready task', '--acceptance', 'runs']);
  const { post, url } = await serve(t, h);
  async function change(command, flags, pos = []) {
    const before = audits(h).length;
    let r = await post(request(command, flags, pos));
    assert.equal(r.status, 200, JSON.stringify(r));
    if (r.data.decision) {
      assert.equal(audits(h).length, before, command);
      r = await post({ decision: r.data.decision, choice: 'approve' }, 'api/controls/answer');
      assert.equal(r.status, 200, JSON.stringify(r));
    }
    assert.equal(audits(h).length, before + 1, command + JSON.stringify(flags));
    assert.equal(audits(h).at(-1).detail.mode, 'board');
    return r;
  }
  const flags = {
    'tests-cmd': 'node --test', 'clean-cmd': 'node clean.js', 'tests-proof-cmd': 'node --test {tests}',
    'ci-required': '["test"]', 'ci-ignore-apps': '["example"]', 'ci-capped-review': '[{"app":"review","pattern":"limit"}]',
    'ci-local': '{"command":["node","ci.js"],"timeout":30}', 'tests-paths': '["test/*.test.js"]',
    'tests-keep': '["fixtures/**"]', 'tests-mode': 'run-only', 'tests-by-kind': '{"docs":"none"}',
    'tests-expensive': 'true', 'lease-minutes': '45', 'merge-keep-branch': 'true',
    'review-policy': '{"small_lines":40}', sandbox: '{"write":[]}', env: '{"BOARD_TEST":"yes"}',
    scope: '{}',
  };
  for (const [key, value] of Object.entries(flags)) await change('project set', { [key]: value });
  await change('project set', { 'budget-hours': '2', 'budget-tokens': '100' });
  assert.deepEqual(audits(h).at(-1).detail.settings, { 'budget.lower': 'operational' });
  await change('project set', { 'budget-hours': 'null', 'budget-tokens': '200' });
  assert.deepEqual(audits(h).at(-1).detail.settings, { 'budget.raise': 'owner-required' });
  assert.equal(h.readState('project.json').budget.hours, null);
  await change('project set', { paused: 'Owner is inspecting the run' });
  assert.match(h.ok(['project', 'show']), /paused: Owner is inspecting the run/);
  assert.match(h.run(['claim', 'T1', '--agent', 'worker']).stderr, /project paused/);
  assert.ok((await (await fetch(url + 'api/controls')).json()).tasks[0].blocked.includes('project paused: Owner is inspecting the run'));
  await change('project set', { paused: '' });
  await change('ladder set', { model: 'test-model', supervision: '{"retries":1}' }, ['hard']);
  await change('ladder set', { sandbox: '{"write":[]}', env: '{"BOARD_RUNG":"yes"}', scope: '{}' }, ['hard']);
  await change('ladder set', { fallbacks: '[{"harness":"codex","profile":"sol","effort":"high"}]' }, ['hard']);
  assert.equal(JSON.parse(fs.readFileSync(h.userConfig)).ladder.hard.fallbacks[0].profile, 'sol');
  await change('ladder save-user', {});
  await change('browser-kit set', { servers: '["playwright","custom"]' });
  assert.deepEqual(JSON.parse(fs.readFileSync(h.userConfig)).browser_kit, ['playwright', 'custom']);
  await change('task update', { kind: 'docs', tier: 'easy', 'needs-owner': 'Review docs', 'ci-local': '{"args":["docs"]}' }, ['T1']);
  await change('owner-done', {}, ['T1']);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null);
  await change('task update', { 'budget-hours': '1' }, ['T1']);
  assert.equal(h.readState('tasks.json').tasks[0].budget.hours, 1);
  // The board reaches the handler itself, which refuses a task with no queued gate work.
  const prioritized = await post(request('gates prioritize', { reason: 'Owner wants this first' }, ['T1']));
  assert.equal(prioritized.status, 400);
  assert.match(prioritized.data.error, /no queued gate work/);
  assert.equal((await post(request('ladder set', { fallbacks: 'not json' }, ['easy']))).status, 400);
});

test('a rung field the CLI spells with a hyphen saves from the rung control', async (t) => {
  const h = fixture(t);
  h.init();
  const { post, keyed } = await serve(t, h);
  const page = await (await fetch(keyed)).text();
  const loaded = JSON.parse(/<script id="controls-data" type="application\/json">([\s\S]*?)<\/script>/.exec(page)[1]);
  // The page's own map from ladder field to CLI flag, as the rung form uses it.
  assert.equal(loaded.rung_flags.web_mcp, 'web-mcp');
  assert.equal(loaded.rung_flags.env_file, 'env_file');
  const server = { name: 'harness-web', command: 'node', args: ['/configured/server.mjs'] };
  const asked = await post(request('ladder set', { [loaded.rung_flags.web_mcp]: JSON.stringify(server) }, ['research']));
  assert.equal(asked.status, 200, JSON.stringify(asked));
  assert.deepEqual(decisions(h).at(-1).escalation.settings, ['ladder.web_mcp']);
  const applied = await post({ decision: asked.data.decision, choice: 'approve' }, 'api/controls/answer');
  assert.equal(applied.status, 200, JSON.stringify(applied));
  assert.deepEqual(h.readState('project.json').ladder.research.web_mcp, server);
});

test('the board approves a publish request without using it, so the orchestrator repeat publishes once', async (t) => {
  const h = fixture(t);
  h.init();
  const { post, url } = await serve(t, h);
  const asked = await post(request('ask', { setting: ['publish'], change: '{"release":"v0.1.0"}' }));
  assert.equal(asked.status, 200, JSON.stringify(asked));
  assert.equal(asked.data.decision, 'D1');
  const approved = await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer');
  assert.equal(approved.status, 200, JSON.stringify(approved));
  assert.equal(decisions(h)[0].answer, 'approve');
  assert.equal(decisions(h)[0].applied, undefined, 'the approval waits for the orchestrator');
  assert.equal(audits(h).filter((e) => e.detail.settings.publish).length, 0);
  assert.match(await (await fetch(url + 'controls')).text(), /Waiting for the orchestrator to apply this request/);
  assert.equal((await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer')).status, 400);
  h.ok(['ask', '--setting', 'publish', '--change', '{"release":"v0.1.0"}'], as('orchestrator'));
  assert.equal(decisions(h).length, 1, 'the repeat opened no new escalation');
  assert.equal(decisions(h)[0].applied.by, 'orchestrator');
  assert.deepEqual(audits(h).filter((e) => e.detail.settings.publish).map((e) => [e.detail.actor, e.detail.approved_by]), [['orchestrator', 'D1']]);
});

test("the board approves an orchestrator's escalations for its repeat, applies the owner's own, and rejects viewer writes", async (t) => {
  const h = fixture(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Delegation target', '--acceptance', 'runs']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Orchestrate the fixture.\n' });
  assert.equal(h.run(['project', 'set', '--merge-admin', 'true'], as('orchestrator')).code, 1);
  assert.equal(h.run(['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait'], as('orchestrator')).code, 1);
  assert.deepEqual(decisions(h)[1].request, { command: 'spawn', flags: { task: 'T1', role: 'orchestrator', wait: true }, pos: [] });
  const { post, url } = await serve(t, h);
  // Approving answers the orchestrator; its refusal told it to run the command again.
  const approved = await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer');
  assert.equal(approved.status, 200, JSON.stringify(approved));
  assert.match(approved.data.message, /orchestrator uses this approval/);
  assert.equal(h.readState('project.json').merge?.admin, undefined);
  assert.equal(decisions(h)[0].applied, undefined);
  h.ok(['project', 'set', '--merge-admin', 'true'], as('orchestrator'));
  assert.equal(h.readState('project.json').merge.admin, true);
  assert.equal(decisions(h)[0].applied.by, 'orchestrator');
  assert.equal(decisions(h).filter((d) => d.escalation?.settings.includes('merge.admin')).length, 1, 'the repeat opened no new decision');
  const waited = await post({ decision: 'D2', choice: 'approve' }, 'api/controls/answer');
  assert.equal(waited.status, 200, JSON.stringify(waited));
  assert.equal(decisions(h)[1].answer, 'approve');
  assert.equal(decisions(h)[1].applied, undefined);
  assert.equal(events(h).filter((e) => e.cmd === 'spawn' && e.detail.role === 'orchestrator').length, 0);
  const page = await (await fetch(url + 'controls')).text();
  assert.doesNotMatch(page, /data-decision="D2"/);
  assert.match(page, /Waiting for the orchestrator to apply this request/);
  assert.equal((await post({ decision: 'D2', choice: 'approve' }, 'api/controls/answer')).status, 400);
  assert.equal(Authority.approval(require('../lib/state').loadState(h.state), ['delegation'], { spawn: 'T1', role: 'orchestrator' }).id, 'D2');
  const r = await post(request('accept', { waive: ['tests', 'clean', 'review', 'ci'], reason: 'Fixture only' }, ['T1']));
  assert.equal(r.data.decision, 'D3');
  const failed = await post({ decision: 'D3', choice: 'approve' }, 'api/controls/answer');
  assert.equal(failed.status, 400);
  assert.match(failed.data.error, /only submitted/);
  assert.equal(decisions(h)[2].applied, undefined);
  assert.match(await (await fetch(url + 'controls')).text(), /Apply approved change/);
  // A tagged question is answered with its own options on the board, not here.
  h.ok(['ask', '--question', 'Which release channel?', '--option', 'beta', '--option', 'stable', '--setting', 'publish'], as('orchestrator'));
  const tagged = decisions(h).at(-1);
  assert.ok(tagged.escalation && tagged.approval_request !== true);
  assert.doesNotMatch(await (await fetch(url + 'controls')).text(), new RegExp(`data-decision="${tagged.id}"`));
  assert.equal((await post({ decision: tagged.id, choice: 'approve' }, 'api/controls/answer')).status, 400);
  assert.equal(decisions(h).at(-1).status, 'open');
  const viewer = await serve(t, h, 'viewer', { fetchToken: false });
  const view = await (await fetch(viewer.url + 'controls')).text();
  assert.doesNotMatch(view, /<form|<input|<select/);
  assert.equal((await viewer.post(request('project set', { workers: '9' }))).status, 403);
});

test("releasing another agent's live claim from the board opens the owner's decision and applies it once approved", async (t) => {
  const h = fixture(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Claimed elsewhere', '--acceptance', 'runs']);
  h.ok(['claim', 'T1', '--agent', 'worker-1']);
  const { post } = await serve(t, h);
  const asked = await post(request('release', { reason: 'Worker is stuck' }, ['T1']));
  assert.equal(asked.status, 200, JSON.stringify(asked));
  assert.equal(asked.data.decision, 'D1');
  assert.deepEqual(decisions(h)[0].escalation.settings, ['claim.release']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'in_progress');
  const released = await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer');
  assert.equal(released.status, 200, JSON.stringify(released));
  assert.equal(h.readState('tasks.json').tasks[0].status, 'todo');
  assert.equal(decisions(h)[0].applied.by, 'owner');
});

test('the board pauses dispatch, interrupts a real supervised fixture and delegates only after approval', { skip: process.platform !== 'linux' && 'interrupt verifies Linux start ticks' }, async (t) => {
  const h = fixture(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A supervised fixture', '--acceptance', 'stops on request', '--tier', 'easy']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Fixture process, no model.\n' });
  const script = `require('node:child_process').execFileSync(process.execPath,[${JSON.stringify(BIN)},'claim','T1']);setInterval(()=>{},1000)`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', script, '{brief}']), '--clear', 'profile', '--clear', 'effort']);
  h.ok(['project', 'set', '--paused', 'Inspect before dispatch']);
  assert.match(h.run(['spawn', '--task', 'T1']).stderr, /project paused/);
  h.ok(['project', 'set', '--paused', '']);
  const run = h.json(['spawn', '--task', 'T1']);
  async function until(fn) {
    const deadline = Date.now() + 15000;
    while (!fn()) {
      assert.ok(Date.now() < deadline, 'fixture process completed the transition');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await until(() => h.readState('tasks.json').tasks[0].claim);
  const { post } = await serve(t, h);
  const stopped = await post(request('interrupt', {}, ['T1']));
  assert.equal(stopped.status, 200, JSON.stringify(stopped));
  assert.equal(audits(h).at(-1).detail.settings['task.interrupt'], 'operational');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'todo');
  const Processes = require('../lib/processes');
  await until(() => Processes.processState({ pid: run.pid, host: run.host, start_ticks: run.start_ticks }) === 'exited');
  assert.equal(events(h).filter((e) => e.cmd === 'spawn retry').length, 0);
  assert.equal((await post(request('interrupt', {}, ['T1']))).status, 400);
  h.ok(['ladder', 'set', 'orchestrator', '--harness', 'command', '--command',
    JSON.stringify([path.join(h.base, 'missing-program'), '{brief}']), '--clear', 'model', '--clear', 'effort']);
  const delegation = await post(request('spawn', { task: 'T1', role: 'orchestrator' }));
  assert.equal(delegation.status, 200, JSON.stringify(delegation));
  assert.ok(delegation.data.decision);
  assert.equal(events(h).filter((e) => e.cmd === 'spawn' && e.detail.role === 'orchestrator').length, 0);
  const failed = await post({ decision: delegation.data.decision, choice: 'approve' }, 'api/controls/answer');
  assert.equal(failed.status, 400, JSON.stringify(failed));
  assert.equal(audits(h).filter((e) => e.detail.settings.delegation).length, 0);
  assert.equal(decisions(h).at(-1).applied, undefined);
  h.ok(['ladder', 'set', 'orchestrator', '--command', JSON.stringify([process.execPath, '-e', 'setInterval(()=>{},1000)', '{brief}'])]);
  const started = await post({ decision: delegation.data.decision, choice: 'approve' }, 'api/controls/answer');
  assert.equal(started.status, 200, JSON.stringify(started));
  assert.equal(events(h).filter((e) => e.cmd === 'spawn' && e.detail.role === 'orchestrator').length, 1);
  assert.equal(audits(h).filter((e) => e.detail.mode === 'board' && e.detail.settings.delegation).length, 1);
});

test('approved board waivers accept once and retain one settings audit', async (t) => {
  const h = fixture(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Waiver fixture', '--acceptance', 'accepted']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  const { post } = await serve(t, h);
  const asked = await post(request('accept', { waive: ['tests', 'clean', 'review', 'ci'], reason: 'Fixture has no software gates' }, ['T1']));
  assert.equal(asked.data.decision, 'D1');
  const applied = await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer');
  assert.equal(applied.status, 200, JSON.stringify(applied));
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
  assert.equal(decisions(h)[0].applied.by, 'owner');
  assert.equal(audits(h).filter((e) => e.detail.command === 'accept').length, 1);
  assert.equal((await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer')).status, 400);
});

test('browser controls save limits, approve and decline requests, keep saved values under unsaved input, in both themes', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = fixture(t);
  h.init();
  h.ok(['project', 'set', '--name', 'Tower Crane board controls', '--goal', 'Run the project from the board']);
  h.ok(['task', 'add', '--title', 'Ship the board controls', '--acceptance', 'Every authority setting is reachable', '--needs-owner', 'Approve the release plan']);
  h.ok(['ask', '--question', 'Publish the release today?', '--option', 'yes', '--option', 'no']);
  const { url, keyed } = await serve(t, h, 'owner', { fetchToken: false });
  const b = await openBrowser(t);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await b.goto(keyed);
  await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'controls connection');
  async function fill(id, name, value, event = 'input') {
    await b.inPage(`(() => {const e = document.querySelector('#${id} [name="${name}"]'); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('${event}',{bubbles:true}));})()`);
  }
  const read = (id, name) => b.inPage(`document.querySelector('#${id} [name="${name}"]').value`);
  async function submit(id, condition) {
    await b.inPage(`window.beforeControlSave = true; document.querySelector('#${id} button[type="submit"]').click()`);
    await b.restored(`!window.beforeControlSave && (${condition})`, id + ' saved');
  }
  await fill('project-workers', 'workers', '4');
  await submit('project-workers', `document.querySelector('#project-workers input').value === '4'`);
  assert.equal(h.readState('project.json').limits.workers, 4);
  await fill('project-merge-admin', 'merge-admin', 'true');
  await submit('project-merge-admin', `document.querySelector('[data-decision="D2"]')`);
  for (const theme of ['light', 'dark']) {
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    assert.equal(await b.inPage(`matchMedia('(prefers-color-scheme: ${theme})').matches`), true);
    assert.equal(await b.inPage(`document.documentElement.scrollWidth <= innerWidth`), true);
    if (process.env.TOWER_CRANE_BOARD_ARTIFACTS) {
      fs.mkdirSync(process.env.TOWER_CRANE_BOARD_ARTIFACTS, { recursive: true });
      await b.inPage('scrollTo(0,0)');
      const shot = await b.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.TOWER_CRANE_BOARD_ARTIFACTS, `controls-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  await b.inPage(`document.querySelector('[data-decision="D2"] [value="approve"]').click()`);
  await b.restored(`!document.querySelector('[data-decision="D2"]')`, 'approval applied');
  assert.equal(h.readState('project.json').merge.admin, true);
  await fill('project-merge-admin', 'merge-admin', 'false');
  await submit('project-merge-admin', `document.querySelector('[data-decision="D3"]')`);
  await b.inPage(`document.querySelector('[data-decision="D3"] [value="decline"]').click()`);
  await b.restored(`!document.querySelector('[data-decision="D3"]')`, 'decline saved');
  assert.equal(h.readState('project.json').merge.admin, true);
  await fill('personal', 'fallbacks', '[{"profile":"sol"}]');
  await submit('personal', `document.querySelector('#personal [name="fallbacks"]').value === '[{"profile":"sol"}]'`);
  assert.equal(JSON.parse(fs.readFileSync(h.userConfig)).ladder.easy.fallbacks[0].profile, 'sol');
  await fill('project-paused', 'paused', 'Inspecting release');
  await submit('project-paused', `document.querySelector('#project-paused input').value === 'Inspecting release'`);
  assert.match(await b.inPage('document.body.textContent'), /project paused: Inspecting release/);
  // With another form holding unsaved input the page stays after a save; the
  // selectors must then load the saved values, or a later save reverts them.
  await fill('project-workers', 'workers', '7');
  await fill('rung', '$field', 'model', 'change');
  const oldModel = await read('rung', '$value');
  await fill('rung', '$value', 'board-model');
  await b.inPage(`document.querySelector('#rung button[type="submit"]').click()`);
  await b.until(`document.querySelector('#rung .result').textContent && document.querySelector('#rung .result').textContent !== 'Saving...' && !document.getElementById('stale').hidden`, 'rung saved without reload');
  assert.equal(h.readState('project.json').ladder.easy.model, 'board-model');
  assert.notEqual(oldModel, 'board-model');
  await fill('rung', '$field', 'effort', 'change');
  await fill('rung', '$field', 'model', 'change');
  assert.equal(await read('rung', '$value'), 'board-model');
  await fill('task', '$field', 'tier', 'change');
  await fill('task', '$value', 'hard');
  await b.inPage(`document.querySelector('#task button[type="submit"]').click()`);
  await b.until(`document.querySelector('#task .result').textContent && document.querySelector('#task .result').textContent !== 'Saving...'`, 'task saved without reload');
  assert.equal(h.readState('tasks.json').tasks[0].tier, 'hard');
  await fill('task', '$field', 'kind', 'change');
  await fill('task', '$field', 'tier', 'change');
  assert.equal(await read('task', '$value'), 'hard');
  // The rung selector sends research's web_mcp as --web-mcp, which opens the owner's approval.
  await fill('rung', '$pos', 'research', 'change');
  await fill('rung', '$field', 'web_mcp', 'change');
  await fill('rung', '$value', '{"name":"harness-web","command":"node","args":["/configured/server.mjs"]}');
  await b.inPage(`document.querySelector('#rung button[type="submit"]').click()`);
  await b.until(`/Review D\\d+ to approve/.test(document.querySelector('#rung .result').textContent)`, 'web MCP request opened a decision');
  assert.deepEqual(decisions(h).at(-1).escalation.settings, ['ladder.web_mcp']);
  assert.equal(await read('project-workers', 'workers'), '7');
  h.ok(['task', 'note', 'T1', 'Progress from a worker']);
  await b.until(`!document.getElementById('stale').hidden`, 'live change notice');
  assert.equal(await read('project-workers', 'workers'), '7');
  await b.goto(url);
  await b.inPage(`document.querySelector('form[data-api="/api/decisions/D1/answer"] button[value="yes"]').click()`);
  await b.restored(`!document.querySelector('form[data-api="/api/decisions/D1/answer"]')`, 'ordinary decision answered');
  assert.equal(decisions(h)[0].answer, 'yes');
  await b.goto(url + 'controls');
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await b.inPage(`document.documentElement.scrollWidth <= innerWidth`), true);
});
