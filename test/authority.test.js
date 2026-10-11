'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, cachedFixture } = require('./helpers');
const { gateFixture } = require('./gate-helpers');
const A = require('../lib/agents');
const L = require('../lib/ladder');

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const as = (agent) => ({ env: { TOWER_CRANE_AGENT: agent } });

// A spawn record as spawn writes it, so an agent name has a recorded role.
function recordSpawn(h, agent, role) {
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify({
    at: new Date().toISOString(), agent: 'owner', cmd: 'spawn', task: 'T1', detail: { agent, role, rung: role === 'orchestrator' ? 'orchestrator' : 'hard', pid: 1 },
  })}\n`);
}

// The owner's own harness config: codex defines the MCP server docs, claude
// defines none.
function harnessConfig(h) {
  h.env.CODEX_HOME = path.join(h.base, 'codex');
  h.env.CLAUDE_CONFIG_DIR = path.join(h.base, 'claude');
  fs.mkdirSync(h.env.CODEX_HOME, { recursive: true });
  fs.mkdirSync(h.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(h.env.CODEX_HOME, 'config.toml'), '[mcp_servers.docs]\ncommand = "docs-server"\n');
}

// The owner's personal ladder settings, such as fallback routes.
function writeUser(h, doc) {
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  fs.writeFileSync(h.userConfig, JSON.stringify(doc));
}

function setup(t) {
  return cachedFixture(t, 'owner task', (h) => {
    harnessConfig(h);
    h.init();
    h.ok(['task', 'add', '--title', 'Owner action', '--acceptance', 'done', '--needs-owner', 'approve access']);
  });
}

const OPERATIONAL = [
  ['project', 'set', '--tests-cmd', 'npm test', '--clean-cmd', 'node clean.js', '--tests-proof-cmd', 'node {tests}'],
  ['project', 'set', '--ci-required', '["test ("]', '--ci-ignore-apps', '["claude"]', '--ci-capped-review', '[{"app":"cursor","pattern":"usage limit"}]'],
  ['project', 'set', '--ci-local', '{"command":["node","ci.js"],"timeout":60}'],
  ['project', 'set', '--tests-mode', 'run-only', '--tests-paths', '["test/**"]', '--tests-keep', '[]', '--tests-by-kind', '{}', '--tests-expensive', 'false'],
  ['project', 'set', '--workers', '3', '--lease-minutes', '45', '--budget-hours', '10'],
  ['project', 'set', '--review-policy', '{"small_lines":50}'],
  ['ladder', 'set', 'easy', '--harness', 'codex', '--model', 'fixture-other', '--effort', 'high', '--args', '[]', '--tools', '["web_search"]', '--mcp', '["docs"]'],
  ['ladder', 'save-user'],
  ['task', 'update', 'T1', '--tier', 'hard'],
  ['task', 'update', 'T1', '--needs-owner', 'approve other access'],
  ['owner-done', 'T1'],
];

test('research web MCP changes use owner-required authority and deduplicate escalation', (t) => {
  const h = setup(t);
  const server = { name: 'harness-web', command: 'node', args: ['/web/server.mjs'] };
  const args = ['ladder', 'set', 'research', '--web-mcp', JSON.stringify(server)];
  const before = h.readState('project.json');
  for (let i = 0; i < 2; i++) {
    const r = h.run(args, as('orchestrator'));
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /ladder\.web_mcp is owner-required; opened D1/);
    assert.deepEqual(h.readState('project.json'), before);
    assert.equal(h.readState('decisions.json').decisions.length, 1);
  }
  const d = h.readState('decisions.json').decisions[0];
  assert.deepEqual(d.escalation, {
    settings: ['ladder.web_mcp'], change: { ladder: { research: { web_mcp: server } } },
  });
  for (const agent of ['worker-T1-1', 'reviewer-T1-1']) {
    const r = h.run(args, as(agent));
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /only the owner/);
    assert.deepEqual(h.readState('project.json'), before);
    assert.equal(h.readState('decisions.json').decisions.length, 1);
  }
  h.ok(args);
  assert.deepEqual(h.readState('project.json').ladder.research.web_mcp, server);
  const clear = h.run(['ladder', 'set', 'research', '--clear', 'web_mcp'], as('orchestrator'));
  assert.equal(clear.code, 1, clear.stderr);
  assert.match(clear.stderr, /ladder\.web_mcp is owner-required; opened D2/);
  assert.deepEqual(h.readState('project.json').ladder.research.web_mcp, server);
  assert.deepEqual(h.readState('decisions.json').decisions[1].escalation.change,
    { ladder: { research: { web_mcp: null } } });
  h.ok(['ladder', 'set', 'research', '--clear', 'web_mcp']);
  assert.equal(h.readState('project.json').ladder.research.web_mcp, undefined);
});

test('research source policy and waivers retain owner-required authority', (t) => {
  const h = setup(t);
  for (const [args, key] of [
    [['project', 'set', '--research-min-sources', '4'], 'research.min_sources'],
    [['accept', 'T1', '--waive', 'sources', '--reason', 'owner exception'], 'waive.sources'],
  ]) {
    const before = { project: h.readState('project.json'), tasks: h.readState('tasks.json') };
    const r = h.run(args, as('orchestrator'));
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /owner-required; opened D/);
    assert.deepEqual(h.readState('decisions.json').decisions.at(-1).escalation.settings, [key]);
    assert.deepEqual({ project: h.readState('project.json'), tasks: h.readState('tasks.json') }, before);
    assert.equal(h.run(args, as('worker-T1-1')).code, 1);
  }
  h.ok(['project', 'set', '--research-min-sources', '4']);
  assert.equal(h.readState('project.json').research.min_sources, 4);
});

test('research defaults and operational model tuning need no new authority grant', (t) => {
  const h = makeRepo(t);
  h.env.TOWER_CRANE_AGENT = 'orchestrator';
  h.init();
  h.ok(['ladder', 'set', 'research', '--model', 'tuned', '--effort', 'high']);
  assert.equal(h.readState('project.json').ladder.research.model, 'tuned');
  assert.equal(h.readState('decisions.json').decisions.length, 0);
});

test('the orchestrator changes operational settings under its own identity; a worker is sent to the orchestrator', (t) => {
  const h = setup(t);
  for (const args of OPERATIONAL) {
    const before = { project: h.readState('project.json'), tasks: h.readState('tasks.json') };
    for (const worker of [as('worker-T1-1'), { env: { TOWER_CRANE_AGENT: 'worker-T1-1' }, extra: ['--agent', 'orchestrator'] }]) {
      const r = h.run([...args, ...(worker.extra || [])], { env: worker.env });
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /only the orchestrator or the owner/);
      assert.match(r.stderr, /msg --to orchestrator/);
      assert.deepEqual({ project: h.readState('project.json'), tasks: h.readState('tasks.json') }, before);
    }
    const r = h.run(args, as('orchestrator'));
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(events(h).at(-1).agent, 'orchestrator');
  }
  const p = h.readState('project.json');
  assert.equal(p.gates.tests_cmd, 'npm test');
  assert.deepEqual(p.ci.capped_review, [{ app: 'cursor', pattern: 'usage limit' }]);
  assert.equal(p.limits.workers, 3);
  assert.equal(p.ladder.easy.model, 'fixture-other');
  assert.equal(events(h).findLast((e) => e.cmd === 'project set').detail.authority, 'orchestrator');
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null);
  assert.equal(h.readState('decisions.json').decisions.length, 0);
});

test('a command the broker runs is never the orchestrator, even under a spawned orchestrator name', (t) => {
  const h = setup(t);
  recordSpawn(h, 'orchestrator-T1-1', 'orchestrator');
  const before = h.readState('project.json');
  const brokered = h.run(['project', 'set', '--tests-cmd', 'npm test', '--agent', 'orchestrator-T1-1'], {
    env: { TOWER_CRANE_STATE: h.state, TOWER_CRANE_AGENT: 'orchestrator-T1-1', TOWER_CRANE_TASK: 'T1', TOWER_CRANE_VIA: 'broker' },
  });
  assert.equal(brokered.code, 1, brokered.stderr);
  assert.match(brokered.stderr, /only the orchestrator or the owner/);
  assert.deepEqual(h.readState('project.json'), before);
  h.ok(['project', 'set', '--tests-cmd', 'npm test', '--agent', 'orchestrator-T1-1'], {
    env: { TOWER_CRANE_AGENT: 'orchestrator-T1-1', TOWER_CRANE_TASK: 'T1' },
  });
  assert.equal(h.readState('project.json').gates.tests_cmd, 'npm test');
});

test('ladder save-user is operational: the orchestrator saves with no decision and the event records it; a worker writes no user file', (t) => {
  const h = setup(t);
  const worker = h.run(['ladder', 'save-user'], as('worker-T1-1'));
  assert.equal(worker.code, 1, worker.stderr);
  assert.match(worker.stderr, /ladder\.save_user is operational: only the orchestrator or the owner/);
  assert.equal(fs.existsSync(h.userConfig), false);
  h.ok(['ladder', 'save-user'], as('orchestrator'));
  assert.equal(fs.existsSync(h.userConfig), true);
  assert.equal(h.readState('decisions.json').decisions.length, 0);
  const saved = events(h).findLast((e) => e.cmd === 'ladder save-user');
  assert.equal(saved.agent, 'orchestrator');
  assert.equal(saved.detail.authority, 'orchestrator');
});

test('only a real orchestrator identity acts as orchestrator', (t) => {
  const h = setup(t);
  const args = ['project', 'set', '--workers', '2'];
  // A spawned orchestrator acts as orchestrator under its spawned name.
  recordSpawn(h, 'orchestrator-T1-1', 'orchestrator');
  assert.equal(h.run(args, as('orchestrator-T1-1')).code, 0);
  // A name some spawn started as a worker never does, even if it is called orchestrator.
  recordSpawn(h, 'orchestrator', 'worker');
  const r = h.run(args, as('orchestrator'));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /msg --to orchestrator/);
  // Brokered commands are a sandboxed agent's, even under an orchestrator's
  // spawned name. A broker passes --state, since it runs no git.
  const brokered = h.run([...args, '--state', h.state], { env: { TOWER_CRANE_AGENT: 'orchestrator-T1-1', TOWER_CRANE_VIA: 'broker' } });
  assert.equal(brokered.code, 1, brokered.stderr);
  assert.match(brokered.stderr, /limits\.workers is operational/);
});

test('owner-required changes by the orchestrator open one decision and change nothing; the owner makes them', (t) => {
  const h = setup(t);
  const cases = [
    [['project', 'set', '--merge-admin', 'true'], ['merge.admin']],
    [['project', 'set', '--decision-delegation', '{"orchestrator_technical":true}'], ['decision_delegation']],
    [['project', 'set', '--sandbox', '{"write":["/tmp/x"]}'], ['sandbox']],
    [['project', 'set', '--session-bus', 'true'], ['sandbox.session_bus']],
    [['project', 'set', '--env', '{"A":"1"}'], ['env']],
    [['project', 'set', '--budget-hours', '5'], null],
    [['ladder', 'set', 'easy', '--scope', '{}'], ['scope']],
    [['ladder', 'set', 'easy', '--command', '["node"]'], ['ladder.command']],
    [['project', 'set', '--budget-hours', '9'], ['budget.raise']],
    [['accept', 'T1', '--waive', 'tests', '--reason', 'flaky'], ['waive.tests']],
  ];
  let opened = 0;
  for (const [args, escalation] of cases) {
    const before = { project: h.readState('project.json'), tasks: h.readState('tasks.json') };
    const r = h.run(args, as('orchestrator'));
    if (!escalation) {
      // Lowering the budget is operational.
      assert.equal(r.code, 0, r.stderr);
      continue;
    }
    opened += 1;
    assert.equal(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`owner-required; opened D${opened} for the owner`));
    assert.deepEqual({ project: h.readState('project.json'), tasks: h.readState('tasks.json') }, before);
    const d = h.readState('decisions.json').decisions.at(-1);
    assert.equal(d.id, `D${opened}`);
    assert.equal(d.asked_by, 'orchestrator');
    assert.deepEqual(d.escalation.settings, escalation);
    assert.deepEqual(d.answerers, []);
    assert.equal(d.technical, false);
    assert.equal(d.answer_rule, null);
    const e = events(h).at(-1);
    assert.equal(e.cmd, 'ask');
    assert.deepEqual(e.detail.escalation.settings, escalation);
    // Asking again waits on the same decision.
    const again = h.run(args, as('orchestrator'));
    assert.match(again.stderr, new RegExp(`opened D${opened} `));
    assert.equal(h.readState('decisions.json').decisions.length, opened);
    // A worker is refused without a decision.
    const worker = h.run(args, as('worker-T1-1'));
    assert.equal(worker.code, 1);
    assert.match(worker.stderr, /only the owner/);
    assert.equal(h.readState('decisions.json').decisions.length, opened);
  }
  // Only the owner answers an escalation.
  const answer = h.run(['answer', 'D1', '--choice', 'approved'], as('orchestrator'));
  assert.equal(answer.code, 1, answer.stderr);
  assert.match(answer.stderr, /only the owner answers it/);
  h.ok(['project', 'set', '--merge-admin', 'true', '--budget-hours', '9']);
  const completed = h.readState('decisions.json').decisions.filter(d => d.applied);
  assert.deepEqual(completed.map(d => d.escalation.settings), [['merge.admin'], ['budget.raise']]);
  assert.ok(completed.every(d => d.applied.by === 'owner' && d.answer === 'approve'));
  h.ok(['ladder', 'set', 'easy', '--scope', '{}']);
  assert.equal(h.readState('project.json').merge.admin, true);
  assert.equal(h.readState('project.json').budget.hours, 9);
});

test('an unpinned project does not block: the orchestrator pins detected gate commands and the owner sees it', (t) => {
  const h = makeRepo(t);
  h.init();
  gateFixture(h);
  h.ok(['project', 'set', '--tests-cmd', 'null', '--clean-cmd', 'null']);
  fs.writeFileSync(path.join(h.repo, 'package.json'), `${JSON.stringify({ name: 'fixture', scripts: { test: 'node test/value.test.js' } })}\n`);
  h.git(['add', 'package.json']);
  h.git(['commit', '-qm', 'test script']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);

  // A worker pins nothing; the gate still names the missing pin.
  const worker = h.run(['check', 'tests', 'T1'], as('worker'));
  assert.equal(worker.code, 1, worker.stderr);
  assert.match(worker.stdout, /no test command pinned/);
  assert.equal(h.readState('project.json').gates, undefined);

  for (const type of ['tests', 'clean']) {
    const r = h.run(['check', type, 'T1'], as('orchestrator'));
    assert.equal(r.code, 0, r.stderr + r.stdout);
  }
  assert.deepEqual(h.readState('project.json').gates, { tests_cmd: 'npm test', clean_cmd: h.env.TOWER_CRANE_CLEAN_CMD });
  const pins = events(h).filter((e) => e.cmd === 'gates pin');
  assert.deepEqual(pins.map((e) => [e.agent, e.detail.key, e.detail.from, e.detail.authority]), [
    ['orchestrator', 'tests_cmd', 'package.json scripts.test', 'orchestrator'],
    ['orchestrator', 'clean_cmd', 'TOWER_CRANE_CLEAN_CMD', 'orchestrator'],
  ]);
  const status = h.ok(['status']);
  assert.match(status, /pinned gate commands: tests_cmd "npm test" by orchestrator from package\.json scripts\.test/);
});

test('the orchestrator opts a rung in only to MCP servers the owner already defines', (t) => {
  const h = setup(t);
  h.ok(['ladder', 'set', 'easy', '--harness', 'codex', '--model', 'fixture-other']);
  const before = h.readState('project.json');
  for (const [args, missing] of [
    [['ladder', 'set', 'easy', '--mcp', '["shell"]'], /ladder easy opts in MCP server shell, which .*config\.toml does not define/],
  ]) {
    const r = h.run(args, as('orchestrator'));
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, missing);
    assert.match(r.stderr, /only MCP servers the owner's harness config already defines/);
    assert.deepEqual(h.readState('project.json'), before);
  }
  // Moving a rung, with the owner's fallback route that follows its harness,
  // to a harness whose config lacks the route's MCP server is a new opt-in too.
  h.ok(['ladder', 'set', 'easy', '--mcp', '["docs"]'], as('orchestrator'));
  writeUser(h, { ladder: { easy: { fallbacks: [{ model: 'fixture-large', mcp: ['docs'] }] } } });
  const moved = h.run(['ladder', 'set', 'easy', '--harness', 'claude', '--model', 'fixture-large', '--clear', 'mcp'], as('orchestrator'));
  assert.equal(moved.code, 1, moved.stderr);
  assert.match(moved.stderr, /ladder easy opts in MCP server docs, which .*mcp\.json or .*\.claude\.json does not define/);
  writeUser(h, {});
  assert.equal(h.readState('decisions.json').decisions.length, 0);
  // The owner can overrule the condition.
  h.ok(['ladder', 'set', 'easy', '--mcp', '["docs","shell"]']);
  assert.deepEqual(h.readState('project.json').ladder.easy.mcp, ['docs', 'shell']);
  // A server the owner set earlier does not block the orchestrator's other changes.
  h.ok(['ladder', 'set', 'easy', '--effort', 'low'], as('orchestrator'));
});

test('a tool that is not a harness built-in or changes the rung sandbox is owner-required', (t) => {
  const h = setup(t);
  h.ok(['ladder', 'set', 'easy', '--harness', 'codex', '--model', 'fixture-other']);
  h.ok(['ladder', 'set', 'review', '--harness', 'claude', '--model', 'fixture-large', '--clear', 'profile', '--clear', 'args']);
  // Built-ins that keep the sandbox are the orchestrator's.
  h.ok(['ladder', 'set', 'easy', '--tools', '["web_search","multi_agent"]'], as('orchestrator'));
  h.ok(['ladder', 'set', 'review', '--tools', '["WebFetch","Agent"]'], as('orchestrator'));
  writeUser(h, { ladder: { medium: { fallbacks: [{ model: 'fixture-large', tools: ['Edit'] }] } } });
  let opened = 0;
  for (const [args, tools] of [
    [['ladder', 'set', 'easy', '--tools', '["web_search","computer_use"]'], { easy: { tools: ['computer_use'] } }],
    [['ladder', 'set', 'review', '--tools', '["WebFetch","Edit"]'], { review: { tools: ['Edit'] } }],
    [['ladder', 'set', 'review', '--tools', '["Bash(gh pr merge:*)"]'], { review: { tools: ['Bash(gh pr merge:*)'] } }],
    // The owner's fallback route follows the primary to claude, where Edit is reach.
    [['ladder', 'set', 'medium', '--harness', 'claude', '--model', 'fixture-large', '--clear', 'profile'], { medium: { tools: ['Edit'] } }],
  ]) {
    const before = h.readState('project.json');
    const r = h.run(args, as('orchestrator'));
    opened += 1;
    assert.equal(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`ladder\\.reach is owner-required; opened D${opened} `));
    assert.deepEqual(h.readState('project.json'), before);
    const d = h.readState('decisions.json').decisions.at(-1);
    assert.deepEqual(d.escalation, { settings: ['ladder.reach'], change: { ladder: tools } });
    const worker = h.run(args, as('worker-T1-1'));
    assert.equal(worker.code, 1);
    assert.match(worker.stderr, /only the owner/);
  }
  // A tool joined with a sandbox grant escalates both.
  const both = h.run(['ladder', 'set', 'easy', '--tools', '["browser_use"]', '--sandbox', '{"write":["/tmp/x"]}'], as('orchestrator'));
  assert.equal(both.code, 1, both.stderr);
  assert.deepEqual(h.readState('decisions.json').decisions.at(-1).escalation.settings, ['sandbox', 'ladder.reach']);
  // The owner can overrule.
  h.ok(['ladder', 'set', 'review', '--tools', '["Edit"]']);
  assert.deepEqual(h.readState('project.json').ladder.review.tools, ['Edit']);
});

for (const harness of L.HARNESSES.filter((name) => name !== 'command')) {
  test(`${harness}: primary, following fallback and default harness moves follow its sandbox capability`, (t) => {
    const h = setup(t);
    // Valid model-only rungs keep profile and effort incompatibilities from
    // hiding the authority result when the default harness changes.
    for (const rung of L.RUNGS) h.ok(['ladder', 'set', rung, '--model', 'fixture',
      '--clear', 'profile', '--clear', 'effort', '--clear', 'args', '--clear', 'provider']);
    h.ok(['ladder', 'harness', 'claude']);
    const sandbox = A.CAPABILITIES[harness].sandbox;
    const unconfined = { unconfined: [{ harness }] };
    writeUser(h, { ladder: { research: { fallbacks: [{ model: 'backup' }] } } });
    let opened = 0;
    for (const [args, change] of [
      [['ladder', 'set', 'hard', '--harness', harness, '--model', 'fixture'], { ladder: { hard: unconfined } }],
      [['ladder', 'set', 'research', '--harness', harness, '--model', 'fixture'],
        { ladder: { research: { unconfined: [{ harness }, { harness }] } } }],
      [['ladder', 'harness', harness], { harness, ladder: Object.fromEntries(
        ['easy', 'medium', 'review', 'small'].map((rung) => [rung, unconfined])) }],
    ]) {
      const before = h.readState('project.json');
      const result = h.run(args, as('orchestrator'));
      assert.equal(result.code, sandbox ? 0 : 1, `${args.join(' ')}: ${result.stderr}`);
      if (sandbox) {
        assert.equal(events(h).findLast((event) => event.cmd.startsWith('ladder')).detail.authority, 'orchestrator');
      } else {
        opened++;
        assert.match(result.stderr, new RegExp(`ladder\\.reach is owner-required; opened D${opened} `));
        assert.deepEqual(h.readState('project.json'), before);
        assert.deepEqual(h.readState('decisions.json').decisions.at(-1).escalation, { settings: ['ladder.reach'], change });
      }
      assert.equal(h.readState('decisions.json').decisions.length, opened);
      const worker = h.run(args, as('worker-T1-1'));
      assert.equal(worker.code, 1, worker.stderr);
      assert.match(worker.stderr, sandbox ? /only the orchestrator or the owner/ : /only the owner/);
    }
    // Moving the unsandboxed orchestrator itself without args drops nothing.
    h.ok(['ladder', 'set', 'orchestrator', '--harness', harness, '--model', 'fixture'], as('orchestrator'));
    // Once the owner puts a rung on a harness, the orchestrator can tune it.
    h.ok(['ladder', 'set', 'hard', '--harness', harness, '--model', 'fixture']);
    h.ok(['ladder', 'set', 'hard', '--model', 'updated'], as('orchestrator'));
    assert.equal(h.readState('project.json').ladder.hard.model, 'updated');
    assert.equal(h.readState('decisions.json').decisions.length, opened);
  });
}

test('new args on an unsandboxed route require the owner, including following fallbacks', (t) => {
  const h = setup(t);
  const harness = L.HARNESSES.find((name) => name !== 'command' && !A.CAPABILITIES[name].sandbox);
  assert.ok(harness, 'the fixture needs an unsandboxed harness');
  writeUser(h, { ladder: {
    research: { fallbacks: [{ model: 'backup', args: ['--verbose'] }] },
    small: { fallbacks: [{ harness, model: 'fixture', args: ['--verbose'] }] },
  } });
  for (const [index, args] of [
    ['ladder', 'set', 'research', '--harness', harness, '--model', 'fixture', '--clear', 'effort'],
    ['ladder', 'set', 'orchestrator', '--harness', harness, '--model', 'fixture', '--args', '["--verbose"]', '--clear', 'effort'],
  ].entries()) {
    const before = h.readState('project.json');
    const result = h.run(args, as('orchestrator'));
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`ladder\\.reach is owner-required; opened D${index + 1} `));
    assert.deepEqual(h.readState('project.json'), before);
    const routes = h.readState('decisions.json').decisions.at(-1).escalation.change.ladder;
    assert.ok(Object.values(routes).flatMap((rung) => rung.unconfined).some((route) => route.args?.includes('--verbose')));
  }
  // An unchanged unsandboxed fallback does not block a model/effort change.
  h.ok(['ladder', 'set', 'small', '--effort', 'medium'], as('orchestrator'));
});

test('authority follows a sandbox capability flip without changing the private-home list', (t) => {
  const h = setup(t);
  const harness = L.HARNESSES.find((name) => name !== 'command' && !A.CAPABILITIES[name].sandbox);
  assert.ok(harness, 'the fixture needs an unsandboxed harness');
  const args = ['ladder', 'set', 'hard', '--harness', harness, '--model', 'fixture', '--clear', 'effort'];
  const refused = h.run(args, as('orchestrator'));
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /ladder\.reach is owner-required/);
  const hook = path.join(h.base, 'capability.cjs');
  fs.writeFileSync(hook, [
    `const agents = require(${JSON.stringify(require.resolve('../lib/agents'))});`,
    `const name = ${JSON.stringify(harness)};`,
    'agents.CAPABILITIES = { ...agents.CAPABILITIES, [name]: { ...agents.CAPABILITIES[name], sandbox: true } };',
    '',
  ].join('\n'));
  const allowed = h.run(args, { env: {
    TOWER_CRANE_AGENT: 'orchestrator', NODE_OPTIONS: `--require ${JSON.stringify(hook)}`,
  } });
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(h.readState('project.json').ladder.hard.harness, harness);
  assert.equal(h.readState('decisions.json').decisions.length, 1, 'the supported move opens no further decision');
  assert.equal(events(h).findLast((event) => event.cmd === 'ladder set').detail.authority, 'orchestrator');
});

test('an orchestrator init with an owner-required setting is told to init without it', (t) => {
  const h = makeRepo(t);
  const r = h.run(['init', '--name', 'demo', '--goal', 'autonomy', '--merge-admin', 'true'], as('orchestrator'));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /merge\.admin is owner-required; init without it/);
  assert.doesNotMatch(r.stderr, /open a decision/);
  assert.ok(!fs.existsSync(h.state), 'refused init creates no state directory');
  h.ok(['init', '--name', 'demo', '--goal', 'autonomy'], as('orchestrator'));
});

test('the orchestrator cannot downgrade a code task to docs, which drops its tests gate', (t) => {
  const h = setup(t);
  h.ok(['task', 'add', '--title', 'Code change', '--acceptance', 'it works']);
  const before = h.readState('tasks.json');
  const r = h.run(['task', 'update', 'T2', '--kind', 'docs'], as('orchestrator'));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /task\.downgrade is owner-required; opened D1 /);
  assert.deepEqual(h.readState('tasks.json'), before);
  assert.deepEqual(h.readState('decisions.json').decisions[0].escalation, {
    settings: ['task.downgrade'], change: { task: 'T2', kind: 'docs' },
  });
  const worker = h.run(['task', 'update', 'T2', '--kind', 'docs'], as('worker-T2-1'));
  assert.equal(worker.code, 1);
  assert.match(worker.stderr, /only the owner/);
  assert.equal(h.readState('decisions.json').decisions.length, 1);
  assert.equal(h.json(['task', 'show', 'T2']).kind, 'code');
  h.ok(['task', 'update', 'T2', '--kind', 'docs']);
  assert.equal(h.json(['task', 'show', 'T2']).kind, 'docs');
  // Moving between the non-code kinds stays operational.
  h.ok(['task', 'update', 'T2', '--kind', 'ops'], as('orchestrator'));
  assert.equal(h.json(['task', 'show', 'T2']).kind, 'ops');
  assert.equal(h.readState('decisions.json').decisions.length, 1);
});

test('a submitted task keeps its kind until it is sent back for rework', (t) => {
  const h = setup(t);
  const sha = gateFixture(h);
  h.ok(['task', 'add', '--title', 'Code change', '--acceptance', 'it works']);
  h.ok(['claim', 'T2', '--agent', 'worker-T2-1']);
  h.ok(['submit', 'T2', '--sha', sha, '--branch', 'fixture-change', '--pr', '7', '--agent', 'worker-T2-1']);
  for (const agent of ['owner', 'orchestrator', 'worker-T2-1']) {
    const before = { tasks: h.readState('tasks.json'), decisions: h.readState('decisions.json') };
    const r = h.run(['task', 'update', 'T2', '--kind', 'docs'], as(agent));
    assert.equal(r.code, 1, `${agent}: ${r.stderr}`);
    assert.match(r.stderr, /on a submitted or accepted task is refused; rework the task first/);
    assert.deepEqual({ tasks: h.readState('tasks.json'), decisions: h.readState('decisions.json') }, before);
  }
  h.ok(['rework', 'T2', '--reason', 'move to docs', '--agent', 'owner']);
  h.ok(['task', 'update', 'T2', '--kind', 'docs']);
  assert.equal(h.json(['task', 'show', 'T2']).kind, 'docs');
});

test('cancelling a task that waits on the owner needs the owner', (t) => {
  const h = setup(t);
  const before = h.readState('tasks.json');
  const r = h.run(['task', 'update', 'T1', '--status', 'cancelled'], as('orchestrator'));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /task\.cancel_needs_owner is owner-required; opened D1 /);
  assert.deepEqual(h.readState('tasks.json'), before);
  const worker = h.run(['task', 'update', 'T1', '--status', 'cancelled'], as('worker-T1-1'));
  assert.equal(worker.code, 1);
  assert.match(worker.stderr, /only the owner/);
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'cancelled');
});
