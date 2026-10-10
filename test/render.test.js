'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const { makeRepo, BIN } = require('./helpers');

function populate(h) {
  h.ok(['task', 'add', '--title', 'Schema <v2> & "keys" | ids', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'API', '--acceptance', 'b', '--dep', 'T1']);
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'c', '--kind', 'docs', '--dep', 'T2', '--needs-owner', 'approve wording']);
  h.ok(['task', 'add', '--title', 'Metrics', '--acceptance', 'd', '--dep', 'T1']);
  h.ok(['ask', '--question', 'Which dashboard?', '--option', 'grafana', '--option', 'datadog', '--blocks', 'T4']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
}

test('every write re-renders sketch.md and sketch.html', (t) => {
  const h = makeRepo(t);
  h.init();
  const md = path.join(h.state, 'sketch.md');
  const html = path.join(h.state, 'sketch.html');
  assert.match(fs.readFileSync(md, 'utf8'), /No tasks yet/);
  populate(h);
  const text = fs.readFileSync(md, 'utf8');
  assert.match(text, /```mermaid\nflowchart LR\n/);
  assert.match(text, /T1\["T1: Schema #lt;v2#gt; & #quot;keys#quot; \| ids"\]/);
  assert.match(text, /T1 --> T2/);
  assert.match(text, /classDef in_progress /);
  assert.match(text, /class T1 in_progress/);
  for (const heading of ['Ready', 'In progress', 'Submitted', 'Decisions open', 'Needs owner', 'Spend vs budget']) {
    assert.match(text, new RegExp(`^## ${heading}$`, 'm'));
  }
  assert.match(text, /\| T1 \| Schema &lt;v2&gt; & "keys" \\\| ids \| w-1 \|/, 'pipes and angle brackets are escaped in tables');
  assert.match(text, /\| D1 \| Which dashboard\? \| grafana, datadog \| - \| T4 \|/);
  assert.match(text, /\| T3 \| Docs \| approve wording \|/);

  const page = fs.readFileSync(html, 'utf8');
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<svg class="graph"/);
  assert.match(page, /prefers-color-scheme: dark/);
  assert.match(page, /Schema &lt;v2&gt; &amp; &quot;keys&quot; \| ids/);
  assert.doesNotMatch(page, /<v2>/, 'titles are escaped');
  assert.equal((page.match(/class="node /g) || []).length, 4);
  assert.equal((page.match(/class="edge[ "]/g) || []).length, 3);
});

test('render writes both files on demand', (t) => {
  const h = makeRepo(t);
  h.init();
  fs.rmSync(path.join(h.state, 'sketch.md'));
  fs.rmSync(path.join(h.state, 'sketch.html'));
  const out = h.json(['render']);
  assert.ok(fs.existsSync(out.md) && fs.existsSync(out.html));
});

test('render holds the lock, so a write made while it runs still shows in the sketch', async (t) => {
  const h = makeRepo(t);
  h.init();
  const paused = path.join(h.base, 'render-read');
  // render stops right after it reads tasks.json, then a task is added.
  const render = h.runAsync(['render'], { hooks: { HOOK_PAUSE_ON: 'tasks.json', HOOK_PAUSED: paused } });
  const end = Date.now() + 20000;
  while (!fs.existsSync(paused)) {
    if (Date.now() > end) throw new Error('render never read the state');
    await new Promise((r) => setTimeout(r, 20));
  }
  const add = h.runAsync(['task', 'add', '--title', 'Added during render', '--acceptance', 'a']);
  // Give the add time to finish if nothing holds it back, then let render go on.
  await Promise.race([add, new Promise((r) => setTimeout(r, 1500))]);
  fs.writeFileSync(`${paused}.go`, '');
  const [r, a] = await Promise.all([render, add]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(h.readState('tasks.json').tasks.length, 1);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.md'), 'utf8'), /Added during render/, 'sketch.md shows the task');
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /Added during render/, 'sketch.html shows the task');
});

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('serve serves the sketch and pushes a reload when the state changes', async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const server = cp.spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json'], { cwd: h.repo, env: h.env });
  const exited = new Promise((resolve) => server.on('exit', resolve));
  let late = null;
  try {
    const url = await new Promise((resolve, reject) => {
      let out = '';
      server.stdout.on('data', (d) => {
        out += d;
        if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]).url);
      });
      server.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
    });
    const page = await get(url);
    assert.equal(page.status, 200);
    assert.match(page.body, /<span class="project" title="[^"]*">demo<\/span>/);
    assert.match(page.body, /"live":true/, 'the served board opens the event stream');
    assert.equal((await get(`${url}nope`)).status, 404);

    const reload = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no reload event within 10 s')), 10000);
      http.get(`${url}events`, (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream');
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          if (buf.includes(': connected') && !late) late = h.runAsync(['task', 'add', '--title', 'Late', '--acceptance', 'e']);
          if (buf.includes('event: reload')) {
            clearTimeout(timer);
            res.destroy();
            resolve();
          }
        });
      }).on('error', reject);
    });
    await reload;
    assert.match((await get(url)).body, /Late/);
    assert.equal((await late).code, 0);
  } finally {
    // Windows cannot delete a directory a live process runs in, so the server
    // and the writer must be gone before makeRepo's cleanup removes the repo.
    server.kill();
    await exited;
    if (late) await late;
  }
});

test('serve exits 1 when its port is taken', async (t) => {
  const h = makeRepo(t);
  h.init();
  const taken = http.createServer();
  await new Promise((resolve) => taken.listen(0, '127.0.0.1', resolve));
  try {
    const port = taken.address().port;
    const started = Date.now();
    const r = h.run(['serve', '--port', String(port)], { timeout: 15000 });
    assert.equal(r.code, 1, `exit ${r.code} (signal ${r.signal}) after ${Date.now() - started} ms: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`port ${port} is in use`));
  } finally {
    taken.close();
  }
});
