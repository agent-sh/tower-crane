'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { cachedFixture, real, BIN, PTY_AVAILABLE } = require('./helpers');
const stack = require('./stack-fixture');
const A = require('../lib/agents');
const S = require('../lib/state');
const SHORT_WAIT = path.join(__dirname, 'fixtures', 'lock-wait.js');

function setup(t) {
  return cachedFixture(t, 'task', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Idempotency key on retries', '--acceptance', 'processed once', '--acceptance', 'test proves it']);
    h.ok(['brief', 'set', 'T1', '-'], { input: '- start from the webhook handler\n' });
  });
}

const dry = (h, rung, env) => h.json(['spawn', ...(rung ? ['--role', rung] : []), '--task', 'T1', '--dry-run'], { env });

const FIELDS = ['harness', 'model', 'profile', 'provider', 'effort', 'args', 'command'];

// Sets a rung to exactly these flags: every field they leave out is cleared.
function setRung(h, rung, flags) {
  const given = flags.filter((f) => f.startsWith('--')).map((f) => f.slice(2));
  h.ok(['ladder', 'set', rung, ...flags, ...FIELDS.filter((k) => !given.includes(k)).flatMap((k) => ['--clear', k])]);
}

const commandRung = (h, rung, argv) => {
  const command = argv.some((arg) => /\{(prompt|brief)\}/.test(arg)) ? argv : [...argv, '{prompt}'];
  setRung(h, rung, ['--harness', 'command', '--command', JSON.stringify(command)]);
};

test('design tasks dispatch without a kit on unsupported worker, review and small harnesses and report the omission', (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--kind', 'design']);
  for (const harness of ['pi', 'opencode', 'command']) {
    for (const role of ['medium', 'review', 'small']) {
      setRung(h, role, harness === 'command'
        ? ['--harness', harness, '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}'])]
        : ['--harness', harness, '--model', 'fixture']);
      const seen = dry(h, role);
      assert.deepEqual(seen.home.mcp, []);
      assert.deepEqual(seen.browser_kit.omitted, ['playwright']);
      assert.match(seen.browser_kit.warning, /browser kit.*without it/);
      assert.match(h.ok(['spawn', '--role', role, '--task', 'T1', '--dry-run']), /browser kit.*without it/);
    }
  }
  const started = h.json(['spawn', '--task', 'T1', '--wait']);
  assert.equal(started.code, 0);
  assert.match(started.browser_kit.warning, /command.*without it/);
  const recorded = h.readState('tasks.json');
  assert.equal(recorded.tasks[0].kind, 'design');
  const event = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.cmd === 'spawn');
  assert.deepEqual(event.detail.browser_kit, started.browser_kit);
});

test('explicit browser needs refuse only when no route can provide the kit', (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--needs', '["browser"]']);
  commandRung(h, 'medium', [process.execPath, '-e', 'process.exit(0)', '{prompt}']);
  const missing = h.run(['spawn', '--task', 'T1', '--dry-run']);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /browser/);
  assert.equal(fs.existsSync(path.join(h.base, 'repo-worktrees')), false);
  const home = path.join(h.base, 'user');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'browser-server' } } }));
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { medium: { fallbacks: [{ harness: 'claude', model: 'fixture' }] } } }));
  const routed = h.json(['spawn', '--task', 'T1', '--dry-run'], {
    env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: '' },
  });
  assert.match(routed.browser_kit.warning, /command.*without it/);
});

test('design tasks with an unconfigured kit still dispatch on supported harnesses', (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--kind', 'design']);
  const home = path.join(h.base, 'unconfigured-user');
  fs.mkdirSync(home);
  for (const harness of ['claude', 'codex']) {
    setRung(h, 'medium', ['--harness', harness, '--model', 'fixture']);
    const seen = h.json(['spawn', '--task', 'T1', '--dry-run'], {
      env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') },
    });
    assert.deepEqual(seen.home.mcp, []);
    assert.match(seen.browser_kit.warning, /playwright.*without it/);
  }
});

function writeSkill(plugin, name, body) {
  const file = path.join(plugin, 'skills', name, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: fixture frontmatter\n---\n${body}\n`);
}

function reviewable(h) {
  h.ok(['task', 'update', 'T1', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'builder']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'builder']);
}

test('worktree creates the task branch from base and is idempotent', (t) => {
  const h = setup(t);
  const first = h.json(['worktree', 'T1']);
  const expected = path.join(h.base, 'repo-worktrees', 'T1-idempotency-key-on-retries');
  assert.equal(real(first.path), real(expected));
  assert.equal(first.branch, 'tower-crane/T1-idempotency-key-on-retries');
  assert.equal(first.created, true);
  assert.equal(h.git(['rev-parse', '--abbrev-ref', 'HEAD'], first.path), first.branch);
  assert.equal(h.git(['rev-parse', 'HEAD'], first.path), h.git(['rev-parse', 'main']));
  assert.equal(h.readState('tasks.json').tasks[0].branch, first.branch);

  h.ok(['task', 'update', 'T1', '--title', 'Renamed task']);
  const again = h.json(['worktree', 'T1']);
  assert.equal(again.created, false);
  assert.equal(real(again.path), real(first.path));
  assert.equal(h.ok(['worktree', 'T1']), again.path);
});

test('spawn --dry-run builds each harness command', (t) => {
  const h = setup(t);
  // claude and codex run the small rung under tower-crane-small.md, in a home of its own.
  const small = A.load('small');
  const claudeOwn = (state) => [
    '--setting-sources', 'user', '--permission-mode', 'acceptEdits', '--tools', 'Bash,Read,Grep,Glob', '--allowedTools', 'Bash,Read,Grep,Glob',
    '--disallowedTools', ...small.disallowedTools,
    '--strict-mcp-config', '--mcp-config', path.join(state, 'homes', 'small-T1-1', 'mcp.json'), '--disable-slash-commands',
  ];
  const codexOwn = () => [
    '-c', 'default_permissions="tower-crane"', '-c', 'approval_policy="never"', '-c', 'bypass_hook_trust=true', '-c', 'web_search="disabled"',
    ...small.codexDisable.flatMap((f) => ['--disable', f]),
  ];
  const piOwn = (state) => [
    '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--tools', 'bash,read,grep,find', '--append-system-prompt', path.join(state, 'homes', 'small-T1-1', 'AGENTS.md'),
    '--extension', path.join(state, 'homes', 'small-T1-1', 'hook.mjs'),
  ];
  const cases = [
    [['--harness', 'claude', '--model', 'claude-opus-5-5'], (p, s) => ['claude', '-p', p, '--model', 'claude-opus-5-5', '--output-format', 'json', ...claudeOwn(s)]],
    [['--harness', 'claude', '--model', 'opus', '--effort', 'high'], (p, s) => ['claude', '-p', p, '--model', 'opus', '--effort', 'high', '--output-format', 'json', ...claudeOwn(s)]],
    [['--harness', 'codex', '--profile', 'sol'], (p, s) => ['codex', 'exec', '--json', '-p', 'sol', ...codexOwn(s), p]],
    [['--harness', 'codex', '--model', 'gpt-x', '--effort', 'high', '--args', '["--skip-git-repo-check"]'], (p, s) => ['codex', 'exec', '--json', '-m', 'gpt-x', '-c', 'model_reasoning_effort=high', ...codexOwn(s), p, '--skip-git-repo-check']],
    [['--harness', 'opencode', '--model', 'anthropic/claude'], (p) => ['opencode', 'run', '--format', 'json', '-m', 'anthropic/claude', p]],
    [['--harness', 'opencode', '--model', 'openai/gpt-x', '--effort', 'high'], (p) => ['opencode', 'run', '--format', 'json', '-m', 'openai/gpt-x', '--variant', 'high', p]],
    [['--harness', 'agy', '--model', 'gemini-3-pro'], (p) => ['agy', '-p', p, '--mode', 'accept-edits', '--output-format', 'json', '--model', 'gemini-3-pro', '--agent', 'gishra-small', '--disable-slash-commands', '--sandbox']],
    [['--harness', 'agy', '--model', 'gemini-3-pro', '--effort', 'max', '--args', '["--print-timeout","60s"]'], (p) => ['agy', '-p', p, '--mode', 'accept-edits', '--output-format', 'json', '--model', 'gemini-3-pro', '--effort', 'max', '--agent', 'gishra-small', '--disable-slash-commands', '--sandbox', '--print-timeout', '60s']],
    [['--harness', 'pi', '--model', 'openai/gpt-5.5'], (p, s) => ['pi', '-p', p, '--mode', 'json', '--model', 'openai/gpt-5.5', ...piOwn(s)]],
    [['--harness', 'pi', '--model', 'openai/gpt-5.5', '--provider', 'openai', '--effort', 'xhigh', '--args', '["--no-session"]'], (p, s) => ['pi', '-p', p, '--mode', 'json', '--model', 'openai/gpt-5.5', '--provider', 'openai', '--thinking', 'xhigh', ...piOwn(s), '--no-session']],
  ];
  const empty = path.join(h.base, 'no-plugin');
  fs.mkdirSync(empty);
  for (const [flags, expected] of cases) {
    setRung(h, 'small', flags);
    const out = dry(h, 'small', { TOWER_CRANE_PLUGIN_ROOT: empty });
    const prompt = out.argv.find((a) => a.includes('## Task'));
    assert.ok(prompt, `prompt present for ${flags.join(' ')}`);
    const argv = expected(prompt, out.env.TOWER_CRANE_STATE);
    if (flags.includes('claude')) {
      assert.match(out.session_id, /^[a-f0-9-]{36}$/);
      if (out.argv.includes('--resume')) assert.equal(out.session_id, out.argv[out.argv.indexOf('--resume') + 1]);
      else argv.push('--session-id', out.session_id);
    }
    assert.deepEqual(out.argv, argv, flags.join(' '));
  }
  const out = dry(h, 'small');
  assert.equal(out.agent, 'small-T1-1');
  assert.equal(out.rung, 'small');
  for (const key of ['TOWER_CRANE_AGENT', 'TOWER_CRANE_STATE', 'TOWER_CRANE_TASK', 'TOWER_CRANE_HOOK']) assert.ok(out.env[key], key);
  assert.equal(out.env.TOWER_CRANE_AGENT, 'small-T1-1');
  assert.equal(out.env.TOWER_CRANE_TASK, 'T1');
  assert.equal(real(out.env.TOWER_CRANE_STATE), real(h.state));
  assert.equal(out.worktree_exists, false);
  assert.ok(!fs.existsSync(path.join(h.base, 'repo-worktrees')), 'a dry run creates nothing');
});

test('opencode inline config keeps caller fields and plugins when adding the home plugin', (t) => {
  const h = setup(t);
  setRung(h, 'small', ['--harness', 'opencode', '--model', 'anthropic/claude']);
  const original = {
    model: 'anthropic/claude',
    theme: 'tower-crane-test',
    agent: { build: { temperature: 0.2 } },
    plugin: ['file:///existing/plugin.mjs'],
  };
  const out = dry(h, 'small', { OPENCODE_CONFIG_CONTENT: JSON.stringify(original) });
  const config = JSON.parse(out.env.OPENCODE_CONFIG_CONTENT);
  const generated = pathToFileURL(path.join(h.state, 'homes', out.agent, 'hook.mjs')).href;
  assert.deepEqual(config, { ...original, plugin: [...original.plugin, generated] });
});

test('spawn embeds the role skill in the system context for isolated reviewers and before the brief for other jobs', (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--tier', 'easy']);
  reviewable(h);
  const plugin = path.join(h.base, 'plugin');
  const bodies = {
    worker: 'WORKER_SKILL_BODY_SENTINEL\n\nFix the task in the worktree.',
    reviewer: 'REVIEWER_SKILL_BODY_SENTINEL\n\nReview the submitted change.',
  };
  writeSkill(plugin, 'tower-crane-work', bodies.worker);
  writeSkill(plugin, 'tower-crane-review', bodies.reviewer);
  const cases = [
    ['claude', 'opus'],
    ['codex', 'gpt-x'],
    ['opencode', 'anthropic/claude'],
    ['agy', 'gemini-3-pro'],
  ];
  const env = { TOWER_CRANE_PLUGIN_ROOT: plugin };

  for (const [harness, model] of cases) {
    for (const [rung, job, other] of [
      ['easy', 'worker', 'reviewer'],
      ['review', 'reviewer', 'worker'],
    ]) {
      setRung(h, rung, ['--harness', harness, '--model', model]);
      const out = dry(h, rung, env);
      const user = out.argv.find((arg) => arg.includes('## Task'));
      if (job === 'reviewer' && harness === 'codex') {
        assert.ok(!user.includes(bodies[job]));
        assert.ok(out.startup.system_bytes > bodies[job].length);
        continue;
      }
      const prompt = job === 'reviewer' && harness === 'claude'
        ? out.system : user;
      assert.ok(prompt.includes(bodies[job]), `${harness} ${job} has its skill body`);
      assert.ok(!prompt.includes(bodies[other]), `${harness} ${job} excludes the other role's skill`);
      assert.ok(!prompt.includes(`name: tower-crane-${job === 'worker' ? 'work' : 'review'}`));
      assert.ok(!prompt.includes('description: fixture frontmatter'), 'skill frontmatter is omitted');
      const context = job === 'worker' ? 'start from the webhook handler' : 'Review T1 at';
      if (prompt === user) assert.ok(prompt.indexOf(bodies[job]) < prompt.indexOf(context), 'the role skill comes before the task context');
      else assert.ok(!user.includes(bodies[job]), 'the user message holds only task context');
    }
  }
});

test('spawn warns when a role SKILL.md is missing', (t) => {
  const h = setup(t);
  const plugin = path.join(h.base, 'incomplete-plugin');
  fs.mkdirSync(path.join(plugin, 'skills', 'tower-crane-work'), { recursive: true });
  setRung(h, 'medium', ['--harness', 'opencode', '--model', 'a/b']);

  const result = h.run(['spawn', '--role', 'medium', '--task', 'T1', '--dry-run', '--json'], {
    env: { TOWER_CRANE_PLUGIN_ROOT: plugin },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /SKILL\.md.*missing/i);
  assert.equal((result.stderr.match(/SKILL\.md/gi) || []).length, 1, 'one warning per spawn');
  const output = JSON.parse(result.stdout);
  const prompt = output.argv.find((arg) => arg.includes('## Task'));
  assert.ok(!prompt.includes('Role instructions'));
});

test('spawn gives workers shared brief text and reviewers only their review section', (t) => {
  const h = setup(t);
  h.ok(['brief', 'set', 'T1', '-'], {
    input: [
      'SHARED_PREAMBLE_SENTINEL',
      '```md',
      '## Reviewer',
      'FENCED_REVIEWER_SENTINEL',
      '## Worker',
      'FENCED_WORKER_SENTINEL',
      '```',
      '## Shared',
      'SHARED_SECTION_SENTINEL',
      '## wOrKeR',
      'WORKER_BRIEF_SENTINEL',
      '## rEvIeWeR',
      'REVIEWER_BRIEF_SENTINEL',
    ].join('\n'),
  });

  const worker = dry(h, 'medium').argv.find((arg) => arg.includes('## Task'));
  assert.ok(worker.includes('SHARED_PREAMBLE_SENTINEL'));
  assert.ok(worker.includes('FENCED_REVIEWER_SENTINEL'));
  assert.ok(worker.includes('FENCED_WORKER_SENTINEL'));
  assert.ok(worker.includes('SHARED_SECTION_SENTINEL'));
  assert.ok(worker.includes('WORKER_BRIEF_SENTINEL'));
  assert.ok(!worker.includes('REVIEWER_BRIEF_SENTINEL'));

  reviewable(h);
  const reviewer = dry(h, 'review').argv.find((arg) => arg.includes('## Task'));
  assert.ok(!reviewer.includes('SHARED_PREAMBLE_SENTINEL'));
  assert.ok(!reviewer.includes('FENCED_REVIEWER_SENTINEL'));
  assert.ok(!reviewer.includes('FENCED_WORKER_SENTINEL'));
  assert.ok(!reviewer.includes('SHARED_SECTION_SENTINEL'));
  assert.ok(reviewer.includes('REVIEWER_BRIEF_SENTINEL'));
  assert.ok(!reviewer.includes('WORKER_BRIEF_SENTINEL'));
});

test('the prompt is the role skill, brief, task, then how to use tower-crane', (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--lock', 'lab/rdma', '--environment', 'lab']);
  setRung(h, 'medium', ['--harness', 'opencode', '--model', 'a/b']);
  const p = dry(h).argv.find((a) => a.includes('## Task'));
  assert.ok(p.startsWith('## Role instructions: tower-crane-work'));
  const iSkill = p.indexOf('# Tower Crane: work one task');
  const iBrief = p.indexOf('start from the webhook handler');
  const iTask = p.indexOf('"acceptance": [');
  const iUse = p.indexOf('Use the tower-crane CLI for every state change');
  assert.ok(iSkill < iBrief && iBrief < iTask && iTask < iUse, 'role skill, brief, task JSON, instruction in order');
  const json = JSON.parse(p.slice(p.indexOf('```json\n') + 8, p.indexOf('\n```', p.indexOf('```json'))));
  assert.deepEqual(json, { id: 'T1', title: 'Idempotency key on retries', acceptance: ['processed once', 'test proves it'], kind: 'code', needs: [], locks: ['lab/rdma'], environment: 'lab' });
  assert.match(p, /TOWER_CRANE_STATE, TOWER_CRANE_TASK and TOWER_CRANE_AGENT are set/);
  assert.ok(p.includes('you are not the owner; never pass --agent owner'));
  assert.ok(p.endsWith('run tower-crane with --agent worker-T1-1 if TOWER_CRANE_AGENT is missing.'));
});

test('without an embedded skill the goal leads the prompt, so a brief opening with a dash is never read as a flag', (t) => {
  const h = setup(t);
  setRung(h, 'small', ['--harness', 'opencode', '--model', 'a/b']);
  const prompt = dry(h, 'small').argv.find((arg) => arg.includes('## Task'));
  assert.ok(prompt.startsWith('## Goal\n\nProject goal: prove the engine\nTask target: T1, "Idempotency key on retries"'));
  assert.ok(prompt.includes('\n\n- start from the webhook handler\n'));
});

test('a spawned reviewer that loses all TOWER_CRANE variables cannot record evidence as owner', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'lost-agent.json');
  const script = `
const fs = require('node:fs');
const cp = require('node:child_process');
const env = { ...process.env };
const agent = env.TOWER_CRANE_AGENT;
const task = env.TOWER_CRANE_TASK;
const state = env.TOWER_CRANE_STATE;
for (const key of Object.keys(env)) if (key.startsWith('TOWER_CRANE_')) delete env[key];
const r = cp.spawnSync(process.execPath, [process.argv[1], 'evidence', 'T1', '--type', 'review', '--ok', '--sha', 'abcdef1', '--state', state], {
  env, encoding: 'utf8', timeout: 10000,
});
fs.writeFileSync(process.argv[2], JSON.stringify({ agent, task, remaining: Object.keys(env).filter((key) => key.startsWith('TOWER_CRANE_')), code: r.status, stderr: r.stderr }));
process.exit(r.status === null ? 1 : r.status);
`;
  reviewable(h);
  commandRung(h, 'medium', [process.execPath, '-e', script, BIN, out]);
  const r = h.run(['spawn', '--role', 'review', '--task', 'T1', '--wait']);
  assert.equal(r.code, 2, r.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(seen, {
    agent: 'reviewer-T1-1',
    task: 'T1',
    remaining: [],
    code: 2,
    stderr: 'tower-crane: no agent: pass --agent NAME or set TOWER_CRANE_AGENT\n',
  });
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(!events.some((e) => e.cmd === 'evidence'));
});

test('a spawned reviewer losing all TOWER_CRANE variables in a terminal cannot clear owner work', { skip: !PTY_AVAILABLE }, (t) => {
  const h = setup(t);
  h.ok(['task', 'add', '--title', 'Owner action', '--acceptance', 'approved', '--needs-owner', 'approve access']);
  const out = path.join(h.base, 'lost-agent-terminal.json');
  const script = `
const fs = require('node:fs');
const { runPty } = require(process.argv[1]);
const env = { ...process.env };
const agent = env.TOWER_CRANE_AGENT;
const task = env.TOWER_CRANE_TASK;
const state = env.TOWER_CRANE_STATE;
for (const key of Object.keys(env)) if (key.startsWith('TOWER_CRANE_')) delete env[key];
const r = runPty(['owner-done', 'T2', '--state', state], { cwd: process.cwd(), env });
fs.writeFileSync(process.argv[2], JSON.stringify({ agent, task, remaining: Object.keys(env).filter((key) => key.startsWith('TOWER_CRANE_')), ...r }));
process.exit(r.code === null ? 99 : r.code);
`;
  reviewable(h);
  commandRung(h, 'medium', [process.execPath, '-e', script, require.resolve('./helpers'), out]);
  const r = h.run(['spawn', '--role', 'review', '--task', 'T1', '--wait']);
  assert.equal(r.code, 1, r.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(seen.agent, 'reviewer-T1-1');
  assert.equal(seen.task, 'T1');
  assert.deepEqual(seen.remaining, []);
  assert.equal(seen.code, 1, seen.stdout + seen.stderr);
  assert.match(seen.stdout, /only the orchestrator or the owner/);
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.needs_owner, 'approve access');
  assert.deepEqual(task.notes, []);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(!events.some((e) => e.cmd === 'owner-done'));
});

test('pi rungs load the tower-crane skill for workers and reviewers when it is installed', (t) => {
  const h = setup(t);
  const plugin = path.join(h.base, 'plugin');
  writeSkill(plugin, 'tower-crane-work', 'PI_WORK_SKILL_MUST_NOT_BE_EMBEDDED');
  writeSkill(plugin, 'tower-crane-review', 'PI_REVIEW_SKILL_MUST_NOT_BE_EMBEDDED');
  const env = { TOWER_CRANE_PLUGIN_ROOT: plugin };
  for (const rung of ['easy', 'medium', 'review', 'small']) setRung(h, rung, ['--model', 'm']);
  h.ok(['ladder', 'harness', 'pi']);
  const at = (argv) => argv.slice(argv.indexOf('--skill'), argv.indexOf('--skill') + 2);
  const worker = dry(h, 'medium', env).argv;
  const reviewer = dry(h, 'review', env).argv;
  assert.deepEqual(at(worker), ['--skill', path.join(plugin, 'skills', 'tower-crane-work')]);
  assert.deepEqual(at(dry(h, 'easy', env).argv), ['--skill', path.join(plugin, 'skills', 'tower-crane-work')]);
  assert.deepEqual(at(reviewer), ['--skill', path.join(plugin, 'skills', 'tower-crane-review')]);
  assert.ok(!worker.find((arg) => arg.includes('## Task')).includes('PI_WORK_SKILL_MUST_NOT_BE_EMBEDDED'));
  assert.ok(!reviewer.find((arg) => arg.includes('## Task')).includes('PI_REVIEW_SKILL_MUST_NOT_BE_EMBEDDED'));
  assert.ok(!dry(h, 'small', env).argv.includes('--skill'), 'other rungs get no skill');
  const missing = path.join(h.base, 'empty-plugin');
  fs.mkdirSync(missing);
  assert.ok(!dry(h, 'medium', { TOWER_CRANE_PLUGIN_ROOT: missing }).argv.includes('--skill'), 'no skill when it is not installed');

  const incomplete = path.join(h.base, 'incomplete-plugin');
  fs.mkdirSync(path.join(incomplete, 'skills', 'tower-crane-work'), { recursive: true });
  const warning = h.run(['spawn', '--role', 'medium', '--task', 'T1', '--dry-run', '--json'], {
    env: { TOWER_CRANE_PLUGIN_ROOT: incomplete },
  });
  assert.equal(warning.code, 0, warning.stderr);
  assert.match(warning.stderr, /SKILL\.md.*missing/i);
  assert.ok(!JSON.parse(warning.stdout).argv.includes('--skill'));
});

test('spawn --wait runs the command rung in the task worktree with the tower-crane environment', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'seen.json');
  const script = 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), task: process.argv[2], brief: process.argv[3], briefText: fs.readFileSync(process.argv[3], "utf8"), cwdArg: process.argv[4], prompt: process.argv[5], env: { s: process.env.TOWER_CRANE_STATE, t: process.env.TOWER_CRANE_TASK, a: process.env.TOWER_CRANE_AGENT } })); process.exit(7)';
  commandRung(h, 'medium', [process.execPath, '-e', script, out, '{task}', '{brief}', '{cwd}', 'P:{prompt}']);
  const tempRoot = path.join(h.base, 'tower-crane-tmp');
  fs.mkdirSync(tempRoot);
  const r = h.run(['spawn', '--task', 'T1', '--wait'], { env: { TOWER_CRANE_TMP: tempRoot } });
  assert.equal(r.code, 7, r.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  const wt = path.join(h.base, 'repo-worktrees', 'T1-idempotency-key-on-retries');
  assert.equal(real(seen.cwd), real(wt));
  assert.equal(real(seen.cwdArg), real(wt));
  assert.equal(seen.task, 'T1');
  assert.notEqual(path.resolve(seen.brief), path.resolve(path.join(h.state, 'briefs', 'T1.md')));
  assert.match(seen.briefText, /^## Goal\n[\s\S]*\n- start from the webhook handler\n\n## Task\n/);
  assert.ok(!fs.existsSync(seen.brief), 'the temporary brief copy is removed after exit');
  assert.match(seen.prompt, /^P:## Goal\n[\s\S]*\n- start from the webhook handler/);
  assert.deepEqual([real(seen.env.s), seen.env.t, seen.env.a], [real(h.state), 'T1', 'worker-T1-1']);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const spawnEv = events.find((e) => e.cmd === 'spawn');
  assert.equal(spawnEv.detail.agent, 'worker-T1-1');
  assert.equal(spawnEv.detail.rung, 'medium');
  assert.ok(Number.isInteger(spawnEv.detail.pid));
  assert.equal(events.find((e) => e.cmd === 'spawn exit').detail.code, 7);
});

test('a spawned agent never inherits the owner key that admitted its spawn', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'agent-env.json');
  commandRung(h, 'medium', [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env)))`]);
  assert.ok(h.env.TOWER_CRANE_OWNER_KEY);
  h.ok(['spawn', '--task', 'T1', '--wait']);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(seen.includes('TOWER_CRANE_AGENT'));
  assert.ok(!seen.includes('TOWER_CRANE_OWNER_KEY'));
});

test('spawn removes outer Node test runner variables so an agent can run its own test suite', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'nested-run.json');
  const marker = path.join(h.base, 'nested-test-ran');
  const file = path.join(h.repo, 'nested.test.js');
  fs.writeFileSync(file, `
const test = require('node:test');
test('the agent runs a real nested test', () => {
  require('node:assert/strict').equal(process.env.NESTED_KEEP, 'kept');
  require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');
});
`);
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'nested runner fixture']);
  const script = `
const cp = require('node:child_process');
const result = cp.spawnSync(process.execPath, ['--test', '--test-reporter=tap', ${JSON.stringify(file)}], { encoding: 'utf8', timeout: 10000 });
require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({
  runnerEnv: Object.keys(process.env).filter((key) => /^NODE_TEST_/i.test(key)),
  code: result.status, stdout: result.stdout, stderr: result.stderr,
}));
`;
  commandRung(h, 'medium', [process.execPath, '-e', script]);
  h.ok(['project', 'set', '--env', '{"NODE_TEST_CONTEXT":"child-v8","NESTED_KEEP":"kept"}']);
  h.ok(['spawn', '--task', 'T1', '--wait'], {
    env: { NODE_TEST_WORKER_ID: 'outer-worker', NODE_TEST_REPORTER: 'outer-reporter', NODE_TEST_FUTURE: 'outer-value' },
  });
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(seen.runnerEnv, []);
  assert.equal(seen.code, 0, seen.stderr);
  assert.equal(seen.stderr, '');
  assert.match(seen.stdout, /# pass 1\b/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
});

test('command brief placeholders point to role-filtered temporary copies', async (t) => {
  const h = setup(t);
  h.ok(['brief', 'set', 'T1', '-'], {
    input: [
      'SHARED_FOR_COMMANDS',
      '## Worker',
      'WORKER_ONLY_COMMAND',
      '## Reviewer',
      'REVIEWER_ONLY_COMMAND',
      '## Rework notes',
      'REWORK_SHARED_COMMAND',
    ].join('\n'),
  });
  const tempRoot = path.join(h.base, 'tower-crane-tmp');
  fs.mkdirSync(tempRoot);
  const workerOut = path.join(h.base, 'worker-brief.json');
  const reviewerOut = path.join(h.base, 'reviewer-brief.json');
  const cleanupOut = path.join(h.base, 'brief-cleanup.jsonl');
  const hook = path.join(h.base, 'brief-cleanup.js');
  fs.writeFileSync(hook, `
// Record the unlink boundary before the supervisor finishes its exit path.
const fs = require('node:fs');
const rm = fs.rmSync;
fs.rmSync = function(file, ...args) {
  const result = rm.call(this, file, ...args);
  if (String(file).startsWith(${JSON.stringify(tempRoot + path.sep)} + 'tower-crane-brief-') && String(file).endsWith('brief.md')) {
    fs.appendFileSync(${JSON.stringify(cleanupOut)}, JSON.stringify(fs.readdirSync(${JSON.stringify(tempRoot)})) + '\\n');
  }
  return result;
};
`);
  const env = { TOWER_CRANE_TMP: tempRoot, NODE_OPTIONS: `--require "${hook.replace(/\\/g, '/')}"` };
  const script = `
const fs = require('node:fs');
fs.writeFileSync(process.argv[1], JSON.stringify({ path: process.argv[2], text: fs.readFileSync(process.argv[2], 'utf8') }));
process.once('SIGTERM', () => process.exit(0));
setImmediate(() => process.platform === 'win32' ? process.exit(0) : process.kill(process.pid, 'SIGTERM'));
`;
  commandRung(h, 'medium', [process.execPath, '-e', script, workerOut, '{brief}']);
  commandRung(h, 'review', [process.execPath, '-e', script, reviewerOut, '{brief}']);

  const planned = dry(h, 'medium', { TOWER_CRANE_TMP: tempRoot });
  const dryCopy = planned.argv.find((arg) => arg.startsWith(tempRoot + path.sep) && arg.endsWith('brief.md'));
  assert.ok(dryCopy);
  assert.ok(dryCopy.startsWith(tempRoot + path.sep));
  assert.ok(!fs.existsSync(dryCopy), 'dry-run only prints the copy path');

  const worker = h.run(['spawn', '--role', 'medium', '--task', 'T1', '--wait'], { env });
  assert.equal(worker.code, 0, worker.stderr);
  const workerCopy = JSON.parse(fs.readFileSync(workerOut, 'utf8'));
  assert.match(workerCopy.text, /SHARED_FOR_COMMANDS/);
  assert.match(workerCopy.text, /WORKER_ONLY_COMMAND/);
  assert.match(workerCopy.text, /REWORK_SHARED_COMMAND/);
  assert.ok(!workerCopy.text.includes('REVIEWER_ONLY_COMMAND'));
  assert.ok(!fs.existsSync(workerCopy.path));

  reviewable(h);
  commandRung(h, 'medium', [process.execPath, '-e', script, reviewerOut, '{brief}']);
  fs.writeFileSync(cleanupOut, '');
  const cleaned = new Promise((resolve, reject) => {
    const watcher = fs.watch(cleanupOut, () => {
      watcher.close();
      clearTimeout(timeout);
      resolve();
    });
    const timeout = setTimeout(() => {
      watcher.close();
      reject(new Error('the reviewer did not remove its brief copy'));
    }, 10000);
    t.after(() => { watcher.close(); clearTimeout(timeout); });
  });
  const reviewer = h.json(['spawn', '--role', 'review', '--task', 'T1'], { env });
  assert.equal(reviewer.agent, 'reviewer-T1-1');
  await cleaned;
  const reviewerCopy = JSON.parse(fs.readFileSync(reviewerOut, 'utf8'));
  assert.ok(!reviewerCopy.text.includes('SHARED_FOR_COMMANDS'));
  assert.match(reviewerCopy.text, /REVIEWER_ONLY_COMMAND/);
  assert.ok(!reviewerCopy.text.includes('REWORK_SHARED_COMMAND'));
  assert.ok(!reviewerCopy.text.includes('WORKER_ONLY_COMMAND'));
  assert.ok(!fs.existsSync(reviewerCopy.path));
  assert.deepEqual(fs.readdirSync(tempRoot), []);
  const snapshots = fs.readFileSync(cleanupOut, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(snapshots.length > 0, 'cleanup reached the unlink boundary');
  for (const snapshot of snapshots) assert.deepEqual(snapshot, []);
});

test('temporary brief copies are removed before normal and signalled foreground exits return', (t) => {
  const h = setup(t);
  const tempRoot = path.join(h.base, 'tower-crane-tmp');
  const out = path.join(h.base, 'brief-path');
  fs.mkdirSync(tempRoot);
  h.ok(['ladder', 'set', 'medium', '--supervision', '{"retries":0}']);
  for (const [exit, code] of [
    ['process.exit(0)', 0],
    ['process.exit(7)', 7],
    ['setImmediate(() => process.kill(process.pid, "SIGTERM"))', 1],
  ]) {
    const script = `require('node:fs').writeFileSync(process.argv[1], process.argv[2]); ${exit};`;
    commandRung(h, 'medium', [process.execPath, '-e', script, out, '{brief}']);
    const result = h.run(['spawn', '--task', 'T1', '--wait'], { env: { TOWER_CRANE_TMP: tempRoot } });
    assert.equal(result.code, code, result.stderr);
    assert.ok(!fs.existsSync(fs.readFileSync(out, 'utf8')));
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  }
});

test('temporary brief copies are removed before spawn startup failure returns', (t) => {
  const h = setup(t);
  const tempRoot = path.join(h.base, 'tower-crane-tmp');
  const hook = path.join(h.base, 'brief-launch-failure.js');
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(hook, `
if (process.argv[1].endsWith('spawn-monitor.js')) {
  const cp = require('node:child_process');
  const spawn = cp.spawn;
  cp.spawn = function(file, args, opts) {
    return spawn.call(this, ${JSON.stringify(path.join(h.base, 'missing-harness'))}, args, opts);
  };
}
`);
  commandRung(h, 'medium', [process.execPath, '-e', 'process.exit(0)', '{brief}']);
  for (const flags of [[], ['--wait']]) {
    const result = h.run(['spawn', '--task', 'T1', ...flags], {
      env: { TOWER_CRANE_TMP: tempRoot, NODE_OPTIONS: `--require "${hook.replace(/\\/g, '/')}"` },
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /could not start.*ENOENT/);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  }
  const dispatch = h.run(['spawn', '--task', 'T1'], {
    env: { TOWER_CRANE_TMP: tempRoot }, hooks: { HOOK_SPAWN_FAIL: '1' },
  });
  assert.notEqual(dispatch.code, 0);
  assert.match(dispatch.stderr, /supervisor startup failed/);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('background spawn refuses occupied log names without writing or recording a spawn', (t) => {
  for (const linked of [false, true]) {
    const h = setup(t);
    commandRung(h, 'small', [process.execPath, '-e', 'console.log("agent output")']);
    const logs = path.join(h.state, 'logs');
    fs.mkdirSync(logs);
    const log = path.join(logs, 'T1-small-T1-1.log');
    const target = path.join(h.base, 'unrelated-file');
    fs.writeFileSync(target, 'preserve this file\n');
    if (linked) {
      try {
        fs.symlinkSync(target, log);
      } catch (e) {
        if (process.platform === 'win32' && e.code === 'EPERM') continue;
        throw e;
      }
    } else {
      fs.writeFileSync(log, 'preserve this log\n');
    }
    const tasks = fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8');
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    const result = h.run(['spawn', '--role', 'small', '--task', 'T1', '--json']);
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stderr, /log already exists/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserve this file\n');
    assert.equal(fs.readFileSync(log, 'utf8'), linked ? 'preserve this file\n' : 'preserve this log\n');
    assert.equal(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'), tasks);
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), events);
  }
});

test('spawn in the background detaches, logs output and numbers agents', async (t) => {
  const h = setup(t);
  commandRung(h, 'small', [process.execPath, '-e', 'console.log("hello from " + process.env.TOWER_CRANE_AGENT)']);
  const started = h.json(['spawn', '--role', 'small', '--task', 'T1']);
  assert.equal(started.agent, 'small-T1-1');
  assert.ok(Number.isInteger(started.pid));
  assert.equal(real(path.dirname(started.log)), real(path.join(h.state, 'logs')));
  assert.equal(path.basename(started.log), 'T1-small-T1-1.log');
  if (process.platform !== 'win32') assert.equal(fs.statSync(started.log).mode & 0o777, 0o600);
  const deadline = Date.now() + 10000;
  while (!(fs.existsSync(started.log) && fs.readFileSync(started.log, 'utf8').includes('hello'))) {
    if (Date.now() > deadline) throw new Error('the background agent wrote nothing to its log');
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(fs.readFileSync(started.log, 'utf8'), /hello from small-T1-1/);
  assert.equal(h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run']).agent, 'small-T1-2');

  reviewable(h);
  commandRung(h, 'medium', ['tower-crane-no-such-program']);
  const missing = h.run(['spawn', '--role', 'review', '--task', 'T1']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /could not start tower-crane-no-such-program/);
  h.ok(['task', 'add', '--title', 'No brief', '--acceptance', 'x']);
  const noBrief = h.run(['spawn', '--role', 'small', '--task', 'T2', '--dry-run']);
  assert.equal(noBrief.code, 1);
  assert.match(noBrief.stderr, /T2 has no brief; write one with tower-crane brief set T2/);
});

// Everything a spawn could leave behind: state files, events, logs, the
// worktree and its branch.
function footprint(h) {
  const read = (f) => (fs.existsSync(path.join(h.state, f)) ? fs.readFileSync(path.join(h.state, f), 'utf8') : null);
  return {
    tasks: read('tasks.json'),
    events: read('events.jsonl'),
    logs: fs.existsSync(path.join(h.state, 'logs')) ? fs.readdirSync(path.join(h.state, 'logs')) : null,
    worktrees: fs.existsSync(path.join(h.base, 'repo-worktrees')),
    branches: h.git(['branch', '--list', 'tower-crane/*']),
  };
}

test('a spawn refused for a missing program creates and writes nothing', (t) => {
  const h = setup(t);
  for (const command of [['tower-crane-no-such-program', '{prompt}'], [path.join(h.base, 'missing', 'agent')]]) {
    commandRung(h, 'small', command);
    const before = footprint(h);
    assert.equal(h.readState('tasks.json').tasks[0].branch, null);
    for (const mode of [[], ['--wait']]) {
      const r = h.run(['spawn', '--role', 'small', '--task', 'T1', ...mode]);
      assert.equal(r.code, 1, r.stderr);
      assert.deepEqual(footprint(h), before, `${command[0]} ${mode.join(' ')}`);
      assert.ok(r.stderr.includes(`could not start ${command[0]}: no executable file by that name`), r.stderr);
    }
  }
});

const leftover = (h) => path.join(h.base, 'repo-worktrees', 'T1-idempotency-key-on-retries');

test('a spawn whose program fails to start records nothing and leaves its worktree for the next spawn', (t) => {
  const h = setup(t);
  commandRung(h, 'small', [process.execPath, '-e', 'process.exit(0)', '{prompt}']);
  const { tasks, events } = footprint(h);
  for (const mode of [[], ['--wait']]) {
    const r = h.run(['spawn', '--role', 'small', '--task', 'T1', ...mode], { hooks: { HOOK_SPAWN_FAIL: '1' } });
    assert.equal(r.code, 1, r.stderr);
    const now = footprint(h);
    assert.ok(fs.existsSync(leftover(h)), 'the worktree stays');
    assert.equal(now.branches.replace(/^[*+ ]+/, ''), 'tower-crane/T1-idempotency-key-on-retries', 'the branch stays');
    assert.deepEqual([now.tasks, now.events, now.logs || []], [tasks, events, []], `${mode.join(' ') || 'background'}: no spawn is recorded`);
    assert.match(r.stderr, /could not start .*; its worktree stays at .*T1-idempotency-key-on-retries for the next spawn/);
  }
  const next = h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait']);
  assert.equal(next.code, 0);
  assert.equal(next.agent, 'small-T1-1', 'a failed spawn does not consume an agent name');
  assert.equal(real(next.cwd), real(leftover(h)), 'the next spawn reuses it');
  assert.equal(h.readState('tasks.json').tasks[0].branch, 'tower-crane/T1-idempotency-key-on-retries');
});

test('a spawn that cannot take the lock leaves its worktree, names it and exits 3', (t) => {
  const h = setup(t);
  commandRung(h, 'small', [process.execPath, '-e', 'process.exit(0)', '{prompt}']);
  const { tasks } = footprint(h);
  // The test process keeps the lock until the spawn exhausts its short budget.
  const lock = S.acquireLock(h.state);
  try {
    const r = h.run(['spawn', '--role', 'small', '--task', 'T1'], {
      env: { NODE_OPTIONS: `--require=${JSON.stringify(SHORT_WAIT)}` },
    });
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /state is locked by .*; its worktree stays at .*T1-idempotency-key-on-retries for the next spawn/);
    assert.ok(fs.existsSync(lock.file), 'the holder keeps its lock through the refusal');
    assert.equal(footprint(h).tasks, tasks);
    assert.ok(fs.existsSync(leftover(h)));
  } finally {
    S.releaseLock(lock);
  }
  assert.equal(real(h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait']).cwd), real(leftover(h)));
});

async function waitForFile(file, ms = 20000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`${file} never appeared`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a failed spawn never deletes a worktree another command took up', async (t) => {
  const h = setup(t);
  const output = 'worker-output.txt';
  const release = path.join(h.base, 'worker-may-write');
  // The worker stays alive with nothing written until the test releases it,
  // then writes into its working directory.
  const worker = `const fs = require("fs"); const end = Date.now() + 20000;
while (!fs.existsSync(process.argv[1]) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
fs.writeFileSync(${JSON.stringify(output)}, "work in progress");`;
  commandRung(h, 'small', [process.execPath, '-e', worker, release]);
  const branchExists = (b) => h.git(['branch', '--list', b]).replace(/^[*+ ]+/, '') === b;

  // A creates T1's worktree and stops before it takes the lock; its program
  // will fail to start. B spawns into the same worktree and its worker starts.
  const aCreated = path.join(h.base, 'a-created');
  const a = h.runAsync(['spawn', '--role', 'small', '--task', 'T1'], { hooks: { HOOK_STOP_WORKTREE_ADD: aCreated, HOOK_SPAWN_FAIL: '1' } });
  await waitForFile(aCreated);
  const b = h.json(['spawn', '--role', 'small', '--task', 'T1']);
  fs.writeFileSync(`${aCreated}.go`, '');
  assert.equal((await a).code, 1);
  assert.ok(fs.existsSync(b.cwd), "B's worktree is still there");
  assert.ok(branchExists(h.readState('tasks.json').tasks[0].branch), "T1's recorded branch still exists");
  fs.writeFileSync(release, '');
  await waitForFile(path.join(b.cwd, output));

  // T2 already names a branch but has no worktree. A creates the worktree
  // and stops; B gets it from tower-crane worktree, claims T2 and works there
  // before writing anything. Then A fails.
  h.git(['branch', 'feature/second']);
  h.ok(['task', 'add', '--title', 'Second', '--acceptance', 'b']);
  h.ok(['brief', 'set', 'T2', '-'], { input: 'second brief\n' });
  h.ok(['claim', 'T2', '--agent', 'w-1']);
  h.ok(['submit', 'T2', '--sha', 'abcdef1', '--branch', 'feature/second', '--agent', 'w-1']);
  h.ok(['rework', 'T2', '--reason', 'again']);
  const a2Created = path.join(h.base, 'a2-created');
  const a2 = h.runAsync(['spawn', '--role', 'small', '--task', 'T2'], { hooks: { HOOK_STOP_WORKTREE_ADD: a2Created, HOOK_SPAWN_FAIL: '1' } });
  await waitForFile(a2Created);
  const handed = h.json(['worktree', 'T2']).path;
  h.ok(['claim', 'T2', '--agent', 'w-b']);
  fs.writeFileSync(`${a2Created}.go`, '');
  assert.equal((await a2).code, 1);
  assert.ok(fs.existsSync(handed), "the claimant's worktree is still there");
  assert.ok(branchExists('feature/second'));
  fs.writeFileSync(path.join(handed, 'claimant-output.txt'), 'work');
});

test('spawn runs the rung of the tier and ladder it finds under the lock, not the one it saw first', async (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'ran.txt');
  const writes = (word) => [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', out, word];
  h.ok(['task', 'update', 'T1', '--tier', 'easy']);
  commandRung(h, 'easy', writes('easy'));
  commandRung(h, 'hard', writes('hard'));
  // The spawn stops after it made the worktree and before it takes the lock;
  // meanwhile the task moves to hard and the hard rung changes.
  const stopped = path.join(h.base, 'stopped');
  const a = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], { hooks: { HOOK_STOP_WORKTREE_ADD: stopped } });
  await waitForFile(stopped);
  h.ok(['task', 'update', 'T1', '--tier', 'hard']);
  commandRung(h, 'hard', writes('hard, changed'));
  fs.writeFileSync(`${stopped}.go`, '');
  const r = await a;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), 'hard, changed');
  assert.equal(JSON.parse(r.stdout).rung, 'hard');
  const ev = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.cmd === 'spawn');
  assert.deepEqual([ev.detail.rung, ev.detail.agent], ['hard', 'worker-T1-1']);

  // A rung that broke in the meantime is refused under the lock, and nothing
  // is recorded.
  fs.rmSync(out);
  const stopped2 = path.join(h.base, 'stopped2');
  h.git(['worktree', 'remove', '--force', ev.detail.cwd]);
  const b = h.runAsync(['spawn', '--task', 'T1', '--wait'], { hooks: { HOOK_STOP_WORKTREE_ADD: stopped2 } });
  await waitForFile(stopped2);
  setRung(h, 'hard', ['--harness', 'command', '--command', JSON.stringify([path.join(h.base, 'no-such-program'), '{prompt}'])]);
  fs.writeFileSync(`${stopped2}.go`, '');
  const rb = await b;
  assert.equal(rb.code, 1);
  assert.match(rb.stderr, /could not start .*no-such-program: no executable file by that name; install it, or fix the rung with tower-crane ladder set hard/);
  assert.ok(!fs.existsSync(out));
  const spawns = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.cmd === 'spawn');
  assert.equal(spawns.length, 1);
});

test('spawn refuses a stacked rework with claim\'s reason when its dependency went back to in_progress, before its worktree work', (t) => {
  const f = stack.stacked(t);
  stack.worker(f);
  // T2's worktree is prepared on T1's head. T1 then takes a new head and goes back to in_progress.
  f.h.ok(['rework', 'T2', '--reason', 'more upper work']);
  stack.resubmit(f, false);
  f.h.ok(['rework', 'T1', '--reason', 'more lower work']);
  f.h.ok(['claim', 'T1', '--agent', 'worker-T1']);
  // The stack is not linked on GitHub, so T2's worktree is stale and must be revalidated at dispatch.
  const state = f.h.readState('tasks.json');
  state.tasks.find((item) => item.id === 'T2').stack.linked = false;
  f.h.writeState('tasks.json', state);
  f.write((d) => { d.linked = false; });

  const r = f.h.run(['spawn', '--task', 'T2']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /T2 is blocked: depends on T1 \(in_progress\)/);
  assert.doesNotMatch(r.stderr, /prepared on T1|before dispatch/);
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'rework');
});
