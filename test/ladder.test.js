'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const L = require('../lib/ladder');

const BUILTIN = {
  orchestrator: { harness: 'claude', model: 'opus', effort: 'high' },
  easy: { harness: 'claude', model: 'claude-haiku-5-5', effort: 'high' },
  medium: { profile: 'sol', effort: 'high' },
  hard: { harness: 'claude', model: 'opus', effort: 'medium' },
  research: { harness: 'claude', model: 'opus', effort: 'high' },
  review: { harness: 'claude', model: 'claude-haiku-5-5', effort: 'high' },
  small: { harness: 'claude', model: 'claude-haiku-5-5', effort: 'high' },
};

function writeUser(h, doc) {
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  fs.writeFileSync(h.userConfig, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
}

const projectText = (h) => fs.readFileSync(path.join(h.state, 'project.json'), 'utf8');
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('init copies the built-in ladder, and a rung the project leaves out falls back to it', (t) => {
  const h = makeRepo(t);
  h.init();
  const p = h.readState('project.json');
  assert.equal(p.harness, 'codex');
  assert.deepEqual(p.ladder, BUILTIN);
  const show = h.json(['ladder', 'show']);
  assert.equal(show.harness_from, 'project');
  assert.equal(show.user_file, h.userConfig);
  assert.equal(show.user_file_exists, false);
  assert.deepEqual(show.ladder.easy, { harness: 'claude', model: 'claude-haiku-5-5', effort: 'high', harness_from: 'rung', from: 'project' });
  assert.deepEqual(show.ladder.medium, { profile: 'sol', effort: 'high', harness: 'codex', harness_from: 'default', from: 'project' });
  assert.deepEqual(show.ladder.hard, { harness: 'claude', model: 'opus', effort: 'medium', harness_from: 'rung', from: 'project' });
  assert.deepEqual(show.ladder.research, { harness: 'claude', model: 'opus', effort: 'high', harness_from: 'rung', from: 'project' });
  assert.deepEqual(show.ladder.review, { harness: 'claude', model: 'claude-haiku-5-5', effort: 'high', harness_from: 'rung', from: 'project' });
  assert.deepEqual(show.ladder.small, { harness: 'claude', model: 'claude-haiku-5-5', effort: 'high', harness_from: 'rung', from: 'project' });
  assert.deepEqual(show.ladder.orchestrator, { harness: 'claude', model: 'opus', effort: 'high', harness_from: 'rung', from: 'project' });
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
  assert.deepEqual([back.harness, back.harness_from], ['codex', 'built-in']);
  assert.deepEqual([back.ladder.easy.model, back.ladder.easy.from], ['claude-haiku-5-5', 'built-in']);
  assert.match(h.ok(['ladder', 'show']), /^ {2}easy +claude +model claude-haiku-5-5, effort high +from built-in$/m);
});

test('docs/builtin-ladder.json is the built-in ladder', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'builtin-ladder.json'), 'utf8'));
  assert.equal(doc.harness, 'codex');
  assert.deepEqual(doc.ladder, BUILTIN);
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
  assert.deepEqual(p.ladder.hard, L.BUILTIN.ladder.hard, 'a rung the user file leaves out comes from the built-in ladder');

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
    ['research', '--harness', 'codex'],
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

test('research web MCP inheritance remains Claude-only and refuses additional MCP servers', (t) => {
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
  // Pinned so the hard row and the pi refusal below do not follow the built-in ladder.
  h.ok(['ladder', 'set', 'medium', '--clear', 'model', '--profile', 'sol', '--effort', 'high']);
  h.ok(['ladder', 'set', 'hard', '--harness', 'claude', '--model', 'fable', '--effort', 'medium']);
  const project = h.readState('project.json');
  const out = h.json(['ladder', 'save-user']);
  assert.equal(out.file, h.userConfig);
  const saved = JSON.parse(fs.readFileSync(h.userConfig, 'utf8'));
  assert.equal(saved.harness, 'codex');
  assert.deepEqual(saved.ladder.hard, { harness: 'claude', model: 'fable', effort: 'medium' });
  assert.deepEqual(saved.ladder.easy, project.ladder.easy);
  assert.equal(events(h).filter((e) => e.cmd === 'ladder save-user').length, 1);

  const other = path.join(h.base, 'second-state');
  h.ok(['init', '--name', 'second', '--goal', 'g', '--state', other]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, 'project.json'), 'utf8')).ladder.hard.model, 'fable');

  // A ladder that cannot run is not saved over the user file.
  const saved1 = fs.readFileSync(h.userConfig, 'utf8');
  h.writeState('project.json', { ...h.readState('project.json'), harness: 'pi' });
  const refused = h.run(['ladder', 'save-user']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /ladder medium \(pi, the default harness\): profile applies only to codex, needs a model;.*before saving it as the default/);
  assert.equal(fs.readFileSync(h.userConfig, 'utf8'), saved1);
});

test('ladder save-user writes only what the project defines and keeps the rest of the user file', (t) => {
  const h = makeRepo(t);
  h.init();
  writeUser(h, { browser_kit: ['playwright'], note: 'kept', ladder: { medium: { fallbacks: [{ harness: 'claude', model: 'fable', effort: 'high' }] } } });
  const p = h.readState('project.json');
  delete p.harness;
  delete p.ladder.easy;
  h.writeState('project.json', p);
  h.ok(['ladder', 'save-user']);
  const saved = JSON.parse(fs.readFileSync(h.userConfig, 'utf8'));
  // Neither the default harness nor easy is in the project, so the user file gets neither: the built-in applies to them.
  assert.equal(saved.harness, undefined);
  assert.equal(saved.ladder.easy, undefined);
  assert.deepEqual(saved.ladder.hard, p.ladder.hard);
  assert.deepEqual(saved.ladder.medium, { ...p.ladder.medium, fallbacks: [{ harness: 'claude', model: 'fable', effort: 'high' }] });
  assert.equal(saved.note, 'kept');
  assert.deepEqual(saved.browser_kit, ['playwright']);
});

test('personal hard fallbacks overlay project rungs and stay out of project writes', (t) => {
  const h = makeRepo(t);
  h.init();
  // Pinned so the expected model does not follow the built-in ladder.
  const pinned = h.readState('project.json');
  pinned.ladder.hard = { harness: 'claude', model: 'opus', effort: 'medium' };
  h.writeState('project.json', pinned);
  const fallbacks = [{ harness: 'codex', profile: 'astra', effort: 'high' }, { harness: 'claude', model: 'fable', effort: 'high' }];
  writeUser(h, { ladder: { hard: { fallbacks } } });
  const hard = h.json(['ladder', 'show']).ladder.hard;
  assert.equal(hard.model, 'opus');
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

test('fallback-only user rungs keep the built-in primary when projects omit them', (t) => {
  const h = makeRepo(t);
  writeUser(h, { ladder: { hard: { fallbacks: [{ harness: 'claude', model: 'fable' }] } } });
  h.init();
  assert.deepEqual(h.readState('project.json').ladder.hard, L.BUILTIN.ladder.hard);
});

test('ladder harness moves every rung without its own harness, and spawn runs each tier there', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const rung of ['easy', 'medium', 'review', 'small']) h.ok(['ladder', 'set', rung, '--model', `m-${rung}`, '--effort', 'high', '--clear', 'profile', '--clear', 'harness']);
  h.ok(['ladder', 'set', 'hard', '--model', 'm-hard', '--effort', 'medium']);
  h.ok(['ladder', 'set', 'research', '--model', 'm-research', '--effort', 'high']);
  h.ok(['task', 'add', '--title', 'Small', '--acceptance', 'a', '--size', 'S']);
  h.ok(['task', 'add', '--title', 'Medium', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'Large', '--acceptance', 'a', '--size', 'L']);
  h.ok(['task', 'add', '--title', 'Study', '--acceptance', 'a', '--kind', 'research', '--size', 'S']);
  for (const id of ['T1', 'T2', 'T3', 'T4']) h.ok(['brief', 'set', id, '-'], { input: `brief ${id}\n` });
  const empty = path.join(h.base, 'no-plugin');
  fs.mkdirSync(empty);
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
  assert.deepEqual(flags(easy.argv), ['pi', '-p', '--mode', 'json', '--model', 'm-easy', '--thinking', 'high', ...piExtension(easy.agent)]);
  const medium = spawn('T2');
  assert.deepEqual(flags(medium.argv), ['pi', '-p', '--mode', 'json', '--model', 'm-medium', '--thinking', 'high', ...piExtension(medium.agent)]);
  const hard = spawn('T3');
  const research = spawn('T4');
  assert.deepEqual(flags(hard.argv).slice(0, 8), ['claude', '-p', '--model', 'm-hard', '--effort', 'medium', '--output-format', 'json']);
  assert.deepEqual(flags(research.argv).slice(0, 8), ['claude', '-p', '--model', 'm-research', '--effort', 'high', '--output-format', 'json']);
  assert.equal(hard.argv[hard.argv.indexOf('--session-id') + 1], hard.session_id);
  assert.equal(research.argv[research.argv.indexOf('--session-id') + 1], research.session_id);
  const review = spawn('T2', 'review');
  assert.deepEqual([review.rung, review.agent], ['review', 'reviewer-T2-1']);
  assert.deepEqual(flags(review.argv), ['pi', '-p', '--mode', 'json', '--model', 'm-review', '--thinking', 'high', ...piExtension(review.agent)]);

  h.ok(['ladder', 'harness', 'codex']);
  assert.deepEqual(flags(spawn('T1').argv).slice(0, 7), ['codex', 'exec', '--json', '-m', 'm-easy', '-c', 'model_reasoning_effort=high']);
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
  // Pinned so the pi refusal below comes from this codex rung, not the built-in one.
  h.ok(['ladder', 'set', 'medium', '--clear', 'model', '--profile', 'sol', '--effort', 'high']);
  const before = projectText(h);
  const logged = events(h).filter((e) => e.cmd.startsWith('ladder')).length;
  const cases = [
    [['ladder', 'harness', 'pi'], 1, /ladder medium \(pi, the default harness\): profile applies only to codex, needs a model;.*fix those rungs first/],
    [['ladder', 'harness', 'gemini'], 2, /claude, codex, opencode, agy, pi, command/],
    [['ladder', 'set', 'easy', '--harness', 'gemini'], 2, /--harness must be one of claude, codex, opencode, agy, pi, command/],
    [['ladder', 'set', 'worker', '--model', 'x'], 2, /unknown rung "worker"; the rungs are orchestrator, easy, medium, hard, research, review, small/],
    [['ladder', 'set', 'research', '--effort', 'ultra'], 1, /ladder research \(claude\): effort must be one of low, medium, high, xhigh, max, not "ultra"/],
    [['ladder', 'set', 'easy', '--provider', 'openai'], 1, /ladder easy \(claude\): claude provider must be anthropic or bedrock/],
    [['ladder', 'set', 'medium', '--provider', 'openai'], 1, /provider applies only to pi and claude/],
    [['ladder', 'set', 'hard', '--clear', 'model'], 1, /ladder hard \(claude\): needs a model/],
    [['ladder', 'set', 'small', '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'effort'], 1, /ladder small \(command\): needs a command array/],
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
  assert.equal(events(h).filter((e) => e.cmd.startsWith('ladder')).length, logged, 'refused writes log no event');

  const p = h.readState('project.json');
  h.writeState('project.json', { ...p, ladder: { ...p.ladder, medium: { harness: 'gemini', model: 'x' } } });
  const hand = h.run(['status']);
  assert.equal(hand.code, 1);
  assert.match(hand.stderr, /ladder medium: harness must be one of claude, codex, opencode, agy, pi, command/);
  h.writeState('project.json', { ...p, roles: { worker: { harness: 'codex', profile: 'sol' } } });
  assert.match(h.run(['status']).stderr, /roles was replaced by harness and ladder/, 'a pre-ladder roles block is refused, not ignored');

  writeUser(h, { ladder: { easy: { harness: 'pi', profile: 'luna' } } });
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
  h.ok(['task', 'add', '--title', 'x', '--acceptance', 'a', '--size', 'S']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'brief\n' });
  // The project keeps its default harness and its orchestrator rung, and
  // follows the user file for the rest.
  const p = h.readState('project.json');
  h.writeState('project.json', { ...p, ladder: { orchestrator: p.ladder.orchestrator } });
  // Another project saves a codex ladder over the user file.
  writeUser(h, { harness: 'codex', ladder: { easy: { profile: 'luna' }, medium: { profile: 'sol' }, review: { profile: 'sol' }, small: { profile: 'luna' } } });

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
  // Pinned so the expected research row does not follow the built-in ladder.
  const pinned = h.readState('project.json');
  pinned.ladder.research = { harness: 'claude', model: 'opus', effort: 'high' };
  h.writeState('project.json', pinned);
  h.ok(['task', 'add', '--title', 'Small fix', '--acceptance', 'a', '--size', 'S']);
  // Effort is set so the expected easy row does not follow the built-in easy effort.
  h.ok(['ladder', 'set', 'easy', '--model', 'gpt-x', '--effort', 'high', '--clear', 'profile', '--clear', 'harness', '--agent', 'orchestrator']);
  const ev = events(h).find((e) => e.cmd === 'ladder set');
  assert.deepEqual([ev.agent, ev.detail], ['orchestrator', { rung: 'easy', model: 'gpt-x', effort: 'high', authority: 'orchestrator' }]);
  assert.deepEqual(h.readState('project.json').ladder.easy, { model: 'gpt-x', effort: 'high' });
  const html = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  assert.match(html, /<tr data-rung="easy"><th scope="row">easy<\/th><td>codex \(default\)<\/td><td>gpt-x<\/td><td>high<\/td>/);
  assert.match(html, /<tr data-rung="research"><th scope="row">research<\/th><td>claude<\/td><td>opus<\/td><td>high<\/td>/);
  assert.match(html, /<a href="#T1" class="node s-ready"[^>]*aria-label="T1 Small fix, ready, tier easy"/, 'the graph shows the task tier');
  const md = fs.readFileSync(path.join(h.state, 'sketch.md'), 'utf8');
  assert.match(md, /^\| easy \| codex \(default\) \| gpt-x \| high \|$/m);
  assert.match(md, /^\| T1 \| Small fix \| code \| S \| easy \| 0 \|$/m, 'the ready table shows the tier');
});

test('tasks take a tier from kind and size unless one is given', (t) => {
  const h = makeRepo(t);
  h.init();
  const add = (...flags) => h.json(['task', 'add', '--title', 'x', '--acceptance', 'a', ...flags]).tier;
  assert.equal(add('--size', 'S'), 'easy');
  assert.equal(add(), 'medium');
  assert.equal(add('--size', 'L'), 'hard');
  assert.equal(add('--kind', 'research', '--size', 'S'), 'research');
  assert.equal(add('--size', 'S', '--tier', 'research'), 'research');
  assert.equal(h.json(['task', 'update', 'T2', '--tier', 'hard']).tier, 'hard');
  assert.equal(h.json(['task', 'update', 'T1', '--size', 'L']).tier, 'easy', 'a size change does not move the tier');
  assert.match(h.ok(['task', 'show', 'T2']), /size: M {2}tier: hard/);
  assert.equal(h.json(['ready']).ready.find((r) => r.id === 'T2').tier, 'hard');
  assert.equal(h.run(['task', 'update', 'T1', '--tier', 'expert']).code, 2);

  const plan = path.join(h.base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify([{ title: 'p', acceptance: ['a'], tier: 'research' }, { title: 'q', acceptance: ['a'], size: 'S' }]));
  assert.deepEqual(h.json(['plan', 'import', plan]).added.map((a) => h.json(['task', 'show', a.id]).tier), ['research', 'easy']);
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
  h.ok(['task', 'add', '--title', 'x', '--acceptance', 'a', '--size', 'S']);
  assert.deepEqual(h.json(['validate']).warnings, [], 'easy and review both run claude-haiku-5-5');
  h.ok(['task', 'add', '--title', 'y', '--acceptance', 'a']);
  const r = h.run(['validate']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^plan ok: 2 tasks/);
  const data = h.json(['validate']);
  assert.deepEqual([data.ok, data.warnings], [true, []]);
  h.ok(['ladder', 'set', 'review', '--harness', 'claude', '--model', 'opus', '--clear', 'profile']);
  assert.deepEqual(h.json(['validate']).warnings, []);
  h.ok(['task', 'update', 'T1', '--tier', 'hard']);
  assert.deepEqual(h.json(['validate']).warnings, [], 'a clean-context reviewer may use the builder model');
});

test('validate allows identical Codex profile and explicit model identities', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'x', '--acceptance', 'a', '--size', 'S']);
  // codex -m overrides the profile's model, so these two run the same model.
  h.ok(['ladder', 'set', 'easy', '--harness', 'codex', '--model', 'same-model', '--profile', 'author-profile']);
  h.ok(['ladder', 'set', 'review', '--harness', 'codex', '--model', 'same-model', '--profile', 'review-profile']);
  for (const tier of ['medium', 'hard', 'research']) h.ok(['ladder', 'set', tier, '--model', 'same-model', '--clear', 'profile']);
  assert.deepEqual(h.json(['validate']).warnings, []);
  h.ok(['ladder', 'set', 'review', '--model', 'other-model']);
  assert.deepEqual(h.json(['validate']).warnings, [], 'different explicit models differ whatever the profiles');
  h.ok(['ladder', 'set', 'easy', '--clear', 'model']);
  h.ok(['ladder', 'set', 'review', '--clear', 'model', '--profile', 'author-profile']);
  for (const tier of ['medium', 'hard', 'research']) h.ok(['ladder', 'set', tier, '--harness', 'codex', '--profile', 'author-profile', '--clear', 'model']);
  assert.deepEqual(h.json(['validate']).warnings, [], 'shared profiles are allowed');
});

test('switching from Codex to agy refuses inherited Codex flags until explicitly cleared', t => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ladder', 'set', 'hard', '--harness', 'codex', '--model', 'fixture',
    '--clear', 'profile', '--args', '["--skip-git-repo-check"]']);
  const before = h.readState('project.json');
  const refused = h.run(['ladder', 'set', 'hard', '--harness', 'agy', '--model', 'gemini-3-pro']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /args may only use.*refused --skip-git-repo-check/);
  assert.deepEqual(h.readState('project.json'), before);
  h.ok(['ladder', 'set', 'hard', '--harness', 'agy', '--model', 'gemini-3-pro', '--clear', 'args']);
  assert.equal(h.json(['ladder', 'show']).ladder.hard.harness, 'agy');
});
