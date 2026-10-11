'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

const STUB = path.join(__dirname, 'fixtures', 'pi-stub.js');
const NO_STUBS = process.platform === 'win32' && 'harness stubs are shebang scripts';

function setup(t) {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Pi isolation probe', '--acceptance', 'only generated resources load']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Measure isolated pi startup.\n' });
  h.ok(['ladder', 'set', 'medium', '--harness', 'pi', '--model', 'stub-model', '--clear', 'profile', '--clear', 'effort', '--clear', 'args']);
  const user = path.join(h.base, 'user');
  const config = path.join(user, '.pi', 'agent');
  const put = (rel, value) => {
    const file = path.join(config, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  put('AGENTS.md', 'PLANTED-GLOBAL-RULE\n'.repeat(1024));
  put('SYSTEM.md', 'PLANTED-USER-SYSTEM\n'.repeat(1024));
  put('memory.md', 'PLANTED-MEMORY\n'.repeat(1024));
  put('rules/approved.json', JSON.stringify({ allow: ['PLANTED-APPROVED-COMMAND'] }));
  put('auth.json', '{"token":"PI-PLANTED-SECRET"}\n');
  put('models.json', '{"providers":{}}\n');
  put('settings.json', JSON.stringify({ packages: ['planted-package'], extensions: ['extensions/planted.mjs'] }));
  put('extensions/planted.mjs', [
    "import fs from 'node:fs';",
    `const memory = ${JSON.stringify(path.join(config, 'memory.md'))};`,
    `const rules = ${JSON.stringify(path.join(config, 'rules', 'approved.json'))};`,
    'export default function(pi) {',
    '  pi.registerTool({ name: "planted_mcp" });',
    '  pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + fs.readFileSync(memory, "utf8") + fs.readFileSync(rules, "utf8") }));',
    '}', '',
  ].join('\n'));
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pi'), `#!${process.execPath}\nrequire(${JSON.stringify(STUB)});\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconsole.log('stub-gh-token');\n`, { mode: 0o755 });
  const out = path.join(h.base, 'pi-stub.json');
  const env = {
    ...h.env, HOME: user, USERPROFILE: user, PI_CODING_AGENT_DIR: config,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, PI_STUB_OUT: out,
  };
  const run = () => {
    // An exited worker keeps its lease until the orchestrator releases it.
    const held = h.json(['task', 'show', 'T1']).claim;
    if (held) h.ok(['release', 'T1', '--agent', held.agent, '--reason', 'worker exited']);
    const spawned = h.json(['spawn', '--task', 'T1', '--wait'], { env });
    assert.equal(spawned.sandbox, false);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };
  return { h, config, user, env, run };
}

test('pi ignores planted user memory, MCP extension and approved rules, links auth and reports rules to read', { skip: NO_STUBS }, (t) => {
  const { h, config, user, env, run } = setup(t);
  const dry = h.json(['spawn', '--task', 'T1', '--dry-run'], { env });
  const reports = [run(), run(), run()];
  console.log(`pi startup context bytes: ${reports.map((r) => r.contextBytes).join(', ')}`);
  const report = reports[0];
  assert.notEqual(report.userHome, user);
  assert.equal(report.home, dry.home.path);
  assert.equal(report.auth, path.join(config, 'auth.json'));
  assert.ok(!report.systemPrompt.includes('PLANTED-'));
  assert.deepEqual(report.tools, []);
  assert.deepEqual(report.settings.packages, []);
  for (const probe of Object.values(report.shims)) {
    assert.equal(probe.code, 126);
    assert.match(probe.stderr, /not allowed by this agent's agent file/);
  }
  assert.match(report.systemPrompt, /# tower-crane-worker/);
  assert.ok(dry.argv.includes('--no-extensions'));
  assert.ok(dry.argv.includes('--no-approve'));
  const rules = dry.startup.rules.filter((r) => r.path === path.join(config, 'AGENTS.md'));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].loaded, 'read');
  assert.equal(dry.startup.instructions_file, path.join(dry.home.path, 'AGENTS.md'));
  assert.equal(dry.startup.sandbox, false);
  assert.equal(dry.startup.confinement, 'unconfined');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line)).filter((e) => e.cmd === 'startup');
  assert.equal(events.length, 3);
  assert.deepEqual(events[0].detail.rules, dry.startup.rules);
  assert.equal(events[0].detail.confinement, 'unconfined');
  const last = reports.at(-1);
  const nested = h.json(['spawn', '--task', 'T1', '--dry-run'], {
    env: { ...env, HOME: last.userHome, USERPROFILE: last.userHome, PI_CODING_AGENT_DIR: last.home },
  });
  assert.ok(nested.startup.rules.some((rule) => rule.path === path.join(config, 'AGENTS.md')));
  assert.ok(!nested.startup.rules.some((rule) => rule.path.startsWith(last.home + path.sep)));
  for (const file of fs.readdirSync(last.home)) {
    const at = path.join(last.home, file);
    let fd;
    try {
      fd = fs.openSync(at, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ELOOP') continue;
      throw error;
    }
    try {
      if (fs.fstatSync(fd).isFile()) assert.ok(!fs.readFileSync(fd, 'utf8').includes('PI-PLANTED-SECRET'));
    } finally {
      fs.closeSync(fd);
    }
  }
});

test('pi renders role tool lists, shows opt-ins and refuses MCP and startup overrides', (t) => {
  const { h, env } = setup(t);
  const dry = (role) => h.json(['spawn', '--task', 'T1', '--role', role, '--dry-run'], { env });
  const tools = (report) => report.argv[report.argv.indexOf('--tools') + 1].split(',');
  h.ok(['ladder', 'set', 'small', '--harness', 'pi', '--model', 'stub-model', '--clear', 'profile', '--clear', 'effort']);
  h.ok(['ladder', 'set', 'review', '--harness', 'pi', '--model', 'stub-model', '--clear', 'profile', '--clear', 'effort']);
  const worker = dry('medium');
  assert.deepEqual(tools(worker), ['bash', 'read', 'edit', 'write', 'grep', 'find']);
  assert.deepEqual(tools(dry('small')), ['bash', 'read', 'grep', 'find']);
  assert.ok(!dry('small').argv.includes('--skill'));
  assert.deepEqual(tools(dry('review')), ['bash', 'read', 'grep', 'find']);
  assert.equal(worker.home.mcp_supported, false);
  assert.equal(worker.home.sandbox, false);
  assert.equal(worker.env.TOWER_CRANE_SANDBOX, '0');
  assert.match(h.ok(['spawn', '--task', 'T1', '--dry-run'], { env }), /MCP opt-ins are unsupported on pi/);
  h.ok(['ladder', 'set', 'medium', '--tools', '["ls"]']);
  const opted = dry('medium');
  assert.ok(tools(opted).includes('ls'));
  assert.deepEqual(opted.home.tools, ['ls']);
  const mcp = h.run(['ladder', 'set', 'medium', '--mcp', '["planted"]']);
  assert.equal(mcp.code, 1);
  assert.match(mcp.stderr, /MCP opt-ins are unsupported on pi/);
  const unknown = h.run(['ladder', 'set', 'medium', '--tools', '["WebSearch"]']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /pi tools must be built-ins/);
  for (const args of [['--extension', 'planted'], ['--approve'], ['--tools', 'write'], ['--system-prompt', 'planted']]) {
    const result = h.run(['ladder', 'set', 'medium', '--args', JSON.stringify(args)]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /args may only use.*refused/);
  }
  const project = h.readState('project.json');
  h.writeState('project.json', { ...project, ladder: { ...project.ladder, medium: { ...project.ladder.medium, mcp: ['planted'] } } });
  const invalid = h.run(['spawn', '--task', 'T1', '--dry-run'], { env });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /MCP opt-ins are unsupported on pi/);
});

test('only the owner can move worker, reviewer or small rungs to unconfined pi', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const rung of ['medium', 'review', 'small']) {
    const args = ['ladder', 'set', rung, '--harness', 'pi', '--model', 'stub-model', '--clear', 'profile'];
    const before = h.readState('project.json');
    const refused = h.run(args, { env: { TOWER_CRANE_AGENT: 'orchestrator' } });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /ladder\.reach is owner-required/);
    assert.deepEqual(h.readState('project.json'), before);
    assert.deepEqual(h.readState('decisions.json').decisions.at(-1).escalation.settings, ['ladder.reach']);
    h.ok(args);
    assert.equal(h.readState('project.json').ladder[rung].harness, 'pi');
  }
  for (const name of ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR']) {
    const result = h.run(['ladder', 'set', 'medium', '--env', JSON.stringify({ [name]: 'planted' })]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /harness homes.*reserved/);
  }
});
