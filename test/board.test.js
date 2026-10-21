'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { makeRepo, useFixtureUserFile, BIN } = require('./helpers');
const { waitUntil, waitOnRepo, killPid } = require('./signals');
const { CHROME, openBrowser, closeBrowser } = require('./browser');
test.after(closeBrowser);
const { gateFixture, gateEvidence } = require('./gate-helpers');
const { preserve } = require('../lib/board/identity');
const checks = require('./bench/checks');
const { POSITION } = require('../lib/board/position');
const B = require('../lib/broker');

// A project with something in every column: a decision, an owner task, a
// claimed task with a message, a submitted task, and work ready and blocked.
function populate(h) {
  h.ok(['task', 'add', '--title', 'Webhook <keys>', '--acceptance', 'a retried webhook runs once']);
  h.ok(['task', 'add', '--title', 'Retry API', '--acceptance', 'b', '--dep', 'T1']);
  h.ok(['task', 'add', '--title', 'Pick a dashboard', '--acceptance', 'c', '--needs-owner', 'grant dashboard access']);
  h.ok(['task', 'add', '--title', 'Metrics', '--acceptance', 'd']);
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'e', '--kind', 'docs']);
  h.ok(['ask', '--kind', 'technical', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--recommend', 'postgres', '--why', 'keys must survive a flush', '--blocks', 'T4']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'tests green, waiting on CI', '--agent', 'w-1']);
  h.ok(['claim', 'T5', '--agent', 'w-2']);
  const sha = h.git(['rev-parse', 'HEAD']).trim();
  h.ok(['submit', 'T5', '--sha', sha, '--agent', 'w-2']);
  h.ok(['evidence', 'T5', '--type', 'review', '--ok', '--sha', sha, '--revision', h.revision('T5'), '--ref', 'https://example.com/acme/demo/pull/1#review', '--summary', 'reads well', '--agent', 'rev-1']);
}

// serve runs in the repository, and Windows cannot delete a directory a live
// process runs in, so every server stops before makeRepo's cleanup: each
// test closes its servers in a finally block.
// The one-time link each server printed, by its URL: only a page loaded from
// it carries the write token.
const links = new Map();
const keyed = (url) => links.get(url);

async function startServe(servers, h, agent = 'owner') {
  const server = cp.spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json', '--agent', agent], { cwd: h.repo, env: h.env });
  const exited = new Promise((resolve) => server.on('exit', resolve));
  servers.push(async () => { server.kill(); await exited; });
  return new Promise((resolve, reject) => {
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      if (!out.includes('\n')) return;
      const { url, open } = JSON.parse(out.split('\n')[0]);
      links.set(url, open);
      resolve(url);
    });
    server.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
  });
}

async function withServers(fn) {
  const servers = [];
  try {
    await fn(servers);
  } finally {
    for (const stop of servers) await stop();
  }
}

const tokenOf = (page) => /<meta name="tower-crane-token" content="([0-9a-f]{48})?">/.exec(page)[1] || '';
const post = (url, token, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-crane-token': token }, body: JSON.stringify(body) });
const log = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('driven CLI failures distinguish killed children from failed spawns', (t) => {
  const h = makeRepo(t);
  h.init();
  assert.throws(() => h.json(['task', 'show', 'T1'], { cwd: path.join(h.base, 'missing') }), /error ENOENT/, 'a failed spawn reports its OS error');
  if (process.platform !== 'win32') {
    assert.throws(() => h.ok(['task', 'add', '--title', 'Killed write', '--acceptance', 'a'], { hooks: { HOOK_DIE_LOCKED: '1' } }), /signal SIGKILL/, 'a child killed while holding the lock reports its signal');
  }
});

test('blocker rows and repeated mentions have distinct identities without breaking serve', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Rollout', '--acceptance', 'verified']);
  h.ok(['task', 'add', '--title', 'Approve rollout', '--acceptance', 'verified', '--dep', 'T1', '--needs-owner', 'approve T1 rollout']);
  h.ok(['ask', '--kind', 'technical', '--question', 'Check T1 then T1?', '--option', 'yes', '--option', 'no', '--blocks', 'T2']);
  const identities = (page) => {
    assert.doesNotThrow(() => preserve(page, { strict: true }), 'valid markup passes strict identity checking');
    const blockers = page.match(/<article id="T2"[\s\S]*?<ul class="blockers box">([\s\S]*?)<\/ul>/)[1];
    const keys = [...blockers.matchAll(/data-preserve="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(keys.length, 4, 'dependency, owner and both decision mentions link to T1');
    assert.equal(new Set(keys).size, keys.length, 'each link has its own identity');
    assert.ok(keys.every((key) => /^[0-9a-f]{64}$/.test(key)), 'valid rows need no duplicate suffix');
    return keys;
  };
  let keys;
  await withServers(async (servers) => {
    for (const agent of ['owner', 'viewer']) {
      const url = await startServe(servers, h, agent);
      const response = await fetch(url);
      assert.equal(response.status, 200, 'the board renders for valid repeated blocker references');
      const served = identities(await response.text());
      if (keys) assert.deepEqual(served, keys);
      else keys = served;
    }
  });
  assert.deepEqual(identities(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8')), keys);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  assert.deepEqual(identities(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8')), keys, 'dependency status changes keep row identities');
  h.ok(['owner-done', 'T2']);
  const page = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  const remaining = page.match(/<article id="T2"[\s\S]*?<ul class="blockers box">([\s\S]*?)<\/ul>/)[1];
  assert.deepEqual([...remaining.matchAll(/data-preserve="([^"]+)"/g)].map((m) => m[1]), [keys[0], ...keys.slice(2)], 'surviving rows keep their keys after a sibling disappears');
});

test('duplicate preservation identities are safe in production and rejected by strict tests', () => {
  const html = '<main><a href="#T1">first</a><a href="#T1">second</a><a href="#T1">third</a></main>';
  const page = preserve(html);
  const keys = [...page.matchAll(/data-preserve="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(keys).size, 4, 'even accidental duplicates remain addressable');
  assert.deepEqual([...preserve(html).matchAll(/data-preserve="([^"]+)"/g)].map((m) => m[1]), keys, 'suffixes are deterministic');
  assert.throws(() => preserve(html, { strict: true }), /duplicate board preservation identity/);
});

test('Settings signals restoration only after a delayed animation frame restores focus and scroll', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Rollout', '--acceptance', 'verified']);
  await withServers(async (servers) => {
    const b = await openBrowser(t);
    await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await b.send('Page.enable');
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.restorationFrames = [];
      window.requestAnimationFrame = (callback) => window.restorationFrames.push(callback);
      const stream = window.EventSource;
      window.EventSource = function (url) { window.testStream = new stream(url); return window.testStream; };
    ` });
    for (const agent of ['owner', 'viewer']) {
      await t.test(agent, async () => {
        const url = await startServe(servers, h, agent);
        await b.goto(`${url}settings`);
        await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
        const page = await (await fetch(url)).text();
        const version = JSON.parse(page.match(/<script[^>]*id="boot">([^<]+)<\/script>/)[1]).version;
        assert.equal(await b.inPage(`(() => {
          window.testStream.dispatchEvent(new MessageEvent('reload', { data: ${JSON.stringify(JSON.stringify({ version }))} }));
          return sessionStorage.getItem('tower-crane:position:' + location.href);
        })()`), null, 'the displayed version does not start another reload');
        const control = agent === 'owner' ? `document.querySelector('tr[data-rung="easy"] input[name="model"]')` : `document.querySelector('.rooms a[data-room="settings"]')`;
        const table = `document.querySelector('main .panel')`;
        await b.inPage(`(() => { window.firstLoad = true; ${control}.focus({ preventScroll: true }); ${table}.scrollLeft = 100; })()`);
        const left = await b.inPage(`${table}.scrollLeft`);
        assert.ok(left > 0, 'the ladder table starts scrolled');
        h.ok(['task', 'note', 'T1', `delayed restoration as ${agent}`]);
        await b.until(`window.firstLoad !== true && document.readyState === 'complete' && document.querySelector('.conn').dataset.conn === 'live' && window.restorationFrames.length > 0`, 'the reload before its restoration frame');
        assert.deepEqual(await b.inPage(`[document.documentElement.hasAttribute('data-position-restored'), document.activeElement.tagName, ${table}.scrollLeft]`), [false, 'BODY', 0], 'a loaded document is not yet restored');
        await b.inPage(`window.beforeSecond = true`);
        h.ok(['task', 'note', 'T1', `second update before restoration as ${agent}`]);
        await b.until(`window.beforeSecond !== true && document.readyState === 'complete' && document.querySelector('.conn').dataset.conn === 'live' && window.restorationFrames.length > 0`, 'the second reload before restoring');
        assert.equal(await b.inPage(`document.documentElement.hasAttribute('data-position-restored')`), false, 'the second reload has not restored yet');
        await b.inPage(`window.restorationFrames.splice(0).forEach((callback) => callback(performance.now()))`);
        await b.restored(`window.beforeSecond !== true`, 'the completed restoration');
        assert.deepEqual(await b.inPage(`[document.activeElement === ${control}, ${table}.scrollLeft]`), [true, left], 'the marker follows restored focus and scroll through both reloads');
      });
    }
  });
});

test('the snapshot names no network resource and carries no token or owner forms', (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const page = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  // Allowed: the SVG namespace inside the data: icon, which is a name, not a
  // request, and evidence links, which open only when clicked.
  assert.match(page, /<a href="https:\/\/example\.com\/acme\/demo\/pull\/1#review" rel="noreferrer noopener" target="_blank"(?: data-preserve="[0-9a-f]{64}")?>/);
  const rest = page.replace(/xmlns%3D%22http%3A%2F%2Fwww\.w3\.org%2F2000%2Fsvg%22/g, '').replace(/<a href="https:\/\/[^"]*" rel="noreferrer noopener" target="_blank"(?: data-preserve="[0-9a-f]{64}")?>/g, '<a>');
  assert.doesNotMatch(rest, /\b(?:https?|wss?|ftp):/i, 'no absolute URLs');
  assert.doesNotMatch(rest, /\bsrc=|@import|<link(?![^>]*rel="icon" href="data:)/i, 'no external scripts, styles or images');
  assert.doesNotMatch(rest, /url\((?!#)/i, 'no CSS resources');
  assert.doesNotMatch(page, /<meta name="tower-crane-token"|<form data-api=/, 'the snapshot cannot write');
  assert.match(page, /"live":false/);
  assert.match(page, /Which store\?/);
  assert.match(page, /answer D1 --choice postgres/, 'a snapshot shows the command for what it cannot do');
});

test('the board escapes every text the state holds', (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const sha = h.git(['rev-parse', 'HEAD']).trim();
  h.ok(['ask', '--kind', 'technical', '--question', 'Pick <script>alert(1)</script>?', '--option', '<b>a</b>', '--option', 'b', '--why', 'why <i>', '--blocks', 'T2']);
  h.ok(['msg', '--to', 'owner', '--task', 'T1', 'look <img src=x onerror=alert(1)>', '--agent', 'w-1']);
  h.ok(['evidence', 'T5', '--revision', h.revision('T5'), '--type', 'note', '--ok', '--sha', sha, '--summary', 'note <svg onload=alert(1)>', '--ref', 'https://example.com/x"onmouseover="alert(1)', '--agent', 'rev-2']);
  const page = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  for (const raw of ['<script>alert(1)', '<b>a</b>', 'why <i>', '<img src=x', '<svg onload', '"onmouseover="']) assert.ok(!page.includes(raw), `${raw} is escaped`);
  assert.match(page, /Pick &lt;script&gt;alert\(1\)&lt;\/script&gt;\?/);
  assert.match(page, /look &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page, /href="https:\/\/example\.com\/x&quot;onmouseover=&quot;alert\(1\)"/);
});

test('review gate pips and ledger ignore unspawned and self-review verdicts', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'reads well', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  const sheet = () => fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8').match(/<article id="T1"[\s\S]*?<\/article>/)[0];
  const room = () => fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8').match(/<article class="rv[^"]*" data-key="review-T1"[\s\S]*?<\/article>/)[0];

  for (const agent of ['made-up-reviewer', 'worker']) {
    for (const verdict of ['--ok', '--fail']) {
      h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', verdict, '--sha', sha, '--agent', agent]);
      const page = sheet();
      assert.match(page, /class="pip missing">review not yet run<\/span>/, `${agent} ${verdict} leaves review missing`);
      assert.doesNotMatch(page, /class="pip (?:pass|fail)">review/);
      assert.match(page, /class="nocount">\(does not count: (?:not a spawned reviewer|self-review)\)/);
      assert.match(room(), /No review at this commit yet\./, `the Review room ignores ${agent} ${verdict} too`);
      assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'review').ok, false);
    }
  }

  h.reviewer('T1', 'reviewer', sha);
  for (const [verdict, state, word] of [['--fail', 'fail', 'failed'], ['--ok', 'pass', 'passed']]) {
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', verdict, '--sha', sha, '--agent', 'reviewer']);
    assert.match(sheet(), new RegExp(`class="pip ${state}">review ${word}</span>`));
    assert.match(room(), state === 'pass' ? /Reviewer passed it:/ : /Reviewer sent findings:/);
  }
});

test('accepted task gate pips and ledger stop counting tests after the owner changes mode', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.ok(['project', 'set', '--tests-mode', 'run-only']);
  gateEvidence(h, 'tests', 'checker');
  gateEvidence(h, 'clean', 'checker');
  h.reviewer('T1', 'reviewer', sha);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer']);
  h.ok(['accept', 'T1']);
  const sheet = () => fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8').match(/<article id="T1"[\s\S]*?<\/article>/)[0];
  assert.match(sheet(), /class="pip pass">tests passed<\/span>/);
  assert.doesNotMatch(sheet(), /does not count:/);

  h.ok(['project', 'set', '--tests-mode', 'prove']);
  const shown = h.json(['task', 'show', 'T1']);
  assert.equal(shown.status, 'accepted');
  assert.equal(shown.gates.gates.find((g) => g.type === 'tests').ok, false);
  const stale = sheet();
  assert.match(stale, /class="pip missing">tests not yet run<\/span>/);
  assert.doesNotMatch(stale, /class="pip pass">tests passed<\/span>/);
  assert.match(stale, /class="nocount">\(does not count: tests evidence mode run-only no longer matches prove/);

  gateEvidence(h, 'tests', 'checker');
  const checked = sheet();
  assert.match(checked, /class="pip pass">tests passed<\/span>/);
  assert.equal((checked.match(/does not count: tests evidence mode run-only/g) || []).length, 1, 'older mode stays uncounted after a new matching pass');
});

test('the snapshot opens offline in a browser, with and without scripts, and requests nothing but itself', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const file = pathToFileURL(path.join(h.state, 'sketch.html')).href;
  const b = await openBrowser(t);
  await b.send('Network.enable');
  const shown = (sel) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display !== 'none'`;
  for (const scripts of [false, true]) {
    await b.send('Emulation.setScriptExecutionDisabled', { value: !scripts });
    // A new document each round, so the script setting applies to a fresh load.
    await b.goto('about:blank');
    await b.goto(`${file}#now`);
    assert.deepEqual(await b.inPage(`[${shown('#now')}, ${shown('#plan')}, document.documentElement.classList.contains('js')]`), [true, false, scripts]);
    for (const view of ['review', 'plan', 'history', 'spend']) {
      await b.goto(`${file}#${view}`);
      assert.deepEqual(await b.inPage(`[${shown(`#${view}`)}, ${shown('#now')}]`), [true, false], `${view} opens by its link (scripts ${scripts})`);
    }
    await b.goto(`${file}#T1`);
    assert.equal(await b.inPage(shown('#T1')), true, `a task sheet opens by its link (scripts ${scripts})`);
    assert.match(await b.inPage(`document.querySelector('#T1 .sbody').textContent`), /a retried webhook runs once/);
  }
  const urls = b.seen.filter((m) => m.method === 'Network.requestWillBeSent').map((m) => m.params.request.url);
  assert.ok(urls.length, 'the browser loaded the file');
  assert.deepEqual(urls.filter((u) => !u.startsWith(file.split('#')[0]) && !u.startsWith('data:')), [], 'nothing but the file itself and data: icons');
});

test('the snapshot page timer runs without errors when there is no live source', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const b = await openBrowser(t);
  await b.send('Runtime.enable');
  await b.goto(`${pathToFileURL(path.join(h.state, 'sketch.html')).href}#now`);
  await b.until(`document.documentElement.classList.contains('js')`, 'the snapshot script');
  // Virtual time runs the page's 5 s refresh timer twice without a real wait.
  const expired = b.seen.length;
  await b.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 11000 });
  await waitUntil(() => b.seen.slice(expired).some((m) => m.method === 'Emulation.virtualTimeBudgetExpired'),
    { what: 'virtual time passed', signal: t.signal });
  const thrown = b.seen.filter((m) => m.method === 'Runtime.exceptionThrown').map((m) => m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  assert.deepEqual(thrown, [], 'no uncaught page errors');
});

test('a delayed initial room frame keeps the reader position in the snapshot', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  for (let i = 6; i <= 24; i++) h.ok(['task', 'add', '--title', `Task ${i}`, '--acceptance', 'verified']);
  for (let i = 1; i <= 24; i++) h.ok(['spend', `T${i}`, '--tokens', String(i * 100), '--rung', 'easy']);
  const b = await openBrowser(t);
  await b.send('Page.enable');
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.initialFrames = [];
    window.requestAnimationFrame = (callback) => window.initialFrames.push(callback);
  ` });
  const file = pathToFileURL(path.join(h.state, 'sketch.html')).href;
  const run = `window.initialFrames.splice(0).forEach((callback) => callback(performance.now()))`;
  for (const [room, width] of [['plan', 390], ['spend', 390], ['spend', 1280]]) {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
    for (const phase of ['initial', 'scrolled']) {
      await b.goto('about:blank');
      await b.goto(`${file}#${room}`);
      await b.until(`document.readyState === 'complete' && window.initialFrames.length > 0`, 'the initial frame pending');
      if (phase === 'initial') {
        await b.inPage(run);
        assert.equal(await b.inPage('scrollY'), 0, `an untouched ${room} at ${width} starts at the top`);
        continue;
      }
      // Away from wherever the fragment jump landed, so the frame can tell.
      const jump = await b.inPage('scrollY');
      const read = await b.inPage('window.scrollTo(0, scrollY + 120), scrollY');
      assert.notEqual(read, jump, 'the reader has scrolled before the initial frame runs');
      await b.inPage(run);
      assert.equal(await b.inPage('scrollY'), read, `the delayed initial frame keeps the reader position in ${room} at ${width}`);
    }
  }
});

test('in a browser, JS displays only the routed view by nav and direct hash at desktop and mobile sizes', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  const file = pathToFileURL(path.join(h.state, 'sketch.html')).href;
  const b = await openBrowser(t);
  const views = ['now', 'review', 'plan', 'history', 'spend'];
  const displayedViews = () => b.inPage(`[...document.querySelectorAll('.room')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id)`);
  const assertView = async (view, route, width) => {
    assert.deepEqual(await displayedViews(), [view], `${view} via ${route} at ${width}px`);
  };
  const assertViewWithoutTarget = async (view, route, width) => {
    // Keep the JS route while clearing :target to exercise the fallback's no-target case.
    await b.inPage(`location.hash = ''`);
    await b.until(`location.hash === '' && document.documentElement.dataset.room === ${JSON.stringify(view)}`, `${view} to stay routed after clearing the fragment`);
    const state = await b.inPage(`[location.hash, document.querySelector('.room:target')?.id || null, document.documentElement.dataset.room]`);
    assert.deepEqual(state, ['', null, view], `${view} keeps its JS route after clearing the fragment`);
    await assertView(view, `${route} without :target`, width);
  };

  for (const [width, height] of [[1280, 800], [390, 844]]) {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const view of views) {
      await b.goto(`${file}#${view}`);
      await b.until(`document.documentElement.classList.contains('js') && document.documentElement.dataset.room === ${JSON.stringify(view)}`, `${view} to load with JS`);
      await assertView(view, 'direct hash', width);
      await assertViewWithoutTarget(view, 'direct hash', width);
    }

    // Start on Spend, so every nav click changes the selected route.
    for (const view of views) {
      await b.inPage(`document.querySelector('.rooms a[data-room="${view}"]').click()`);
      await b.until(`document.documentElement.dataset.room === ${JSON.stringify(view)}`, `${view} via nav`);
      await assertView(view, 'nav', width);
      await assertViewWithoutTarget(view, 'nav', width);
    }
  }
});

test('serve sends a submitted or accepted task back for rework only as the owner, through the CLI rework', async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  await withServers(async (servers) => {
    const viewer = await startServe(servers, h, 'viewer');
    const viewerPage = await (await fetch(viewer)).text();
    assert.doesNotMatch(viewerPage, /data-api="\/api\/tasks\/T5\/rework"/, 'no rework form without the owner');
    const before = log(h).length;
    assert.equal((await post(`${viewer}api/tasks/T5/rework`, tokenOf(viewerPage), { reason: 'forged' })).status, 403);

    const url = await startServe(servers, h);
    const page = await (await fetch(keyed(url))).text();
    assert.match(page, /data-api="\/api\/tasks\/T5\/rework"/);
    assert.doesNotMatch(page, /data-api="\/api\/tasks\/T1\/rework"/, 'a claimed task cannot be sent back');
    const token = tokenOf(page);
    assert.equal((await post(`${url}api/tasks/T5/rework`, token, { reason: '' })).status, 400, 'a reason is required');
    assert.equal((await post(`${url}api/tasks/T1/rework`, token, { reason: 'not submitted' })).status, 400, 'the CLI refuses a claimed task');
    assert.equal((await post(`${url}api/decisions/D1/rework`, token, { reason: 'x' })).status, 404, 'decisions have no rework');
    assert.equal(log(h).length, before, 'refused writes record nothing');

    const r = await post(`${url}api/tasks/T5/rework`, token, { reason: 'cover the retry path' });
    assert.equal(r.status, 200, await r.clone().text());
    const t5 = h.readState('tasks.json').tasks.find((x) => x.id === 'T5');
    assert.equal(t5.status, 'rework');
    assert.match(t5.notes[t5.notes.length - 1].text, /^rework: cover the retry path$/);
    const ev = log(h).pop();
    assert.deepEqual([ev.cmd, ev.agent, ev.task, ev.detail.reason], ['rework', 'owner', 'T5', 'cover the retry path']);
  });
});

test('in a browser, Enter in a decision note answers the recommended option and never the first one, and a refusal stays shown', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Store', '--acceptance', 'stored']);
  h.ok(['ask', '--kind', 'technical', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--recommend', 'postgres', '--blocks', 'T1']);
  h.ok(['ask', '--kind', 'technical', '--question', 'Which day?', '--option', 'monday', '--option', 'friday', '--blocks', 'T1']);
  await withServers(async (servers) => {
    const url = await startServe(servers, h);
    const b = await openBrowser(t);
    await b.goto(keyed(url));
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    const enter = async (id, text) => {
      await b.inPage(`document.querySelector('form[data-api="/api/decisions/${id}/answer"] input[name="note"]').focus()`);
      await b.send('Input.insertText', { text });
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
      await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, text: '\r' });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    };
    const before = log(h).length;
    await enter('D2', 'after the load test');
    await new Promise((resolve) => setTimeout(resolve, 800)); // wait-allow: observe that Enter without a recommendation makes no write after browser handlers settle
    assert.equal(h.readState('decisions.json').decisions[1].status, 'open', 'without a recommendation Enter answers nothing');
    assert.equal(log(h).length, before);
    await enter('D1', 'history must survive restarts');
    // D2's typed note holds the queue's redraw, so read the state, not the page.
    await waitOnRepo(h, () => h.readState('decisions.json').decisions[0].status !== 'open', 'the recommended answer');
    const d1 = h.readState('decisions.json').decisions[0];
    assert.deepEqual([d1.status, d1.answer, d1.note], ['answered', 'postgres', 'history must survive restarts']);
    await new Promise((resolve) => setTimeout(resolve, 800)); // wait-allow: verify that the completed answer produces no duplicate form submission
    assert.equal(await b.inPage(`(document.querySelector('form[data-api="/api/decisions/D1/answer"] output') || {}).textContent || ''`), '', 'the form sends once: no second, empty post is refused');

    // A refused write keeps its message through the redraw that follows it,
    // until the form is edited.
    await b.goto(url);
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    const out = `document.querySelector('form[data-api="/api/decisions/D2/answer"] output').textContent`;
    await b.inPage(`(() => { const x = document.querySelector('form[data-api="/api/decisions/D2/answer"] button[value="friday"]'); x.value = 'sunday'; x.click(); })()`);
    await b.until(`/must be one of/.test(${out})`, 'the refusal');
    await new Promise((resolve) => setTimeout(resolve, 2500)); // wait-allow: verify that the refusal remains visible across the scheduled redraw
    assert.match(await b.inPage(out), /must be one of/, 'the refusal is still shown after the redraw');
    await b.inPage(`document.querySelector('form[data-api="/api/decisions/D2/answer"] input[name="note"]').focus()`);
    await b.send('Input.insertText', { text: 'x' });
    assert.equal(await b.inPage(out), '', 'editing the form clears it');
  });
});

test('in a browser, every board write goes through its form: answer, comments, owner-done, rework and tier', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  h.ok(['ask', '--kind', 'technical', '--question', 'How should the worker continue?', '--option', 'redis',
    '--option', 'postgres', '--agent', 'asking-worker']);
  await withServers(async (servers) => {
    const url = await startServe(servers, h);
    const b = await openBrowser(t);
    await b.goto(keyed(url));
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    assert.equal(await b.inPage('location.search'), '', 'the page drops the one-time key from the address bar');
    const events = () => log(h).length;

    // Each form sends once; the answer and its asker message share that write.
    for (const row of [
      { id: 'D1', choice: 'redis', note: '', blocks: ['T4'] },
      { id: 'D2', choice: 'postgres', note: 'Also fix the CI gate before submitting.', blocks: [] },
    ]) {
      const n = events();
      await b.inPage(`(() => {
        const form = document.querySelector('form[data-api="/api/decisions/${row.id}/answer"]');
        form.querySelector('input[name="note"]').value = ${JSON.stringify(row.note)};
        form.querySelector('button[value="${row.choice}"]').click();
      })()`);
      await b.restored(`!document.querySelector('form[data-api="/api/decisions/${row.id}/answer"]')`, 'the answered decision to leave the board');
      const decision = h.readState('decisions.json').decisions.find((d) => d.id === row.id);
      assert.deepEqual([decision.status, decision.answer, decision.answered_by], ['answered', row.choice, 'owner']);
      const written = log(h).slice(n);
      assert.deepEqual(written.map((e) => e.cmd), ['answer', 'msg']);
      assert.deepEqual([written[0].detail.decision, written[0].detail.choice], [row.id, row.choice]);
      const message = written[1];
      assert.deepEqual([message.detail.to, message.detail.decision, message.detail.blocks],
        [decision.asked_by, row.id, row.blocks]);
      assert.ok(message.detail.text.startsWith(`decision ${row.id} answered: ${row.choice}`));
      if (row.note) assert.ok(message.detail.text.endsWith(`\nOrchestrator note:\n${row.note}`));
      else assert.doesNotMatch(message.detail.text, /Orchestrator note:/);
      assert.equal(await b.inPage(`!!document.activeElement.closest('#queue .qi')`), true, 'focus lands on the next queue item');
    }

    // A comment on a task, from its sheet.
    await b.goto(`${url}#T1`);
    await b.inPage(`(() => { const f = document.querySelector('#T1 form[data-api="/api/tasks/T1/comments"]'); f.querySelector('textarea').value = 'please split the API part'; f.querySelector('button[type="submit"]').click(); })()`);
    await b.restored(`[...document.querySelectorAll('#T1 .thread .msg p')].some((p) => p.textContent === 'please split the API part')`, 'the comment in the thread');
    const t1 = h.readState('tasks.json').tasks[0];
    assert.deepEqual([t1.notes.at(-1).agent, t1.notes.at(-1).text], ['owner', 'please split the API part']);

    // Owner-done from the queue item.
    await b.goto(url);
    await b.inPage(`document.querySelector('form[data-api="/api/tasks/T3/owner-done"] button[type="submit"]').click()`);
    await b.restored(`!document.querySelector('form[data-api="/api/tasks/T3/owner-done"]')`, 'the owner task to clear');
    assert.equal(h.readState('tasks.json').tasks[2].needs_owner, null);

    // Rework from the submitted task's sheet.
    await b.goto(`${url}#T5`);
    await b.inPage(`(() => { const f = document.querySelector('#T5 form[data-api="/api/tasks/T5/rework"]'); f.querySelector('textarea').value = 'docs miss the retry header'; f.querySelector('button').click(); })()`);
    await b.restored(`!document.querySelector('#T5 form[data-api="/api/tasks/T5/rework"]')`, 'the rework form to go once the task is in rework');
    assert.equal(h.readState('tasks.json').tasks[4].status, 'rework');

    // Tier from a sheet, with the tier it was based on.
    await b.goto(`${url}#T2`);
    await b.inPage(`(() => { const f = document.querySelector('#T2 form[data-kind="tier"]'); f.querySelector('select').value = 'hard'; f.querySelector('button').click(); })()`);
    await b.restored(`document.querySelector('#T2 form[data-kind="tier"]') && document.querySelector('#T2 form[data-kind="tier"]').dataset.base === 'hard'`, 'the sheet to show the saved tier');
    assert.equal(h.readState('tasks.json').tasks[1].tier, 'hard');
    const tierEvent = log(h).pop();
    assert.deepEqual([tierEvent.cmd, tierEvent.agent, tierEvent.detail.tier, tierEvent.detail.via], ['task update', 'owner', 'hard', 'serve']);

    // A refused write says why in the form and writes nothing.
    h.ok(['task', 'update', 'T2', '--tier', 'easy']);
    let n = events();
    await b.inPage(`(() => { const f = document.querySelector('#T2 form[data-kind="tier"]'); f.dataset.base = 'medium'; f.querySelector('select').value = 'research'; f.querySelector('button').click(); })()`);
    await b.until(`document.querySelector('#T2 form[data-kind="tier"] output.err')`, 'the refusal to show');
    assert.match(await b.inPage(`document.querySelector('#T2 form[data-kind="tier"] output').textContent`), /T2/);
    assert.equal(events(), n);
  });
});

test('in a browser, a change elsewhere updates the board in place and waits while the owner is typing', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  await withServers(async (servers) => {
    const url = await startServe(servers, h);
    const b = await openBrowser(t);
    await b.goto(url);
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    await b.inPage('window.firstLoad = true');

    h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'rebased, CI running', '--agent', 'w-1']);
    await b.restored(`document.querySelector('.agent[data-key="agent-T1"] .last').textContent.startsWith('rebased, CI running')`, 'the row to show the new message');
    assert.equal(await b.inPage('window.firstLoad === true && document.querySelector(\'.agent[data-key="agent-T1"]\').classList.contains(\'changed\')'), true, 'updated in place, and the row marks the change');

    // History keeps its filters across an update.
    await b.inPage(`(() => { location.hash = 'history'; document.getElementById('hf-messages').click(); const q = document.getElementById('hf-task'); q.value = 'T1'; q.dispatchEvent(new Event('input', { bubbles: true })); q.blur(); })()`);
    h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'CI green', '--agent', 'w-1']);
    await b.restored(`document.querySelector('#history').textContent.includes('CI green')`, 'History to show the new message');
    assert.deepEqual(await b.inPage(`[document.getElementById('hf-messages').checked, document.getElementById('hf-task').value, [...document.querySelectorAll('#history .ev')].filter((li) => getComputedStyle(li).display !== 'none' && !li.hidden).every((li) => li.dataset.kind === 'messages' && li.dataset.task === 'T1')]`), [true, 'T1', true]);
    await b.inPage(`location.hash = 'now'`);
    await b.until(`location.pathname === '/' && document.documentElement.dataset.room === 'now'`, 'the fragment to become the path');

    // Typed text holds its band: the owner's draft is never replaced.
    await b.inPage(`(() => { const d = document.querySelector('#queue [data-key="D1"] details.more'); d.open = true; const ta = d.querySelector('textarea'); ta.focus(); })()`);
    await b.type('my draft');
    h.ok(['ask', '--kind', 'technical', '--question', 'Ship on Friday?', '--option', 'yes', '--option', 'no']);
    await b.restored(`document.querySelector('[data-notice]').classList.contains('on')`, 'the waiting notice');
    assert.equal(await b.inPage(`document.querySelector('#queue textarea').value`), 'my draft');
    await b.restored(`document.querySelector('.recent').textContent.includes('Ship on Friday?')`, 'the other bands to update');
    assert.equal(await b.inPage(`document.querySelector('#queue').textContent.includes('Ship on Friday?')`), false, 'the held band has not changed yet');
    await b.inPage(`(() => { const ta = document.querySelector('#queue textarea'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.blur(); })()`);
    await b.restored(`document.querySelector('#queue').textContent.includes('Ship on Friday?')`, 'the held update to apply');
    assert.equal(await b.inPage('window.firstLoad === true'), true, 'still the same page');
  });
});

test('live CLI writes keep Plan, its task sheet, scroll and the focused control on desktop and phone', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  for (let i = 0; i < 8; i++) h.ok(['task', 'add', '--title', `Plan task ${i}`, '--acceptance', 'verified']);
  let dep = 'T2';
  for (let i = 0; i < 4; i++) {
    dep = h.ok(['task', 'add', '--title', `Layer ${i}`, '--acceptance', 'verified', '--dep', dep]).match(/T\d+/)[0];
  }
  await withServers(async (servers) => {
    const url = await startServe(servers, h, 'viewer');
    const b = await openBrowser(t);
    const position = `({ main: [document.querySelector('main').scrollLeft, document.querySelector('main').scrollTop], page: [scrollX, scrollY], graph: [document.querySelector('.plan-wrap').scrollLeft, document.querySelector('.plan-wrap').scrollTop] })`;
    for (const [width, height] of [[1280, 800], [390, 844]]) {
      const link = JSON.stringify(width >= 720 ? '#plan .node[data-id="T1"]' : '#plan .layers [href="#T1"]');
      await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await b.goto(`${url}plan`);
      await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
      await b.inPage(`(() => {
        window.firstLoad = true;
        document.querySelector(${link}).focus({ preventScroll: true });
        document.querySelector('.plan-wrap').scrollLeft = 120;
        document.querySelector('main').scrollTop = 180;
        window.scrollTo(0, 180);
      })()`);
      const plan = await b.inPage(position);
      assert.ok(plan.main[1] > 0 || plan.page[1] > 0, 'the view is scrolled');
      if (width >= 720) assert.ok(plan.graph[0] > 0, 'the graph is scrolled horizontally');
      const update = `place kept at ${width}`;
      h.ok(['task', 'note', 'T1', update, '--agent', 'orchestrator']);
      await b.restored(`document.querySelector('#T1 .thread').textContent.includes(${JSON.stringify(update)})`, 'the live state change');
      assert.deepEqual(await b.inPage(`[location.pathname, document.documentElement.dataset.room, [...document.querySelectorAll('.room')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id), !!document.querySelector('.sheet.open'), window.firstLoad]`), ['/plan', 'plan', ['plan'], false, true]);
      assert.deepEqual(await b.inPage(position), plan, `Plan keeps both scroll axes at ${width}`);
      assert.equal(await b.inPage(`document.activeElement === document.querySelector(${link})`), true, 'the same Plan link keeps focus');

      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await b.until(`document.querySelector('#T1').classList.contains('open')`, 'the task sheet over Plan');
      const background = await b.inPage(position);
      const copy = await b.inPage(`(() => {
        const button = document.querySelector('#T1 .sec:last-child [data-copy]');
        button.focus({ preventScroll: true });
        document.querySelector('#T1 .sbody').scrollTop = 160;
        return button.getAttribute('data-copy');
      })()`);
      const sheetScroll = await b.inPage(`document.querySelector('#T1 .sbody').scrollTop`);
      assert.ok(sheetScroll > 0, 'the task sheet is scrolled');
      h.ok(['task', 'note', 'T1', `${update} with sheet`, '--agent', 'orchestrator']);
      await b.restored(`document.querySelector('#T1 .thread').textContent.includes(${JSON.stringify(`${update} with sheet`)})`, 'the task sheet update');
      assert.deepEqual(await b.inPage(`[location.hash, document.documentElement.dataset.room, document.querySelector('.sheet.open').id, document.querySelector('main').inert, document.querySelector('.bar').inert, [...document.querySelectorAll('.room')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id)]`), ['#T1', 'plan', 'T1', true, true, ['plan']]);
      assert.equal(await b.inPage(`document.activeElement.getAttribute('data-copy')`), copy, 'the same sheet button keeps focus');
      assert.equal(await b.inPage(`document.querySelector('#T1 .sbody').scrollTop`), sheetScroll, 'the sheet keeps its scroll');
      assert.deepEqual(await b.inPage(position), background, 'the background keeps its scroll');
      await b.inPage(`document.querySelector('#T1 [data-close]').click()`);
      await b.until(`!document.querySelector('.sheet.open')`, 'the sheet to close');
      assert.deepEqual(await b.inPage(`[location.pathname + location.hash, document.documentElement.dataset.room, document.activeElement === document.querySelector(${link})]`), ['/plan', 'plan', true]);
      assert.deepEqual(await b.inPage(position), background, 'closing the sheet returns to the same place in Plan');
    }
  });
});

test('live CLI writes keep Settings and Spend focus and table scroll at 390px', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const b = await openBrowser(t);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  for (const [view, agent] of [['settings', 'owner'], ['settings', 'viewer'], ['spend', 'viewer']]) {
    await t.test(`${view} as ${agent}`, async (t) => {
      const h = makeRepo(t);
      h.init();
      h.ok(['task', 'add', '--title', 'A task with usage and a long title to make its table scroll horizontally', '--acceptance', 'verified']);
      h.ok(['spend', 'T1', '--tokens', '200', '--minutes', '12', '--rung', 'easy', '--model', 'provider/a-model-with-a-long-name-for-the-model-usage-table']);
      await withServers(async (servers) => {
        const url = await startServe(servers, h, agent);
        const page = `${url}${view}`;
        await b.goto(page);
        await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
        const selector = JSON.stringify(view === 'settings' ? 'main .panel' : '#spend .tbl-wrap');
        const focused = JSON.stringify(view === 'spend' ? '#spend .tbl [href="#T1"]' : agent === 'owner' ? 'tr[data-rung="easy"] input[name="model"]' : '.rooms a[data-room="settings"]');
        const position = `({ page: [scrollX, scrollY], main: [document.querySelector('main').scrollLeft, document.querySelector('main').scrollTop], tables: [...document.querySelectorAll(${selector})].map((el) => [el.scrollLeft, el.scrollTop]) })`;
        await b.inPage(`(() => {
          window.firstLoad = true;
          document.querySelector(${focused}).focus({ preventScroll: true });
          [...document.querySelectorAll(${selector})].forEach((el, i) => { el.scrollLeft = 100 + i * 25; });
          window.scrollTo(0, 200);
        })()`);
        const before = await b.inPage(position);
        assert.ok(before.tables.some(([x]) => x > 0), 'a table is scrolled horizontally');
        if (view === 'spend') assert.ok(new Set(before.tables.filter(([x]) => x > 0).map(([x]) => x)).size > 1, 'separate tables have distinct horizontal positions');
        const update = `${view} stays put as ${agent}`;
        h.ok(['task', 'note', 'T1', update]);
        await b.restored(view === 'settings' ? `window.firstLoad !== true && document.readyState === 'complete' && document.querySelector('.conn').dataset.conn === 'live'` : `document.querySelector('#T1 .thread').textContent.includes(${JSON.stringify(update)})`, 'the live update');
        assert.equal(await b.inPage('location.href'), page, 'the current route stays');
        assert.deepEqual(await b.inPage(`[document.activeElement === document.querySelector(${focused}), ${position}]`), [true, before], 'focus and all scroll offsets stay on the same controls and containers');
      });
    });
  }
});

test('every view keeps disclosures, event identity, focus and scroll through live CLI updates', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  for (let i = 6; i <= 24; i++) h.ok(['task', 'add', '--title', `Task ${i}`, '--acceptance', 'verified']);
  for (let i = 1; i <= 24; i++) h.ok(['spend', `T${i}`, '--tokens', String((25 - i) * 100), '--rung', 'easy']);
  await withServers(async (servers) => {
    const owner = await startServe(servers, h);
    const viewer = await startServe(servers, h, 'viewer');
    const b = await openBrowser(t);
    await b.send('Page.enable');
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      if (location.pathname.endsWith('/settings')) {
        const frame = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) => setTimeout(() => frame(callback), 300); // wait-allow: delay the injected animation frame to exercise restoration before paint
      }
    ` });
    for (const width of [1280, 390]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
      for (const view of ['now', 'review', 'plan', 'history', 'spend', 'sheet', 'settings', 'settings-viewer']) {
        await t.test(`${view} at ${width}px`, async () => {
          await b.goto('about:blank');
          const settings = view.startsWith('settings');
          const eventView = view === 'now' || view === 'history';
          const seed = `original event for ${view} at ${width}`;
          h.ok(['task', 'note', 'T1', seed]);
          const url = view === 'settings-viewer' ? `${viewer}settings` : settings ? `${owner}settings` : view === 'sheet' ? `${owner}#T5` : view === 'now' ? owner : `${owner}${view}`;
          await b.goto(url);
          await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
          if (!settings) await b.until(`document.querySelector('#T1 .thread').textContent.includes(${JSON.stringify(seed)})`, 'the initial note');
          const scope = settings ? 'main.settings' : view === 'sheet' ? '#T5' : `#${view}`;
          const spendTask = width === 1280 ? 'T24' : 'T23';
          const focus = view === 'now' ? '.recent .ev a[href="#T1"]'
            : view === 'review' ? '#review [href="#T5"]'
            : view === 'history' ? '#history .ev a[href="#T1"]'
            : view === 'plan' ? width === 1280 ? '#plan .node[data-id="T1"]' : '#plan .layers a[href="#T1"]'
            : view === 'spend' ? `#spend details a[href="#${spendTask}"]`
            : view === 'sheet' ? '#T5 .ledger details > summary'
            : view === 'settings' ? 'tr[data-rung="easy"] input[name="model"]'
            : '.rooms a[data-room="settings"]';
          const selector = JSON.stringify(focus);
          await b.inPage(`(() => {
            window.firstLoad = true;
            // At tab widths, Recent sits behind its tab under the floor.
            if (${JSON.stringify(view)} === 'now') document.querySelector('#tab-recent')?.click();
            const scope = document.querySelector(${JSON.stringify(scope)});
            [...scope.querySelectorAll('details')].forEach((el, i) => { el.open = i % 2 === 0; });
            if (${JSON.stringify(view)} === 'sheet') scope.querySelector('.ledger details').open = false;
            if (${JSON.stringify(view)} === 'spend') scope.querySelector('details').open = true;
            document.querySelector(${selector}).focus({ preventScroll: true });
            [scope, ...scope.querySelectorAll('*'), document.querySelector('.rooms'), document.querySelector('main')].forEach((el) => {
              if (/auto|scroll/.test(getComputedStyle(el).overflow)) { el.scrollLeft = 70; el.scrollTop = 90; }
            });
            window.scrollTo(0, 120);
          })()`);
          const snapshot = `(() => {
            const scope = document.querySelector(${JSON.stringify(scope)});
            return {
              disclosures: [...scope.querySelectorAll('details')].map((el) => [el.querySelector('summary').textContent, el.open]),
              scroll: [scope, ...scope.querySelectorAll('*'), document.querySelector('.rooms'), document.querySelector('main')].filter((el) => /auto|scroll/.test(getComputedStyle(el).overflow)).map((el) => [el.scrollLeft, el.scrollTop]),
              page: [scrollX, scrollY]
            };
          })()`;
          const before = await b.inPage(snapshot);
          const event = eventView ? await b.inPage(`document.activeElement.closest('.ev').querySelector('.txt').textContent`) : null;
          const update = `update for ${view} at ${width}`;
          h.ok(['task', 'note', 'T1', update]);
          await b.restored(settings ? `window.firstLoad !== true && document.readyState === 'complete' && document.querySelector('.conn').dataset.conn === 'live'` : `document.querySelector('#T1 .thread').textContent.includes(${JSON.stringify(update)})`, 'the live update');
          assert.equal(await b.inPage('location.href'), url, 'the route stays');
          if (eventView) {
            assert.equal(await b.inPage(`document.activeElement.closest('.ev')?.querySelector('.txt').textContent`), event, 'focus remains in the original event row');
          } else {
            assert.equal(await b.inPage(`document.activeElement === document.querySelector(${selector})`), true, 'the exact control keeps focus');
          }
          assert.deepEqual(await b.inPage(snapshot), before, 'open and closed disclosures and every scroll offset stay');
          assert.deepEqual(await b.inPage(`(() => {
            const scope = document.querySelector(${JSON.stringify(scope)});
            const elements = [scope, ...scope.querySelectorAll('*'), document.querySelector('.rooms'), document.querySelector('main')];
            const restored = [...new Set(elements)].filter((el) => el.matches('a, button, input, textarea, select, summary, details, [tabindex]') || /auto|scroll/.test(getComputedStyle(el).overflow));
            const keys = restored.map((el) => el.dataset.preserve);
            return [keys.every((key) => /^[0-9a-f]{64}$/.test(key)), new Set(keys).size === keys.length];
          })()`), [true, true], 'every restored control, disclosure and scroll container has a unique server identity');
          if (view === 'spend') {
            h.ok(['spend', spendTask, '--tokens', '10000', '--rung', 'easy']);
            await b.restored(`document.querySelector('#spend a[href="#${spendTask}"]') && !document.querySelector('#spend details a[href="#${spendTask}"]')`, 'the focused task to move out of the disclosure');
            assert.deepEqual(await b.inPage(`[document.activeElement.getAttribute('href'), document.querySelector('#spend details').open]`), [`#${spendTask}`, true], 'the same task action keeps focus after its row changes rank');
          }
          if (view === 'now') {
            const task = width === 1280 ? 'T6' : 'T7';
            await b.inPage(`(() => { document.querySelector('#tab-next')?.click(); document.querySelector('#p-next a[href="#${task}"]').focus({ preventScroll: true }); })()`);
            h.ok(['claim', task, '--agent', `moving-${width}`]);
            await b.restored(`document.querySelector('.floor [data-key="agent-${task}"]')`, 'the task to move to the floor');
            assert.equal(await b.inPage(`document.activeElement === document.querySelector('.floor a[href="#${task}"]')`), true, 'the same task action keeps focus after moving between bands');
          }
        });
      }
    }
  });
});

test('Spend keeps focus when a task drops into its closed more-tasks disclosure', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const b = await openBrowser(t);
  for (const width of [1280, 390]) {
    await t.test(`${width}px`, async (t) => {
      const h = makeRepo(t);
      h.init();
      for (let i = 1; i <= 21; i++) {
        h.ok(['task', 'add', '--title', `Task ${i}`, '--acceptance', 'verified']);
        h.ok(['spend', `T${i}`, '--tokens', String(22 - i), '--rung', 'easy']);
      }
      await withServers(async (servers) => {
        const url = await startServe(servers, h, 'viewer');
        await b.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
        await b.goto(`${url}spend`);
        await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
        await b.inPage(`document.querySelector('#spend .tbl a[href="#T20"]').focus({ preventScroll: true })`);
        assert.deepEqual(await b.inPage(`[document.activeElement.getAttribute('href'), !!document.activeElement.closest('details'), document.querySelector('#spend details').open]`), ['#T20', false, false], 'T20 starts focused in a visible row with more tasks closed');
        h.ok(['spend', 'T21', '--tokens', '1000', '--rung', 'easy']);
        await b.restored(`document.querySelector('#spend details a[href="#T20"]')`, 'T20 to drop below the cutoff');
        assert.deepEqual(await b.inPage(`[location.pathname, document.activeElement.getAttribute('href'), document.querySelector('#spend details').open]`), ['/spend', '#T20', true], 'restoration reveals the surviving focused task');
        h.ok(['task', 'note', 'T20', `focus stays reachable at ${width}`]);
        await b.restored(`document.querySelector('#T20 .thread').textContent.includes('focus stays reachable at ${width}')`, 'the following live update');
        assert.deepEqual(await b.inPage(`[document.activeElement.getAttribute('href'), document.querySelector('#spend details').open]`), ['#T20', true], 'the opened disclosure remains preserved on the next update');
      });
    });
  }
});

test('shared restoration reveals nested disclosures and falls back to a visible ancestor control', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const b = await openBrowser(t);
  await b.goto('about:blank');
  const markup = preserve('<main id="ancestor" tabindex="-1"><div id="nearest" tabindex="-1"><button id="focused">Focus</button></div><details id="outer"><summary>Outer</summary><details id="inner"><summary>Inner</summary></details></details></main><h2 id="fallback" tabindex="-1">Fallback</h2>');
  for (const change of ['nested', 'disabled', 'hidden', 'hidden-parent', 'fallback']) {
    await b.inPage(`(() => {
      document.body.innerHTML = ${JSON.stringify(markup)};
      window.position = ${POSITION};
      document.getElementById('focused').focus();
      window.saved = position.capture(document);
      const control = document.getElementById('focused');
      if (${JSON.stringify(change)} === 'nested') document.getElementById('inner').appendChild(control);
      if (${JSON.stringify(change)} === 'disabled') control.disabled = true;
      if (${JSON.stringify(change)} === 'hidden') control.hidden = true;
      if (${JSON.stringify(change)} === 'hidden-parent') document.getElementById('nearest').style.visibility = 'hidden';
      if (${JSON.stringify(change)} === 'fallback') {
        control.hidden = true;
        document.getElementById('nearest').removeAttribute('tabindex');
        document.getElementById('ancestor').removeAttribute('tabindex');
      }
      position.restore(document, saved, document.getElementById('fallback'));
    })()`);
    if (change === 'nested') {
      assert.deepEqual(await b.inPage(`[document.activeElement.id, document.getElementById('outer').open, document.getElementById('inner').open, saved.disclosures[position.key(document.getElementById('outer'))], saved.disclosures[position.key(document.getElementById('inner'))]]`), ['focused', true, true, true, true], 'all containing disclosures open in the DOM and snapshot');
      await b.inPage('position.restore(document, saved)');
      assert.deepEqual(await b.inPage(`[document.activeElement.id, document.getElementById('outer').open, document.getElementById('inner').open]`), ['focused', true, true], 'reusing the snapshot keeps the focused contents reachable');
    } else {
      assert.equal(await b.inPage('document.activeElement.id'), change === 'fallback' ? 'fallback' : change === 'hidden-parent' ? 'ancestor' : 'nearest', `${change} falls back to the closest visible control or explicit fallback`);
    }
  }
});

test('live updates match task sheet buttons by form and fall back when the focused action is removed', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const b = await openBrowser(t);
  for (const action of ['comments', 'owner-done']) {
    await t.test(action === 'comments' ? 'the focused button survives a removed sibling form' : 'the removed focused button falls back to the heading', async (t) => {
      const h = makeRepo(t);
      h.init();
      h.ok(['task', 'add', '--title', 'Dashboard access', '--acceptance', 'access granted', '--needs-owner', 'grant dashboard access']);
      await withServers(async (servers) => {
        const url = await startServe(servers, h);
        await b.goto(`${keyed(url)}#T1`);
        await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
        const button = JSON.stringify(`#T1 form[data-api="/api/tasks/T1/${action}"] button[type="submit"]`);
        await b.inPage(`document.querySelector(${button}).focus({ preventScroll: true })`);
        assert.equal(await b.inPage(`document.activeElement === document.querySelector(${button})`), true, 'the action starts focused');

        h.ok(['owner-done', 'T1', '--note', 'access granted']);
        await b.restored(`!document.querySelector('#T1 form[data-api="/api/tasks/T1/owner-done"]')`, 'the owner-done form to be removed by the live update');
        assert.deepEqual(await b.inPage(`[location.hash, document.querySelector('.sheet.open').id]`), ['#T1', 'T1'], 'the task sheet stays open');
        const expected = action === 'comments' ? button : JSON.stringify('#T1 h2');
        assert.equal(await b.inPage(`document.activeElement === document.querySelector(${expected})`), true, action === 'comments' ? 'Send comment keeps focus when Mark done disappears' : 'focus moves to the heading when Mark done disappears');
      });
    });
  }
});

test('a viewer cannot edit tiers or the ladder from a sheet, Settings or a forged POST', async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  await withServers(async (servers) => {
    const url = await startServe(servers, h, 'viewer');
    const page = await (await fetch(url)).text();
    const settings = await (await fetch(`${url}settings`)).text();
    assert.doesNotMatch(page, /<form data-api=/, 'viewer sheets and queue are read-only');
    assert.doesNotMatch(settings, /<form|<input|<select|Save ladder|Save tiers/, 'viewer Settings shows values without edit controls');
    assert.match(settings, /Read-only/);
    assert.match(settings, /<code>tower-crane serve --agent owner<\/code>/, 'Settings names the explicit owner command');
    const before = log(h);
    const tasks = h.readState('tasks.json');
    const project = h.readState('project.json');
    const token = tokenOf(page);
    for (const [api, body] of [
      ['tiers', { tiers: { T1: 'hard' }, base: { T1: 'medium' } }],
      ['ladder', { harness: 'claude', base: { harness: 'codex' } }],
    ]) {
      const r = await post(`${url}api/${api}`, token, body);
      assert.equal(r.status, 403, `${api} requires the owner even with this server's token`);
      assert.match((await r.json()).error, /owner/);
    }
    assert.deepEqual(h.readState('tasks.json'), tasks);
    assert.deepEqual(h.readState('project.json'), project);
    assert.deepEqual(log(h), before, 'refusals append no events');
  });
});

test('the floor uses only the current claimant and claim, then Review shows the submitter context', (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const page = () => fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  const card = () => (page().match(/<article class="agent[^"]*" data-key="agent-T1"[\s\S]*?<\/article>/) || page().match(/<article class="rv[^"]*" data-key="review-T1"[\s\S]*?<\/article>/))[0];
  h.ok(['task', 'note', 'T1', 'orchestrator planning note', '--agent', 'orchestrator']);
  assert.match(card(), /tests green, waiting on CI/);
  assert.doesNotMatch(card(), /orchestrator planning note/);
  h.ok(['release', 'T1', '--reason', 'handoff', '--agent', 'w-1']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  assert.doesNotMatch(card(), /tests green, waiting on CI|orchestrator planning note/, 'a renewed claim by the same worker does not reuse its older message');
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'new claim work', '--agent', 'w-1']);
  h.ok(['task', 'note', 'T1', 'reviewer context', '--agent', 'reviewer']);
  assert.match(card(), /new claim work/);
  assert.doesNotMatch(card(), /reviewer context/);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--summary', 'retry verified', '--agent', 'w-1']);
  h.ok(['task', 'note', 'T1', 'review in progress', '--agent', 'reviewer']);
  assert.match(card(), /retry verified/);
  assert.doesNotMatch(card(), /review in progress/);
});

test('a budget at 90% is a Now item in words, with minutes for hours', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Usage', '--acceptance', 'usage is reported']);
  h.ok(['project', 'set', '--budget-tokens', '100', '--budget-hours', '1']);
  h.ok(['spend', 'T1', '--tokens', '95', '--minutes', '57', '--agent', 'w-1']);
  const page = () => fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  const items = page().match(/<li class="qi" data-tier="now" data-kind="budget" data-key="budget-[\s\S]*?<\/li>/g);
  assert.equal(items.length, 2);
  assert.match(items[0], /<h3 class="q">Token budget at 95%<\/h3>/);
  assert.match(items[0], /95 used of 100/);
  assert.match(items[1], /<h3 class="q">Hours budget at 95%<\/h3>/);
  assert.match(items[1], /57 min used of 1 h/);
  for (const item of items) assert.match(item, /<span class="tier">.*Now<\/span>/, 'the tier is a word, not only a hue');
  h.ok(['project', 'set', '--budget-hours', '2']);
  h.ok(['spend', 'T1', '--minutes', '57', '--agent', 'w-1']);
  assert.match(page(), /1 h 54 min used of 2 h/);
});

test('budget-only attention agrees across the queue, navigation, title and icon, including live changes', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Usage', '--acceptance', 'usage is reported']);
  h.ok(['project', 'set', '--budget-tokens', '100', '--budget-hours', '1']);
  await withServers(async (servers) => {
    const url = await startServe(servers, h, 'viewer');
    const b = await openBrowser(t);
    await b.goto(url);
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    const originalIcon = await b.inPage(`document.querySelector('link[rel="icon"]').href`);
    h.ok(['spend', 'T1', '--tokens', '95', '--minutes', '57', '--agent', 'w-1']);
    await b.restored(`document.querySelector('#queue').textContent.includes('Token budget at 95%')`, 'budget alerts');
    const counts = await b.inPage(`[document.querySelector('#h-queue .count').textContent, document.querySelector('.rooms a[data-room="now"] .count').textContent, document.title.split(' ')[0], document.querySelector('h1[data-status]').textContent]`);
    assert.deepEqual(counts.slice(0, 3), ['2', '2', '2']);
    assert.match(counts[3], /2 need you \(2 now\)/, 'the status sentence leads with the same count');
    assert.notEqual(await b.inPage(`document.querySelector('link[rel="icon"]').href`), originalIcon);
    const snapshot = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
    assert.match(snapshot, /<title>2 need you · 0 working/);
    assert.match(snapshot, /"attention":2/);
    assert.match(snapshot, /aria-label="2 need you">2/);
  });
});

test('the front room scrolls as one page at every size, with no nested scroll area, and keeps it on live updates', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init(['--workers', '12']);
  populate(h);
  for (let i = 0; i < 8; i++) {
    h.ok(['ask', '--kind', 'technical', '--question', `Owner decision ${i}`, '--option', 'yes', '--option', 'no']);
    const id = h.ok(['task', 'add', '--title', `Worker task ${i}`, '--acceptance', 'verified']).match(/T\d+/)[0];
    h.ok(['claim', id, '--agent', `worker-${i}`]);
    h.ok(['msg', '--task', id, '--to', 'orchestrator', 'checking the retry contract and integration paths', '--agent', `worker-${i}`]);
  }
  await withServers(async (servers) => {
    const url = await startServe(servers, h, 'viewer');
    const b = await openBrowser(t);
    for (const [width, height] of [[3840, 1080], [1920, 1080], [1280, 800], [390, 844]]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await b.goto(url);
      await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
      const nested = await b.inPage(`[...document.querySelectorAll('#now *')].filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1).length`);
      assert.equal(nested, 0, `no nested vertical scroll area at ${width}`);
      assert.equal(await b.inPage(`document.documentElement.scrollWidth <= innerWidth`), true, `no horizontal page scroll at ${width}`);
      await b.inPage(`window.scrollTo(0, 400)`);
      const y = await b.inPage('scrollY');
      assert.ok(y > 0, `the page scrolls at ${width}`);
      h.ok(['task', 'note', 'T2', `update at ${width}`, '--agent', 'orchestrator']);
      await b.restored(`document.querySelector('.recent').textContent.includes('update at ${width}')`, 'the live update');
      assert.equal(await b.inPage('scrollY'), y, `the page keeps its scroll at ${width}`);
    }
  });
});

test('task sheets contain keyboard focus, restore the invoking link and keep modal state through refresh', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  await withServers(async (servers) => {
    const url = await startServe(servers, h, 'viewer');
    const b = await openBrowser(t);
    await b.goto(url);
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    // Use the link on the floor, not the first T1 link in another band.
    await b.inPage(`(() => { const a = document.querySelector('.floor [href="#T1"]'); a.focus(); a.click(); })()`);
    await b.until(`document.querySelector('#T1').classList.contains('open')`, 'the sheet');
    assert.equal(await b.inPage(`document.querySelector('#T1 .panel').getAttribute('aria-modal')`), 'true');
    assert.equal(await b.inPage(`document.querySelector('main').inert && document.querySelector('.bar').inert`), true);
    const tab = async (shift = false) => {
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 });
    };
    for (let i = 0; i < 12; i++) {
      await tab(i % 2 === 0);
      assert.equal(await b.inPage(`document.querySelector('#T1 .panel').contains(document.activeElement)`), true, 'Tab stays in the sheet');
    }
    h.ok(['msg', '--task', 'T1', '--to', 'orchestrator', 'modal refresh', '--agent', 'w-1']);
    await b.restored(`document.querySelector('#T1 .thread').textContent.includes('modal refresh')`, 'the sheet refresh');
    assert.equal(await b.inPage(`document.querySelector('main').inert && document.querySelector('.bar').inert && document.querySelector('#T1 .panel').contains(document.activeElement)`), true);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await b.until(`!document.querySelector('.sheet.open')`, 'sheet close');
    assert.equal(await b.inPage(`document.activeElement === document.querySelector('.floor [href="#T1"]') && !document.querySelector('main').inert && !document.querySelector('.bar').inert`), true, 'focus returns to the same invoking row, even when refreshed');

    h.ok(['ask', '--kind', 'technical', '--question', 'Another decision for Metrics?', '--option', 'yes', '--option', 'no', '--blocks', 'T4']);
    await b.restored(`document.querySelector('#queue [data-key="D2"]')`, 'the second decision');
    await b.inPage(`(() => { const a = document.querySelector('#queue [data-key="D2"] [href="#T4"]'); a.focus(); a.click(); })()`);
    await b.until(`document.querySelector('#T4').classList.contains('open')`, 'the Metrics sheet');
    h.ok(['task', 'note', 'T4', 'receipt available', '--agent', 'reviewer']);
    await b.restored(`document.querySelector('#T4 .thread').textContent.includes('receipt available')`, 'the sheet refresh');
    await b.inPage(`document.querySelector('#T4 [data-close]').click()`);
    await b.until(`!document.querySelector('.sheet.open')`, 'sheet close');
    assert.equal(await b.inPage(`document.activeElement === document.querySelector('#queue [data-key="D2"] [href="#T4"]')`), true, 'duplicate task links in one band return to the invoking decision, not its first neighbor');
  });
});

test('phone gates keep whole names and states in both themes without horizontal overflow', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'w-1']);
  const b = await openBrowser(t);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false });
  for (const theme of ['light', 'dark']) {
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await b.goto(`${pathToFileURL(path.join(h.state, 'sketch.html')).href}#T1`);
    const gates = await b.inPage(`(() => { const list = document.querySelector('#T1 .receipts'); return { fits: list.getBoundingClientRect().right <= innerWidth && list.scrollWidth <= list.clientWidth, cells: [...list.querySelectorAll('.pip')].map((c) => { const range = document.createRange(); range.selectNodeContents(c); return [c.textContent, range.getClientRects().length]; }) }; })()`);
    assert.equal(gates.fits, true, `gates fit in ${theme}`);
    for (const [label, lines] of gates.cells) assert.equal(lines, 1, `${label} stays whole in ${theme}`);
  }
});

test('each room has its own path, and the URL decides the room over anything remembered', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  await withServers(async (servers) => {
    const url = await startServe(servers, h);
    for (const room of ['review', 'plan', 'spend', 'history']) assert.equal((await fetch(`${url}${room}`)).status, 200, `/${room} is served`);
    assert.equal((await fetch(`${url}nowhere`)).status, 404);
    const b = await openBrowser(t);
    const shown = () => b.inPage(`[location.pathname, [...document.querySelectorAll('.room')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id), document.querySelector('.rooms a[aria-current="page"]').dataset.room]`);
    await b.goto(`${url}plan`);
    assert.deepEqual(await shown(), ['/plan', ['plan'], 'plan'], 'a path opens its room');
    // An old fragment link names a room too, and becomes its path.
    await b.send('Page.navigate', { url: `${url}#review` });
    await b.until(`location.pathname === '/review' && document.readyState === 'complete'`, 'the fragment to become a path');
    assert.deepEqual(await shown(), ['/review', ['review'], 'review']);
    await b.goto(`${url}history#T1`);
    assert.deepEqual(await shown(), ['/history', ['history'], 'history'], 'a sheet opens over the room its path names');
    assert.equal(await b.inPage(`document.querySelector('.sheet.open').id`), 'T1');
    // From Settings, a separate page, the nav link goes to the room it names.
    await b.goto(`${url}settings`);
    await b.inPage(`document.querySelector('.rooms a[data-room="plan"]').click()`);
    await b.until(`location.pathname === '/plan' && document.readyState === 'complete' && document.documentElement.classList.contains('js')`, 'Plan from Settings');
    assert.deepEqual(await shown(), ['/plan', ['plan'], 'plan']);
    // Back and forward follow the path.
    await b.inPage(`document.querySelector('.rooms a[data-room="spend"]').click()`);
    await b.until(`location.pathname === '/spend'`, 'Spend by nav');
    await b.inPage('history.back()');
    await b.until(`location.pathname === '/plan' && document.documentElement.dataset.room === 'plan'`, 'back to Plan');
    assert.deepEqual(await shown(), ['/plan', ['plan'], 'plan']);
  });
});

test('only the routed room is displayed after a sheet opens inside it and after a live update', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  await withServers(async (servers) => {
    const url = await startServe(servers, h, 'viewer');
    const b = await openBrowser(t);
    const shown = () => b.inPage(`[...document.querySelectorAll('.room')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id)`);
    for (const [width, height] of [[1280, 800], [390, 844]]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      for (const room of ['now', 'review', 'plan', 'spend', 'history']) {
        await b.goto(room === 'now' ? url : `${url}${room}`);
        await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
        const link = await b.inPage(`(() => { const a = [...document.querySelectorAll('#${room} a[href^="#T"]')].find((x) => x.getClientRects().length); if (a) location.hash = a.getAttribute('href'); return !!a; })()`);
        if (link) {
          await b.until(`!!document.querySelector('.sheet.open')`, 'a sheet from inside the room');
          assert.deepEqual(await shown(), [room], `${room} under its sheet at ${width}`);
          await b.inPage(`document.querySelector('.sheet.open [data-close]').click()`);
          await b.until(`!document.querySelector('.sheet.open')`, 'the sheet to close');
        }
        h.ok(['task', 'note', 'T1', `live in ${room} at ${width}`, '--agent', 'orchestrator']);
        await b.restored(`document.querySelector('#T1 .thread').textContent.includes(${JSON.stringify(`live in ${room} at ${width}`)})`, 'the live update');
        assert.deepEqual(await shown(), [room], `${room} after a live update at ${width}`);
        assert.equal(await b.inPage(`document.querySelector('#${room}').getBoundingClientRect().top < innerHeight`), true, `${room} starts in the first viewport`);
      }
    }
  });
});

test('in a browser, opening Message on an agent row puts the cursor in its field and Enter sends it', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  await withServers(async (servers) => {
    const url = await startServe(servers, h);
    const b = await openBrowser(t);
    await b.goto(keyed(url));
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    const { x, y } = await b.call((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, '[data-key="agent-T1"] details.act-message > summary');
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await b.until(`document.activeElement && document.activeElement.matches('[data-key="agent-T1"] form[data-api="/api/tasks/T1/message"] input[name="text"]')`, 'the message field to take focus');
    await b.type('split the API part first');
    // keyDown with text is a real Enter: its keypress submits the form the way
    // the browser does, with no page handler of the board's own.
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    const msg = await waitOnRepo(h, () => log(h).find((e) => e.cmd === 'msg' && e.agent === 'owner'), 'Enter sent the message');
    assert.ok(msg, 'Enter sent the message');
    assert.deepEqual([msg.task, msg.detail.to, msg.detail.text], ['T1', 'w-1', 'split the API part first']);
  });
});

test('in a browser, Pause in the header pauses dispatch through the controls API, the sentence leads with it, and Resume clears it', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  h.ok(['task', 'add', '--title', 'Changelog', '--acceptance', 'the release notes list it']);
  await withServers(async (servers) => {
    const url = await startServe(servers, h);
    const b = await openBrowser(t);
    await b.goto(keyed(url));
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    const { x, y } = await b.call((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, '.lead details.act-pause > summary');
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await b.until(`document.activeElement && document.activeElement.matches('.lead form[data-kind="control"] input[name="paused"]')`, 'the reason field to take focus');
    await b.type('owner is inspecting the run');
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    await b.until(`/^Paused: owner is inspecting the run/.test(document.title) && !!document.querySelector('.lead [data-pause="paused"]')`, 'the paused sentence');
    assert.equal(h.readState('project.json').limits.paused, 'owner is inspecting the run');
    const audit = log(h).findLast((e) => e.cmd === 'setting');
    assert.deepEqual([audit.detail.command, audit.detail.actor, audit.detail.mode, Object.keys(audit.detail.settings)], ['project set', 'owner', 'board', ['limits.paused']]);
    assert.match(await b.inPage(`document.querySelector('h1.sentence').textContent`), /^.*Paused: owner is inspecting the run.*still working/);
    assert.match(await b.inPage(`document.querySelector('.lead [data-pause]').textContent`), /Paused by owner, (now|\d+ \w+ ago)\. New work waits/);
    // The pause is said once: ready work stays ready, held by it, and no
    // blocked row repeats it as its own reason.
    const next = await b.inPage(`document.querySelector('[data-region="next"]').textContent`);
    assert.doesNotMatch(next, /project paused/);
    assert.match(next, /Ready \d+, held by the pause/);
    await b.inPage(`document.querySelector('.lead [data-pause] button[type="submit"]').click()`);
    await b.until(`!document.querySelector('.lead [data-pause="paused"]') && !/^Paused/.test(document.title)`, 'dispatch resumed');
    assert.equal(h.readState('project.json').limits.paused, undefined);
  });
  // The snapshot says it too, with the command that resumes.
  h.ok(['project', 'set', '--paused', 'release freeze']);
  const html = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  assert.match(html, /<title>Paused: release freeze · /);
  assert.match(html, /data-pause="paused"[\s\S]*?project set --paused &#39;&#39; --agent owner/);
});

test('serve messages the claimant and stops a task only as the owner, through msg and interrupt', async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  assert.notEqual(h.run(['interrupt', 'T1', '--needs-owner', ' ']).code, 0, 'a hold needs a reason');
  await withServers(async (servers) => {
    const viewer = await startServe(servers, h, 'viewer');
    const viewerPage = await (await fetch(viewer)).text();
    assert.doesNotMatch(viewerPage, /data-api="\/api\/tasks\/T1\/(message|stop)"/, 'no message or stop form without the owner');
    assert.equal((await post(`${viewer}api/tasks/T1/message`, tokenOf(viewerPage), { text: 'forged' })).status, 403);
    assert.equal((await post(`${viewer}api/tasks/T1/stop`, tokenOf(viewerPage), {})).status, 403);
    const url = await startServe(servers, h);
    const before = log(h).length;
    const unkeyed = tokenOf(await (await fetch(url)).text());
    assert.equal(unkeyed, '', 'a page opened without the one-time link carries no token');
    assert.equal((await post(`${url}api/tasks/T1/message`, unkeyed, { text: 'forged' })).status, 403);
    assert.equal((await post(`${url}api/tasks/T1/stop`, unkeyed, {})).status, 403);
    const page = await (await fetch(keyed(url))).text();
    assert.match(page, /data-api="\/api\/tasks\/T1\/message"/, 'the claimed task offers a message on its row');
    const token = tokenOf(page);
    assert.equal((await post(`${url}api/tasks/T4/message`, token, { text: 'nobody holds T4' })).status, 400, 'an unclaimed task has nobody to message');
    assert.equal((await post(`${url}api/tasks/T4/stop`, token, {})).status, 400, 'an unclaimed task has nothing to stop');
    assert.equal(log(h).length, before, 'refused writes record nothing');
    const r = await post(`${url}api/tasks/T1/message`, token, { text: 'split the API part first' });
    assert.equal(r.status, 200, await r.clone().text());
    const msg = log(h).pop();
    assert.deepEqual([msg.cmd, msg.agent, msg.task, msg.detail.to, msg.detail.text], ['msg', 'owner', 'T1', 'w-1', 'split the API part first']);
    const stop = await post(`${url}api/tasks/T1/stop`, token, { reason: 'too costly' });
    assert.equal(stop.status, 200, await stop.clone().text());
    const task = h.readState('tasks.json').tasks.find((x) => x.id === 'T1');
    assert.deepEqual([task.status, task.claim, task.needs_owner], ['todo', null, 'stopped from the board: too costly; mark done to resume']);
    const e = log(h).findLast((x) => x.cmd === 'interrupt');
    assert.deepEqual([e.agent, e.task, e.detail.holder, e.detail.needs_owner], ['owner', 'T1', 'w-1', task.needs_owner]);
    assert.ok(!h.json(['ready']).ready.some((x) => x.id === 'T1'), 'a stopped task is not dispatched again');
    const held = await (await fetch(url)).text();
    const row = held.match(/<article class="agent stopped" data-key="stopped-T1"[\s\S]*?<\/article>/);
    assert.ok(row, 'the floor keeps the stopped task');
    assert.match(row[0], /stopped, waiting on you/);
    assert.match(row[0], /data-api="\/api\/tasks\/T1\/owner-done"[\s\S]*>Resume T1</, 'Resume is owner-done');
    assert.match(held, /data-key="owner-T1"[\s\S]*?>Resume T1<\/button>/, 'the queue names the same action');
    const resume = await post(`${url}api/tasks/T1/owner-done`, token, { note: 'resumed from the board' });
    assert.equal(resume.status, 200, await resume.clone().text());
    assert.equal(h.readState('tasks.json').tasks.find((x) => x.id === 'T1').needs_owner, null);
    assert.ok(h.json(['ready']).ready.some((x) => x.id === 'T1'), 'Resume lets dispatch pick it up');
  });
});

test('an approval on the board answers approve or decline, and approve lets the orchestrator apply it once', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Ship', '--acceptance', 'shipped']);
  assert.notEqual(h.run(['project', 'set', '--merge-admin', 'true', '--agent', 'orchestrator']).code, 0);
  await withServers(async (servers) => {
    const url = await startServe(servers, h);
    const page = await (await fetch(keyed(url))).text();
    const item = page.match(/<li class="qi"[^>]*data-kind="approval" data-key="D1"[\s\S]*?<\/li>/)[0];
    const values = [...item.matchAll(/name="choice" value="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(values, h.readState('decisions.json').decisions[0].options, 'the buttons post the decision\'s own options');
    const r = await post(`${url}api/decisions/D1/answer`, tokenOf(page), { choice: values[0] });
    assert.equal(r.status, 200, await r.clone().text());
  });
  const d = h.readState('decisions.json').decisions[0];
  assert.deepEqual([d.status, d.answer, d.answered_by], ['answered', 'approve', 'owner']);
  h.ok(['project', 'set', '--merge-admin', 'true', '--agent', 'orchestrator']);
  assert.ok(h.readState('decisions.json').decisions[0].applied, 'the approved change applied once');
  assert.equal(h.readState('project.json').merge.admin, true);
});

test('runaway rules: status and the board flag the same claim, from the project\'s own history', (t) => {
  const h = makeRepo(t);
  h.init();
  // Ten accepted docs tasks: the median is 2M and the 90th percentile 10.9M.
  const spent = [1, 1.5, 1.8, 2, 2, 2, 2.2, 3, 10.8, 12];
  for (const [i, m] of spent.entries()) {
    const id = h.ok(['task', 'add', '--title', `Done ${i}`, '--acceptance', 'done', '--kind', 'docs', '--tier', 'easy']).match(/T\d+/)[0];
    h.ok(['claim', id, '--agent', `w-${i}`]);
    h.ok(['submit', id, '--sha', h.git(['rev-parse', 'HEAD']), '--agent', `w-${i}`]);
    h.ok(['spend', id, '--tokens', String(m * 1e6), '--minutes', '20', '--agent', `w-${i}`]);
    h.reviewer(id, `r-${i}`, h.git(['rev-parse', 'HEAD']));
    h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--ok', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', `r-${i}`]);
    h.ok(['accept', id]);
  }
  h.ok(['task', 'add', '--title', 'Retry jitter', '--acceptance', 'jitter', '--tier', 'easy']);
  h.ok(['claim', 'T11', '--agent', 'w-x']);
  h.ok(['spend', 'T11', '--tokens', '9000000', '--agent', 'w-x']);
  const status = () => h.json(['status']);
  assert.equal(status().runaway_norms.from, 'project');
  assert.deepEqual(status().runaways, [], 'below the multiple, nothing is flagged');
  const page = () => fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  assert.doesNotMatch(page(), /data-key="runaway-T11/);
  h.ok(['spend', 'T11', '--tokens', '3000000', '--agent', 'w-x']);
  const flags = status().runaways;
  assert.deepEqual(flags.map((f) => [f.task, f.agent, f.rule]), [['T11', null, 'spend'], ['T11', 'w-x', 'worker-spend']]);
  assert.match(h.ok(['status']), /runaway: T11: T11 has spent 12M tokens over 1 worker \(current w-x: 12M tokens\); cached share unknown, uncached tokens unknown; 6 times the easy M median of 2M; the rule is 5\.\d times$/m);
  const item = page().match(/<li class="qi" data-tier="now" data-kind="runaway" data-key="runaway-T11-spend">[\s\S]*?<\/li>/);
  assert.ok(item, 'the board shows the same flag as a Now item');
  assert.match(item[0], /T11 has spent 12M tokens/);
  assert.match(page(), /data-key="agent-T11"[\s\S]*?in the queue: spend/, 'the row keeps a marker');
  // Once the agent has exited, the queue says stuck, not runaway, and the row agrees.
  const at = new Date().toISOString();
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), [
    { at, agent: 'orchestrator', cmd: 'spawn', task: 'T11', detail: { agent: 'w-x', role: 'worker', rung: 'easy', pid: 999999, attempt: 1 } },
    { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T11', detail: { agent: 'w-x', pid: 999999, attempt: 1, code: 1 } },
  ].map((e) => `${JSON.stringify(e)}\n`).join(''));
  h.ok(['task', 'note', 'T11', 're-render', '--agent', 'orchestrator']);
  assert.match(page(), /data-key="stuck-T11-exited"/);
  assert.doesNotMatch(page(), /data-key="runaway-T11/);
  assert.match(page(), /<title>[^<]* · 0 working, 1 stuck · /, 'the sentence names the claim the floor still shows');
  assert.match(page(), /<h1 class="sentence" data-status>[\s\S]*?0 working, 1 stuck<\/a>/);
  assert.doesNotMatch(page().match(/<article class="agent[^"]*" data-key="agent-T11"[\s\S]*?<\/article>/)[0], /in the queue:/, 'an exited claim keeps no runaway marker');
  // A tier with no history of its own is measured against the project median, and every surface names it.
  h.ok(['task', 'add', '--title', 'Event fan-out', '--acceptance', 'fan-out', '--tier', 'hard']);
  h.ok(['claim', 'T12', '--agent', 'w-y']);
  h.ok(['spend', 'T12', '--tokens', '13000000', '--agent', 'w-y']);
  assert.deepEqual(status().runaway_norms.tiers.hard, { median: 2e6, from: 'project', rate: null, samples: 0 });
  assert.equal(status().runaway_norms.tiers.easy.from, 'tier');
  assert.match(h.ok(['status']), /runaway: T12: T12 has spent 13M tokens over 1 worker \(current w-y: 13M tokens\); cached share unknown, uncached tokens unknown; 6\.5 times the project median of 2M \(hard has no accepted task with tokens\) \(hard M has no accepted task with tokens; needs 3\); the rule is 5\.\d times$/m);
  assert.match(page(), /data-key="runaway-T12-spend">[\s\S]*?6\.5 times the project median of 2M \(hard has no accepted task with tokens\)/, 'the Now item');
  assert.match(page(), /data-spend="top">[^\n]*?T12[^\n]*?\(project median 2M\)/, 'the spend line');
  assert.match(page(), /data-key="top-T12">[\s\S]*?6\.5 times the project median of 2M \(hard has no accepted task with tokens\) \(hard M has no accepted task with tokens; needs 3\)<\/span>/, 'the Spend room');
  assert.doesNotMatch(page(), /hard median/);
});

test('the queue orders Now before Your turn, and an approval reads as a sentence', (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  h.ok(['task', 'add', '--title', 'Later', '--acceptance', 'later', '--dep', 'T2']);
  h.ok(['ask', '--kind', 'technical', '--question', 'Defer the export?', '--option', 'yes', '--option', 'no', '--blocks', 'T6']);
  assert.notEqual(h.run(['project', 'set', '--merge-admin', 'true', '--agent', 'orchestrator']).code, 0, 'the orchestrator cannot make an owner-required change');
  const page = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  const items = [...page.matchAll(/<li class="qi" data-tier="(\w+)" data-kind="(\w+)" data-key="([^"]+)"/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(items.slice(0, 1), [['now', 'decision', 'D1']], 'a decision that blocks ready work is Now');
  assert.ok(items.some(([tier, kind, key]) => tier === 'turn' && kind === 'decision' && key === 'D2'), 'a decision whose task still waits on others is Your turn');
  assert.ok(items.findIndex(([tier]) => tier === 'turn') > items.findLastIndex(([tier]) => tier === 'now'), 'Now items come first');
  const approval = page.match(/<li class="qi" data-tier="turn" data-kind="approval" data-key="D3"[\s\S]*?<\/li>/)[0];
  assert.match(approval, /orchestrator asks to change admin merges: off to on/);
  assert.match(approval, /merge\.admin<\/b> is <span class="class-word">yours<\/span>/);
  assert.match(approval, /project set --merge-admin true --agent owner/, 'the change to make, as a command');
  assert.match(page, /<title>4 need you · 1 working/);
});

test('an approval offers a command to make the change only when project set can make it', (t) => {
  const h = makeRepo(t);
  h.init();
  assert.notEqual(h.run(['project', 'set', '--merge-admin', 'true', '--agent', 'orchestrator']).code, 0);
  assert.notEqual(h.run(['ladder', 'set', 'easy', '--tools', '["computer_use"]', '--agent', 'orchestrator']).code, 0);
  h.ok(['render']);
  const page = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  const item = (id) => page.match(new RegExp(`<li class="qi" data-tier="\\w+" data-kind="approval" data-key="${id}"[\\s\\S]*?</li>`))[0];
  assert.match(item('D1'), /Make it yourself[\s\S]*project set --merge-admin true --agent owner/);
  assert.match(item('D2'), /ladder\.reach/, 'D2 is the ladder reach request');
  assert.doesNotMatch(item('D2'), /Make it yourself|project set --ladder/, 'no project set flag makes a ladder reach change');
  assert.match(page, /No tasks yet/, 'the requests show beside the first-run hint');
});

// The deterministic bars of the human bench (docs/human-bench.md), kept as
// assertions so a later change cannot regress them silently.
test('the board meets contrast, target, name and readability bars at the owner\'s sizes in both themes', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  h.ok(['msg', '--to', 'owner', '--task', 'T1', 'which header name?', '--agent', 'w-1']);
  await withServers(async (servers) => {
    const url = await startServe(servers, h);
    const b = await openBrowser(t);
    await b.send('Accessibility.enable');
    for (const [width, height] of [[3840, 1080], [1920, 1080], [1280, 800], [390, 844]]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      for (const theme of ['light', 'dark']) {
        await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        for (const room of ['', 'review', 'plan', 'spend', 'history', 'settings', 'controls']) {
          await b.goto(`${url}${room}`);
          await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
          const where = `${room || 'now'} at ${width} in ${theme}`;
          const c = await b.inPage(checks.contrast);
          assert.equal(c.failures, 0, `contrast ${where}: ${JSON.stringify(c.samples)}`);
          const tg = await b.inPage(checks.targets);
          assert.ok(tg.pass, `targets ${where}: ${JSON.stringify([tg.samples, tg.short_samples])}`);
          const rd = await b.inPage(checks.readability);
          assert.ok(rd.min_px >= 12 && rd.sizes <= 6 && rd.body_px >= 15 && !rd.horizontal_scroll && !rd.clipped && !rd.long_lines, `readability ${where}: ${JSON.stringify(rd)}`);
          const nm = await checks.names(b);
          assert.ok(nm.pass, `names ${where}: ${JSON.stringify(nm)}`);
          assert.ok(await b.inPage(`(() => { const t = document.querySelector('.bar [data-theme-toggle]'); return !!t && t.getClientRects().length > 0; })()`), `the theme switch is in the bar on ${where}`);
          // A status line with nothing to say draws nothing, not an empty box.
          const boxes = await b.inPage(`[...document.querySelectorAll('main *')].filter((el) => el.getClientRects().length && !el.textContent.trim() && !el.children.length && !el.matches('input, select, textarea, button, svg *, img, hr') && parseFloat(getComputedStyle(el).borderTopWidth) > 0 && el.getBoundingClientRect().width > 8 && el.getBoundingClientRect().height > 8).map((el) => el.className || el.tagName)`);
          assert.deepEqual(boxes, [], `no empty bordered box on ${where}`);
        }
      }
    }
  });
});

test('an open board draws a live reading stale once it stops arriving, with no state change to trigger it', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Spend live', '--tier', 'easy', '--acceptance', 'usage shows']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Work on T1.\n' });
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '', { mode: 0o755 });
  h.ok(['ladder', 'set', 'easy', '--harness', 'claude', '--model', 'live-model', '--clear', 'profile', '--clear', 'effort', '--supervision', JSON.stringify({ usage_ms: 200, stall_ms: 60000 })]);
  const stub = path.join(__dirname, 'fixtures', 'live-usage-harness.js').replace(/\\/g, '/');
  // Spawn caches under HOME; this one keeps them in the scratch directory.
  const home = path.join(h.base, 'home');
  fs.mkdirSync(path.join(home, '.cache'), { recursive: true });
  // Inherited harness homes carry origin markers; resolve only this fixture's home.
  const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, '.cache'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), GH_CONFIG_DIR: path.join(home, '.config', 'gh'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    OPENCODE_CONFIG_DIR: path.join(home, '.config', 'opencode') };
  h.json(['spawn', '--task', 'T1'], { env: { ...env, PATH: bin + path.delimiter + h.env.PATH, NODE_OPTIONS: `--require "${stub}"`, LIVE_STEPS: '2', LIVE_STEP_TOKENS: '700', LIVE_HOLD: '60000', LIVE_DONE: path.join(h.base, 'done') } });
  await waitOnRepo(h, () => h.json(['status']).spend.live.some((l) => l.tokens === 1400), 'live usage was not read');
  await withServers(async (servers) => {
    const url = await startServe(servers, h, 'viewer');
    const b = await openBrowser(t);
    await b.goto(url);
    await b.until(`document.querySelector('.conn').dataset.conn === 'live' && !!document.querySelector('[data-key="agent-T1"] [data-live-state="live"]')`, 'the live reading on the row');
    // The supervisor goes away and the agent keeps running: no reading, no write.
    const monitor = log(h).find((e) => e.cmd === 'spawn' && e.task === 'T1').detail.monitor_pid;
    killPid(monitor, 'SIGKILL');
    const events = log(h).length;
    await b.until(`!!document.querySelector('[data-key="agent-T1"] [data-live-state="stale"]') && !!document.querySelector('#queue [data-key="runaway-T1-stale"]')`, 'the stale reading and its Now item');
    assert.equal(log(h).length, events, 'nothing was written: the page aged the reading itself');
    assert.match(await b.inPage(`document.querySelector('h1[data-status]').textContent`), /1 not counted/);
    assert.doesNotMatch(await b.inPage(`document.querySelector('[data-key="agent-T1"] [data-usage]').textContent`), /(^|\s)0 tokens/, 'never drawn as zero');
  });
});

test('the board shows a refused brokered message as trouble, without its text', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'one', '--acceptance', 'noted']);
  h.ok(['task', 'add', '--title', 'two', '--acceptance', 'noted']);
  const job = { state: h.state, task: 'T2', agent: 'worker-T2-1', role: 'worker', cwd: h.repo, broker: path.join(h.base, 'brokers', 'worker-T2-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const refused = await B.forward(job.broker, ['msg', '--to', 'worker-T1-1', 'text the board must not show'], h.state);
  assert.equal(refused.code, 1, refused.stderr);
  useFixtureUserFile(t, h);
  const board = require('../lib/board/model').build(require('../lib/state').loadState(h.state));
  const item = board.history.find((e) => e.cmd === 'msg refused');
  assert.deepEqual([item.kind, item.tone], ['trouble', 'fault']);
  assert.match(item.text, /worker-T2-1 tried to message worker-T1-1; the broker refused it/);
  assert.ok(!JSON.stringify(board).includes('text the board must not show'), 'the board never shows the refused text');
});

test('the board marks a ready task without a brief until its brief is written', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'briefless', '--acceptance', 'marked']);
  useFixtureUserFile(t, h);
  const marks = () => {
    const st = require('../lib/state').loadState(h.state);
    return [require('../lib/board/model').build(st).ready.map((r) => r.brief), require('../lib/render').renderHtml(st).includes('no brief')];
  };
  assert.deepEqual(marks(), [[false], true]);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Context.\n' });
  assert.deepEqual(marks(), [[true], false]);
});
