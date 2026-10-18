'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, fixtureLadder, pluginRoot, ROOT, TMP_ROOT } = require('./helpers');
const A = require('../lib/agents');
const L = require('../lib/ladder');
const { findReal } = require('../lib/shim');

test('every ladder harness declares its sandbox capabilities', () => {
  assert.deepEqual(Object.keys(A.CAPABILITIES).sort(), [...L.HARNESSES].sort());
  for (const capability of Object.values(A.CAPABILITIES)) {
    assert.equal(typeof capability.sandbox, 'boolean');
    assert.equal(typeof capability.osSandbox, 'boolean');
    assert.ok(!capability.osSandbox || capability.sandbox);
  }
});

const PINNED = fixtureLadder().ladder;

function writeUser(h, doc) {
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  fs.writeFileSync(h.userConfig, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
}

const projectText = (h) => fs.readFileSync(path.join(h.state, 'project.json'), 'utf8');
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// validate also warns about this machine (harness programs, gh login); these
// tests are about reviewer selection only.
const reviewWarnings = (data) => data.warnings.filter((w) => w.kind === 'review-unavailable');

test('BUILTIN matches the documented defaults and init fallback', (t) => {
  const h = makeRepo(t, { builtin: true });
  h.init();
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'builtin-ladder.json'), 'utf8'));
  const p = h.readState('project.json');
  assert.deepEqual({ harness: p.harness, ladder: p.ladder }, { harness: expected.harness, ladder: expected.ladder });
  assert.deepEqual(L.BUILTIN.claude_aliases, expected.claude_aliases);
  const show = h.json(['ladder', 'show']);
  assert.equal(show.harness_from, 'project');
  assert.equal(show.user_file, h.userConfig);
  assert.equal(show.user_file_exists, false);
  const printed = h.ok(['ladder', 'show']);
  assert.match(printed, /^ {2}orchestrator +claude +model opus, effort high +from project$/m);
  assert.match(printed, /^ {2}easy +claude +model claude-haiku-5-5, effort high +from project$/m);
  assert.match(printed, /^ {2}medium +codex \(default\) +profile sol, effort high +from project$/m);
  assert.match(printed, /^ {2}hard +claude +model opus, effort medium +from project$/m);
  assert.match(printed, /^ {2}research +claude +model opus, effort high +from project$/m);
  assert.match(printed, /^ {2}review +claude +model claude-haiku-5-5, effort high +from project$/m);
  assert.match(printed, /^ {2}small +claude +model claude-haiku-5-5, effort high +from project$/m);
  delete p.ladder.easy;
  delete p.harness;
  h.writeState('project.json', p);
  const back = h.json(['ladder', 'show']);
  assert.deepEqual([back.harness, back.harness_from], [expected.harness, 'built-in']);
  assert.deepEqual(back.ladder.easy, { ...expected.ladder.easy, harness_from: 'rung', from: 'built-in' });
});

test('the user file supplies the defaults a new project copies, and the project file then wins', (t) => {
  const h = makeRepo(t);
  writeUser(h, {
    harness: 'opencode',
    ladder: { easy: { model: 'a/easy' }, medium: { model: 'a/medium', effort: 'high' }, review: { model: 'a/review' }, small: { model: 'a/small' } },
  });
  h.init();
  const p = h.readState('project.json');
  assert.equal(p.harness, 'opencode');
  assert.deepEqual(p.ladder.easy, { model: 'a/easy' });
  assert.deepEqual(p.ladder.medium, { model: 'a/medium', effort: 'high' });
  assert.deepEqual(p.ladder.hard, PINNED.hard, 'a rung the user file leaves out keeps the fixture pin');

  writeUser(h, { harness: 'pi', ladder: { easy: { model: 'p/easy' } } });
  const show = h.json(['ladder', 'show']);
  assert.deepEqual([show.harness, show.ladder.easy.model, show.ladder.easy.from], ['opencode', 'a/easy', 'project'], 'the project keeps its own ladder');
  assert.equal(show.user_file_exists, true);

  delete p.ladder.easy;
  h.writeState('project.json', p);
  const easy = h.json(['ladder', 'show']).ladder.easy;
  assert.deepEqual([easy.model, easy.harness, easy.from], ['p/easy', 'opencode', 'user'], 'a rung the project leaves out comes from the user file');
});

test('research web MCP settings persist in user defaults and refuse other rungs or secret fields', (t) => {
  const h = makeRepo(t);
  h.init();
  const server = { name: 'harness-web', command: 'node', args: ['/web/server.mjs'] };
  h.ok(['ladder', 'set', 'research', '--web-mcp', JSON.stringify(server)]);
  h.ok(['ladder', 'save-user']);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.userConfig, 'utf8')).ladder.research.web_mcp, server);
  assert.deepEqual(require('../lib/ladder').resolve({}, h.env).ladder.research.own.web_mcp, server);
  for (const args of [
    ['easy', '--web-mcp', JSON.stringify(server)],
    ['research', '--web-mcp', JSON.stringify({ ...server, env: { TOKEN: 'secret' } })],
    ['research', '--mcp', '["other"]'],
    ['research', '--harness', 'codex', '--web-mcp', JSON.stringify(server)],
  ]) assert.notEqual(h.run(['ladder', 'set', ...args]).code, 0);
  h.ok(['ladder', 'set', 'research', '--clear', 'web_mcp']);
  assert.equal(h.json(['ladder', 'show']).ladder.research.web_mcp, undefined);
});

test('research web MCP stays owner guarded alongside personal provider fallbacks', (t) => {
  const h = makeRepo(t);
  h.init();
  const server = { name: 'harness-web', command: 'node', args: ['/web/server.mjs'] };
  const fallbacks = [{ harness: 'codex', model: 'second' }];
  writeUser(h, { ladder: { research: { fallbacks } } });
  h.ok(['ladder', 'set', 'research', '--web-mcp', JSON.stringify(server)]);
  h.ok(['ladder', 'save-user']);
  const saved = JSON.parse(fs.readFileSync(h.userConfig, 'utf8')).ladder.research;
  assert.deepEqual(saved.web_mcp, server);
  assert.deepEqual(saved.fallbacks, fallbacks);
  assert.equal(h.run(['ladder', 'set', 'research', '--web-mcp',
    JSON.stringify({ ...server, name: 'replacement' }), '--agent', 'worker']).code, 1);
  const rung = h.json(['ladder', 'show']).ladder.research;
  assert.deepEqual(rung.web_mcp, server);
  assert.deepEqual(rung.fallbacks, fallbacks);
  writeUser(h, { ladder: { research: { fallbacks: [] } } });
  assert.deepEqual(h.json(['ladder', 'show']).ladder.research.web_mcp, server);
  writeUser(h, { ladder: { research: { fallbacks } } });
  h.ok(['ladder', 'set', 'research', '--clear', 'web_mcp']);
  assert.deepEqual(h.json(['ladder', 'show']).ladder.research.fallbacks, fallbacks);
});

test('research web MCP inheritance requires Claude and refuses additional MCP servers', (t) => {
  const h = makeRepo(t);
  h.init();
  const server = { name: 'harness-web', command: 'node', args: ['/web/server.mjs'] };
  const fallbacks = [{ harness: 'claude', model: 'backup' }, { harness: 'codex', model: 'second' }];
  writeUser(h, { ladder: { research: { fallbacks } } });
  h.ok(['ladder', 'set', 'research', '--web-mcp', JSON.stringify(server)]);
  const routes = require('../lib/ladder').routes(h.json(['ladder', 'show']).ladder.research);
  assert.deepEqual(routes[1].web_mcp, server);
  assert.equal(routes[2].web_mcp, undefined);
  writeUser(h, { ladder: { research: { fallbacks: [{ harness: 'claude', model: 'backup', mcp: ['other'] }] } } });
  const extra = h.json(['ladder', 'show']);
  assert.ok(extra.problems.some(p => /web_mcp cannot be combined with mcp.*skipped/.test(p)));
  assert.deepEqual(extra.ladder.research.web_mcp, server);
  writeUser(h, { ladder: { research: { fallbacks: [{ harness: 'codex', model: 'second', web_mcp: server }] } } });
  assert.ok(h.json(['ladder', 'show']).problems.some(p => /web_mcp applies only to claude.*skipped/.test(p)));
});

test('ladder save-user makes the project ladder the default for new projects', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ladder', 'set', 'hard', '--model', 'fixture-secondary']);
  const out = h.json(['ladder', 'save-user']);
  assert.equal(out.file, h.userConfig);
  const saved = JSON.parse(fs.readFileSync(h.userConfig, 'utf8'));
  assert.equal(saved.harness, 'codex');
  assert.deepEqual(saved.ladder.hard, { harness: 'claude', model: 'fixture-secondary', effort: 'high' });
  assert.deepEqual(saved.ladder.easy, PINNED.easy);
  assert.equal(events(h).filter((e) => e.cmd === 'ladder save-user').length, 1);

  const other = path.join(h.base, 'second-state');
  h.ok(['init', '--name', 'second', '--goal', 'g', '--state', other]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, 'project.json'), 'utf8')).ladder.hard.model, 'fixture-secondary');

  // A ladder that cannot run is not saved over the user file.
  const saved1 = fs.readFileSync(h.userConfig, 'utf8');
  h.writeState('project.json', { ...h.readState('project.json'), harness: 'pi' });
  const refused = h.run(['ladder', 'save-user']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /ladder easy \(pi, the default harness\): profile applies only to codex, needs a model;.*before saving it as the default/);
  assert.equal(fs.readFileSync(h.userConfig, 'utf8'), saved1);
});

test('ladder save-user writes only what the project defines and keeps the rest of the user file', (t) => {
  const h = makeRepo(t);
  h.init();
  writeUser(h, { browser_kit: ['playwright'], note: 'kept', ladder: { medium: { fallbacks: [{ harness: 'claude', model: 'fixture-secondary', effort: 'high' }] } } });
  const p = h.readState('project.json');
  // Remaining rungs need their own harness when the project omits its default.
  for (const rung of Object.values(p.ladder)) rung.harness ||= p.harness;
  delete p.harness;
  delete p.ladder.easy;
  h.writeState('project.json', p);
  h.ok(['ladder', 'save-user']);
  const saved = JSON.parse(fs.readFileSync(h.userConfig, 'utf8'));
  // Saving omits inherited fields and preserves unrelated personal settings.
  assert.equal(saved.harness, undefined);
  assert.equal(saved.ladder.easy, undefined);
  assert.deepEqual(saved.ladder.hard, PINNED.hard);
  assert.deepEqual(saved.ladder.medium, { ...PINNED.medium, harness: fixtureLadder().harness,
    fallbacks: [{ harness: 'claude', model: 'fixture-secondary', effort: 'high' }] });
  assert.equal(saved.note, 'kept');
  assert.deepEqual(saved.browser_kit, ['playwright']);
});

test('personal hard fallbacks overlay project rungs and stay out of project writes', (t) => {
  const h = makeRepo(t);
  h.init();
  const fallbacks = [{ harness: 'codex', profile: 'fixture-backup', effort: 'high' }, { harness: 'claude', model: 'fixture-secondary', effort: 'high' }];
  writeUser(h, { ladder: { hard: { fallbacks } } });
  const hard = h.json(['ladder', 'show']).ladder.hard;
  assert.equal(hard.model, 'fixture-large');
  assert.equal(hard.from, 'project');
  assert.deepEqual(hard.fallbacks, fallbacks);
  assert.equal(hard.fallbacks_from, 'user');
  assert.match(h.ok(['ladder', 'show']), /hard fallback 1.*from user file/);
  h.ok(['ladder', 'set', 'hard', '--effort', 'medium']);
  assert.equal(h.readState('project.json').ladder.hard.fallbacks, undefined);
  h.ok(['ladder', 'save-user']);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.userConfig, 'utf8')).ladder.hard.fallbacks, fallbacks);
  const other = path.join(h.base, 'second-state');
  h.ok(['init', '--name', 'second', '--goal', 'g', '--state', other]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, 'project.json'), 'utf8')).ladder.hard.fallbacks, undefined);
  assert.deepEqual(h.json(['ladder', 'show', '--state', other]).ladder.hard.fallbacks, fallbacks);
  writeUser(h, { ladder: { hard: { fallbacks: [] } } });
  assert.deepEqual(h.json(['ladder', 'show']).ladder.hard.fallbacks, []);
  assert.equal(h.readState('project.json').ladder.hard.fallbacks, undefined);
});

test('projects reject fallback configuration through project flags and state', (t) => {
  const h = makeRepo(t);
  h.init();
  assert.equal(h.run(['project', 'set', '--fallbacks', '[]']).code, 2);
  assert.equal(h.run(['init', '--fallbacks', '[]']).code, 2);
  const project = h.readState('project.json');
  project.ladder.hard.fallbacks = [];
  h.writeState('project.json', project);
  assert.match(h.run(['status']).stderr, /fallbacks.*user file/);
});

test('fallback-only user rungs keep the pinned primary during init', (t) => {
  const h = makeRepo(t);
  writeUser(h, { ladder: { hard: { fallbacks: [{ harness: 'claude', model: 'fixture-secondary' }] } } });
  h.init();
  assert.deepEqual(h.readState('project.json').ladder.hard, PINNED.hard);
});

test('ladder harness moves every rung without its own harness, and spawn runs each tier there', (t) => {
  const h = makeRepo(t);
  // Native dry runs use fixture credential stores for every harness.
  Object.assign(h.env, {
    USERPROFILE: h.env.HOME,
    CLAUDE_CONFIG_DIR: path.join(h.env.HOME, '.claude'),
    CODEX_HOME: path.join(h.env.HOME, '.codex'),
    PI_CODING_AGENT_DIR: path.join(h.env.HOME, '.pi', 'agent'),
    GH_CONFIG_DIR: path.join(h.env.HOME, '.config', 'gh'),
    XDG_CONFIG_HOME: path.join(h.env.HOME, '.config'),
    XDG_DATA_HOME: path.join(h.env.HOME, '.local', 'share'),
    OPENCODE_CONFIG_DIR: path.join(h.env.HOME, '.config', 'opencode'),
  });
  h.init();
  for (const rung of ['easy', 'medium', 'review', 'small']) h.ok(['ladder', 'set', rung, '--model', `m-${rung}`, '--clear', 'profile']);
  h.ok(['task', 'add', '--title', 'Small', '--acceptance', 'a', '--kind', 'docs', '--size', 'S']);
  h.ok(['task', 'add', '--title', 'Medium', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'Large', '--acceptance', 'a', '--size', 'L']);
  h.ok(['task', 'add', '--title', 'Study', '--acceptance', 'a', '--kind', 'research', '--size', 'S']);
  for (const id of ['T1', 'T2', 'T3', 'T4']) h.ok(['brief', 'set', id, '-'], { input: `brief ${id}\n` });
  const empty = path.join(h.base, 'no-plugin');
  pluginRoot(empty);
  const spawn = (id, role) => h.json(['spawn', '--task', id, ...(role ? ['--role', role] : []), '--dry-run'], { env: { TOWER_CRANE_PLUGIN_ROOT: empty } });
  const flags = (argv) => argv.filter((a) => !a.includes('## Task'));
  const piExtension = (agent) => [
    '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--tools', agent.startsWith('worker') ? 'bash,read,edit,write,grep,find' : 'bash,read,grep,find',
    '--append-system-prompt', path.join(h.state, 'homes', agent, 'AGENTS.md'),
    '--extension', path.join(h.state, 'homes', agent, 'hook.mjs'),
  ];

  h.ok(['ladder', 'harness', 'pi']);
  const show = h.json(['ladder', 'show']);
  for (const rung of ['easy', 'medium', 'review', 'small']) assert.equal(show.ladder[rung].harness, 'pi', rung);
  for (const rung of ['orchestrator', 'hard', 'research']) assert.equal(show.ladder[rung].harness, 'claude', `${rung} keeps its own harness`);

  const easy = spawn('T1');
  assert.deepEqual([easy.rung, easy.agent], ['easy', 'worker-T1-1']);
  assert.deepEqual(flags(easy.argv), ['pi', '-p', '--mode', 'json', '--model', 'm-easy', '--thinking', 'medium', ...piExtension(easy.agent)]);
  const medium = spawn('T2');
  assert.deepEqual(flags(medium.argv), ['pi', '-p', '--mode', 'json', '--model', 'm-medium', '--thinking', 'high', ...piExtension(medium.agent)]);
  const hard = spawn('T3');
  const research = spawn('T4');
  assert.deepEqual(flags(hard.argv).slice(0, 8), ['claude', '-p', '--model', 'fixture-large', '--effort', 'high', '--output-format', 'json']);
  assert.deepEqual(flags(research.argv).slice(0, 8), ['claude', '-p', '--model', 'fixture-large', '--effort', 'max', '--output-format', 'json']);
  assert.equal(hard.argv[hard.argv.indexOf('--session-id') + 1], hard.session_id);
  assert.equal(research.argv[research.argv.indexOf('--session-id') + 1], research.session_id);
  const review = spawn('T2', 'review');
  assert.deepEqual([review.rung, review.agent], ['review', 'reviewer-T2-1']);
  assert.deepEqual(flags(review.argv), ['pi', '-p', '--mode', 'json', '--model', 'm-review', '--thinking', 'high', ...piExtension(review.agent)]);

  h.ok(['ladder', 'harness', 'codex']);
  assert.deepEqual(flags(spawn('T1').argv).slice(0, 7), ['codex', 'exec', '--json', '-m', 'm-easy', '-c', 'model_reasoning_effort=medium']);
  assert.deepEqual(flags(spawn('T3').argv).slice(0, 1), ['claude']);
  const harnessEvents = events(h).filter((e) => e.cmd === 'ladder harness').map((e) => e.detail.harness);
  assert.deepEqual(harnessEvents, ['pi', 'codex']);
});

test('Claude providers and pi tool opt-ins validate independently', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const provider of ['bedrock', 'anthropic']) {
    h.ok(['ladder', 'set', 'hard', '--provider', provider]);
    assert.equal(h.readState('project.json').ladder.hard.provider, provider);
  }
  h.ok(['ladder', 'set', 'medium', '--harness', 'pi', '--model', 'stub-model', '--provider', 'custom-pi-provider',
    '--tools', '["ls"]', '--clear', 'profile']);
  assert.deepEqual(h.readState('project.json').ladder.medium.tools, ['ls']);
  const before = projectText(h);
  for (const [args, message] of [
    [['hard', '--provider', 'openai'], /claude provider must be anthropic or bedrock/],
    [['medium', '--mcp', '["planted"]'], /MCP opt-ins are unsupported on pi/],
    [['medium', '--tools', '["WebSearch"]'], /pi tools must be built-ins/],
  ]) {
    const result = h.run(['ladder', 'set', ...args]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
    assert.equal(projectText(h), before);
  }
});

test('ladder writes are validated, and a refused one leaves project.json as it was', (t) => {
  const h = makeRepo(t);
  h.init();
  const before = projectText(h);
  const cases = [
    [['ladder', 'harness', 'pi'], 1, /ladder easy \(pi, the default harness\): profile applies only to codex, needs a model;.*fix those rungs first/],
    [['ladder', 'harness', 'gemini'], 2, /claude, codex, opencode, agy, pi, command/],
    [['ladder', 'set', 'easy', '--harness', 'gemini'], 2, /--harness must be one of claude, codex, opencode, agy, pi, command/],
    [['ladder', 'set', 'worker', '--model', 'x'], 2, /unknown rung "worker"; the rungs are orchestrator, easy, medium, hard, research, review, small/],
    [['ladder', 'set', 'research', '--effort', 'ultra'], 1, /ladder research \(claude\): effort must be one of low, medium, high, xhigh, max, not "ultra"/],
    [['ladder', 'set', 'easy', '--provider', 'openai'], 1, /ladder easy \(codex, the default harness\): provider applies only to pi/],
    [['ladder', 'set', 'hard', '--clear', 'model'], 1, /ladder hard \(claude\): needs a model/],
    [['ladder', 'set', 'small', '--harness', 'command', '--clear', 'profile', '--clear', 'effort'], 1, /ladder small \(command\): needs a command array/],
    [['ladder', 'set', 'small', '--args', '"--x"'], 2, /--args must be a JSON array of strings/],
    [['ladder', 'set', 'small', '--clear', 'colour'], 2, /--clear takes a rung field/],
    [['ladder', 'set', 'small', '--model', 'x', '--clear', 'model'], 2, /model is both set and cleared/],
    [['ladder', 'set', 'small'], 2, /needs a change/],
    [['role', 'set', 'worker', '--harness', 'codex'], 2, /unknown command "role"/],
  ];
  for (const [args, code, message] of cases) {
    const r = h.run(args);
    assert.equal(r.code, code, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, message, args.join(' '));
    assert.equal(projectText(h), before, `${args.join(' ')} wrote nothing`);
  }
  assert.equal(events(h).filter((e) => e.cmd.startsWith('ladder')).length, 0, 'refused writes log no event');

  const p = h.readState('project.json');
  h.writeState('project.json', { ...p, ladder: { ...p.ladder, medium: { harness: 'gemini', model: 'x' } } });
  const hand = h.run(['status']);
  assert.equal(hand.code, 1);
  assert.match(hand.stderr, /ladder medium: harness must be one of claude, codex, opencode, agy, pi, command/);
  h.writeState('project.json', { ...p, roles: { worker: { harness: 'codex', profile: 'fixture-main' } } });
  assert.match(h.run(['status']).stderr, /roles was replaced by harness and ladder/, 'a pre-ladder roles block is refused, not ignored');

  writeUser(h, { ladder: { easy: { harness: 'pi', profile: 'fixture-light' } } });
  const fresh = h.run(['init', '--name', 'n', '--goal', 'g', '--state', path.join(h.base, 'fresh')]);
  assert.equal(fresh.code, 1);
  assert.ok(fresh.stderr.includes(`the default ladder is invalid: ladder easy (pi, from the user file ${h.userConfig}): profile applies only to codex, needs a model`), fresh.stderr);
  assert.ok(!fs.existsSync(path.join(h.base, 'fresh')), 'a refused init creates nothing');
  writeUser(h, '{ not json');
  assert.match(h.run(['init', '--name', 'n', '--goal', 'g', '--state', path.join(h.base, 'fresh')]).stderr, /config\.json is not valid JSON/);
});

test('a ladder broken by a changed user file still loads, and ladder set repairs it one rung at a time', (t) => {
  const h = makeRepo(t);
  writeUser(h, { harness: 'pi', ladder: { easy: { model: 'p/easy' }, medium: { model: 'p/medium' }, review: { model: 'p/review' }, small: { model: 'p/small' } } });
  h.init();
  h.ok(['task', 'add', '--title', 'x', '--acceptance', 'a', '--kind', 'docs', '--size', 'S']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'brief\n' });
  // The project keeps its default harness and its orchestrator rung, and
  // follows the user file for the rest.
  const p = h.readState('project.json');
  h.writeState('project.json', { ...p, ladder: { orchestrator: p.ladder.orchestrator } });
  // Another project saves a codex ladder over the user file.
  writeUser(h, { harness: 'codex', ladder: { easy: { profile: 'fixture-light' }, medium: { profile: 'fixture-main' }, review: { profile: 'fixture-main' }, small: { profile: 'fixture-light' } } });

  assert.equal(h.run(['status']).code, 0, 'the project still loads');
  assert.equal(h.ok(['task', 'add', '--title', 'y', '--acceptance', 'a']), 'T2', 'other writes still work');
  const v = h.run(['validate']);
  assert.equal(v.code, 1);
  assert.ok(v.stdout.includes(`ladder easy (pi, the default harness, from the user file ${h.userConfig}): profile applies only to codex, needs a model`), v.stdout);
  const spawn = h.run(['spawn', '--task', 'T1', '--dry-run']);
  assert.equal(spawn.code, 1);
  assert.match(spawn.stderr, /ladder easy \(pi.*profile applies only to codex, needs a model; fix it with tower-crane ladder set easy/);
  assert.match(h.ok(['ladder', 'show']), /^cannot run: ladder medium \(pi/m);

  h.ok(['ladder', 'set', 'easy', '--model', 'p/easy', '--clear', 'profile']);
  assert.equal(h.json(['spawn', '--task', 'T1', '--dry-run']).argv[0], 'pi', 'the repaired rung runs while others are still broken');
  const worse = h.run(['ladder', 'set', 'orchestrator', '--effort', 'ultra']);
  assert.equal(worse.code, 1, 'a change that breaks a working rung is still refused');
  assert.match(worse.stderr, /^tower-crane: ladder orchestrator \(claude\): effort must be one of/);
});

test('a ladder write is evented and re-renders the sketch with the ladder and each task tier', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Small fix', '--acceptance', 'a', '--size', 'S', '--tier', 'easy']);
  h.ok(['ladder', 'set', 'easy', '--model', 'fixture-model', '--clear', 'profile', '--agent', 'orchestrator']);
  const ev = events(h).find((e) => e.cmd === 'ladder set');
  assert.deepEqual([ev.agent, ev.detail], ['orchestrator', { rung: 'easy', model: 'fixture-model', effort: 'medium', authority: 'orchestrator' }]);
  assert.deepEqual(h.readState('project.json').ladder.easy, { model: 'fixture-model', effort: 'medium' });
  const html = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  assert.match(html, /<tr data-rung="easy"><th scope="row">easy<\/th><td>codex \(default\)<\/td><td>fixture-model<\/td><td>medium<\/td>/);
  assert.match(html, /<tr data-rung="research"><th scope="row">research<\/th><td>claude<\/td><td>fixture-large<\/td><td>max<\/td>/);
  assert.match(html, /<a href="#T1" class="node s-ready"[^>]*aria-label="T1 Small fix, ready, tier easy"/, 'the graph shows the task tier');
  const md = fs.readFileSync(path.join(h.state, 'sketch.md'), 'utf8');
  assert.match(md, /^\| easy \| codex \(default\) \| fixture-model \| medium \|$/m);
  assert.match(md, /^\| T1 \| Small fix \(no brief\) \| code \| S \| easy \| 0 \|$/m, 'the ready table shows the tier and the missing brief');
});

test('tasks take a tier from kind and size unless one is given', (t) => {
  const h = makeRepo(t);
  h.init();
  const add = (...flags) => h.json(['task', 'add', '--title', 'x', '--acceptance', 'a', ...flags]).tier;
  assert.equal(add('--kind', 'docs', '--size', 'S'), 'easy');
  assert.equal(add(), 'medium');
  assert.equal(add('--size', 'L'), 'hard');
  assert.equal(add('--kind', 'research', '--size', 'S'), 'research');
  assert.equal(add('--size', 'S', '--tier', 'research'), 'research');
  // Only trivial work defaults to easy: small docs. Every other kind starts at medium.
  const want = {
    code: { S: 'medium', M: 'medium', L: 'hard' },
    ops: { S: 'medium', M: 'medium', L: 'hard' },
    design: { S: 'medium', M: 'medium', L: 'hard' },
    docs: { S: 'easy', M: 'medium', L: 'hard' },
    research: { S: 'research', M: 'research', L: 'research' },
  };
  for (const [kind, sizes] of Object.entries(want)) {
    for (const [size, tier] of Object.entries(sizes)) assert.equal(add('--kind', kind, '--size', size), tier, `${kind} ${size}`);
  }
  assert.equal(add('--kind', 'code', '--size', 'S', '--tier', 'easy'), 'easy', 'an explicit tier still wins');
  assert.equal(h.json(['task', 'update', 'T2', '--tier', 'hard']).tier, 'hard');
  assert.equal(h.json(['task', 'update', 'T1', '--size', 'L']).tier, 'easy', 'a size change does not move the tier');
  assert.match(h.ok(['task', 'show', 'T2']), /size: M {2}tier: hard/);
  assert.equal(h.json(['ready']).ready.find((r) => r.id === 'T2').tier, 'hard');
  assert.equal(h.run(['task', 'update', 'T1', '--tier', 'expert']).code, 2);

  const plan = path.join(h.base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify([{ title: 'p', acceptance: ['a'], tier: 'research' }, { title: 'q', acceptance: ['a'], size: 'S' }, { title: 'd', acceptance: ['a'], kind: 'docs', size: 'S' }]));
  assert.deepEqual(h.json(['plan', 'import', plan]).added.map((a) => h.json(['task', 'show', a.id]).tier), ['research', 'medium', 'easy']);
  fs.writeFileSync(plan, JSON.stringify([{ title: 'r', acceptance: ['a'], tier: 'expert' }]));
  const bad = h.run(['plan', 'import', plan]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /tier must be one of easy, medium, hard, research/);

  // A task written before tiers existed gets one from its kind and size.
  const doc = h.readState('tasks.json');
  delete doc.tasks[2].tier;
  doc.tasks[2].role = 'worker';
  h.writeState('tasks.json', doc);
  const old = h.json(['task', 'show', 'T3']);
  assert.deepEqual([old.tier, old.role], ['hard', undefined]);
});

test('validate does not warn when review uses the task tier model', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'x', '--acceptance', 'a', '--kind', 'docs', '--size', 'S']);
  assert.deepEqual(reviewWarnings(h.json(['validate'])), [], 'easy runs fixture-light and review runs fixture-main');
  h.ok(['task', 'add', '--title', 'y', '--acceptance', 'a']);
  const r = h.run(['validate']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^plan ok: 2 tasks/);
  const data = h.json(['validate']);
  assert.deepEqual([data.ok, reviewWarnings(data)], [true, []]);
  h.ok(['ladder', 'set', 'review', '--harness', 'claude', '--model', 'fixture-large', '--clear', 'profile']);
  assert.deepEqual(reviewWarnings(h.json(['validate'])), []);
  h.ok(['task', 'update', 'T1', '--tier', 'hard']);
  assert.deepEqual(reviewWarnings(h.json(['validate'])), [], 'a clean-context reviewer may use the builder model');
});

test('validate allows identical Codex profile and explicit model identities', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'x', '--acceptance', 'a', '--kind', 'docs', '--size', 'S']);
  // codex -m overrides the profile's model, so these two run the same model.
  h.ok(['ladder', 'set', 'easy', '--model', 'same-model', '--profile', 'author-profile']);
  h.ok(['ladder', 'set', 'review', '--model', 'same-model', '--profile', 'review-profile']);
  for (const tier of ['medium', 'hard', 'research']) h.ok(['ladder', 'set', tier, '--model', 'same-model', '--clear', 'profile']);
  assert.deepEqual(reviewWarnings(h.json(['validate'])), []);
  h.ok(['ladder', 'set', 'review', '--model', 'other-model']);
  assert.deepEqual(reviewWarnings(h.json(['validate'])), [], 'different explicit models differ whatever the profiles');
  h.ok(['ladder', 'set', 'easy', '--clear', 'model']);
  h.ok(['ladder', 'set', 'review', '--clear', 'model', '--profile', 'author-profile']);
  for (const tier of ['medium', 'hard', 'research']) h.ok(['ladder', 'set', tier, '--harness', 'codex', '--profile', 'author-profile', '--clear', 'model']);
  assert.deepEqual(reviewWarnings(h.json(['validate'])), [], 'shared profiles are allowed');
});

// A directory holding git and the named stand-ins, used as the whole PATH.
// Its git runs the real one: inside an agent the first git on PATH is the
// agent's shim, which would find this wrapper first and run it again.
function onlyOnPath(h, name, programs) {
  const dir = path.join(h.base, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = findReal('git', '');
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nexec '${git}' "$@"\n`, { mode: 0o755 });
  for (const [program, script] of Object.entries(programs)) {
    const file = path.join(dir, `${program}.js`);
    fs.writeFileSync(file, script);
    fs.writeFileSync(path.join(dir, program), `#!/bin/sh\nexec '${process.execPath}' '${file}' "$@"\n`, { mode: 0o755 });
  }
  const key = Object.keys(h.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { env: { [key]: dir } };
}

// The stand-ins are shell scripts; Windows runs neither them nor a .cmd without a shell.
test('validate warns when no harness on PATH can run a worker or reviewer, and when gh cannot run', { skip: process.platform === 'win32' }, (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'x', '--acceptance', 'a', '--kind', 'docs', '--size', 'S']);
  const r = h.run(['validate'], onlyOnPath(h, 'empty', {}));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^plan ok: 1 tasks$/m);
  assert.match(r.stdout, /^warning: no harness on PATH can run a worker: easy needs codex, medium needs codex, hard needs claude, research needs claude$/m);
  assert.match(r.stdout, /^warning: no harness on PATH can run a reviewer: review needs codex, easy needs codex, medium needs codex, hard needs claude, research needs claude$/m);
  assert.match(r.stdout, /^warning: gh is not on PATH; workers open PRs with it: install the GitHub CLI and run gh auth login$/m);
  const kinds = h.json(['validate'], onlyOnPath(h, 'empty', {})).warnings.map((w) => w.kind);
  assert.deepEqual(kinds, ['worker-harness', 'reviewer-harness', 'gh-auth']);
});

test('validate names a worker rung an open task needs when only it cannot start, and a failed gh login', { skip: process.platform === 'win32' }, (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'x', '--acceptance', 'a', '--kind', 'docs', '--size', 'S']);
  const loggedOut = "process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\\n'); process.exit(1);\n";
  const codexOnly = onlyOnPath(h, 'codex-only', { codex: '', gh: loggedOut });
  assert.deepEqual(h.json(['validate'], codexOnly).warnings, [{ task: null, kind: 'gh-auth',
    message: 'gh auth status failed (You are not logged into any GitHub hosts. To log in, run: gh auth login); workers open PRs with gh. If this machine is online, run gh auth login' }]);
  h.ok(['task', 'add', '--title', 'y', '--acceptance', 'a', '--tier', 'hard']);
  const ready = onlyOnPath(h, 'codex-gh', { codex: '', gh: 'process.exit(0);\n' });
  assert.deepEqual(h.json(['validate'], ready).warnings.map((w) => w.message),
    ['ladder hard cannot start a worker for T2: hard needs claude on PATH']);
});

test('switching from Codex to agy drops inherited Codex flags and names them', t => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ladder', 'set', 'hard', '--harness', 'codex', '--model', 'fixture',
    '--clear', 'profile', '--args', '["--skip-git-repo-check"]']);
  const out = h.ok(['ladder', 'set', 'hard', '--harness', 'agy', '--model', 'fixture-large']);
  assert.match(out, /^ladder hard: moving from codex to agy dropped args \["--skip-git-repo-check"\], which does not fit agy$/m);
  assert.deepEqual(h.readState('project.json').ladder.hard, { harness: 'agy', model: 'fixture-large', effort: 'high' });
  assert.equal(h.json(['ladder', 'show']).ladder.hard.harness, 'agy');
});

test('moving a rung to another harness drops the model and fields the old harness chose', (t) => {
  // The rungs name a configured Claude alias, so the model swap proof still
  // moves a Claude model off Claude.
  const alias = Object.keys(L.BUILTIN.claude_aliases)[0];
  const claudeRung = { harness: 'claude', model: alias, effort: 'high' };
  const h = makeRepo(t);
  h.initLadder = { easy: claudeRung, review: claudeRung, small: claudeRung, medium: { profile: 'sol', effort: 'high' } };
  h.init();
  // The field report: a claude/haiku rung moved to codex kept its Claude model.
  const out = h.run(['ladder', 'set', 'easy', '--harness', 'codex', '--profile', 'sol', '--effort', 'medium', '--json']);
  assert.equal(out.code, 0, out.stderr);
  const data = JSON.parse(out.stdout);
  assert.deepEqual(data.dropped, { model: alias });
  assert.equal(data.model, undefined);
  assert.deepEqual(h.readState('project.json').ladder.easy, { harness: 'codex', profile: 'sol', effort: 'medium' });
  const ev = events(h).filter((e) => e.cmd === 'ladder set').pop();
  assert.deepEqual(ev.detail, { rung: 'easy', harness: 'codex', profile: 'sol', effort: 'medium', dropped: { model: alias } });
  assert.ok(events(h).some((e) => e.cmd === 'setting' && e.detail.settings['ladder.model']), 'the dropped field is audited as changed');

  // A model named in the same edit stays, even one the drop would remove.
  h.ok(['ladder', 'set', 'small', '--harness', 'codex', '--model', alias]);
  assert.equal(h.readState('project.json').ladder.small.model, alias);

  // Following the default through --clear harness moves the rung too.
  h.ok(['ladder', 'set', 'review', '--clear', 'harness', '--profile', 'sol']);
  assert.deepEqual(h.readState('project.json').ladder.review, { profile: 'sol', effort: 'high' });

  // codex to claude drops the profile; a rung left with nothing to run is
  // refused, naming what the move would drop.
  const before = projectText(h);
  const refused = h.run(['ladder', 'set', 'medium', '--harness', 'claude']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /ladder medium \(claude\): needs a model; ladder medium: moving from codex to claude would drop profile sol, which does not fit claude, so name what the rung runs on claude/);
  assert.equal(projectText(h), before);
  h.ok(['ladder', 'set', 'medium', '--harness', 'claude', '--model', alias]);
  assert.deepEqual(h.readState('project.json').ladder.medium, { harness: 'claude', model: alias, effort: 'high' });

  // A new default harness does not edit the rungs that follow it, so it
  // refuses one whose model cannot run there.
  h.ok(['ladder', 'set', 'research', '--clear', 'harness', '--model', 'gpt-5-codex']);
  const stuck = h.run(['ladder', 'harness', 'claude']);
  assert.equal(stuck.code, 1);
  assert.match(stuck.stderr, /ladder research \(claude, the default harness\): model gpt-5-codex does not run on claude/);
});

test('a harness move drops tools the new harness does not know and names the personal fallbacks that follow it', (t) => {
  const h = makeRepo(t);
  h.init();
  // Claude ids by name: the model swap proof leaves no Claude release in the defaults.
  writeUser(h, { ladder: {
    hard: { fallbacks: [{ model: 'claude-fixture-large' }, { model: 'fixture-large', tools: ['WebFetch'] }] },
    research: { fallbacks: [{ model: 'gpt-fixture-mini' }, { harness: 'codex', model: 'gpt-fixture-mini' }] },
  } });
  const user = fs.readFileSync(h.userConfig, 'utf8');

  // The review's case: codex exits on --enable WebFetch.
  h.ok(['ladder', 'set', 'hard', '--tools', '["WebFetch"]']);
  const moved = h.run(['ladder', 'set', 'hard', '--harness', 'codex', '--profile', 'fixture-main', '--json']);
  assert.equal(moved.code, 0, moved.stderr);
  const data = JSON.parse(moved.stdout);
  assert.deepEqual(data.dropped, { tools: ['WebFetch'] });
  assert.equal(h.readState('project.json').ladder.hard.tools, undefined);
  assert.deepEqual(data.notices, [
    `hard fallback 1 from user file ${h.userConfig} follows the rung to codex, where model claude-fixture-large does not run on codex; spawn skips it until the route names its harness or what codex runs`,
    `hard fallback 2 from user file ${h.userConfig} follows the rung to codex, where codex does not know tool WebFetch; spawn skips it until the route names its harness or what codex runs`,
  ]);
  assert.equal(fs.readFileSync(h.userConfig, 'utf8'), user, 'the user file is not edited');
  const show = h.json(['ladder', 'show']).problems.filter((p) => p.startsWith('hard fallback'));
  // Named for what cannot run, not for an approval that would start codex with --enable WebFetch.
  assert.deepEqual(show, [
    `hard fallback 1 from user file ${h.userConfig} follows the rung's harness, where model claude-fixture-large does not run on codex; skipped`,
    `hard fallback 2 from user file ${h.userConfig} follows the rung's harness, where codex does not know tool WebFetch; skipped`,
  ]);

  // A rung that follows the default is not edited, so a tool the new default
  // does not know refuses the move.
  for (const n of ['easy', 'medium', 'review', 'small']) h.ok(['ladder', 'set', n, '--harness', 'codex']);
  h.ok(['ladder', 'set', 'research', '--clear', 'harness', '--model', 'fixture-large', '--tools', '["web_search"]']);
  const before = projectText(h);
  const stuck = h.run(['ladder', 'harness', 'claude']);
  assert.equal(stuck.code, 1, stuck.stdout);
  assert.match(stuck.stderr, /ladder research \(claude, the default harness\): claude does not know tool web_search/);
  assert.equal(projectText(h), before);

  // Its fallback that follows it is named; the one with its own harness is not.
  h.ok(['ladder', 'set', 'research', '--clear', 'tools']);
  const out = h.ok(['ladder', 'harness', 'claude']);
  assert.match(out, new RegExp(`^notice: research fallback 1 from user file .* follows the rung to claude, where model gpt-fixture-mini does not run on claude;`, 'm'));
  assert.doesNotMatch(out, /research fallback 2/);
});

test('a move to a codex profile with a custom provider keeps a Claude model it can serve', (t) => {
  const h = makeRepo(t);
  h.init();
  fs.mkdirSync(path.join(h.env.HOME, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(h.env.HOME, '.codex', 'config.toml'), '[profiles.router]\nmodel_provider = "openrouter"\n');
  h.ok(['ladder', 'set', 'hard', '--model', 'anthropic/claude-fixture-large']);
  const kept = h.json(['ladder', 'set', 'hard', '--harness', 'codex', '--profile', 'router']);
  assert.equal(kept.dropped, undefined);
  assert.equal(h.readState('project.json').ladder.hard.model, 'anthropic/claude-fixture-large');
  // The OpenAI route cannot serve it, so the move drops it there.
  h.ok(['ladder', 'set', 'research', '--model', 'anthropic/claude-fixture-large']);
  const off = h.json(['ladder', 'set', 'research', '--harness', 'codex', '--profile', 'fixture-main']);
  assert.deepEqual(off.dropped, { model: 'anthropic/claude-fixture-large' });
});

test('harnessDrops keeps what fits the new harness and returns the rest', () => {
  const alias = Object.keys(L.BUILTIN.claude_aliases)[0];
  const rung = { model: 'claude-haiku-5-5', effort: 'high', supervision: { retries: 1 }, env: { A: '1' } };
  for (const [r, h, dropped] of [
    [rung, 'codex', { model: 'claude-haiku-5-5' }],
    [rung, 'claude', {}],
    [rung, 'pi', {}],
    [{ model: alias }, 'pi', { model: alias }],
    [{ model: 'global.anthropic.claude-fable-5-1' }, 'codex', { model: 'global.anthropic.claude-fable-5-1' }],
    [{ model: 'gpt-5.5' }, 'claude', { model: 'gpt-5.5' }],
    [{ model: 'openai.gpt-oss-120b' }, 'claude', { model: 'openai.gpt-oss-120b' }],
    [{ model: 'gemini-3-pro' }, 'codex', { model: 'gemini-3-pro' }],
    [{ model: 'fixture-large' }, 'claude', {}],
    [{ model: 'fixture-large', effort: 'high' }, 'command', { model: 'fixture-large', effort: 'high' }],
    [{ profile: 'sol', effort: 'xhigh' }, 'agy', { profile: 'sol', effort: 'xhigh' }],
    [{ provider: 'bedrock' }, 'codex', { provider: 'bedrock' }],
    [{ provider: 'custom' }, 'claude', { provider: 'custom' }],
    [{ effort: 'off' }, 'opencode', {}],
    [{ args: ['--verbose'] }, 'codex', { args: ['--verbose'] }],
    [{ command: ['x'] }, 'claude', { command: ['x'] }],
    [{ tools: ['WebSearch'] }, 'pi', { tools: ['WebSearch'] }],
    [{ tools: ['read'], mcp: ['m'] }, 'pi', { mcp: ['m'] }],
    [{ web_mcp: { name: 'w', command: 'c' } }, 'codex', { web_mcp: { name: 'w', command: 'c' } }],
    // Tool names are judged one by one against what the new harness knows.
    [{ tools: ['WebFetch', 'web_search'] }, 'codex', { tools: ['WebFetch'] }],
    [{ tools: ['web_search', 'memories'] }, 'claude', { tools: ['web_search', 'memories'] }],
    [{ tools: ['WebSearch', 'Bash(git log:*)', 'mcp__docs'] }, 'claude', {}],
    [{ tools: ['WebFetch'] }, 'opencode', {}],
    [{ tools: ['web_search'] }, 'agy', { tools: ['web_search'] }],
    // A context suffix keeps an alias an alias.
    [{ model: `${alias}[1m]` }, 'codex', { model: `${alias}[1m]` }],
    [{ model: `${alias}[1m]` }, 'claude', {}],
    // An application inference profile id is opaque, even one that starts like an o-series id.
    [{ model: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/o3k2abc' }, 'claude', {}],
    [{ model: 'o3k2abc' }, 'claude', {}],
    // An ARN that names its model keeps the model's vendor.
    [{ model: 'arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-oss-120b-1:0' }, 'claude', { model: 'arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-oss-120b-1:0' }],
    [{ model: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-fixture-large-v1:0' }, 'codex', { model: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-fixture-large-v1:0' }],
    [{ model: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-fixture-large-v1:0' }, 'claude', {}],
    [{ model: 'o4-mini' }, 'claude', { model: 'o4-mini' }],
    [{ model: 'openai.o3' }, 'claude', { model: 'openai.o3' }],
  ]) assert.deepEqual(L.harnessDrops(r, h), dropped, `${JSON.stringify(r)} on ${h}`);
});

test('inheritedMisfits judges only routes that follow the rung, and not one that may use a proxy', () => {
  const layers = (harness, fallbacks) => ({ ladder: { easy: { harness, fallbacks } } });
  for (const [harness, route, why] of [
    ['codex', { model: 'claude-fixture-large' }, ['model claude-fixture-large does not run on codex']],
    ['codex', { model: 'claude-fixture-large', tools: ['WebFetch', 'web_search'] }, ['model claude-fixture-large does not run on codex', 'codex does not know tool WebFetch']],
    ['codex', { harness: 'codex', model: 'claude-fixture-large' }, null],
    ['codex', { model: 'claude-fixture-large', env: { OPENAI_BASE_URL: 'http://127.0.0.1:4000' } }, null],
    ['codex', { model: 'claude-fixture-large', env_file: '~/.proxy.env' }, null],
    // A variable that is not a provider endpoint says nothing about the model.
    ['codex', { model: 'claude-fixture-large', env: { GITHUB_BASE_URL: 'https://ghe.example' } }, ['model claude-fixture-large does not run on codex']],
    ['claude', { model: 'gpt-fixture-mini', env: { ANTHROPIC_BEDROCK_BASE_URL: 'https://proxy.example' } }, null],
    // A proxy does not change which tool names the harness takes.
    ['codex', { model: 'claude-fixture-large', tools: ['WebFetch'], env: { OPENAI_BASE_URL: 'http://127.0.0.1:4000' } }, ['codex does not know tool WebFetch']],
    ['codex', { model: 'claude-fixture-large', tools: ['WebFetch'], env_file: '~/.proxy.env' }, ['codex does not know tool WebFetch']],
    ['claude', { model: 'gpt-fixture-mini', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' } }, null],
    ['claude', { model: 'gpt-fixture-mini', env: { ROUTE: '1' } }, ['model gpt-fixture-mini does not run on claude']],
    ['claude', { model: 'fixture-large', tools: ['WebFetch'] }, null],
  ]) {
    assert.deepEqual(L.inheritedMisfits(layers(harness, [route]), 'easy', {}), why ? [{ route: 1, why }] : [], JSON.stringify(route));
  }
});

test('a codex route keeps another vendor\'s model only when its provider is a custom one', (t) => {
  // Claude by its name, not a configured release: the model swap proof
  // replaces those with ids of no known vendor.
  const release = 'claude-fixture-large';
  const base = fs.mkdtempSync(path.join(TMP_ROOT, 'codex-custom-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const [name, config, rung, fits] of [
    ['default OpenAI', '', {}, false],
    ['global custom provider', 'model_provider = "openrouter"', {}, true],
    ['custom profile', '[profiles.router]\nmodel_provider = "litellm"', { profile: 'router' }, true],
    ['other profile', '[profiles.router]\nmodel_provider = "litellm"', { profile: 'sol' }, false],
    ['override', '', { args: ['-c', 'model_provider=openrouter'] }, true],
    ['local server', 'model_provider = "ollama"', {}, false],
  ]) {
    const home = path.join(base, name);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'config.toml'), config);
    for (const model of [`anthropic/${release}`, release]) {
      assert.equal(L.modelFits(model, 'codex', rung, {}, { codex: home }), fits, `${name}: ${model}`);
    }
  }
});

test('pricing identity drops Claude provider, context and Bedrock version suffixes', () => {
  for (const [id, identity] of [
    ['global.anthropic.claude-opus-5-5[1m]', 'claude-opus-5-5'],
    ['anthropic.claude-haiku-5-5', 'claude-haiku-5-5'],
    [' Global.Anthropic.Claude-Opus-5-5[1M] ', 'claude-opus-5-5'],
    ['claude-opus-5-5', 'claude-opus-5-5'],
    ['global.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5-20251001'],
    ['anthropic.claude-haiku-4-5-20251001-v12:34', 'claude-haiku-4-5-20251001'],
    ['claude-haiku-4-5-20251001-v1:0[1m]', 'claude-haiku-4-5-20251001'],
    ['claude-haiku-4-5-20251001-v1:0-extra', 'claude-haiku-4-5-20251001-v1:0-extra'],
    ['global.anthropic.fixture-release', 'fixture-release'],
    ['openai.gpt-fixture', 'openai.gpt-fixture'],
    ['openai.gpt-fixture-v1:0', 'openai.gpt-fixture-v1:0'],
    ['a/easy', 'a/easy'],
  ]) assert.equal(L.modelIdentity(id), identity, id);
  assert.equal(L.billing({ harness: 'claude', provider: 'bedrock' }, {}), 'api');
  assert.equal(L.billing({ harness: 'claude' }, { ANTHROPIC_API_KEY: 'x' }), 'api');
  assert.equal(L.billing({ harness: 'claude' }, { ANTHROPIC_API_KEY: '' }), 'subscription');
  assert.equal(L.billing({ harness: 'pi' }, {}), null);
  // A rung that names no provider runs on the Bedrock route its environment inherits; a pinned provider decides alone.
  assert.equal(L.billing({ harness: 'claude' }, { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'fixture', AWS_REGION: 'eu-west-1' }), 'api');
  assert.equal(L.billing({ harness: 'claude' }, { CLAUDE_CODE_USE_BEDROCK: '0' }), 'subscription');
  assert.equal(L.billing({ harness: 'claude', provider: 'anthropic' }, { CLAUDE_CODE_USE_BEDROCK: '1' }), 'subscription');
  // Every provider switch Claude Code reads is a metered route, with Claude Code's truthy spellings.
  for (const name of ['BEDROCK', 'VERTEX', 'FOUNDRY', 'ANTHROPIC_AWS', 'ANTHROPIC_GOOGLE_CLOUD', 'MANTLE', 'GATEWAY']) {
    for (const value of ['1', 'true', 'YES', ' on ']) {
      assert.equal(L.billing({ harness: 'claude', model: 'claude-opus-5-5' }, { [`CLAUDE_CODE_USE_${name}`]: value }), 'api', `${name}=${value}`);
    }
    assert.equal(L.billing({ harness: 'claude' }, { [`CLAUDE_CODE_USE_${name}`]: 'off' }), 'subscription', `${name}=off`);
    assert.equal(L.billing({ harness: 'claude', provider: 'anthropic' }, { [`CLAUDE_CODE_USE_${name}`]: '1' }), 'subscription', `pinned ${name}`);
  }
  assert.equal(L.billing({ harness: 'claude' }, { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' }), 'subscription');
});

test('Codex billing follows the configured provider rather than inherited credentials', (t) => {
  const base = fs.mkdtempSync(path.join(TMP_ROOT, 'codex-billing-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const [name, config, standalone, rung, env, expected] of [
    ['default login', '', undefined, {}, {}, 'subscription'],
    ['OpenAI key', '', undefined, {}, { OPENAI_API_KEY: 'fixture-key' }, 'api'],
    ['AWS credentials on OpenAI', 'model_provider = "openai"', undefined, {}, { AWS_PROFILE: 'fixture', AWS_REGION: 'us-east-1' }, 'subscription'],
    ['global Bedrock', 'model_provider = "amazon-bedrock"', undefined, {}, {}, 'api'],
    ['named Bedrock profile', 'model_provider = "openai"\n[profiles.sol]\nmodel_provider = "amazon-bedrock"', undefined, { profile: 'sol' }, {}, 'api'],
    ['named profile inherits Bedrock', 'model_provider = "amazon-bedrock"\n[profiles.sol]\nmodel = "fixture"', undefined, { profile: 'sol' }, {}, 'api'],
    ['standalone Bedrock', 'model_provider = "openai"', 'model_provider = "amazon-bedrock"', { profile: 'sol', model: 'fixture' }, {}, 'api'],
    ['standalone login', 'model_provider = "amazon-bedrock"', 'model_provider = "openai"', { profile: 'sol' }, {}, 'subscription'],
    ['standalone inherits Bedrock', 'model_provider = "amazon-bedrock"', 'model = "fixture"', { profile: 'sol' }, {}, 'api'],
    ['missing profile', 'model_provider = "openai"', undefined, { profile: 'missing' }, { AWS_BEARER_TOKEN_BEDROCK: 'fixture-token' }, null],
    ['invalid config', '[broken', undefined, {}, {}, null],
    ['invalid provider', 'model_provider = false', undefined, {}, {}, null],
    ['provider override', 'model_provider = "openai"', undefined, { args: ['-c', 'model_provider=amazon-bedrock'] }, {}, 'api'],
    ['local Ollama', 'model_provider = "ollama"', undefined, {}, { OPENAI_API_KEY: 'fixture-key' }, null],
    ['local LM Studio profile', 'model_provider = "openai"\n[profiles.sol]\nmodel_provider = "lmstudio"', undefined, { profile: 'sol' }, {}, null],
    ['last provider override wins', 'model_provider = "amazon-bedrock"', undefined, { args: ['-c', 'model_provider="amazon-bedrock"', '-c', 'model_provider="openai"'] }, {}, 'subscription'],
  ]) {
    const home = path.join(base, name);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'config.toml'), config);
    if (standalone !== undefined) fs.writeFileSync(path.join(home, 'sol.config.toml'), standalone);
    // Codex can load AWS credentials itself; billing needs only the route.
    fs.writeFileSync(path.join(home, '.env'), 'AWS_BEARER_TOKEN_BEDROCK=fixture-token\n');
    assert.equal(L.billing({ harness: 'codex', ...rung }, env, { codex: home }), expected, name);
  }
});
