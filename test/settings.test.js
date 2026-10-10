'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const { makeRepo, BIN } = require('./helpers');
const { CHROME, openBrowser, closeBrowser } = require('./browser');
test.after(closeBrowser);

async function startServe(h) {
  const server = cp.spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json', '--agent', 'owner'], { cwd: h.repo, env: h.env });
  const exited = new Promise((resolve) => server.on('exit', resolve));
  const printed = await new Promise((resolve, reject) => {
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]));
    });
    server.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
  });
  // keyed(path) is that page through the one-time link serve printed.
  // Windows cannot delete a directory a live process runs in, so the server
  // must be gone before makeRepo's cleanup removes the repo.
  return { url: printed.url, open: printed.open, keyed: (p = '') => `${printed.url}${p}${new URL(printed.open).search}`, stop: async () => { server.kill(); await exited; } };
}

function request(url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(url, { method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Pages are HTML.
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const tokenOf = (page) => /<meta name="tower-crane-token" content="([0-9a-f]{48})?">/.exec(page)[1] || '';
const read = (h, f) => fs.readFileSync(path.join(h.state, f), 'utf8');

// What the Settings page was drawn from, as its script reads it.
async function loadedOf(url) {
  return JSON.parse(/<script type="application\/json" id="loaded">(.*?)<\/script>/.exec((await request(`${url}settings`)).text)[1]);
}

// A ladder save as the page sends it: the edit plus, as its base, the default
// harness and each edited rung as the page loaded them.
function ladderBody(loaded, edit) {
  const rungs = edit.rungs || {};
  return { ...edit, base: { harness: loaded.harness, rungs: Object.fromEntries(Object.keys(rungs).map((n) => [n, loaded.rungs[n]])) } };
}
const tierBody = (loaded, tiers) => ({ tiers, base: Object.fromEntries(Object.keys(tiers).map((id) => [id, loaded.tiers[id]])) });
const events = (h) => read(h, 'events.jsonl').trim().split('\n').map((l) => JSON.parse(l));

test('the Settings view edits the ladder and task tiers only with the page token, through the CLI write path', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Webhook retries', '--acceptance', 'a']);
  const s = await startServe(h);
  try {
    const page = await request(s.keyed('settings'));
    assert.equal(page.status, 200);
    const token = tokenOf(page.text);
    assert.match(page.text, /<label for="harness">Default harness<\/label>/);
    assert.match(page.text, /<input name="model" value="opus" data-initial="opus" aria-labelledby="r-hard c-model"/);
    assert.match(page.text, /<select name="tier" aria-labelledby="t-T1 c-tier" data-initial="medium"(?: data-preserve="[0-9a-f]{64}")?>/);
    assert.match((await request(s.url)).text, /<a href="settings" data-view="settings"(?: data-preserve="[0-9a-f]{64}")?>Settings<\/a>/, 'the board links to Settings');
    assert.notEqual((await startAgain(h)).token, token, 'each run has its own token');

    const ladder = `${s.url}api/ladder`;
    const project = read(h, 'project.json');
    let loaded = await loadedOf(s.url);
    const change = ladderBody(loaded, { rungs: { easy: { harness: '', model: 'gpt-x', profile: '', provider: '', effort: 'low', args: '["--skip-git-repo-check"]', command: '' } } });
    const refused = [
      [{}, 403, /missing or wrong token/],
      [{ 'x-tower-crane-token': 'f'.repeat(48) }, 403, /missing or wrong token/],
      [{ 'x-tower-crane-token': token, origin: 'http://evil.example' }, 403, /other origins/],
      [{ 'x-tower-crane-token': token, host: 'evil.example' }, 403, /forbidden host/],
    ];
    for (const [headers, status, message] of refused) {
      const r = await request(ladder, { method: 'POST', body: change, headers });
      assert.equal(r.status, status, JSON.stringify(headers));
      assert.match(r.text, message);
    }
    assert.equal(read(h, 'project.json'), project, 'a POST without the token writes nothing');

    const invalid = await request(ladder, { method: 'POST', headers: { 'x-tower-crane-token': token }, body: ladderBody(loaded, { rungs: { easy: { harness: 'pi', model: '', profile: 'luna', effort: 'medium' } } }) });
    assert.equal(invalid.status, 400);
    assert.match(invalid.json.error, /^ladder easy \(pi\): profile applies only to codex, needs a model$/);
    const badArgs = await request(ladder, { method: 'POST', headers: { 'x-tower-crane-token': token }, body: ladderBody(loaded, { rungs: { small: { args: 'not json' } } }) });
    assert.equal(badArgs.status, 400);
    assert.match(badArgs.json.error, /^ladder small: args must be a JSON array of strings/);
    assert.equal(read(h, 'project.json'), project, 'a refused value leaves project.json unchanged');

    const saved = await request(ladder, { method: 'POST', headers: { 'x-tower-crane-token': token }, body: change });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual([saved.json.ok, saved.json.harness, saved.json.ladder.easy.model, saved.json.ladder.easy.from], [true, 'codex', 'gpt-x', 'project'], 'the reply is the ladder as ladder show prints it');
    assert.deepEqual(h.readState('project.json').ladder.easy, { model: 'gpt-x', effort: 'low', args: ['--skip-git-repo-check'] });
    const ev = events(h).find((e) => e.cmd === 'ladder set');
    assert.deepEqual([ev.agent, ev.detail.rung, ev.detail.via], ['owner', 'easy', 'serve']);
    assert.match(read(h, 'sketch.html'), /<tr data-rung="easy"><th scope="row">easy<\/th><td>codex \(default\)<\/td><td>gpt-x<\/td>/, 'the write re-rendered the sketch');

    loaded = await loadedOf(s.url);
    const harness = await request(ladder, { method: 'POST', headers: { 'x-tower-crane-token': token }, body: ladderBody(loaded, { harness: 'agy', rungs: { medium: { model: 'gemini-3-pro', profile: '' }, review: { model: 'gemini-3-pro', profile: '' }, small: { model: 'gemini-3-flash', profile: '' }, easy: { model: 'gemini-3-flash', args: '' } } }) });
    assert.equal(harness.status, 200, harness.text);
    assert.equal(h.json(['ladder', 'show']).ladder.medium.harness, 'agy', 'the default harness and rungs change in one write');

    const tiers = `${s.url}api/tiers`;
    const tasks = read(h, 'tasks.json');
    assert.equal((await request(tiers, { method: 'POST', body: tierBody(loaded, { T1: 'hard' }) })).status, 403);
    const badTier = await request(tiers, { method: 'POST', headers: { 'x-tower-crane-token': token }, body: tierBody(loaded, { T1: 'expert' }) });
    assert.equal(badTier.status, 400);
    assert.match(badTier.json.error, /^T1: tier must be one of easy, medium, hard, research/);
    assert.equal(read(h, 'tasks.json'), tasks);
    const tier = await request(tiers, { method: 'POST', headers: { 'x-tower-crane-token': token }, body: tierBody(loaded, { T1: 'hard' }) });
    assert.equal(tier.status, 200, tier.text);
    assert.deepEqual([tier.json.ok, tier.json.tiers], [true, [{ id: 'T1', tier: 'hard' }]]);
    assert.match(tier.json.version, /^[0-9a-f]{16}$/, 'the reply carries the state version the page compares reload events to');
    assert.equal(h.readState('tasks.json').tasks[0].tier, 'hard');
    const tierEv = events(h).filter((e) => e.cmd === 'task update').pop();
    assert.deepEqual([tierEv.task, tierEv.detail], ['T1', { tier: 'hard', via: 'serve' }]);
    assert.match((await request(`${s.url}settings`)).text, /Last change: T1 tier hard by owner from serve/);
  } finally {
    await s.stop();
  }
});

// Review finding F4: a local client read the token from a page and answered
// the owner's decisions. Only the one-time link serve printed carries it.
test('a local process without the one-time link gets no token serve accepts, with or without an Origin header', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Webhook retries', '--acceptance', 'a']);
  h.ok(['ask', '--question', 'ship it?', '--option', 'yes', '--option', 'no', '--agent', 'orchestrator']);
  const s = await startServe(h);
  try {
    const files = ['tasks.json', 'decisions.json', 'project.json', 'events.jsonl'];
    const before = files.map((f) => read(h, f));
    const loaded = await loadedOf(s.url);
    const writes = [
      ['decisions/D1/answer', { choice: 'yes' }],
      ['ladder', ladderBody(loaded, { rungs: { medium: { harness: 'command', command: '["/bin/true"]', model: '', profile: '', effort: '', args: '' } } })],
      ['tiers', tierBody(loaded, { T1: 'hard' })],
    ];
    for (const headers of [{}, { origin: new URL(s.url).origin }]) {
      const pages = ['', 'settings', `settings?key=${'f'.repeat(48)}`];
      const tokens = [];
      for (const p of pages) {
        const page = await request(`${s.url}${p}`, { headers });
        assert.equal(page.status, 200);
        tokens.push(tokenOf(page.text));
      }
      assert.deepEqual(tokens, pages.map(() => ''), `no page without the key carries the token (${JSON.stringify(headers)})`);
      for (const [api, body] of writes) {
        const r = await request(`${s.url}api/${api}`, { method: 'POST', headers: { ...headers, 'x-tower-crane-token': '' }, body });
        assert.equal(r.status, 403, `${api} ${JSON.stringify(headers)}`);
        assert.match(r.text, /missing or wrong token/);
      }
    }
    assert.deepEqual(files.map((f) => read(h, f)), before, 'nothing was written');

    const owner = tokenOf((await request(s.open)).text);
    assert.match(owner, /^[0-9a-f]{48}$/, 'the printed link carries the token');
    assert.equal(tokenOf((await request(s.open)).text), '', 'the link works once');
    const r = await request(`${s.url}api/decisions/D1/answer`, { method: 'POST', headers: { 'x-tower-crane-token': owner }, body: { choice: 'yes' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(h.readState('decisions.json').decisions[0].answered_by, 'owner');
  } finally {
    await s.stop();
  }
});

test('a save made against a rung, default harness or tier that changed since the page loaded is refused and writes nothing', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Webhook retries', '--acceptance', 'a']);
  const s = await startServe(h);
  try {
    const token = tokenOf((await request(s.keyed('settings'))).text);
    const post = (api, body) => request(`${s.url}api/${api}`, { method: 'POST', headers: { 'x-tower-crane-token': token }, body });
    const loaded = await loadedOf(s.url);
    // The page loaded easy as luna; the form sends every field of the rung,
    // so its stale profile would undo a model chosen through the CLI.
    h.ok(['ladder', 'set', 'easy', '--model', 'chosen-by-cli', '--clear', 'profile']);
    const project = read(h, 'project.json');
    const edit = { rungs: { easy: { harness: '', model: '', profile: 'luna', provider: '', effort: 'high', args: '', command: '' } } };
    const r = await post('ladder', ladderBody(loaded, edit));
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, 'the ladder changed since this page loaded: ladder easy is now model chosen-by-cli, effort medium; reload the page and make the edit again');
    assert.equal(read(h, 'project.json'), project);
    assert.equal(h.json(['ladder', 'show']).ladder.easy.model, 'chosen-by-cli');

    const noBase = await post('ladder', edit);
    assert.equal(noBase.status, 400);
    assert.match(noBase.json.error, /^send base: /);
    assert.equal(read(h, 'project.json'), project, 'a save without its base is refused');

    // Pin the codex rungs so the default harness can move under them.
    for (const n of ['easy', 'medium', 'review', 'small']) h.ok(['ladder', 'set', n, '--harness', 'codex']);
    // A rung nobody else touched still saves, from a fresh page.
    const fresh = await loadedOf(s.url);
    const ok = await post('ladder', ladderBody(fresh, { rungs: { small: { effort: 'medium' } } }));
    assert.equal(ok.status, 200, ok.text);

    h.ok(['ladder', 'harness', 'claude']);
    const after = read(h, 'project.json');
    const def = await post('ladder', ladderBody(fresh, { rungs: { hard: { effort: 'max' } } }));
    assert.equal(def.status, 409, def.text);
    assert.match(def.json.error, /the default harness is now claude, not codex/);
    assert.equal(read(h, 'project.json'), after);

    h.ok(['task', 'update', 'T1', '--tier', 'research']);
    const tasks = read(h, 'tasks.json');
    const tier = await post('tiers', tierBody(fresh, { T1: 'hard' }));
    assert.equal(tier.status, 409, tier.text);
    assert.equal(tier.json.error, 'tiers changed since this page loaded: T1 is now research, not medium; reload the page and make the edit again');
    assert.equal(read(h, 'tasks.json'), tasks);
  } finally {
    await s.stop();
  }
});

test("in a browser, saving one form keeps the other form's unsaved edits, and a stale rung save is refused", { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Webhook retries', '--acceptance', 'a']);
  const s = await startServe(h);
  t.after(() => s.stop());
  const b = await openBrowser(t);
  await b.goto(s.keyed('settings'));
  const easyEffort = `document.querySelector('tr[data-rung="easy"] input[name="effort"]')`;
  const tierSelect = `document.querySelector('tr[data-task="T1"] select')`;
  const set = (el, value, event) => b.inPage(`(function (el) { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })(${el})`);
  const click = (form) => b.inPage(`document.querySelector('#${form} button[type="submit"]').click()`);
  const saved = (form) => `document.querySelector('#${form} .msg').textContent.startsWith('Saved.') || (!window.firstLoad && document.documentElement.hasAttribute('data-position-restored'))`;
  const settle = () => new Promise((r) => setTimeout(r, 800));
  await b.inPage('window.firstLoad = true');

  await set(easyEffort, 'high', 'input');
  await set(tierSelect, 'hard', 'change');
  await click('ladder-form');
  await b.until(saved('ladder-form'), 'the ladder save');
  await settle();
  assert.equal(h.readState('project.json').ladder.easy.effort, 'high');
  assert.deepEqual(
    await b.inPage(`[window.firstLoad === true, ${tierSelect}.value, ${tierSelect}.closest('tr').classList.contains('dirty'), document.getElementById('stale').hidden]`),
    [true, 'hard', true, true],
    'no reload, the unsaved tier stays, and the reload event for its own write raises no banner',
  );

  // The stale-save repro: an effort edit on the page while a model is chosen
  // through the CLI. Save stays possible; the server refuses it.
  await set(easyEffort, 'low', 'input');
  h.ok(['ladder', 'set', 'easy', '--model', 'chosen-by-cli', '--clear', 'profile']);
  await b.until(`!document.getElementById('stale').hidden`, 'the stale banner');
  await click('ladder-form');
  await b.until(`document.getElementById('ladder-err').textContent.includes('changed since this page loaded')`, 'the refusal');
  assert.deepEqual(h.readState('project.json').ladder.easy, { model: 'chosen-by-cli', effort: 'high' });

  await click('tier-form');
  await b.until(saved('tier-form'), 'the tier save');
  assert.equal(h.readState('tasks.json').tasks[0].tier, 'hard');
  assert.deepEqual(await b.inPage(`[window.firstLoad === true, ${easyEffort}.value]`), [true, 'low'], 'the unsaved ladder edit stays too');
});

test('in a browser, a form is read-only while its save waits, so typing then loses nothing', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Webhook retries', '--acceptance', 'a']);
  const s = await startServe(h);
  t.after(() => s.stop());
  const b = await openBrowser(t);
  const easyModel = `document.querySelector('tr[data-rung="easy"] input[name="model"]')`;
  const easyEffort = `document.querySelector('tr[data-rung="easy"] input[name="effort"]')`;
  const tierSelect = `document.querySelector('tr[data-task="T1"] select')`;
  const set = (el, value, event) => b.inPage(`(function (el) { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })(${el})`);
  const appeared = async (file) => {
    const end = Date.now() + 15000;
    while (!fs.existsSync(file)) {
      if (Date.now() > end) throw new Error(`${file} never appeared`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  // otherDirty: with an unsaved tier the saved form is updated in place,
  // without one the page reloads; both must keep what the person typed.
  for (const [round, otherDirty] of [[1, false], [2, true]]) {
    await b.goto(round === 1 ? s.keyed('settings') : `${s.url}settings`);
    if (otherDirty) await set(tierSelect, 'hard', 'change');
    await set(easyEffort, round === 1 ? 'high' : 'low', 'input');
    await b.inPage(`${easyModel}.focus()`);
    // A CLI write holds the lock, so the save waits for it.
    const paused = path.join(h.base, `holder-${round}`);
    const holder = h.runAsync(['task', 'note', 'T1', 'holding the lock'], { hooks: { HOOK_PAUSE_ON: 'tasks.json', HOOK_PAUSED: paused } });
    await appeared(paused);
    await b.inPage(`document.querySelector('#ladder-form button[type="submit"]').click()`);
    await b.until(`document.querySelector('#ladder-form button[type="submit"]').textContent === 'Saving...'`, 'the save to start');
    assert.deepEqual(await b.inPage(`[${easyModel}.disabled, ${easyEffort}.disabled, document.getElementById('harness').disabled, document.getElementById('ladder-form').getAttribute('aria-busy')]`), [true, true, true, 'true']);
    await b.type('typed-while-saving');
    const typed = await b.inPage(`${easyModel}.value`);
    fs.writeFileSync(`${paused}.go`, '');
    assert.equal((await holder).code, 0);
    await b.until(`document.readyState === 'complete' && !document.querySelector('#ladder-form[aria-busy]') && ${easyModel} && !${easyModel}.disabled && (${otherDirty} || document.documentElement.hasAttribute('data-position-restored'))`, 'the save to finish');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.readState('project.json').ladder.easy.effort, round === 1 ? 'high' : 'low');
    assert.equal(await b.inPage(`${easyModel}.value`), typed, `round ${round}: what was typed during the save is still there`);
    assert.equal(typed, '', 'the read-only field took no input');
    if (otherDirty) assert.equal(await b.inPage(`${tierSelect}.value`), 'hard', 'the other form keeps its edit');
  }
});

// A second server on the same state, to show the token is per run.
async function startAgain(h) {
  const s = await startServe(h);
  try {
    return { token: tokenOf((await request(s.keyed('settings'))).text) };
  } finally {
    await s.stop();
  }
}
