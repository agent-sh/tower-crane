'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, makeProjectRepo, cachedFixture, BIN, runPty, PTY_AVAILABLE } = require('./helpers');
const { gateFixture, gateEvidence, changeKind } = require('./gate-helpers');

const prices = {
  'openai.gpt-6-luna': { input: 0.10, cache_write: 0.125, cache_read: 0.01, output: 0.50 },
  'openai.gpt-6.1-sol': { input: 2, cache_write: 2.50, cache_read: 0.10, output: 10 },
  'claude-opus-5-5': { input: 4, cache_write: 5, cache_read: 0.20, output: 20 },
};
const windowsConcurrency = process.platform === 'win32' ? 2 : false;

function rung(h, name, model) {
  h.ok(['ladder', 'set', name, '--harness', 'opencode', '--model', model, '--clear', 'profile', '--clear', 'effort']);
}

// Built once per process for each combination and copied for each test.
// gated adds passing tests and clean evidence at the submitted sha.
function setup(t, tier = 'easy', builder = 'other', profile, { gated = false } = {}) {
  return cachedFixture(t, JSON.stringify([tier, builder, profile ?? null, gated]), (h) => {
    h.init(['--repo', 'acme/demo']);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'value becomes one', '--tier', tier]);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'BUILDER-HISTORY that the reviewer does not need\n\n## Reviewer\nREVIEWER-ONLY instruction\n\n## Worker\nWORKER-HISTORY that the reviewer does not need\n' });
    h.sha = gateFixture(h);
    if (profile) {
      const bin = path.join(h.base, 'bin');
      const codexHome = path.join(h.base, 'codex');
      fs.mkdirSync(bin);
      fs.mkdirSync(codexHome);
      fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex'), '', { mode: 0o755 });
      // An isolated caller's default must not rename another rung's known profile.
      fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "caller-model"\n');
      h.reviewEnv = { CODEX_HOME: codexHome, PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''), USAGE_CLAIM: '1' };
      h.ok(['ladder', 'set', tier, '--harness', 'codex', '--profile', profile, '--clear', 'model', '--clear', 'effort']);
      h.builder = h.json(['spawn', '--task', 'T1', '--wait'], {
        env: h.reviewEnv,
        hooks: { HOOK_USAGE_HARNESS: 'codex', HOOK_USAGE_FILE: path.join(__dirname, 'fixtures', 'usage', 'codex-stream.jsonl') },
      }).agent;
    } else {
      h.builder = 'builder';
      h.ok(['claim', 'T1', '--agent', h.builder]);
    }
    h.ok(['spend', 'T1', '--agent', h.builder, '--tokens', '10', '--input', '10', '--output', '0', '--rung', tier, '--model', builder]);
    h.ok(['submit', 'T1', '--agent', h.builder, '--sha', h.sha, '--branch', 'fixture-change']);
    for (const [name, model] of [['easy', 'luna'], ['medium', 'sol'], ['hard', 'opus'], ['research', 'opus'], ['review', 'fallback']]) rung(h, name, model);
    if (profile) for (const [name, value] of [['easy', 'luna'], ['medium', 'sol']]) {
      h.ok(['ladder', 'set', name, '--harness', 'codex', '--profile', value, '--clear', 'model', '--clear', 'effort']);
    }
    h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices, small_lines: 100, small_files: 5, risk_paths: ['auth/**'] })]);
    if (gated) ready(h);
    return { sha: h.sha, builder: h.builder, reviewEnv: h.reviewEnv };
  });
}

function ready(h) {
  gateEvidence(h, 'tests', 'gates');
  gateEvidence(h, 'clean', 'gates');
}

function choice(h, env) {
  return h.json(['spawn', '--task', 'T1', '--role', 'review', '--dry-run'], { env: { ...h.reviewEnv, ...env } });
}

function model(out) {
  const flag = out.harness === 'claude' ? '--model' : out.argv.includes('-m') ? '-m' : out.argv.includes('-p') ? '-p' : '--model';
  return out.argv[out.argv.indexOf(flag) + 1];
}

function sample(h, name, input, cached, output, cacheWrite = 0) {
  h.ok(['spend', 'T1', '--agent', `review-${name}`, '--tokens', String(input + output), '--input', String(input),
    '--cached', String(cached), '--cache-write', String(cacheWrite), '--output', String(output), '--rung', 'review', '--model', name]);
}

function commandReviewer(h, out) {
  const script = `const fs = require('node:fs'); const cp = require('node:child_process');
fs.writeFileSync(process.argv[1], process.argv[2]);
const r = cp.spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'evidence', 'T1', '--type', 'review', '--ok', '--sha', ${JSON.stringify(h.sha)}, '--summary', 'reviewed'], {env: process.env});
process.exit(r.status ?? 1);`;
  h.ok(['project', 'set', '--review-policy', 'null']);
  const command = [process.execPath, '-e', script, out, '{prompt}'];
  for (const name of ['easy', 'medium', 'hard', 'research']) {
    h.ok(['ladder', 'set', name, '--harness', 'command', '--clear', 'model', '--clear', 'profile',
      '--clear', 'provider', '--clear', 'effort', '--command', JSON.stringify(command)]);
  }
  h.ok(['ladder', 'set', 'review', '--harness', 'command', '--clear', 'model', '--command', JSON.stringify([process.execPath, '-e', script, out, '{prompt}'])]);
}

describe('reviewer integration cases', { concurrency: windowsConcurrency }, () => {
test('reviewers share static system instructions and receive audited gates in the user prompt', (t) => {
  const h = setup(t);
  h.ok(['submit', 'T1', '--agent', h.builder, '--sha', h.sha, '--pr', '42']);
  ready(h);
  gateEvidence(h, 'ci', 'gates');
  fs.writeFileSync(path.join(h.repo, 'AGENTS.md'), 'REPO_REVIEW_RULE\n');
  fs.mkdirSync(path.join(h.repo, 'docs'));
  fs.writeFileSync(path.join(h.repo, 'docs', 'state.md'), '### Acceptance gates\nSTATE_REVIEW_CONTRACT\n\n## Next\nUNNEEDED_STATE_DOC\n');
  fs.writeFileSync(path.join(h.repo, 'docs', 'cli.md'), '## Gates\nCLI_REVIEW_CONTRACT\n\n## Next\nUNNEEDED_CLI_DOC\n');
  const standards = path.join(h.repo, 'review-standards.md');
  fs.writeFileSync(standards, 'REVIEW_STANDARDS\n');
  h.ok(['project', 'set', '--standards', standards]);
  for (const harness of ['claude', 'codex', 'pi']) {
    if (harness === 'codex') fs.writeFileSync(path.join(h.repo, 'AGENTS.override.md'), 'CODEX_REVIEW_RULE\n');
    h.ok(['ladder', 'set', 'easy', '--harness', harness, '--model', 'fixture', '--clear', 'profile', '--clear', 'args']);
    if (harness === 'claude') h.ok(['ladder', 'set', 'easy', '--args', '["--append-system-prompt","CUSTOM_REVIEW_RULE"]']);
    const out = choice(h, { FORCE_PROMPT_CACHING_5M: '0' });
    const user = out.argv.find((arg) => arg.includes('## Task'));
    if (harness === 'pi') {
      assert.equal(out.sandbox, false);
      assert.equal(out.startup.sandbox, false);
      assert.equal(out.startup.confinement, 'unconfined');
      assert.ok(out.startup.rules.every((r) => r.loaded === 'read'));
      assert.ok(out.startup.rules.some((r) => r.path === path.join(h.repo, 'AGENTS.md')));
      assert.match(user, /## House rules/);
      assert.match(user, /## Gate results/);
      assert.equal(out.startup.system_bytes, undefined);
      assert.equal(out.system, undefined);
      assert.ok(out.argv.includes('--no-context-files'));
      assert.equal(out.argv[out.argv.indexOf('--append-system-prompt') + 1], path.join(out.home.path, 'AGENTS.md'));
      continue;
    }
    assert.ok(out.startup.rules.every((r) => r.loaded === 'system'));
    assert.ok(!user.includes('Role instructions'), 'the role skill is static');
    assert.ok(!user.includes('## House rules'), 'house rules are static');
    assert.match(user, /## Gate results/);
    for (const type of ['tests', 'clean', 'ci']) assert.ok(user.includes(`"type": "${type}"`), type);
    assert.match(user, /"commands":/);
    assert.match(user, /"sha":/);
    assert.match(user, /"tests_mode": "prove"/);
    assert.match(user, /Do not re-run the full suite/);
    if (harness === 'claude') {
      const system = out.system;
      assert.ok(out.argv.includes('--exclude-dynamic-system-prompt-sections'));
      assert.equal(out.env.FORCE_PROMPT_CACHING_5M, '1');
      assert.ok(!out.argv.includes('--append-system-prompt'));
      assert.equal(out.argv[out.argv.indexOf('--append-system-prompt-file') + 1], path.join(out.home.path, 'system.md'));
      for (const text of ['Role instructions', 'REPO_REVIEW_RULE', 'STATE_REVIEW_CONTRACT', 'CLI_REVIEW_CONTRACT', 'REVIEW_STANDARDS', 'CUSTOM_REVIEW_RULE']) {
        assert.ok(system.includes(text), text);
      }
      for (const text of ['## Task', 'REVIEWER-ONLY', 'UNNEEDED_STATE_DOC', 'UNNEEDED_CLI_DOC', h.repo]) assert.ok(!system.includes(text), text);
      const second = choice(h);
      assert.equal(second.system, system);
    } else {
      assert.ok(out.startup.instructions_file.endsWith('AGENTS.md'));
      assert.ok(out.startup.system_bytes > 0);
      assert.ok(out.startup.rules.some((r) => r.path === path.join(h.repo, 'AGENTS.override.md')));
      assert.ok(!out.startup.rules.some((r) => r.path === path.join(h.repo, 'AGENTS.md')));
    }
  }
});

test('a claude reviewer prefix over 32 KB stays off the command line', (t) => {
  const h = setup(t);
  h.ok(['submit', 'T1', '--agent', h.builder, '--sha', h.sha, '--pr', '42']);
  ready(h);
  gateEvidence(h, 'ci', 'gates');
  const standards = path.join(h.repo, 'review-standards.md');
  fs.writeFileSync(standards, `LARGE_STANDARDS\n${'Each finding names a file and line.\n'.repeat(1200)}`);
  h.ok(['project', 'set', '--standards', standards]);
  h.ok(['ladder', 'set', 'easy', '--harness', 'claude', '--model', 'fixture', '--clear', 'profile', '--clear', 'args']);
  const out = choice(h);
  assert.ok(Buffer.byteLength(out.system) > 32 * 1024, 'the fixture prefix is over 32 KB');
  assert.match(out.system, /LARGE_STANDARDS/);
  assert.ok(!out.argv.some((arg) => arg.includes('LARGE_STANDARDS')));
  // Windows CreateProcess caps the whole command line at 32,767 characters.
  assert.ok(out.argv.map((arg) => `"${arg}"`).join(' ').length < 32767);
});

test('a fallback reviewer on a large diff keeps the task context and gate results', {
  skip: process.platform === 'win32' && 'the stub uses a shebang executable',
}, (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, 'large.txt'), 'LARGE_DIFF_LINE\n'.repeat(1500));
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'large change']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', h.builder, '--sha', h.sha, '--branch', 'fixture-change']);
  ready(h);
  const bin = path.join(h.base, 'harness-bin');
  fs.mkdirSync(bin);
  const captures = path.join(h.base, 'captures.jsonl');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
fs.appendFileSync(${JSON.stringify(captures)}, JSON.stringify({ model, args }) + '\\n');
if (model === 'first') console.log(JSON.stringify({ type: 'assistant', message: { stop_reason: 'refusal', content: [] } }));
console.log(JSON.stringify({ type: 'result', is_error: false, model, usage: { input_tokens: 1, output_tokens: 1 } }));
`, { mode: 0o755 });
  h.ok(['ladder', 'set', 'easy', '--harness', 'claude', '--model', 'first', '--clear', 'profile', '--clear', 'args']);
  h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices, small_lines: 5000, small_files: 5 })]);
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { easy: { fallbacks: [{ harness: 'claude', model: 'second' }] } } }));
  const caller = path.join(h.base, 'caller');
  fs.mkdirSync(path.join(caller, '.claude'), { recursive: true });
  const result = h.run(['spawn', '--task', 'T1', '--role', 'review', '--wait'], {
    env: { HOME: caller, CLAUDE_CONFIG_DIR: path.join(caller, '.claude'), XDG_CACHE_HOME: path.join(caller, 'cache'),
      PATH: bin + path.delimiter + (h.env.PATH || '') }, timeout: 20000 });
  assert.equal(result.code, 0, result.stderr);
  const rows = fs.readFileSync(captures, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((r) => r.model), ['first', 'second']);
  const prompts = rows.map((r) => r.args.find((arg) => arg.includes('## Task')));
  for (const user of prompts) {
    assert.ok(!user.includes('LARGE_DIFF_LINE'), 'the diff stays in the packet file');
    assert.ok(!user.includes('undefined'));
    assert.match(user, /## Gate results/);
    assert.match(user, new RegExp(`Read .+ for the diff at ${h.sha}`));
  }
  assert.equal(prompts[1], prompts[0]);
});

test('stub reviewers 2 through 4 reuse the static prefix across tasks and fresh homes', {
  skip: process.platform === 'win32' && 'the stub uses a shebang executable',
}, (t) => {
  const h = setup(t);
  ready(h);
  h.ok(['task', 'add', '--title', 'Another review', '--acceptance', 'same repository rules', '--kind', 'docs', '--tier', 'easy']);
  h.ok(['brief', 'set', 'T2', '-'], { input: '## Reviewer\nSECOND_TASK_CONTEXT\n' });
  h.ok(['claim', 'T2', '--agent', 'another-builder']);
  h.ok(['submit', 'T2', '--agent', 'another-builder', '--sha', h.sha]);
  const bin = path.join(h.base, 'harness-bin');
  fs.mkdirSync(bin);
  const captures = path.join(h.base, 'captures.jsonl');
  const checkpoint = path.join(h.base, 'prefix.json');
  const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const claude = path.basename(process.argv[1]) === 'claude';
const system = claude ? fs.readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')
  : fs.readFileSync(path.join(process.env.CODEX_HOME, 'AGENTS.md'), 'utf8');
const configHome = process.env[claude ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'];
const policy = JSON.parse(fs.readFileSync(path.join(configHome, 'policy.json'), 'utf8'));
const hash = crypto.createHash('sha256').update(system).digest('hex');
const previous = fs.existsSync(${JSON.stringify(checkpoint)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(checkpoint)})) : {};
const tokens = Math.ceil(Buffer.byteLength(system) / 4);
const hit = previous[claude ? 'claude' : 'codex'] === hash;
previous[claude ? 'claude' : 'codex'] = hash;
fs.writeFileSync(${JSON.stringify(checkpoint)}, JSON.stringify(previous));
fs.appendFileSync(${JSON.stringify(captures)}, JSON.stringify({
  harness: claude ? 'claude' : 'codex', system, args, cwd: process.cwd(),
  repo: policy.repo,
  home: process.env.HOME, cache_read: hit ? tokens : 0, cache_write: hit ? 0 : tokens,
  cache: process.env.XDG_CACHE_HOME,
  tool_caches: [process.env.GOCACHE, process.env.GOMODCACHE, process.env.npm_config_cache],
  ttl: process.env.FORCE_PROMPT_CACHING_5M,
  memory: claude ? fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'), 'utf8') : null,
}) + '\\n');
console.log(JSON.stringify({type:'result', result:'cache probe', usage: {
  input_tokens: 1, cache_read_input_tokens: hit ? tokens : 0,
  cache_creation_input_tokens: hit ? 0 : tokens, output_tokens: 1,
}}));
`;
  for (const harness of ['claude', 'codex']) fs.writeFileSync(path.join(bin, harness), stub, { mode: 0o755 });
  const caller = path.join(h.base, 'caller');
  for (const dir of ['.claude', '.codex']) fs.mkdirSync(path.join(caller, dir), { recursive: true });
  fs.writeFileSync(path.join(caller, '.claude', 'CLAUDE.md'), 'STUB_GLOBAL_RULE\n');
  fs.writeFileSync(path.join(caller, '.codex', 'AGENTS.md'), 'STUB_GLOBAL_RULE\n');
  const env = { HOME: caller, CLAUDE_CONFIG_DIR: path.join(caller, '.claude'), CODEX_HOME: path.join(caller, '.codex'),
    XDG_CACHE_HOME: path.join(caller, 'cache'),
    PATH: bin + path.delimiter + (h.env.PATH || ''), FORCE_PROMPT_CACHING_5M: '0' };
  for (const harness of ['claude', 'codex']) {
    h.ok(['ladder', 'set', 'easy', '--harness', harness, '--model', 'fixture', '--clear', 'profile']);
    for (const task of ['T1', 'T2', 'T1', 'T2']) h.json(['spawn', '--task', task, '--role', 'review', '--wait'], { env });
  }
  const rows = fs.readFileSync(captures, 'utf8').trim().split('\n').map(JSON.parse);
  for (const harness of ['claude', 'codex']) {
    const runs = rows.filter((r) => r.harness === harness);
    assert.ok(runs[0].cache_write > 0);
    assert.equal(runs[0].cache_read, 0);
    assert.notEqual(runs[0].cwd, runs[1].cwd);
    assert.equal(new Set(runs.map((r) => r.home)).size, 4);
    assert.equal(new Set(runs.map((r) => r.cache)).size, 4, 'reviewer filesystem caches are isolated');
    for (const row of runs.slice(1)) {
      assert.equal(row.system, runs[0].system);
      assert.equal(row.cache_read, runs[0].cache_write);
      assert.equal(row.cache_write, 0);
    }
    for (const row of runs) {
      assert.equal(row.repo, 'acme/demo', 'reviewer shims retain the recorded repository');
      assert.match(row.system, /Role instructions: tower-crane-review/);
      assert.ok(!row.system.includes('## Task'));
      assert.ok(row.cache.startsWith(path.join(caller, 'cache') + path.sep));
      assert.deepEqual(row.tool_caches, ['go-build', 'go-mod', 'npm'].map((dir) => path.join(row.cache, dir)));
      assert.ok(!row.system.includes(row.cache), 'per-agent filesystem paths stay out of the shared prefix');
      if (harness === 'claude') {
        assert.equal(row.ttl, '1');
        assert.equal(row.memory, '');
        assert.ok(row.args.includes('--exclude-dynamic-system-prompt-sections'));
      }
    }
    t.diagnostic(`${harness} stub first-turn prefix tokens: ${JSON.stringify(runs.map(({ cache_read, cache_write }) => ({ cache_read, cache_write })))}`);
  }
});

test('review selection also uses tier and diff defaults without a price table', (t) => {
  const h = setup(t, 'easy', 'other', undefined, { gated: true });
  h.ok(['project', 'set', '--review-policy', 'null']);
  assert.equal(model(choice(h)), 'luna');
});

test('review choice follows tier, diff limits and configured risk paths', (t) => {
  for (const [tier, expected] of [['easy', 'luna'], ['medium', 'sol'], ['hard', 'opus'], ['research', 'opus']]) {
    const h = setup(t, tier, 'other', undefined, { gated: true });
    assert.equal(model(choice(h)), expected, tier);
  }
  for (const policy of [{ small_lines: 1 }, { small_files: 1 }, { risk_paths: ['value.js'] }]) {
    const h = setup(t, 'easy', 'other', undefined, { gated: true });
    h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices, ...policy })]);
    assert.equal(model(choice(h)), policy.risk_paths ? 'opus' : 'sol', JSON.stringify(policy));
  }
});

test('top-tier Claude builders can receive review on the same model', (t) => {
  for (const tier of ['hard', 'research']) {
    const h = setup(t, tier, 'claude-opus-5-5', undefined, { gated: true });
    assert.equal(model(choice(h)), 'opus', tier);
  }
});

test('Codex profile builders share canonical identity with provider spend and prices', (t) => {
  for (const [tier, profile, provider, promotedTier, promotedModel, promotedProvider] of [
    ['easy', 'luna', 'openai.gpt-6-luna', 'medium', 'sol', 'openai.gpt-6.1-sol'],
    ['medium', 'sol', 'openai.gpt-6.1-sol', 'hard', 'opus', 'claude-opus-5-5'],
  ]) {
    const h = setup(t, tier, provider, profile, { gated: true });
    // A later self-reported model and ladder edit cannot rename the builder route.
    h.ok(['spend', 'T1', '--agent', h.builder, '--tokens', '1', '--rung', tier, '--model', 'wrong-model']);
    assert.deepEqual([choice(h).review_rung, model(choice(h))], [tier, profile]);
    sample(h, provider, 1000000, 0, 0);
    sample(h, promotedProvider, 0, 0, 1);
    const out = choice(h);
    assert.deepEqual([out.review_rung, model(out)], [promotedTier, promotedModel]);
    const prompt = out.argv.find((arg) => arg.includes('## Task'));
    assert.ok(prompt.includes(`builder model ${provider}`), prompt);
    h.ok(['ladder', 'set', tier, '--harness', 'opencode', '--model', 'changed-model', '--clear', 'profile']);
    assert.ok(choice(h).argv.some((arg) => arg.includes(`builder model ${provider}`)));
  }
});

test('a stronger model wins only when its median priced review cost is no higher', (t) => {
  const h = setup(t, 'medium', 'other', undefined, { gated: true });
  // Inclusive input includes cache writes and cache reads.
  sample(h, 'sol', 100000, 50000, 60000); // $0.705
  sample(h, 'opus', 100000, 50000, 20000, 20000); // $0.63
  assert.equal(model(choice(h)), 'opus');
  sample(h, 'opus', 100000, 50000, 100000, 20000); // median $1.43
  assert.equal(model(choice(h)), 'sol');
  // Worker spend must not masquerade as a cheap review sample.
  h.ok(['spend', 'T1', '--agent', 'cheap-worker', '--tokens', '1', '--input', '1', '--cached', '0', '--output', '0', '--rung', 'hard', '--model', 'opus']);
  assert.equal(model(choice(h)), 'sol');
});

test('a running reviewer\'s live reading is not a cost sample until exit finalizes it', (t) => {
  const h = setup(t, 'medium');
  ready(h);
  sample(h, 'sol', 100000, 50000, 60000);
  sample(h, 'opus', 100000, 50000, 20000, 20000);
  const tasks = h.readState('tasks.json');
  const entry = tasks.tasks[0].spend.entries.find((e) => e.agent === 'review-opus');
  entry.live = { state: 'live', interval_ms: 1000 };
  h.writeState('tasks.json', tasks);
  assert.equal(model(choice(h)), 'sol');
});

test('review selection matches Claude provider aliases to recorded provider spend', (t) => {
  const bedrock = 'global.anthropic.claude-opus-5-5';
  const anthropic = 'claude-opus-5-5';
  for (const tier of ['medium', 'hard']) {
    const h = setup(t, tier);
    const bin = path.join(h.base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude'), '', { mode: 0o755 });
    const env = { PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''),
      AWS_REGION: 'eu-west-1', AWS_BEARER_TOKEN_BEDROCK: 'stub-secret-bedrock',
      ANTHROPIC_API_KEY: 'stub-secret-anthropic' };
    h.ok(['ladder', 'set', 'hard', '--harness', 'claude', '--provider', 'bedrock', '--model', 'opus']);
    h.ok(['ladder', 'set', 'research', '--harness', 'claude', '--provider', 'anthropic', '--model', 'opus']);
    h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices: { ...prices, [bedrock]: prices[anthropic] } })]);
    ready(h);
    sample(h, tier === 'medium' ? 'sol' : bedrock, 1000000, 0, 0);
    sample(h, tier === 'medium' ? bedrock : anthropic, 0, 0, 1);
    const promoted = choice(h, env);
    assert.equal(promoted.review_rung, tier === 'medium' ? 'hard' : 'research');
    assert.equal(model(promoted), tier === 'medium' ? bedrock : anthropic);
    sample(h, tier === 'medium' ? bedrock : anthropic, 0, 0, 1000000);
    assert.equal(choice(h, env).review_rung, tier, 'a higher provider median keeps the current rung');
  }
});

test('equal cost promotes, missing components do not provide a cost sample', (t) => {
  const h = setup(t, 'medium', 'other', undefined, { gated: true });
  h.ok(['spend', 'T1', '--agent', 'unknown-review', '--tokens', '1', '--rung', 'review', '--model', 'opus']);
  sample(h, 'sol', 0, 0, 1000);
  assert.equal(model(choice(h)), 'sol');
  sample(h, 'opus', 0, 0, 500);
  assert.equal(model(choice(h)), 'opus');
});

test('review history from other tasks and cached tokens determines cost', (t) => {
  const h = setup(t, 'medium', 'other', undefined, { gated: true });
  h.ok(['task', 'add', '--title', 'Recorded review history', '--acceptance', 'usage captured']);
  sample(h, 'sol', 1000000, 990000, 0);
  h.ok(['spend', 'T2', '--agent', 'historical-reviewer', '--rung', 'review', '--model', 'opus',
    '--tokens', '100000', '--input', '100000', '--cached', '99000', '--cache-write', '0', '--output', '0']);
  assert.equal(model(choice(h)), 'opus', 'cached token prices, rather than input-only prices, decide');
});

test('review escalation climbs one tier after failed reviews', (t) => {
  const h = setup(t, 'easy', 'other', undefined, { gated: true });
  assert.equal(model(choice(h)), 'luna');
  // A failure under a name no review dispatch started does not escalate.
  h.ok(['evidence', 'T1', '--agent', 'made-up', '--type', 'review', '--fail', '--sha', h.sha]);
  assert.equal(model(choice(h)), 'luna');
  h.reviewer('T1', 'r1');
  h.ok(['evidence', 'T1', '--agent', 'r1', '--type', 'review', '--fail', '--sha', h.sha, '--summary', 'needs stronger reasoning']);
  assert.equal(model(choice(h)), 'sol');
  h.reviewer('T1', 'r2');
  h.ok(['evidence', 'T1', '--agent', 'r2', '--type', 'review', '--fail', '--sha', h.sha]);
  assert.equal(model(choice(h)), 'opus');
});

test('escalation starts above the actual dispatched reviewer rung', (t) => {
  const h = setup(t, 'easy', 'other', undefined, { gated: true });
  const script = `const cp = require('node:child_process');
const r = cp.spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'evidence', 'T1', '--type', 'review', '--fail', '--sha', ${JSON.stringify(h.sha)}], {env: process.env});
process.exit(r.status ?? 1);`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--clear', 'model',
    '--command', JSON.stringify([process.execPath, '-e', script, '{prompt}'])]);
  const dispatched = h.json(['spawn', '--task', 'T1', '--role', 'review', '--wait']);
  assert.equal(dispatched.review_rung, 'easy');
  assert.equal(choice(h).review_rung, 'medium');
});

test('direct review dispatch refuses missing and failed gates and supplies lean context after they pass', (t) => {
  const h = setup(t);
  const before = h.run(['spawn', '--task', 'T1', '--role', 'review', '--dry-run']);
  assert.equal(before.code, 1);
  assert.match(before.stderr, /software gates/);
  gateEvidence(h, 'tests', 'gates', false);
  assert.equal(h.run(['spawn', '--task', 'T1', '--role', 'review']).code, 1);
  ready(h);
  const out = choice(h);
  assert.equal(out.agent, 'reviewer-T1-1');
  const prompt = out.argv.find((arg) => arg.includes('## Task'));
  assert.match(prompt, /value becomes one/);
  assert.match(prompt, /diff --git a\/value.js b\/value.js/);
  assert.match(prompt, /Gate results/);
  assert.match(prompt, /fail without/);
  assert.match(prompt, /probe/);
  assert.match(prompt, /## Reviewer\nREVIEWER-ONLY instruction/);
  assert.ok(!prompt.includes('BUILDER-HISTORY'));
  assert.ok(!prompt.includes('WORKER-HISTORY'));
  assert.equal(out.rung, 'review');
});

test('review packet uses role headings consistently and ignores fenced headings', (t) => {
  const h = setup(t);
  h.ok(['brief', 'set', 'T1', '-'], { input: [
    '## Worker', 'BUILDER-HISTORY', '```md', '## Reviewer', 'FAKE-REVIEWER', '```',
    '## rEvIeWeR', 'REVIEWER-ONLY instruction', '### Probe', 'keep this nested heading',
    '## Shared', 'SHARED-HISTORY',
  ].join('\n') });
  ready(h);
  const prompt = choice(h).argv.find((arg) => arg.includes('## Task'));
  assert.match(prompt, /## rEvIeWeR\nREVIEWER-ONLY instruction/);
  assert.match(prompt, /### Probe\nkeep this nested heading/);
  for (const secret of ['BUILDER-HISTORY', 'FAKE-REVIEWER', 'SHARED-HISTORY']) assert.ok(!prompt.includes(secret));
});

test('review dispatch computes its diff once outside the state lock', (t) => {
  const h = setup(t, 'easy', 'other', undefined, { gated: true });
  commandReviewer(h, path.join(h.base, 'context.txt'));
  const report = path.join(h.base, 'diff-calls.jsonl');
  h.json(['spawn', '--task', 'T1', '--role', 'review', '--wait'], {
    hooks: { HOOK_REVIEW_DIFF_REPORT: report },
  });
  const calls = fs.readFileSync(report, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ locked: false })));
});
});

test('real Haiku reviewers expose first-turn cache reads and writes across worktrees', {
  skip: process.env.TOWER_CRANE_LIVE_REVIEW_CACHE !== '1' && 'set TOWER_CRANE_LIVE_REVIEW_CACHE=1 for the paid Haiku probe',
  timeout: 300000,
}, async (t) => {
  const h = setup(t);
  ready(h);
  h.ok(['project', 'set', '--goal', 'Measure reviewer prompt cache reuse']);
  const instruction = '## Reviewer\nThis is an owner-authorized cache probe, not a code review. Use no tools, change no files, and do not record review evidence. Reply with CACHE_PROBE_OK and stop after one answer.\n';
  h.ok(['brief', 'set', 'T1', '-'], { input: instruction });
  h.ok(['task', 'add', '--title', 'Cache validation', '--acceptance', 'one answer', '--kind', 'docs', '--tier', 'easy']);
  h.ok(['brief', 'set', 'T2', '-'], { input: instruction });
  h.ok(['claim', 'T2', '--agent', 'another-builder']);
  h.ok(['submit', 'T2', '--agent', 'another-builder', '--sha', h.sha]);
  h.ok(['ladder', 'set', 'easy', '--harness', 'claude', '--model', 'claude-haiku-5-5', '--clear', 'profile',
    '--args', '["--max-turns","1"]']);
  const liveHome = process.env.TOWER_CRANE_LIVE_REVIEW_HOME || require('node:os').homedir();
  const env = { HOME: liveHome, CODEX_HOME: path.join(liveHome, '.codex'),
    CLAUDE_CONFIG_DIR: process.env.TOWER_CRANE_LIVE_REVIEW_CLAUDE_CONFIG || path.join(liveHome, '.claude') };
  const rows = [];
  for (const task of ['T1', 'T2', 'T1', 'T2']) {
    const out = await h.runAsync(['spawn', '--task', task, '--role', 'review', '--wait', '--json'], { env });
    assert.equal(out.code, 0, out.stderr);
    const launch = JSON.parse(out.stdout);
    const log = fs.readFileSync(launch.log, 'utf8');
    const result = log.split('\n').map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).findLast((e) => e?.type === 'result');
    assert.ok(result?.result?.includes('CACHE_PROBE_OK'), log.slice(-2000));
    const usage = result.usage;
    assert.ok(usage, 'Haiku returned usage');
    const startup = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      .findLast((e) => e.cmd === 'startup' && e.detail.agent === launch.agent);
    rows.push({ task, agent: launch.agent, system_bytes: startup.detail.system_bytes,
      model: result.modelUsage, usage, total_cost_usd: result.total_cost_usd });
  }
  t.diagnostic(`Haiku first-turn cache probe: ${JSON.stringify(rows)}`);
  assert.equal(new Set(rows.map((r) => r.system_bytes)).size, 1, 'system context size is stable across worktrees');
  assert.ok(rows.slice(1).every((r) => r.usage.cache_read_input_tokens > 0), 'warm reviewer first turns read the cache');
  for (const row of rows) {
    assert.equal(row.usage.cache_creation.ephemeral_1h_input_tokens, 0);
    assert.equal(row.usage.cache_creation.ephemeral_5m_input_tokens, row.usage.cache_creation_input_tokens);
  }
});

test('review dispatch refuses a submitted head or configured base changed after diff preparation', async (t) => {
  for (const change of ['head', 'base']) {
    const h = setup(t);
    changeKind(h, 'docs');
    commandReviewer(h, path.join(h.base, 'context.txt'));
    h.git(['commit', '--allow-empty', '-qm', 'next head']);
    const next = h.git(['rev-parse', 'HEAD']);
    const paused = path.join(h.base, 'diff-ready');
    const running = h.runAsync(['spawn', '--task', 'T1', '--role', 'review', '--wait'], {
      hooks: { HOOK_STOP_REVIEW_DIFF: paused },
    });
    try {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(paused)) {
        assert.ok(Date.now() < deadline, 'diff preparation did not finish');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(!fs.existsSync(path.join(h.state, 'lock')), 'diff preparation leaves state writable');
      if (change === 'head') h.ok(['submit', 'T1', '--agent', 'builder', '--sha', next]);
      else h.ok(['project', 'set', '--base', 'fixture-change']);
    } finally {
      fs.writeFileSync(`${paused}.go`, '');
    }
    const result = await running;
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /changed.*diff.*retry/i);
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(!events.some((e) => e.cmd === 'spawn'));
    assert.ok(!fs.existsSync(path.join(h.state, 'reviews')), 'a stale packet is never written');
  }
});

test('accept runs tests, clean and CI before dispatch, then automation accepts after review', async (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'review-context.txt');
  commandReviewer(h, out);
  h.ok(['submit', 'T1', '--agent', 'builder', '--sha', h.sha, '--pr', '7']);
  const result = h.json(['accept', 'T1']);
  assert.equal(result.status, 'submitted');
  assert.equal(result.review_pending, true);
  const deadline = Date.now() + 10000;
  while (h.readState('tasks.json').tasks[0].status !== 'accepted') {
    assert.ok(Date.now() < deadline, 'review did not reach automatic acceptance');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const dispatch = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  for (const type of ['tests', 'clean', 'ci']) assert.ok(events.findIndex((e) => e.cmd === `check ${type}` && e.detail.ok) < dispatch);
  assert.match(fs.readFileSync(out, 'utf8'), /Gate results/);
  const accepted = h.readState('tasks.json').tasks[0];
  assert.equal(accepted.status, 'accepted');
  assert.ok(accepted.evidence.some((e) => e.type === 'review' && e.ok));
});

describe('remaining reviewer integration cases', { concurrency: windowsConcurrency }, () => {
test('a failed automatic gate never starts a reviewer', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'review-context.txt');
  commandReviewer(h, out);
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(1)"']);
  const failed = h.run(['accept', 'T1', '--cmd', 'node -e "process.exit(1)"']);
  assert.equal(failed.code, 1);
  assert.ok(!fs.existsSync(out));
  assert.ok(!fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').includes('"cmd":"spawn"'));
  assert.equal(h.readState('tasks.json').tasks[0].evidence[0].type, 'tests');
});

test('automatic tests honor owner none mode and forward expensive proof commands', (t) => {
  for (const expensive of [false, true]) {
    const h = setup(t);
    commandReviewer(h, path.join(h.base, 'review-context.txt'));
    h.ok(['project', 'set', '--tests-mode', expensive ? 'prove' : 'none', '--tests-expensive', String(expensive), '--tests-proof-cmd', 'node {tests}']);
    const args = expensive ? ['--cmd', 'node test/value.test.js', '--proof-cmd', 'node {tests}'] : [];
    assert.equal(h.json(['accept', 'T1', ...args]).review_pending, true);
    const evidence = h.readState('tasks.json').tasks[0].evidence.find((e) => e.type === 'tests');
    assert.equal(evidence.tests_mode, expensive ? 'prove' : 'none');
    assert.equal(evidence.ok, true);
  }
});
test('accept reuses an active review and direct dispatch refuses a duplicate', (t) => {
  const h = setup(t, 'easy', 'other', undefined, { gated: true });
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--clear', 'model',
    '--command', JSON.stringify([process.execPath, '-e', 'setInterval(() => {}, 1000)', '{prompt}'])]);
  const first = h.json(['accept', 'T1']);
  const second = h.json(['accept', 'T1']);
  assert.equal(second.reviewer, first.reviewer);
  const refused = h.run(['spawn', '--task', 'T1', '--role', 'review']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /reviewer is still running/);
});

test('large review diffs use a context file and a short argv', (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, 'large.md'), 'A focused review reads this diff.\n'.repeat(1000));
  h.git(['add', 'large.md']);
  h.git(['commit', '-qm', 'large diff']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'builder', '--sha', h.sha]);
  ready(h);
  const out = path.join(h.base, 'large-prompt.txt');
  commandReviewer(h, out);
  const preview = choice(h);
  const packet = path.join(h.state, 'reviews', `T1-${h.sha}.md`);
  assert.ok(!fs.existsSync(packet), 'a dry run writes no packet');
  assert.ok(preview.argv.join(' ').length < 16000);
  const user = preview.argv.find((arg) => arg.includes('## Task'));
  assert.match(user, /## Gate results/);
  assert.match(user, /"type": "tests"/);
  assert.match(user, /"type": "clean"/);
  h.json(['spawn', '--role', 'review', '--task', 'T1', '--wait']);
  assert.match(fs.readFileSync(out, 'utf8'), /reviews/);
  const fullPacket = fs.readFileSync(packet, 'utf8');
  assert.match(fullPacket, /diff --git a\/large.md b\/large.md/);
  assert.match(fullPacket, /## Reviewer\nREVIEWER-ONLY instruction/);
  assert.ok(!fullPacket.includes('WORKER-HISTORY'));
});

test('the review packet flags changed files outside the paths the brief names', (t) => {
  const h = setup(t);
  changeKind(h, 'docs');
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Only `docs/` changes.\n\n## Reviewer\nREVIEWER-ONLY instruction\n' });
  fs.mkdirSync(path.join(h.repo, 'docs'));
  fs.writeFileSync(path.join(h.repo, 'docs', 'note.md'), 'note\n');
  fs.writeFileSync(path.join(h.repo, 'stray.md'), 'stray\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'docs and a stray file']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'builder', '--sha', h.sha]);
  commandReviewer(h, path.join(h.base, 'prompt.txt'));
  h.json(['spawn', '--role', 'review', '--task', 'T1', '--wait']);
  const packet = fs.readFileSync(path.join(h.state, 'reviews', `T1-${h.sha}.md`), 'utf8');
  assert.match(packet, /## Scope\n\nscope: \d+ changed files? outside the paths the brief and acceptance name \(docs\/\): [^\n]*stray\.md/);
  assert.ok(!/\(docs\/\): [^\n]*docs\/note\.md/.test(packet), 'a named path is in scope');
});

test('review policy validates price and diff settings through the CLI', (t) => {
  const h = makeProjectRepo(t);
  for (const bad of [{ prices: { 'openai.gpt-6.1-sol': { input: -1 } } },
    { prices: { sol: prices['openai.gpt-6.1-sol'], 'openai.gpt-6.1-sol': prices['openai.gpt-6.1-sol'] } },
    { small_lines: -1 }, { risk_paths: [3] }, { surprise: true }]) {
    assert.equal(h.run(['project', 'set', '--review-policy', JSON.stringify(bad)]).code, 2);
  }
  h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices: { sol: prices['openai.gpt-6.1-sol'] } })]);
  assert.deepEqual(h.json(['project', 'show']).review.prices, { 'openai.gpt-6.1-sol': prices['openai.gpt-6.1-sol'] });
  for (const [alias, provider] of [['sol', 'openai.gpt-6.1-sol'], ['luna', 'openai.gpt-6-luna'], ['opus', 'claude-opus-5-5']]) {
    const task = h.json(['task', 'add', '--title', alias, '--acceptance', 'usage']);
    const out = h.json(['spend', task.id, '--tokens', '1', '--model', alias]);
    assert.equal(out.spend.entries[0].model, provider);
  }
});

test('review policy and prices are the orchestrator\'s or the explicit owner\'s', (t) => {
  const h = makeRepo(t);
  const policy = JSON.stringify({ prices });
  const init = h.run(['init', '--name', 'demo', '--goal', 'prove the engine', '--review-policy', policy, '--agent', 'worker']);
  assert.equal(init.code, 1);
  assert.match(init.stderr, /only the orchestrator or the owner/);
  assert.ok(!fs.existsSync(h.state), 'a refused init writes no state');

  h.init();
  const before = h.readState('project.json');
  const denied = h.run(['project', 'set', '--review-policy', policy, '--agent', 'worker']);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /only the orchestrator or the owner/);
  assert.deepEqual(h.readState('project.json'), before);
  assert.equal(h.run(['project', 'set', '--review-policy', 'null', '--agent', 'worker']).code, 1);
  h.ok(['project', 'set', '--review-policy', 'null', '--agent', 'orchestrator']);
  h.ok(['project', 'set', '--review-policy', policy, '--agent', 'owner']);
  assert.deepEqual(h.json(['project', 'show']).review.prices, prices);
});

test('terminal owner fallback cannot change review policy', { skip: !PTY_AVAILABLE }, (t) => {
  const h = makeProjectRepo(t);
  const env = { ...h.env };
  delete env.TOWER_CRANE_AGENT;
  const result = runPty(['project', 'set', '--review-policy', 'null'], { cwd: h.repo, env });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /only the orchestrator or the owner/);
});

test('review uses the nearest base when only origin has it or the local base is stale', (t) => {
  const h = setup(t, 'easy', 'other', undefined, { gated: true });
  const base = h.git(['rev-parse', 'main']);
  h.git(['update-ref', 'refs/remotes/origin/main', base]);
  h.git(['branch', '-D', 'main']);
  assert.match(choice(h).argv.find((arg) => arg.includes('## Task')), /diff --git/);
  h.git(['branch', 'main', `${base}~1`]);
  const prompt = choice(h).argv.find((arg) => arg.includes('## Task'));
  assert.ok(prompt.includes(`Base: ${base}.`));
});
});
