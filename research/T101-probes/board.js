'use strict';
// The board's write paths: tower-crane serve on 127.0.0.1 in a scratch state.
const fs = require('node:fs');
const http = require('node:http');
const cp = require('node:child_process');
const { H, rec, save } = require('./lib');
const BIN = H.BIN;

function serve(h, agent) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json'], { cwd: h.repo, env: { ...h.env, TOWER_CRANE_AGENT: agent } });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) { const o = JSON.parse(buf.slice(0, nl)); resolve({ child, url: o.url, open: o.open }); }
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('serve did not start')), 10000);
  });
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ code: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ code: 0, body: e.message }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function main() {
  const h = H.makeRepo();
  const kids = [];
  try {
    h.init();
    h.ok(['task', 'add', '--title', 'A', '--acceptance', 'x']);
    h.ok(['ask', '--question', 'ship it?', '--option', 'yes', '--option', 'no', '--agent', 'orchestrator']);
    const json = { 'content-type': 'application/json' };

    const s1 = await serve(h, 'orchestrator');
    kids.push(s1.child);
    let r = await request(`${s1.url}api/tiers`, { method: 'POST', headers: json, body: '{"tiers":{"T1":"hard"},"base":{"T1":"medium"}}' });
    rec('W1', 'board', 'TOWER_CRANE_AGENT=orchestrator tower-crane serve; POST /api/tiers without a token', '403', `${r.code} ${r.body}`, r.code === 403 ? 'held' : 'CONFIRMED');
    const page1 = await request(`${s1.url}settings`);
    const tokenOf = (page) => (/name="tower-crane-token" content="([0-9a-f]+)"/.exec(page.body) || [])[1];
    const tok1 = tokenOf(page1);
    r = await request(`${s1.url}api/decisions/D1/answer`, { method: 'POST', headers: { ...json, 'x-tower-crane-token': tok1 || '' }, body: '{"choice":"yes"}' });
    rec('W2', 'board', 'serve as orchestrator; GET /settings, then POST /api/decisions/D1/answer with the page token', '403: owner routes need serve run by the owner',
      `${r.code} ${r.body}`, r.code === 403 ? 'held' : 'CONFIRMED');
    s1.child.kill();

    const s2 = await serve(h, 'owner');
    kids.push(s2.child);
    const page2 = await request(`${s2.url}settings`);
    const tok2 = tokenOf(page2) || '';
    // W3 and W5 test other defenses, so they send the token of the owner's
    // one-time link; W6 and W7 have only what a page without it carries.
    const keyed = tokenOf(await request(s2.open)) || '';
    r = await request(`${s2.url}api/decisions/D1/answer`, { method: 'POST', headers: { ...json, origin: 'http://evil.example', 'x-tower-crane-token': keyed }, body: '{"choice":"yes"}' });
    rec('W3', 'board', 'serve as owner; POST answer with the right token and Origin: http://evil.example', '403', `${r.code} ${r.body}`, r.code === 403 ? 'held' : 'CONFIRMED');
    const port = new URL(s2.url).port;
    r = await request(`${s2.url}settings`, { headers: { host: `rebound.example:${port}` } });
    rec('W4', 'board', 'serve as owner; GET /settings with Host: rebound.example (DNS rebinding)', '403', `${r.code} ${r.body.slice(0, 80)}`, r.code === 403 ? 'held' : 'CONFIRMED');
    r = await request(`${s2.url}api/decisions/D1/answer`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-tower-crane-token': keyed }, body: '{"choice":"yes"}' });
    rec('W5', 'board', 'serve as owner; POST answer as text/plain with the token', '415', `${r.code} ${r.body}`, r.code === 415 ? 'held' : 'CONFIRMED');
    r = await request(`${s2.url}api/decisions/D1/answer`, { method: 'POST', headers: { ...json, 'x-tower-crane-token': tok2 }, body: '{"choice":"yes","note":"answered by a local process, not the owner"}' });
    const d1 = h.readState('decisions.json').decisions.find((d) => d.id === 'D1');
    rec('W6', 'board', 'serve as owner; any local process (no browser, no Origin header) GETs /settings, reads the token from the meta tag, POSTs /api/decisions/D1/answer',
      'refused unless the request comes from the owner\'s page; a codex sandbox reaches 127.0.0.1 over TCP (lib/broker.js)', `token read: ${tok2 ? 'yes' : 'no'}; ${r.code}; D1 now ${d1.status} by ${d1.answered_by}`,
      d1.status !== 'open' ? 'CONFIRMED' : 'held');
    const layers = require('./lib').lib('ladder').resolve(h.readState('project.json'), h.env);
    r = await request(`${s2.url}api/ladder`, { method: 'POST', headers: { ...json, 'x-tower-crane-token': tok2 },
      body: JSON.stringify({ rungs: { medium: { harness: 'command', command: JSON.stringify(['/bin/true']), profile: '', effort: '', args: '', model: '' } }, base: { harness: layers.harness, rungs: { medium: layers.ladder.medium.own } } }) });
    rec('W7', 'board', 'same local process POSTs /api/ladder setting the medium rung to harness command ["/bin/true"] (an owner-required ladder.command change)',
      'refused for anything but the owner\'s page', `${r.code} ${r.body.slice(0, 200)}`, r.code === 200 ? 'CONFIRMED' : 'held (see body)');
  } finally {
    for (const k of kids) k.kill();
    save('board');
    fs.rmSync(h.base, { recursive: true, force: true });
  }
}
main();