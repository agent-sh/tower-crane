'use strict';

// The real claude on Bedrock with its bearer token in the OS store: it
// reaches a local stand-in for Bedrock (test/fixtures/fake-bedrock.js)
// through the supervisor's broker, holding no credential itself, while its
// sandboxed command cannot reach the broker, its URL or the store. The agent
// calls no model, but it is the real claude, which only a live opt-in runs.
// Every value here is fake, and the store entry is named tc-test-fake-*.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
// The store layout, as the owner's docs give it (docs/state.md#credentials):
// Secret Service items under service=tower-crane, systemd-creds files in
// credentials/ beside the user file.
const SERVICE = 'tower-crane';
const credentialsDir = (file) => path.join(path.dirname(file), 'credentials');
const credFile = (file, name) => path.join(credentialsDir(file), `${name}.cred`);
const { makeRepo } = require('./helpers');
const { NO_STUBS } = require('./isolation-helpers');

// Why the real claude cannot run here, or false.
function claudeSkip() {
  if (process.env.TOWER_CRANE_LIVE_CLAUDE !== '1') return 'set TOWER_CRANE_LIVE_CLAUDE=1 to run the real claude';
  if (process.platform !== 'linux') return 'the probe covers the Linux sandbox and stores';
  const r = cp.spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 60000 }); // wait-allow: backstop for a claude that never answers
  if (r.error?.code === 'ENOENT') return 'claude is not on PATH';
  return r.status === 0 ? false : `claude does not start here: ${String(r.stderr).trim().split('\n').pop()}`;
}

// The store the test puts the fake bearer in: the Secret Service when an
// unlocked keyring takes an entry, else systemd-creds beside the user file.
function storeFake(t, h, name, value) {
  const keyring = cp.spawnSync('secret-tool', ['store', `--label=${name}`, 'service', SERVICE, 'name', name], { input: value, timeout: 30000 }); // wait-allow: backstop for a keyring that never answers
  if (keyring.status === 0) {
    t.after(() => cp.spawnSync('secret-tool', ['clear', 'service', SERVICE, 'name', name], { timeout: 30000 })); // wait-allow: same backstop
    return 'secret-service';
  }
  const file = h.env.TOWER_CRANE_CONFIG;
  fs.mkdirSync(credentialsDir(file), { recursive: true, mode: 0o700 });
  const r = cp.spawnSync('systemd-creds', ['--user', 'encrypt', `--name=${name}`, '-', credFile(file, name)], { input: value });
  assert.equal(r.status, 0, `neither the Secret Service nor systemd-creds takes a credential here: ${keyring.stderr} ${r.stderr}`);
  fs.writeFileSync(file, JSON.stringify({ credentials: { [name]: { store: 'systemd-creds' } } }));
  return 'systemd-creds';
}

// The processes on this host whose environment holds value.
function environHolders(value) {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      if (fs.readFileSync(`/proc/${pid}/environ`).includes(value)) out.push(fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0')[0]);
    } catch { /* gone, or another user's */ }
  }
  return out;
}

test('in the real claude sandbox a Bedrock agent authenticates through the broker with no credential in any environment, and its command reaches neither the broker nor the store', { skip: NO_STUBS, timeout: 300000 }, async (t) => {
  const why = claudeSkip();
  if (why) {
    t.skip(why);
    return;
  }
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Probe', '--acceptance', 'probe']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'probe\n' });
  const name = `tc-test-fake-bedrock-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const value = `tc-test-fake-bearer-${crypto.randomBytes(8).toString('hex')}`;
  const dispatcherToken = `tc-test-fake-dispatcher-${crypto.randomBytes(8).toString('hex')}`;
  const store = storeFake(t, h, name, value);
  h.ok(['ladder', 'set', 'easy', '--harness', 'claude', '--model', 'claude-haiku-5-5', '--provider', 'bedrock', '--clear', 'profile', '--clear', 'effort', '--clear', 'args', '--credential', name]);
  const dir = path.join(h.base, 'results');
  fs.mkdirSync(dir);
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [dir] })]);
  // While the agent runs, every request the stand-in Bedrock answers looks
  // for a process on this host whose environment holds the stored token. The
  // dispatcher's own token stays in the dispatcher and the supervisor, which
  // the test started with it.
  const hostHolders = new Set();
  const probe = path.join(dir, 'probe.js');
  fs.writeFileSync(path.join(dir, 'probe.json'), JSON.stringify({ values: [value, dispatcherToken], name, cred: credFile(h.env.TOWER_CRANE_CONFIG, name), urlFile: path.join(dir, 'broker-url') }));
  fs.writeFileSync(probe, `const fs = require('fs'), cp = require('child_process'), http = require('http'), path = require('path');
const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'probe.json'), 'utf8'));
const url = fs.readFileSync(c.urlFile, 'utf8');
const nonce = url.split('/').pop();
const seen = (s) => c.values.some((v) => String(s).includes(v));
const run = (cmd, args) => { const r = cp.spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 }); return { status: r.status, error: r.error ? r.error.code : null, value: seen(r.stdout) || seen(r.stderr) }; }; // wait-allow: a store tool that hangs in the sandbox must not hold the agent's turn
const o = { names: Object.keys(process.env).filter((k) => ['ANTHROPIC_BEDROCK_BASE_URL', 'AWS_BEARER_TOKEN_BEDROCK'].includes(k) || seen(process.env[k]) || (nonce && process.env[k].includes(nonce))), holders: [] };
for (const pid of fs.readdirSync('/proc').filter((p) => /^\\d+$/.test(p))) {
  try { if (seen(fs.readFileSync('/proc/' + pid + '/environ', 'latin1'))) o.holders.push(fs.readFileSync('/proc/' + pid + '/cmdline', 'latin1').split('\\0')[0]); } catch {}
}
o.secretTool = run('secret-tool', ['lookup', 'service', 'tower-crane', 'name', c.name]);
o.systemdCreds = run('systemd-creds', ['--user', 'decrypt', '--name=' + c.name, c.cred, '-']);
o.credFile = fs.existsSync(c.cred);
const req = http.request(url + '/inference-profiles', { timeout: 5000 }, (res) => { o.broker = 'status ' + res.statusCode; done(); });
req.on('error', (e) => { o.broker = e.code || e.message; done(); });
req.on('timeout', () => { o.broker = 'timeout'; req.destroy(); });
req.end();
function done() { console.log('PROBE ' + JSON.stringify(o)); }
`);
  const steps = [() => ({ name: 'Bash', input: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}`, description: 'probe' } })];
  const bedrock = await require('./fixtures/fake-bedrock').start(steps, {
    onRequest: () => { for (const holder of environHolders(value)) hostHolders.add(holder); },
  });
  t.after(bedrock.close);
  // Where the broker forwards: the project's own Bedrock endpoint, which
  // spawn hands the broker, never claude.
  h.ok(['project', 'set', '--env', JSON.stringify({ ANTHROPIC_BEDROCK_BASE_URL: bedrock.url, AWS_REGION: 'us-east-1' })]);
  // The stand-in records what claude itself starts with, puts the broker's
  // URL where the probe can try it, then runs the real claude.
  const bin = path.join(h.base, 'claude-bin');
  fs.mkdirSync(bin);
  const outside = path.join(h.base, 'claude-env.json');
  fs.writeFileSync(path.join(bin, 'stand-in.json'), JSON.stringify({ outside, values: [value, dispatcherToken], bin, urlFile: path.join(dir, 'broker-url') }));
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'stand-in.json'), 'utf8'));
fs.writeFileSync(c.outside, JSON.stringify({ holding: Object.keys(process.env).filter((k) => c.values.some((v) => process.env[k].includes(v))),
  bearer: 'AWS_BEARER_TOKEN_BEDROCK' in process.env, url: process.env.ANTHROPIC_BEDROCK_BASE_URL, skip: process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH }));
fs.writeFileSync(c.urlFile, process.env.ANTHROPIC_BEDROCK_BASE_URL || '');
const PATH = process.env.PATH.split(path.delimiter).filter((d) => path.resolve(d) !== c.bin).join(path.delimiter);
const env = { ...process.env, PATH, DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
const r = cp.spawnSync('claude', process.argv.slice(2), { env, stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  const config = path.join(h.base, 'claude-config');
  fs.mkdirSync(config);
  const cache = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'tcl-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const env = { ...h.env, HOME: os.homedir(), USERPROFILE: os.homedir(), CLAUDE_CONFIG_DIR: config, XDG_CACHE_HOME: cache,
    PATH: `${bin}${path.delimiter}${h.env.PATH || process.env.PATH}`, AWS_BEARER_TOKEN_BEDROCK: dispatcherToken };
  const r = await h.runAsync(['spawn', '--role', 'easy', '--task', 'T1', '--wait'], { env });
  const said = bedrock.results.map((x, i) => `${i}: ${x.error ? 'error ' : ''}${x.text.slice(0, 600)}`).join('\n');
  assert.equal(bedrock.results.length, steps.length, `the probe ran (exit ${r.code}, store ${store})\n${said}\n${r.stderr}\n${JSON.stringify(bedrock.requests)}`);
  // claude reached Bedrock only through the broker, which added the stored token.
  assert.ok(bedrock.requests.length >= 2, JSON.stringify(bedrock.requests));
  for (const q of bedrock.requests) {
    assert.equal(q.authorization, `Bearer ${value}`, `${q.method} ${q.url} carries the stored token`);
    assert.match(q.url, /^\/(model\/|inference-profiles)/, 'the broker strips its nonce');
  }
  const own = JSON.parse(fs.readFileSync(outside, 'utf8'));
  assert.deepEqual(own.holding, [], 'claude starts with neither the stored token nor the dispatcher\'s');
  assert.equal(own.bearer, false, 'claude has no AWS_BEARER_TOKEN_BEDROCK');
  assert.equal(own.skip, '1');
  assert.match(own.url, /^http:\/\/127\.0\.0\.1:\d+\/[\w-]{20,}$/, 'claude gets the broker\'s URL and nonce');
  assert.deepEqual([...hostHolders], [], 'no process on this host holds the stored token in its environment while the agent runs');
  const seen = JSON.parse(/PROBE (.*)/.exec(bedrock.results[0].text)[1]);
  t.diagnostic(`store ${store}; the command saw ${JSON.stringify(seen)}`);
  assert.deepEqual(seen.names, [], 'the command gets neither the broker\'s URL nor a token');
  assert.deepEqual(seen.holders, [], 'no process in the sandbox holds a token in its environment');
  assert.ok(!/^status /.test(seen.broker), `the command cannot reach the broker: ${seen.broker}`);
  assert.ok(seen.secretTool.status !== 0 && !seen.secretTool.value, `the command cannot read the keyring: ${JSON.stringify(seen.secretTool)}`);
  assert.ok(seen.systemdCreds.status !== 0 && !seen.systemdCreds.value, `the command cannot decrypt systemd-creds: ${JSON.stringify(seen.systemdCreds)}`);
  assert.equal(seen.credFile, false, 'the credentials directory is hidden');
  // The broker stops with the spawn.
  const after = await new Promise((resolve) => {
    const req = require('node:http').request(`${own.url}/inference-profiles`, { timeout: 5000 }, (res) => resolve(`status ${res.statusCode}`));
    req.on('error', (e) => resolve(e.code));
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.end();
  });
  assert.equal(after, 'ECONNREFUSED', 'the broker is gone once the spawn ends');
});
