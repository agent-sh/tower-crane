'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, ROOT } = require('./helpers');
const L = require('../lib/ladder');

// Read the alias table rather than naming a release, so a swap of the shipped
// table changes no test.
const [ALIAS, RELEASE] = Object.entries(L.BUILTIN.claude_aliases)[0];
const MODEL = 'fixture-claude';

function setup(t) {
  const h = makeRepo(t);
  const home = path.join(h.base, 'user-home');
  const claude = path.join(home, '.claude');
  const aws = path.join(home, '.aws');
  const bin = path.join(h.base, 'bin');
  for (const dir of [claude, aws, bin]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude'), '', { mode: 0o755 });
  for (const key of Object.keys(h.env)) {
    if (/^(AWS_|ANTHROPIC_|CLAUDE_)/.test(key)) delete h.env[key];
  }
  Object.assign(h.env, {
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claude,
    PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''),
    NODE_OPTIONS: `--require "${path.join(__dirname, 'fixtures', 'fallback-harness.js').replace(/\\/g, '/')}"`,
    TOWER_CRANE_TEST_FALLBACK_FILE: path.join(h.base, 'attempts.json'),
    TOWER_CRANE_TEST_CLAUDE_PROVIDER: '1',
  });
  h.init();
  h.ok(['task', 'add', '--title', 'Claude provider switch', '--tier', 'hard', '--acceptance', 'fresh provider session']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Build with the original brief.\n' });
  h.primary = (provider, model = MODEL) => h.ok([
    'ladder', 'set', 'hard', '--provider', provider, '--model', model,
    '--supervision', '{"retries":1,"backoff_ms":10,"max_backoff_ms":10,"stall_ms":60000}',
  ]);
  h.fallbacks = (routes) => {
    fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
    fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { hard: { fallbacks: routes } } }));
  };
  h.login = () => fs.writeFileSync(path.join(claude, '.credentials.json'), 'stub login, never parsed\n');
  h.aws = () => {
    fs.writeFileSync(path.join(aws, 'config'), '[profile personal]\nregion = eu-west-1\n');
    fs.writeFileSync(path.join(aws, 'credentials'), 'stub credentials, never parsed\n');
    fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({
      env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'personal', ANTHROPIC_MODEL: 'us.anthropic.old-model',
        ANTHROPIC_SMALL_FAST_MODEL: 'us.anthropic.fixture-small',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.fixture-stub',
        ANTHROPIC_API_KEY: 'stub-secret-config-value' },
    }));
  };
  h.attempts = () => JSON.parse(fs.readFileSync(h.env.TOWER_CRANE_TEST_FALLBACK_FILE, 'utf8'));
  h.claude = claude;
  h.userHome = home;
  return h;
}

for (const [provider, other, model, plain] of [
  ['anthropic', 'bedrock', ALIAS, RELEASE],
  ['bedrock', 'anthropic', MODEL, MODEL],
]) {
  test(`${provider} outage exhausts retries then runs the same Claude model on ${other}`, (t) => {
    const h = setup(t);
    h.login();
    h.aws();
    h.env.CLAUDE_CODE_USE_VERTEX = '1';
    h.env.ANTHROPIC_API_KEY = 'stub-secret-env-value';
    h.env.TOWER_CRANE_TEST_FAIL_PROVIDER = provider;
    h.primary(provider, model);
    h.fallbacks([{ provider: other, model }]);
    assert.deepEqual(h.json(['ladder', 'show']).problems, []);
    const result = h.run(['spawn', '--task', 'T1', '--wait'], { timeout: 20000 });
    assert.equal(result.code, 0, result.stderr);
    const attempts = h.attempts();
    assert.deepEqual(attempts.map((a) => a.provider), [provider, provider, other]);
    assert.deepEqual(attempts.map((a) => a.retry), ['0', '1', '0']);
    assert.deepEqual(attempts.map((a) => a.model),
      [provider, provider, other].map((p) => p === 'bedrock' ? `global.anthropic.${plain}` : plain));
    assert.equal(new Set(attempts.map((a) => a.session)).size, 3);
    assert.equal(new Set(attempts.map((a) => a.args[a.args.indexOf('--session-id') + 1])).size, 3);
    for (const attempt of attempts) {
      assert.equal(attempt.args.includes('--resume'), false);
      assert.ok(attempt.args.some((arg) => arg.includes('Build with the original brief.')));
      assert.deepEqual(attempt.claim, attempts[0].claim);
      assert.equal(attempt.provider_env.CLAUDE_CODE_USE_VERTEX, '0');
      assert.equal(attempt.provider_env.CLAUDE_CODE_USE_FOUNDRY, '0');
      assert.equal(attempt.provider_env.ANTHROPIC_MODEL, attempt.model);
      if (attempt.provider === 'bedrock') {
        assert.equal(attempt.provider_env.AWS_PROFILE, 'personal');
        assert.equal(attempt.provider_env.AWS_REGION, 'eu-west-1');
        assert.equal(attempt.provider_env.AWS_CONFIG_FILE, path.join(h.userHome, '.aws', 'config'));
        assert.equal(attempt.provider_env.AWS_SHARED_CREDENTIALS_FILE, path.join(h.userHome, '.aws', 'credentials'));
      }
    }
    const entries = h.json(['task', 'show', 'T1']).spend.entries;
    assert.deepEqual(entries.map((e) => [e.provider, e.model, e.tokens]), attempts.map((a) => [a.provider, a.model, 24]));
    h.ok(['spend', 'T1', '--from-spawn', 'worker-T1-1']);
    assert.deepEqual(h.json(['task', 'show', 'T1']).spend.entries, entries);
    const stateText = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    assert.match(stateText, /provider outage after 1 retries/);
    assert.equal(stateText.includes('stub credentials'), false);
    assert.equal(stateText.includes('stub login'), false);
    assert.equal(stateText.includes('stub-secret'), false);
    const generated = fs.readFileSync(path.join(h.state, 'homes', 'worker-T1-1', 'settings.json'), 'utf8');
    assert.equal(generated.includes('us.anthropic.'), false);
    assert.equal(generated.includes('stub credentials'), false);
    assert.equal(generated.includes('stub-secret'), false);
    const home = path.join(h.state, 'homes', 'worker-T1-1');
    const pinned = JSON.parse(fs.readFileSync(path.join(home, 'tool.json'), 'utf8'));
    const events = stateText.trim().split('\n').map(JSON.parse);
    assert.deepEqual(pinned, events.find((e) => e.cmd === 'spawn').detail.tool, 'provider fallback keeps the original runtime');
    const providerFile = path.relative(ROOT, require.resolve('../lib/claude-provider'));
    assert.ok(fs.existsSync(path.join(pinned.path, providerFile)));
    for (const event of Object.values(JSON.parse(generated).hooks)) {
      assert.ok(event[0].hooks[0].command.includes(path.join(pinned.path, 'lib', 'hook-bridge.js')));
    }
  });
}

test('ladder show marks missing Claude provider config and the supervisor skips unavailable routes', (t) => {
  const h = setup(t);
  h.login();
  h.primary('anthropic');
  h.env.TOWER_CRANE_TEST_FAIL_PROVIDER = 'anthropic';
  h.fallbacks([{ provider: 'bedrock', model: MODEL }, { harness: 'command', command: [process.execPath, '-e', 'process.exit(0)', '{prompt}'] }]);
  const shown = h.json(['ladder', 'show']);
  assert.match(shown.problems.join('\n'), /hard fallback 1.*bedrock.*region.*skipped/);
  assert.match(shown.problems.join('\n'), /credentials/);
  const result = h.run(['spawn', '--task', 'T1', '--wait'], { timeout: 20000 });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /skipping fallback 1.*bedrock/);
  assert.deepEqual(h.attempts().map((a) => a.provider), ['anthropic', 'anthropic']);
  const ev = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ev.find((e) => e.cmd === 'spawn fallback').detail.route_index, 2);
});

test('missing first-party credentials are reported for primaries and skipped as fallback', (t) => {
  const h = setup(t);
  h.aws();
  h.primary('bedrock');
  h.fallbacks([{ provider: 'anthropic', model: MODEL }]);
  assert.match(h.ok(['ladder', 'show']), /cannot run: hard fallback 1.*anthropic.*credentials.*skipped/);
  h.env.TOWER_CRANE_TEST_FAIL_PROVIDER = 'bedrock';
  const result = h.run(['spawn', '--task', 'T1', '--wait'], { timeout: 20000 });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /skipping fallback 1.*anthropic/);
  h.primary('anthropic');
  assert.match(h.ok(['ladder', 'show']), /cannot run: ladder hard.*anthropic.*credentials/);
  const missing = h.run(['spawn', '--task', 'T1']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /anthropic.*credentials/);
});

test('provider checks accept only local auth presence and use global model ids', (t) => {
  const h = setup(t);
  h.primary('bedrock', 'us.anthropic.fixture-claude');
  h.env.AWS_REGION = 'eu-west-1';
  h.env.AWS_BEARER_TOKEN_BEDROCK = 'stub-secret-value';
  assert.deepEqual(h.json(['ladder', 'show']).problems, []);
  let preview = h.json(['spawn', '--task', 'T1', '--dry-run']);
  assert.equal(preview.argv[preview.argv.indexOf('--model') + 1], 'global.anthropic.fixture-claude');
  assert.equal(JSON.stringify(preview).includes('stub-secret-value'), false);
  h.primary('anthropic', 'global.anthropic.fixture-claude');
  h.env.ANTHROPIC_API_KEY = 'stub-secret-value';
  preview = h.json(['spawn', '--task', 'T1', '--dry-run']);
  assert.equal(preview.argv[preview.argv.indexOf('--model') + 1], 'fixture-claude');
  assert.equal(JSON.stringify(preview).includes('stub-secret-value'), false);
  const bad = h.run(['ladder', 'set', 'hard', '--provider', 'unknown']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /anthropic.*bedrock/);
});

test('Claude helper commands and AWS SSO config can satisfy local auth checks', (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.claude, 'settings.json'), JSON.stringify({ apiKeyHelper: 'unused stub helper' }));
  h.primary('anthropic');
  assert.deepEqual(h.json(['ladder', 'show']).problems, []);
  h.primary('bedrock');
  fs.writeFileSync(path.join(h.userHome, '.aws', 'config'), '[default]\nregion = eu-west-1\nsso_session = personal\n');
  assert.deepEqual(h.json(['ladder', 'show']).problems, []);
});

for (const provider of ['anthropic', 'bedrock']) {
  test(`${provider} readiness includes project and rung environment variable names`, (t) => {
    const h = setup(t);
    h.primary(provider);
    h.ok(['project', 'set', '--env', JSON.stringify(provider === 'bedrock'
      ? { AWS_BEARER_TOKEN_BEDROCK: 'stub-secret-project-value', AWS_REGION: 'us-east-1' }
      : { ANTHROPIC_API_KEY: 'stub-secret-project-value' })]);
    if (provider === 'bedrock') h.ok(['ladder', 'set', 'hard', '--env', '{"AWS_REGION":"eu-west-1"}']);
    assert.deepEqual(h.json(['ladder', 'show']).problems, []);
    const preview = h.json(['spawn', '--task', 'T1', '--dry-run']);
    assert.equal(JSON.stringify(preview).includes('stub-secret'), false);
    const result = h.run(['spawn', '--task', 'T1', '--wait'], { timeout: 20000 });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(h.attempts()[0].provider, provider);
    if (provider === 'bedrock') assert.equal(h.attempts()[0].provider_env.AWS_REGION, 'eu-west-1');
  });
}

test('Bedrock env_file readiness is deferred without reading the file during a dry run', (t) => {
  const h = setup(t);
  h.primary('bedrock');
  const file = path.join(h.base, 'provider.env');
  h.ok(['project', 'set', '--env_file', file]);
  // A nonexistent file makes any attempted preview read fail.
  assert.deepEqual(h.json(['ladder', 'show']).problems, []);
  const preview = h.json(['spawn', '--task', 'T1', '--dry-run']);
  assert.equal(preview.env.CLAUDE_CODE_USE_BEDROCK, '1');
  const missing = h.run(['spawn', '--task', 'T1', '--wait'], { timeout: 20000 });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /cannot read env_file/);
  fs.writeFileSync(file, 'AWS_REGION=eu-west-1\nAWS_BEARER_TOKEN_BEDROCK=stub-secret-file-value\n');
  const result = h.run(['spawn', '--task', 'T1', '--wait'], { timeout: 20000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.attempts()[0].provider_env.AWS_REGION, 'eu-west-1');
  const stored = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8')
    + fs.readFileSync(path.join(h.state, 'homes', 'worker-T1-1', 'settings.json'), 'utf8');
  assert.equal(stored.includes('stub-secret-file-value'), false);
});

for (const source of ['project env', 'rung env', 'env_file']) {
  test(`Bedrock fallback uses ${source} with no inherited AWS credentials`, (t) => {
    const h = setup(t);
    h.login();
    h.primary('anthropic');
    h.env.TOWER_CRANE_TEST_FAIL_PROVIDER = 'anthropic';
    const env = { AWS_REGION: 'eu-west-1', AWS_BEARER_TOKEN_BEDROCK: 'stub-secret-fallback-value' };
    let route = { provider: 'bedrock', model: MODEL };
    if (source === 'project env') h.ok(['project', 'set', '--env', JSON.stringify(env)]);
    else if (source === 'rung env') route.env = env;
    else {
      const file = path.join(h.base, 'fallback.env');
      fs.writeFileSync(file, Object.entries(env).map(([name, value]) => `${name}=${value}\n`).join(''));
      route.env_file = file;
      // User routing defaults must not override the file at launch.
      fs.writeFileSync(path.join(h.claude, 'settings.json'), JSON.stringify({
        env: { AWS_REGION: 'us-east-1', AWS_PROFILE: 'unused' },
      }));
    }
    h.fallbacks([route]);
    assert.deepEqual(h.json(['ladder', 'show']).problems, []);
    const result = h.run(['spawn', '--task', 'T1', '--wait'], { timeout: 20000 });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(h.attempts().map((a) => a.provider), ['anthropic', 'anthropic', 'bedrock']);
    assert.equal(h.attempts()[2].provider_env.AWS_REGION, 'eu-west-1');
  });
}
