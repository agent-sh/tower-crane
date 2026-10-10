'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { makeRepo } = require('./helpers');
const { changeKind } = require('./gate-helpers');
const { pageText } = require('../lib/gates/sources');
const { fetchPublic } = require('../lib/public-http');

const BODIES = new Map(Array.from({ length: 10 }, (_, i) => [
  `/${i}`, `<p>Page ${i} says <b>water</b> &amp; light.</p><script>hidden claim</script>`,
]));
BODIES.set('/copy', '<p>Page 0 says <b>water</b> &amp; light.</p>');
BODIES.set('/inline', '<p>The result is <strong>42</strong>.</p><p>A<em>B</em>C is adjacent.</p>');
BODIES.set('/blocks', '<p>First paragraph.</p><p>Second paragraph.</p>');
BODIES.set('/nested', '<p title="a > b">Visible <b>nested <em>text</em></b>.</p><!-- hidden comment --><template>hidden template<template>inner template</template>outer hidden claim</template><script>if (a < b) { hiddenScript(); }</script><style>hidden style</style><p>After blocks.</p>');
const REDIRECTS = new Map([
  ['/alias', '/0'], ['/private-redirect', 'http://private.example/secret'],
  ['/loopback-redirect', 'http://127.0.0.1/secret'],
  ['/public-redirect', 'http://source.example/inline'],
  ['/second-hop', 'http://source.example/private-redirect'],
]);

// One research task per fixture; each case resubmits a new research/T1.json
// as the claimant, so a case costs a commit, a submit and a check.
async function fixture(t, tier) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (REDIRECTS.has(req.url)) { res.writeHead(302, { location: REDIRECTS.get(req.url) }); res.end(); return; }
    if (!BODIES.has(req.url)) { res.writeHead(404); res.end('missing'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(BODIES.get(req.url));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://source.example';
  const h = makeRepo(t);
  const preload = path.join(__dirname, 'fixtures', 'sources-network.js');
  h.env.NODE_OPTIONS = `${h.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`;
  h.env.HOOK_SOURCES_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  h.init();
  h.ok(['task', 'add', '--title', 'Research', '--kind', 'research', '--acceptance', 'claims have sources',
    ...(tier ? ['--tier', tier] : [])]);
  h.ok(['claim', 'T1', '--agent', 'researcher']);
  const wt = h.json(['worktree', 'T1']).path;
  const fresh = () => ({
    sources: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, url: `${base}/${i}` })),
    claims: Array.from({ length: 10 }, (_, i) => ({
      claim: `Page ${i} discusses water and light.`,
      quote: `Page ${i} says water & light.`,
      source: `s${i}`,
    })),
  });
  function submit(value = fresh()) {
    fs.mkdirSync(path.join(wt, 'research'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'research', 'T1.json'), JSON.stringify(value));
    h.git(['add', 'research'], wt);
    h.git(['commit', '-q', '--allow-empty', '-m', 'research sources'], wt);
    const sha = h.git(['rev-parse', 'HEAD'], wt);
    h.ok(['submit', 'T1', '--agent', 'researcher', '--sha', sha]);
    requests.length = 0;
    return sha;
  }
  return { h, wt, fresh, requests, submit };
}

test('sources gate fetches ten cited pages at the submitted commit and records an audited receipt', async (t) => {
  const { h, wt, requests, submit } = await fixture(t);
  const sha = submit();
  fs.writeFileSync(path.join(wt, 'research', 'T1.json'), '{}');
  const result = await h.runAsync(['check', 'sources', 'T1', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.sha, sha);
  assert.equal(receipt.receipt.min_sources, 10);
  assert.equal(receipt.receipt.sources.length, 10);
  assert.equal(requests.length, 10);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find(g => g.type === 'sources').ok, true);
  assert.equal(h.run(['evidence', 'T1', '--type', 'sources', '--ok']).code, 1);
  // Every check must reach the pages again, even when evidence already passed.
  assert.equal((await h.runAsync(['check', 'sources', 'T1'])).code, 0);
  assert.equal(requests.length, 20);
  h.ok(['project', 'set', '--research-min-sources', '11']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find(g => g.type === 'sources').ok, false);
  const state = require('../lib/state').loadState(h.state);
  const board = require('../lib/board/model').build(state);
  assert.equal(board.sheets[0].ledger[0].entries.find(e => e.type === 'sources').counts, false);
  assert.match(board.history.find(e => e.cmd === 'check sources').text, /sources/);
  assert.equal((await h.runAsync(['check', 'sources', 'T1'])).code, 1);
  h.ok(['project', 'set', '--research-min-sources', '2']);
  assert.equal((await h.runAsync(['check', 'sources', 'T1'])).code, 0);
  const review = h.json(['spawn', '--role', 'review', '--task', 'T1', '--dry-run']);
  assert.match(review.argv.join('\n'), /each claim maps to a cited source/);
});

test('sources gate reads visible text across inline markup, blocks and nested markup, through a public redirect', async (t) => {
  const { h, fresh, requests, submit } = await fixture(t);
  const doc = fresh();
  doc.sources[0].url = 'http://source.example/public-redirect';
  doc.claims[0].quote = 'The result is 42. ABC is adjacent.';
  doc.sources[1].url = 'http://source.example/blocks';
  doc.claims[1].quote = 'First paragraph. Second paragraph.';
  doc.sources[2].url = 'http://source.example/nested';
  doc.claims[2].quote = 'Visible nested text. After blocks.';
  submit(doc);
  const result = await h.runAsync(['check', 'sources', 'T1', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).receipt.sources[0].final_url, 'http://source.example/inline');
  assert.deepEqual(requests.slice(0, 2), ['/public-redirect', '/inline']);
});

test('hidden markup text is never page text', () => {
  for (const [body, quote] of [
    [BODIES.get('/nested'), 'outer hidden claim'],
    [BODIES.get('/0'), 'hidden claim'],
    ['<p>Visible prefix.</p><!-- unfinished hidden claim', 'unfinished hidden claim'],
    ['<p>Visible prefix.</p><script>unfinished hidden claim', 'unfinished hidden claim'],
    ['<p>Visible prefix.</p><style>unfinished hidden claim', 'unfinished hidden claim'],
    ['<p>Visible prefix.</p><template><template>inner</template>unfinished hidden claim', 'unfinished hidden claim'],
    ['<p>Visible prefix.</p><span title="unfinished hidden claim', 'unfinished hidden claim'],
    ['<p>Visible prefix.</p><scr<script>ipt>unfinished hidden claim</script>', 'unfinished hidden claim'],
    ['<p>Visible prefix.</p><!-- outer <!-- inner --> outer hidden claim -->', 'outer hidden claim'],
  ]) {
    const text = pageText(body, true);
    assert.ok(!text.includes(quote), `${body} hides ${quote}`);
    assert.match(text, /Visible|Page 0|After blocks/, `${body} keeps its visible text`);
  }
});

test('sources gate pins its DNS answer for the real HTTP transport despite rebinding, and falls back from IPv6 to IPv4', async (t) => {
  const { h, fresh, requests, submit } = await fixture(t);
  h.env.HOOK_SOURCES_PIN = '1';
  h.env.HOOK_SOURCES_TRACE = path.join(h.base, 'socket.json');
  h.ok(['project', 'set', '--research-min-sources', '1']);
  const doc = fresh();
  doc.sources = doc.sources.slice(0, 1);
  doc.claims = doc.claims.slice(0, 1);
  submit(doc);
  const pinned = await h.runAsync(['check', 'sources', 'T1']);
  assert.equal(pinned.code, 0, pinned.stdout + pinned.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.env.HOOK_SOURCES_TRACE, 'utf8')), {
    lookups: 1, address: '93.184.216.34', host: 'source.example',
  });
  assert.deepEqual(requests, ['/0']);

  requests.length = 0;
  h.env.HOOK_SOURCES_DUAL_STACK = '1';
  const dual = await h.runAsync(['check', 'sources', 'T1']);
  assert.equal(dual.code, 0, dual.stdout + dual.stderr);
  const trace = JSON.parse(fs.readFileSync(h.env.HOOK_SOURCES_TRACE, 'utf8'));
  assert.equal(trace.lookups, 1);
  assert.deepEqual(trace.addresses, [
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '93.184.216.34', family: 4 },
  ]);
  assert.deepEqual(requests, ['/0']);
});

test('the source fetch refuses non-public addresses and redirects before connecting', async () => {
  const answers = {
    'source.example': [{ address: '93.184.216.34', family: 4 }],
    'private.example': [{ address: '10.0.0.1', family: 4 }],
    'mixed.example': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
  };
  for (const [url, expected] of [
    ['http://127.0.0.1/secret', []], ['http://10.0.0.1/secret', []],
    ['http://172.16.0.1/secret', []], ['http://192.168.0.1/secret', []],
    ['http://169.254.169.254/latest/meta-data', []], ['http://100.64.0.1/secret', []],
    ['http://[::1]/secret', []], ['http://[fc00::1]/secret', []],
    ['http://[fe80::1]/secret', []], ['http://[::ffff:127.0.0.1]/secret', []],
    ['http://2130706433/secret', []], ['http://private.example/secret', []],
    ['http://mixed.example/secret', []],
    ['http://source.example/private-redirect', ['/private-redirect']],
    ['http://source.example/loopback-redirect', ['/loopback-redirect']],
    ['http://source.example/second-hop', ['/second-hop', '/private-redirect']],
  ]) {
    const requests = [];
    const ctx = {
      resolveHost: async (hostname) => answers[hostname],
      fetchPage: async (target) => {
        requests.push(target.pathname);
        return new Response(null, { status: 302, headers: { location: REDIRECTS.get(target.pathname) } });
      },
    };
    await assert.rejects(fetchPublic(url, { signal: AbortSignal.timeout(5000) }, ctx), /non-public address/, url);
    assert.deepEqual(requests, expected, url);
  }
});

test('research kind requires sources and citation review on every tier, including after a tier move', async (t) => {
  const { h, submit } = await fixture(t, 'easy');
  const sha = submit();
  h.reviewer('T1', 'reviewer', sha);
  h.ok(['evidence', 'T1', '--agent', 'reviewer', '--type', 'review', '--ok', '--sha', sha]);
  const tiers = ['easy', 'medium', 'hard', 'research'];
  for (const tier of tiers) {
    h.ok(['task', 'update', 'T1', '--tier', tier]);
    const report = h.json(['task', 'show', 'T1']).gates;
    assert.equal(report.ok, false, `review alone cannot satisfy research verification on ${tier}`);
    assert.equal(report.gates.find(g => g.type === 'sources')?.ok, false);
  }
  const blocked = h.run(['spawn', '--role', 'review', '--task', 'T1', '--dry-run']);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /sources/);
  const checked = await h.runAsync(['check', 'sources', 'T1']);
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  for (const tier of tiers) {
    h.ok(['task', 'update', 'T1', '--tier', tier]);
    assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true, tier);
    const prompt = h.json(['spawn', '--role', 'review', '--task', 'T1', '--dry-run']).argv.join('\n');
    assert.match(prompt, /each claim maps to a cited source/);
    assert.match(prompt, /## Sources receipt/);
    assert.match(prompt, /"min_sources": 10/);
    assert.match(prompt, /research\/T1\.json/);
  }
});

test('sources gate follows research kind when kind changes without moving the task tier', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--kind', 'docs', '--title', 'Worker task', '--acceptance', 'reviewed']);
  // A submitted task refuses a kind change, so the kind moves while the task is still todo.
  h.ok(['task', 'update', 'T1', '--kind', 'research']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', sha]);
  h.reviewer('T1', 'reviewer', sha);
  h.ok(['evidence', 'T1', '--agent', 'reviewer', '--type', 'review', '--ok', '--sha', sha]);
  assert.equal(h.json(['task', 'show', 'T1']).tier, 'medium');
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false);
  h.ok(['task', 'update', 'T1', '--tier', 'research']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find(g => g.type === 'sources').ok, false);
  changeKind(h, 'docs');
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
});

test('sources gate rejects bad citations and pages through the CLI, and a failed gate prevents review dispatch', async (t) => {
  const { h, fresh, requests, submit } = await fixture(t);
  for (const [name, mutate, pattern] of [
    ['non-public address', d => { d.sources[0].url = 'http://127.0.0.1/secret'; }, /non-public address/],
    ['non-public redirect hop', d => { d.sources[0].url = 'http://source.example/second-hop'; }, /non-public address/],
    ['dead link', d => { d.sources[9].url = d.sources[9].url.replace('/9', '/dead'); }, /HTTP 404/],
    ['duplicate URL', d => { d.sources[9].url = `${d.sources[0].url}#section`; }, /duplicate URL/],
    ['duplicate redirect page', d => { d.sources[9].url = d.sources[9].url.replace('/9', '/alias'); }, /duplicate page/],
    ['duplicate page content', d => { d.sources[9].url = d.sources[9].url.replace('/9', '/copy'); }, /duplicate page/],
    ['quote absent from page', d => { d.claims[9].quote = 'not on the page'; }, /quote.*not found/],
    ['hidden script quote', d => { d.claims[9].quote = 'hidden claim'; }, /quote.*not found/],
    ['uncited URL', d => { d.claims.pop(); }, /uncited source/],
    ['unmapped claim', d => { d.claims[9].source = 'missing'; }, /unknown source/],
    ['too few sources', d => { d.sources.pop(); d.claims.pop(); }, /at least 10/],
  ]) {
    const doc = fresh();
    mutate(doc);
    submit(doc);
    const result = await h.runAsync(['check', 'sources', 'T1']);
    assert.equal(result.code, 1, `${name}: ${result.stderr}`);
    assert.match(result.stdout, pattern, name);
    if (name === 'non-public address') assert.deepEqual(requests, [], 'nothing is fetched from a private address');
    if (name === 'non-public redirect hop') assert.deepEqual(requests, ['/second-hop', '/private-redirect']);
  }
  const review = h.run(['spawn', '--role', 'review', '--task', 'T1', '--dry-run']);
  assert.equal(review.code, 1, review.stderr);
  assert.match(review.stderr, /sources/);
});

test('research source minimum refuses invalid values and worker changes', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const value of ['0', '-1', '1.5']) assert.equal(h.run(['project', 'set', '--research-min-sources', value]).code, 2);
  assert.equal(h.run(['project', 'set', '--research-min-sources', '1', '--agent', 'worker-T1-1']).code, 1);
  h.ok(['project', 'set', '--research-min-sources', '3']);
  assert.equal(h.json(['project', 'show']).research.min_sources, 3);
});
