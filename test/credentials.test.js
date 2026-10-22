'use strict';

// Provider credentials in the OS store (lib/credentials.js): the helper a
// harness runs, the credentials commands, spawn's preflight, the codex auth
// command, the Bedrock broker and the login-failure reading of a helper's
// errors. Every value here is fake, and every store entry a test makes is
// named tc-test-fake-* and removed by that test.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const cp = require('node:child_process');
const TOML = require('../lib/toml');
// The store layout, as the owner's docs give it (docs/state.md#credentials):
// Secret Service items under service=tower-crane, systemd-creds files in
// credentials/ beside the user file.
const SERVICE = 'tower-crane';
const credentialsDir = (file) => path.join(path.dirname(file), 'credentials');
const credFile = (file, name) => path.join(credentialsDir(file), `${name}.cred`);
const { makeRepo } = require('./helpers');
const { NO_STUBS, setup, spawn } = require('./isolation-helpers');

const HELPER = path.join(__dirname, '..', 'lib', 'credential-helper.js');
const fakeName = (what) => `tc-test-fake-${what}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
const fakeValue = (what) => `tc-test-fake-value-${what}-${crypto.randomBytes(6).toString('hex')}`;

// Why systemd-creds --user cannot hold a credential here, or false.
const SYSTEMD_CREDS = (() => {
  if (process.platform !== 'linux') return 'systemd-creds is Linux only';
  const r = cp.spawnSync('systemd-creds', ['--user', 'encrypt', '--name=tc-test-fake-probe', '-', '-'], { input: 'tc-test-fake-probe', timeout: 30000 }); // wait-allow: backstop for a credential service that never answers
  if (r.error) return `systemd-creds: ${r.error.code}`;
  return r.status === 0 ? false : `systemd-creds --user does not encrypt here: ${String(r.stderr).trim()}`;
})();

// Why the Secret Service cannot hold a throwaway entry here, or false.
const SECRET_SERVICE = (() => {
  if (process.platform !== 'linux') return 'the Secret Service store is Linux only';
  const name = fakeName('probe');
  const r = cp.spawnSync('secret-tool', ['store', '--label=tc-test-fake-probe', 'service', SERVICE, 'name', name], { input: 'tc-test-fake-probe', timeout: 30000 }); // wait-allow: backstop for a keyring that never answers
  cp.spawnSync('secret-tool', ['clear', 'service', SERVICE, 'name', name], { timeout: 30000 }); // wait-allow: same backstop
  if (r.error) return `secret-tool: ${r.error.code}`;
  return r.status === 0 ? false : `no unlocked keyring: ${String(r.stderr).trim()}`;
})();

function storeSystemdCreds(file, name, value) {
  const dir = credentialsDir(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const r = cp.spawnSync('systemd-creds', ['--user', 'encrypt', `--name=${name}`, '-', credFile(file, name)], { input: value });
  assert.equal(r.status, 0, String(r.stderr));
}

function storeSecretService(t, name, value) {
  const r = cp.spawnSync('secret-tool', ['store', `--label=${name}`, 'service', SERVICE, 'name', name], { input: value });
  assert.equal(r.status, 0, String(r.stderr));
  t.after(() => cp.spawnSync('secret-tool', ['clear', 'service', SERVICE, 'name', name]));
}

const helper = (args, env) => cp.spawnSync(process.execPath, [HELPER, ...args], { env, encoding: 'utf8' });

test('the credential helper prints a value from a systemd-creds file and nothing else, and its errors never hold it', { skip: SYSTEMD_CREDS }, (t) => {
  const dir = fs.mkdtempSync(path.join(require('./helpers').TMP_ROOT, 'creds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const name = fakeName('creds');
  const value = fakeValue('creds');
  storeSystemdCreds(file, name, value);
  const env = { ...process.env, TOWER_CRANE_CONFIG: path.join(dir, 'elsewhere.json') };
  const r = helper(['value', name, '--config', file, '--session-bus'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, value, 'the value, with no line break');
  assert.equal(r.stderr, '');
  assert.equal(helper(['check', name, '--config', file], env).stdout, '', 'check prints nothing on stdout');
  assert.equal(helper(['check', name, '--config', file], env).status, 0);
  // A file encrypted under another name is refused, and the refusal holds no value.
  fs.copyFileSync(credFile(file, name), credFile(file, `${name}-copy`));
  const copied = helper(['value', `${name}-copy`, '--config', file, '--session-bus'], env);
  assert.equal(copied.status, 1);
  assert.equal(copied.stdout, '');
  assert.match(copied.stderr, /tower-crane credential .* cannot be read \(systemd-creds: /);
  assert.ok(!copied.stderr.includes(value));
  const missing = helper(['value', `${name}-missing`, '--config', file, '--session-bus'], env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /is not stored \(systemd-creds: not stored\); store it with tower-crane credentials set /);
});

test('the credential helper prints a value from the Secret Service', { skip: SECRET_SERVICE }, (t) => {
  const dir = fs.mkdtempSync(path.join(require('./helpers').TMP_ROOT, 'creds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const name = fakeName('keyring');
  const value = fakeValue('keyring');
  storeSecretService(t, name, value);
  // A harness may start the helper with neither bus variable; the runtime
  // directory of the uid finds the bus.
  const env = { ...process.env };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.XDG_RUNTIME_DIR;
  const r = helper(['value', name, '--config', file], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, value);
  // With the session bus granted to the sandbox, only systemd-creds is read.
  const bus = helper(['value', name, '--config', file, '--session-bus'], env);
  assert.equal(bus.status, 1);
  assert.match(bus.stderr, /is not stored \(systemd-creds: not stored\)/);
  fs.writeFileSync(file, JSON.stringify({ credentials: { [name]: { store: 'secret-service' } } }));
  assert.match(helper(['value', name, '--config', file, '--session-bus'], env).stderr, /sandbox\.session_bus puts that store in reach of the agent's commands/);
});

// The CLI's store tools run through recording wrappers, so the test sees
// every argv the value could have reached.
function recordingTools(h) {
  const bin = path.join(h.base, 'store-tools');
  const log = path.join(h.base, 'store-argv.log');
  fs.mkdirSync(bin);
  for (const tool of ['systemd-creds', 'secret-tool']) {
    const real = cp.spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (!real) continue;
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  }
  return { env: { ...h.env, PATH: `${bin}${path.delimiter}${h.env.PATH}` }, log };
}

// Every file under dir holding value, so nothing written there keeps it.
function holders(dir, value) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(e.parentPath ?? e.path, e.name);
    if (e.isFile() && fs.readFileSync(p).includes(value)) out.push(p);
  }
  return out;
}

test('credentials set reads the value from stdin and it never reaches argv, events, logs or project.json', { skip: SYSTEMD_CREDS }, (t) => {
  const h = makeRepo(t);
  h.init();
  const name = fakeName('set');
  const value = fakeValue('set');
  const { env, log } = recordingTools(h);
  const out = h.json(['credentials', 'set', name, '--store', 'systemd-creds'], { env, input: `${value}\n` });
  assert.deepEqual(out, { name, store: 'systemd-creds' });
  assert.equal(helper(['value', name, '--config', h.env.TOWER_CRANE_CONFIG, '--session-bus'], h.env).stdout, value, 'stored without the line break');
  assert.equal(fs.statSync(credFile(h.env.TOWER_CRANE_CONFIG, name)).mode & 0o777, 0o600);
  // Rotation replaces the value in place.
  const rotated = fakeValue('rotated');
  h.ok(['credentials', 'set', name, '--store', 'systemd-creds'], { env, input: rotated });
  assert.equal(helper(['value', name, '--config', h.env.TOWER_CRANE_CONFIG, '--session-bus'], h.env).stdout, rotated);
  const argv = fs.readFileSync(log, 'utf8');
  assert.match(argv, /^systemd-creds --user encrypt --name=tc-test-fake-set-/m, 'the store tool ran');
  for (const v of [value, rotated]) {
    assert.ok(!argv.includes(v), 'no store tool got the value on its argv');
    assert.deepEqual(holders(h.state, v), [], 'no state file, event or log holds the value');
  }
  assert.ok(!fs.readFileSync(credFile(h.env.TOWER_CRANE_CONFIG, name)).includes(rotated), 'the file holds it encrypted');
  const checked = h.run(['credentials', 'check', name], { env });
  assert.equal(checked.code, 0, checked.stderr);
  assert.equal(checked.stdout.trim(), `${name}: stored in systemd-creds`);
  assert.equal(h.ok(['credentials', 'rm', name], { env }), `removed credential ${name} from systemd-creds`);
  assert.equal(h.run(['credentials', 'check', name], { env }).code, 1);
  // An empty value is refused, and a task process manages no credential.
  assert.match(h.run(['credentials', 'set', name, '--store', 'systemd-creds'], { env, input: '\n' }).stderr, /the credential value is empty/);
  assert.match(h.run(['credentials', 'set', name], { env: { ...env, TOWER_CRANE_TASK: 'T1' }, input: value }).stderr, /a task process never manages credentials/);
});

test('credentials import stores one variable of an env file under a name', { skip: SYSTEMD_CREDS }, (t) => {
  const h = makeRepo(t);
  const value = fakeValue('import');
  const envFile = path.join(h.base, 'bedrock.env');
  fs.writeFileSync(envFile, `CLAUDE_CODE_USE_BEDROCK=1\nAWS_BEARER_TOKEN_BEDROCK="${value}"\n`, { mode: 0o600 });
  const name = fakeName('import');
  const { env, log } = recordingTools(h);
  const r = h.run(['credentials', 'import', '--env-file', envFile, '--var', 'AWS_BEARER_TOKEN_BEDROCK', '--name', name, '--store', 'systemd-creds'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`stored credential ${name} in systemd-creds from AWS_BEARER_TOKEN_BEDROCK in .*bedrock\\.env; remove that line`));
  assert.equal(helper(['value', name, '--config', h.env.TOWER_CRANE_CONFIG, '--session-bus'], h.env).stdout, value);
  assert.ok(!fs.readFileSync(log, 'utf8').includes(value));
  assert.match(h.run(['credentials', 'import', '--env-file', envFile, '--var', 'MISSING', '--name', name], { env }).stderr, /sets no MISSING/);
});

// A codex route on Bedrock: its provider runs the helper for the bearer
// token, in config.toml and in a profile file that defines the provider.
test('a codex rung that names a credential gets the helper as its provider auth command and starts without the bearer token', { skip: NO_STUBS || SYSTEMD_CREDS }, (t) => {
  const { h, u } = setup(t);
  fs.writeFileSync(path.join(u.home, '.codex', 'fixture-bedrock.config.toml'), [
    'model = "fixture-model"', 'model_provider = "amazon-bedrock"', '',
    '[model_providers.amazon-bedrock]', 'base_url = "http://127.0.0.1:9/fake"', '',
    '[model_providers.amazon-bedrock.aws]', 'region = "us-east-1"', '',
  ].join('\n'));
  const name = fakeName('codex');
  const value = fakeValue('codex');
  // The user file sits in the dispatcher's home; the stand-in user's is another.
  const config = h.env.TOWER_CRANE_CONFIG;
  storeSystemdCreds(config, name, value);
  fs.writeFileSync(config, JSON.stringify({ credentials: { [name]: { store: 'systemd-creds' } } }));
  h.ok(['ladder', 'set', 'small', '--harness', 'codex', '--profile', 'fixture-bedrock', '--clear', 'model', '--clear', 'effort', '--clear', 'args', '--credential', name]);
  const started = spawn(h, u, 'small', { AWS_BEARER_TOKEN_BEDROCK: 'tc-test-fake-dispatcher-token', TOWER_CRANE_CONFIG: config });
  const seen = u.report();
  const home = path.join(h.state, 'homes', started.agent);
  const argv = [process.execPath, path.join(started.tool.path, 'lib', 'credential-helper.js'), 'value', name, '--config', config];
  const auth = { command: argv[0], args: argv.slice(1) };
  assert.deepEqual(seen.config.model_providers['amazon-bedrock'].auth, auth, 'config.toml names the helper on the route\'s provider');
  const profile = JSON.parse(JSON.stringify(TOML.parse(fs.readFileSync(path.join(home, 'fixture-bedrock.config.toml'), 'utf8'))));
  assert.deepEqual(profile.model_providers['amazon-bedrock'], { base_url: 'http://127.0.0.1:9/fake', aws: { region: 'us-east-1' }, auth }, 'the profile keeps its provider and gains the command');
  assert.equal(TOML.parse(fs.readFileSync(path.join(home, 'fixture-main.config.toml'), 'utf8')).model_providers.r.auth, undefined, 'a profile of another provider is left as it was');
  assert.equal(seen.env, null, 'no .env in the home');
  assert.ok(!fs.existsSync(path.join(home, '.env')));
  assert.ok(!seen.envNames.includes('AWS_BEARER_TOKEN_BEDROCK'), 'codex starts without the dispatcher\'s bearer token');
  // The command codex would run prints the value.
  const r = cp.spawnSync(auth.command, auth.args, { encoding: 'utf8', env: { ...process.env, HOME: path.join(home, 'home') } });
  assert.equal(r.stdout, value, r.stderr);
  assert.deepEqual(holders(h.state, value), [], 'the home holds the command, never the value');
});

test('spawn refuses a route whose credential the store cannot give, and ladder show names it', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const name = fakeName('absent');
  h.ok(['ladder', 'set', 'small', '--harness', 'claude', '--model', 'claude-haiku-5-5', '--provider', 'bedrock', '--clear', 'profile', '--clear', 'effort', '--clear', 'args', '--credential', name]);
  // The store holds nothing by this name: an empty credentials directory and
  // a user file that names systemd-creds alone, so no keyring is asked.
  fs.writeFileSync(h.env.TOWER_CRANE_CONFIG, JSON.stringify({ credentials: { [name]: { store: 'systemd-creds' } } }));
  const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json'], { env: { ...u.env, TOWER_CRANE_CONFIG: h.env.TOWER_CRANE_CONFIG } });
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, new RegExp(`tower-crane credential ${name} is not stored \\(systemd-creds: not stored\\); store it with tower-crane credentials set ${name}`));
  assert.ok(!fs.existsSync(u.out), 'no harness started');
  const show = h.json(['ladder', 'show'], { env: { ...u.env, TOWER_CRANE_CONFIG: h.env.TOWER_CRANE_CONFIG } });
  assert.ok(show.problems.some((p) => p.startsWith(`ladder small: tower-crane credential ${name} is not stored`)), show.problems.join('\n'));
  // A credential is a rung field only claude, with a provider, and codex take.
  assert.match(h.run(['ladder', 'set', 'small', '--clear', 'provider']).stderr, /credential on claude needs provider bedrock or anthropic/);
});

test('ladder show names a credential read from an env file and an env_file on every rung that has one', { skip: NO_STUBS }, (t) => {
  const { h } = setup(t);
  const name = fakeName('envstore');
  const envFile = path.join(h.base, 'fallback.env');
  fs.writeFileSync(envFile, `AWS_BEARER_TOKEN_BEDROCK=${fakeValue('envstore')}\n`, { mode: 0o600 });
  fs.writeFileSync(h.env.TOWER_CRANE_CONFIG, JSON.stringify({ credentials: { [name]: { store: 'env', env_file: envFile, var: 'AWS_BEARER_TOKEN_BEDROCK' } } }));
  h.ok(['ladder', 'set', 'small', '--harness', 'claude', '--model', 'claude-haiku-5-5', '--provider', 'bedrock', '--clear', 'profile', '--credential', name]);
  h.ok(['ladder', 'set', 'review', '--env_file', envFile]);
  const text = h.ok(['ladder', 'show']);
  assert.match(text, new RegExp(`notice: ladder small: credential ${name} reads AWS_BEARER_TOKEN_BEDROCK from .*fallback\\.env \\(store env, the per-machine fallback`));
  assert.match(text, /notice: ladder review: env_file .*fallback\.env puts its variables in the harness environment/);
  assert.ok(!/cannot run: ladder small/.test(text), text);
  // A malformed credentials entry in the user file is refused by name.
  fs.writeFileSync(h.env.TOWER_CRANE_CONFIG, JSON.stringify({ credentials: { [name]: { store: 'env' } } }));
  assert.match(h.run(['ladder', 'show']).stderr, /store env needs env_file/);
});

// The broker the supervisor runs for claude on Bedrock: the bearer from the
// store on each forwarded request, only under its nonce and only for
// claude's two calls, with the upstream's status, headers and body.
test('the Bedrock broker adds the stored bearer token and forwards only claude\'s calls under its nonce', { skip: SYSTEMD_CREDS }, async (t) => {
  const dir = fs.mkdtempSync(path.join(require('./helpers').TMP_ROOT, 'creds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const name = fakeName('broker');
  const value = fakeValue('broker');
  storeSystemdCreds(file, name, value);
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, apiKey: req.headers['x-api-key'], body });
      res.writeHead(201, { 'content-type': 'application/vnd.amazon.eventstream', 'x-fake': 'kept' });
      res.write('part-1;');
      setTimeout(() => res.end('part-2'), 20); // wait-allow: a second chunk after a pause shows the broker streams the body
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const broker = await require('../lib/bedrock-broker').start({ env: process.env });
  t.after(() => broker.close());
  const call = (method, url, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{"fake":true}' : undefined);
  });
  assert.equal((await call('POST', `${broker.url}/model/x/invoke`)).status, 403, 'no route is running yet');
  broker.target({ name, config: file, session_bus: true, base_url: `http://127.0.0.1:${upstream.address().port}/prefix`, region: 'us-east-1' });
  const r = await call('POST', `${broker.url}/model/global.anthropic.fake/invoke-with-response-stream?x=1`, { authorization: 'Bearer agent-supplied', 'x-api-key': 'agent-key' });
  assert.equal(r.status, 201);
  assert.equal(r.headers['x-fake'], 'kept');
  assert.equal(r.body, 'part-1;part-2');
  assert.deepEqual(seen.at(-1), { method: 'POST', url: '/prefix/model/global.anthropic.fake/invoke-with-response-stream?x=1', auth: `Bearer ${value}`, apiKey: undefined, body: '{"fake":true}' });
  assert.equal((await call('GET', `${broker.url}/inference-profiles?type=SYSTEM_DEFINED`)).status, 201);
  assert.equal(seen.at(-1).url, '/prefix/inference-profiles?type=SYSTEM_DEFINED');
  const port = new URL(broker.url).port;
  for (const [method, url] of [['POST', `http://127.0.0.1:${port}/model/x/invoke`], ['POST', `http://127.0.0.1:${port}/wrong-nonce/model/x/invoke`],
    ['DELETE', `${broker.url}/model/x`], ['GET', `${broker.url}/foundation-models`], ['POST', `${broker.url}/inference-profiles`]]) {
    const denied = await call(method, url);
    assert.equal(denied.status, 404, `${method} ${url}`);
    assert.ok(!denied.body.includes(value));
  }
  assert.equal(seen.length, 2, 'nothing else reached Bedrock');
  // A credential the store cannot give is refused with the helper's reason.
  broker.target({ name: `${name}-missing`, config: file, session_bus: true, base_url: `http://127.0.0.1:${upstream.address().port}`, region: 'us-east-1' });
  const missing = await call('POST', `${broker.url}/model/x/invoke`);
  assert.equal(missing.status, 403);
  assert.match(JSON.parse(missing.body).message, /tower-crane credential .*-missing is not stored/);
});

// What a harness prints when its credential helper fails is a login outage,
// on the stream each harness prints it on.
test('a failing credential helper reads as a harness login failure', () => {
  const { errorReader } = require('../lib/spawn-monitor');
  const cases = [
    ['claude', false, { type: 'result', is_error: true, result: 'apiKeyHelper failed: exited 1: tower-crane credential x is not stored' }],
    ['claude', false, { type: 'result', is_error: true, result: 'Your apiKeyHelper script is failing · Run /status to see the script\'s error output' }],
    ['claude', false, { type: 'result', is_error: true, result: 'awsCredentialExport did not return a valid value' }],
    ['claude', false, { type: 'result', is_error: true, result: 'Error getting AWS credentials from awsCredentialExport' }],
    ['claude', false, { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 403 {"message":"tower-crane credential x cannot be read (Secret Service: locked)"}' }] } }],
    ['codex', false, { type: 'error', message: 'Failed to resolve external auth: provider auth command `node` exited with status 1: tower-crane credential x is not stored' }],
    ['codex', true, 'AWS credential export command failed'],
  ];
  for (const [harness, stderr, line] of cases) {
    let auth = null;
    const read = errorReader(harness, stderr, (_outage, a) => { auth ||= a; });
    read(Buffer.from(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`), true);
    assert.ok(auth, `${harness}: ${JSON.stringify(line)}`);
  }
  // Agent output that quotes the phrase is not the harness failing.
  let auth = null;
  errorReader('claude', false, (_o, a) => { auth ||= a; })(Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'apiKeyHelper failed' }] } })}\n`), true);
  assert.equal(auth, null);
});

test('the store order follows the platform, the user file and the session bus grant', () => {
  const Credentials = require('../lib/credentials');
  const at = { file: '/fake/config.json' };
  assert.deepEqual(Credentials.order('n', { store: 'auto' }, { ...at, platform: 'linux' }), ['secret-service', 'systemd-creds']);
  assert.deepEqual(Credentials.order('n', { store: 'auto' }, { ...at, platform: 'linux', sessionBus: true }), ['systemd-creds']);
  assert.deepEqual(Credentials.order('n', { store: 'auto' }, { ...at, platform: 'darwin' }), [], 'the untested Keychain stays off by default');
  assert.deepEqual(Credentials.order('n', { store: 'auto' }, { ...at, platform: 'win32' }), []);
  assert.deepEqual(Credentials.order('n', { store: 'keychain' }, { ...at, platform: 'darwin' }), ['keychain']);
  assert.deepEqual(Credentials.order('n', { store: 'systemd-creds' }, { ...at, platform: 'linux', sessionBus: true }), ['systemd-creds']);
  assert.throws(() => Credentials.order('n', { store: 'secret-service' }, { ...at, platform: 'linux', sessionBus: true }), /sandbox\.session_bus puts that store in reach/);
  assert.throws(() => Credentials.read('n', { file: at.file, platform: 'darwin' }), /macOS Keychain support is untested and off by default; opt in with "credentials": \{"n": \{"store": "keychain"\}\}/);
  assert.deepEqual(Credentials.configErrors({ ok: { store: 'systemd-creds' }, 'bad name': {}, x: { store: 'nope' }, y: { store: 'env' }, z: { var: 'V' } }), [
    'credentials.bad name: a credential name is 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit',
    'credentials.x.store must be auto, secret-service, systemd-creds, keychain, wincred, env',
    'credentials.y: store env needs env_file, the file that holds the value',
    'credentials.y: store env needs var, the variable in env_file that holds the value',
    'credentials.z: env_file and var apply only to store env',
  ]);
});
