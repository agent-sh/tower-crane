'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture, BIN, ROOT, TMP_ROOT } = require('./helpers');

function auditCli(run, timings, now) {
  return (args, options = {}) => {
    const spawn = cp.spawnSync;
    let launches = 0;
    let timeout;
    // Observe the options the helper actually passes to Node, including bootstrap.
    cp.spawnSync = function parentCli(file, argv, spawnOptions) {
      if (file === process.execPath && argv.includes(BIN)) {
        launches++;
        timeout = spawnOptions.timeout;
        assert.equal(timeout, 0, 'parent provider CLI has no per-call deadline');
      }
      return spawn.call(this, file, argv, spawnOptions);
    };
    const start = now();
    try {
      const result = run(args, { ...options, timeout: 0 });
      assert.equal(launches, 1, 'audit observes the real parent CLI launch');
      return result;
    } finally {
      cp.spawnSync = spawn;
      timings.push({ command: args.slice(0, 2).join(' '), ms: Math.round(now() - start), timeout });
    }
  };
}

const L = require('../lib/ladder');
const P = require('../lib/claude-provider');

// Read the alias table rather than naming a release, so a swap of the shipped
// table changes no test.
const [ALIAS, RELEASE] = Object.entries(L.BUILTIN.claude_aliases)[0];
const MODEL = 'fixture-claude';

function setup(t) {
  const now = () => Number(process.hrtime.bigint()) / 1e6;
  const started = now();
  const bootstrap = [];
  const h = cachedFixture(null, 'claude-provider', (base) => {
    base.env.TOWER_CRANE_TEST_CLAUDE_PROVIDER = '1';
    base.env.NODE_OPTIONS = `--require "${path.join(__dirname, 'fixtures', 'fallback-harness.js').replace(/\\/g, '/')}"`;
    base.run = auditCli(base.run, bootstrap, now);
    base.init();
    base.ok(['task', 'add', '--title', 'Claude provider switch', '--tier', 'hard', '--acceptance', 'fresh provider session']);
    base.ok(['brief', 'set', 'T1', '-'], { input: 'Build with the original brief.\n' });
  });
  const repoMs = now() - started;
  const commands = [];
  h.profiles = () => {
    const file = h.env.TOWER_CRANE_TEST_PROVIDER_TRACE;
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  };
  t.after(async () => {
    try {
      const processes = new Map();
      const children = new Map();
      const profiles = h.profiles();
      const delays = profiles.filter((profile) => profile.process === 'spawn-monitor.js').flatMap((profile) => profile.delays);
      const timeouts = [...new Set(profiles.flatMap((profile) => profile.children.map((child) => child.timeout)))];
      const parentTimeouts = [...new Set([...bootstrap, ...commands].map((command) => command.timeout))];
      assert.deepEqual(parentTimeouts, [0], 'parent provider commands have no deadline');
      assert.ok(delays.every((ms) => ms === 0), 'provider fixtures schedule no timed wait');
      assert.ok(timeouts.every((ms) => ms === 0), 'provider subprocesses have no deadline');
      assert.ok(profiles.every((profile) => profile.children.every((child) =>
        !/^gh(?:\.exe|\.cmd|\.bat)?$/i.test(child.process))), 'provider fixtures need no credential helper');
      for (const profile of profiles) {
        for (const [map, entries] of [[processes, [profile]], [children, profile.children]]) {
          for (const entry of entries) {
            const item = map.get(entry.process) || { process: entry.process, count: 0, ms: 0 };
            item.count++;
            item.ms += entry.ms || 0;
            map.set(entry.process, item);
          }
        }
      }
      const rounded = (items) => [...items.values()].map((item) => ({ ...item, ms: Math.round(item.ms) }));
      t.diagnostic(JSON.stringify({ repo_ms: Math.round(repoMs), bootstrap, commands, processes: rounded(processes), children: rounded(children), delays, timeouts, parent_timeouts: parentTimeouts }));
    } finally { await h.cleanup(); }
  });
  // Completion and attempt records decide success; CI owns the suite deadline.
  h.run = auditCli(h.run, commands, now);
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
    // Provider routing needs no credential-helper process.
    GH_TOKEN: 'stub-secret-gh-token',
    PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''),
    NODE_OPTIONS: `--require "${path.join(__dirname, 'fixtures', 'fallback-harness.js').replace(/\\/g, '/')}"`,
    TOWER_CRANE_TEST_FALLBACK_FILE: path.join(h.base, 'attempts.json'),
    TOWER_CRANE_TEST_CLAUDE_PROVIDER: '1',
    TOWER_CRANE_TEST_PROVIDER_TRACE: path.join(h.base, 'processes.jsonl'),
  });
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

function assertRetry(h) {
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const retries = events.filter((e) => e.cmd === 'spawn phase' && e.detail.phase === 'retrying');
  assert.deepEqual(retries.map((e) => [e.detail.retry, e.detail.backoff_ms]), [[1, 0]]);
  assert.equal(events.filter((e) => e.cmd === 'spawn retry').length, 1);
  const profiles = h.profiles();
  const monitors = profiles.filter((profile) => profile.process === 'spawn-monitor.js');
  assert.equal(monitors.length, 1);
  assert.deepEqual(monitors[0].delays, [0]);
  assert.ok(profiles.every((profile) => profile.children.every((child) => child.timeout === 0)));
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
    h.env.CLAUDE_CODE_USE_ANTHROPIC_AWS = '1';
    h.env.CLAUDE_CODE_USE_GATEWAY = '1';
    h.env.CLAUDE_CODE_USE_MANTLE = '1';
    h.env.ANTHROPIC_API_KEY = 'stub-secret-env-value';
    h.env.TOWER_CRANE_TEST_FAIL_PROVIDER = provider;
    h.primary(provider, model);
    h.fallbacks([{ provider: other, model }]);
    assert.deepEqual(h.json(['ladder', 'show']).problems, []);
    const result = h.run(['spawn', '--task', 'T1', '--wait']);
    assert.equal(result.code, 0, result.stderr);
    const attempts = h.attempts();
    assert.deepEqual(attempts.map((a) => a.provider), [provider, provider, other]);
    assert.deepEqual(attempts.map((a) => a.retry), ['0', '1', '0']);
    assertRetry(h);
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
      assert.equal(attempt.provider_env.CLAUDE_CODE_USE_ANTHROPIC_AWS, '0');
      assert.equal(attempt.provider_env.CLAUDE_CODE_USE_GATEWAY, '0');
      // Mantle is a Bedrock endpoint, so only the first-party pin turns it off.
      assert.equal(attempt.provider_env.CLAUDE_CODE_USE_MANTLE, attempt.provider === 'bedrock' ? '1' : '0');
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
    for (const [name, event] of Object.entries(JSON.parse(generated).hooks)) {
      const script = name === 'PreToolUse' ? 'read-guard.js' : 'hook-bridge.js';
      assert.ok(event[0].hooks[0].command.includes(path.join(pinned.path, 'lib', script)), name);
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
  const result = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /skipping fallback 1.*bedrock/);
  assert.deepEqual(h.attempts().map((a) => a.provider), ['anthropic', 'anthropic']);
  assert.deepEqual(h.attempts().map((a) => a.retry), ['0', '1']);
  assertRetry(h);
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
  const result = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /skipping fallback 1.*anthropic/);
  assert.deepEqual(h.attempts().map((a) => [a.provider, a.retry]), [['bedrock', '0'], ['bedrock', '1']]);
  assertRetry(h);
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

test('a Claude alias on a Bedrock rung maps to its global id or is refused at ladder set', (t) => {
  const h = setup(t);
  h.aws();
  const table = L.BUILTIN.claude_aliases;
  // haiku is the name the incident sent, so it stays in the list when the table lacks it.
  for (const alias of new Set([...Object.keys(table), 'haiku'])) {
    const set = h.run(['ladder', 'set', 'hard', '--provider', 'bedrock', '--model', alias]);
    if (!Object.hasOwn(table, alias)) {
      assert.equal(set.code, 1, alias);
      assert.match(set.stderr, /full model id/, alias);
      continue;
    }
    assert.equal(set.code, 0, set.stderr);
    const preview = h.json(['spawn', '--task', 'T1', '--dry-run']);
    assert.equal(preview.argv[preview.argv.indexOf('--model') + 1], `global.anthropic.${table[alias]}`, alias);
  }
  // The shipped table fills only the pins the user did not set.
  assert.equal(h.json(['spawn', '--task', 'T1', '--dry-run']).env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'global.anthropic.fixture-stub');
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
    const result = h.run(['spawn', '--task', 'T1', '--wait']);
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
  const missing = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /cannot read env_file/);
  fs.writeFileSync(file, 'AWS_REGION=eu-west-1\nAWS_BEARER_TOKEN_BEDROCK=stub-secret-file-value\n');
  const result = h.run(['spawn', '--task', 'T1', '--wait']);
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
    const result = h.run(['spawn', '--task', 'T1', '--wait']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(h.attempts().map((a) => a.provider), ['anthropic', 'anthropic', 'bedrock']);
    assert.deepEqual(h.attempts().map((a) => a.retry), ['0', '1', '0']);
    assertRetry(h);
    assert.equal(h.attempts()[2].provider_env.AWS_REGION, 'eu-west-1');
  });
}

test('a Bedrock switch in the user settings file bills a rung that names no provider as api', () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'claude-provider-billing-')));
  const from = { claude: { dir: path.join(base, 'claude') } };
  fs.mkdirSync(from.claude.dir, { recursive: true });
  fs.writeFileSync(path.join(from.claude.dir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
  assert.equal(L.billing({ harness: 'claude' }, {}), 'subscription', 'the launch environment alone does not show the route');
  assert.equal(L.billing({ harness: 'claude' }, P.routedEnv({}, from)), 'api');
});

test('Claude billing follows Claude Code credential precedence on the first-party route', () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'claude-provider-helper-')));
  const from = { claude: { dir: path.join(base, 'claude') } };
  fs.mkdirSync(from.claude.dir, { recursive: true });
  assert.equal(L.billing({ harness: 'claude' }, {}, from), 'subscription', 'no settings file is a login');
  fs.writeFileSync(path.join(from.claude.dir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'print-key' }));
  for (const rung of [{ harness: 'claude' }, { harness: 'claude', provider: 'anthropic' }]) {
    assert.equal(L.billing(rung, P.routedEnv({}, from), from), 'api');
    // apiKeyHelper ranks above a long-lived OAuth token.
    assert.equal(L.billing(rung, P.routedEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fixture' }, from), from), 'api');
  }
  fs.writeFileSync(path.join(from.claude.dir, 'settings.json'), '{}');
  const profile = { ANTHROPIC_PROFILE: 'fixture' };
  const federation = { ANTHROPIC_FEDERATION_RULE_ID: 'fixture', ANTHROPIC_ORGANIZATION_ID: 'fixture' };
  assert.equal(L.billing({ harness: 'claude' }, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture' }, from), 'subscription');
  assert.equal(L.billing({ harness: 'claude' }, profile, from), 'api', 'a named profile is a Console login');
  assert.equal(L.billing({ harness: 'claude' }, federation, from), 'api', 'federation credentials are a Console login');
  assert.equal(L.billing({ harness: 'claude' }, { ANTHROPIC_FEDERATION_RULE_ID: 'fixture' }, from), 'subscription', 'federation needs both variables');
  assert.equal(L.billing({ harness: 'claude' }, { ...profile, CLAUDE_CODE_OAUTH_TOKEN: 'fixture' }, from), 'subscription', 'an OAuth token ranks above profiles');
});
