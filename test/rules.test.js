'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

const STUB = path.join(__dirname, 'fixtures', 'harness-stub.js');
// The stubs are shebang scripts; Windows starts only .exe and .com files.
const NO_STUBS = process.platform === 'win32' && 'harness stubs are shebang scripts';

// A user home with global rules for both harnesses (claude's importing a
// shared file), an ancestor AGENTS.md above the repository, the
// repository's own AGENTS.md and a CLAUDE.md that imports a docs file.
function setup(t, brief = 'probe\n') {
  const h = makeRepo(t);
  const home = path.join(h.base, 'home');
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  put(path.join(home, '.claude', 'CLAUDE.md'), '@~/.config/agents/SHARED.md\n\nCLAUDE-GLOBAL\n');
  put(path.join(home, '.config', 'agents', 'SHARED.md'), 'SHARED-RULES\n');
  put(path.join(home, '.codex', 'AGENTS.md'), 'CODEX-GLOBAL\n');
  put(path.join(h.base, 'AGENTS.md'), 'ANCESTOR-RULES\n');
  put(path.join(h.repo, 'AGENTS.md'), 'REPO-RULES\n');
  put(path.join(h.repo, 'CLAUDE.md'), 'See @docs/extra.md for more.\n');
  put(path.join(h.repo, 'docs', 'extra.md'), 'EXTRA-RULES\n');
  // A user MCP server the agent did not opt into.
  put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { planted: { command: 'planted-mcp' } } }));
  h.git(['add', '.']);
  h.git(['commit', '-q', '-m', 'rules']);
  h.init();
  h.ok(['task', 'add', '--title', 'Probe', '--acceptance', 'the agent knows the goal', '--acceptance', 'and the rules']);
  h.ok(['brief', 'set', 'T1', '-'], { input: brief });
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex', 'opencode', 'agy', 'pi']) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(STUB)})(${JSON.stringify(name)});\n`, { mode: 0o755 });
  }
  const out = path.join(h.base, 'stub.json');
  const env = { ...h.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: out, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', XDG_CONFIG_HOME: '', PI_CODING_AGENT_DIR: '', GH_TOKEN: 'x' };
  return { h, home, env, report: () => JSON.parse(fs.readFileSync(out, 'utf8')) };
}

const rung = (h, harness) => {
  const model = harness === 'claude' ? ['--model', 'opus', '--clear', 'profile'] : ['--profile', 'sol', '--clear', 'model'];
  h.ok(['ladder', 'set', 'small', '--harness', harness, ...model, '--clear', 'effort', '--clear', 'args']);
};

const ours = (h, rules) => rules.filter((r) => r.path.startsWith(h.base + path.sep)).map((r) => [path.relative(h.base, r.path), r.scope, r.loaded]);

test('a claude spawn imports the user rules and the repository chain by path, and records a startup receipt', { skip: NO_STUBS }, (t) => {
  const { h, env, report } = setup(t);
  rung(h, 'claude');
  const dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env });
  const wt = dry.cwd;
  h.ok(['worktree', 'T1']);
  const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json'], { env });
  assert.equal(r.code, 0, r.stderr);
  const seen = report();
  const rel = path.relative(h.base, wt);
  const expected = [
    [path.join('home', '.claude', 'CLAUDE.md'), 'global', 'harness'],
    [path.join('home', '.config', 'agents', 'SHARED.md'), 'import', 'harness'],
    ['AGENTS.md', 'project', 'harness'],
    [path.join(rel, 'AGENTS.md'), 'project', 'harness'],
    [path.join(rel, 'CLAUDE.md'), 'project', 'harness'],
    [path.join(rel, 'docs', 'extra.md'), 'import', 'harness'],
  ];
  const startup = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.cmd === 'startup');
  assert.equal(startup.length, 1, 'one startup receipt');
  assert.deepEqual(ours(h, startup[0].detail.rules), expected);
  assert.equal(startup[0].detail.goal, 'prove the engine');
  assert.deepEqual(startup[0].detail.target, { id: 'T1', title: 'Probe', acceptance: 2 });
  assert.equal(startup[0].detail.rules_tokens, Math.ceil(startup[0].detail.rules_bytes / 4));
  assert.ok(startup[0].detail.prompt_bytes > 0);
  const memory = seen.memory.join('\n');
  for (const text of ['CLAUDE-GLOBAL', 'SHARED-RULES', 'ANCESTOR-RULES', 'REPO-RULES', 'EXTRA-RULES']) assert.ok(memory.includes(text), `claude loads ${text}`);
  const instructions = fs.readFileSync(path.join(h.state, 'homes', JSON.parse(r.stdout).agent, 'CLAUDE.md'), 'utf8');
  assert.ok(!/RULES|GLOBAL/.test(instructions), 'the home names the files, never copies them');
  assert.deepEqual(seen.mcp, {}, 'no MCP server it did not opt into');
  assert.match(seen.prompt, /## Goal\n\nProject goal: prove the engine\nTask target: T1, "Probe"/);
  assert.match(seen.prompt, /Begin your first message by restating the project goal and this target/);
  assert.ok(seen.prompt.includes(`- ${path.join(h.base, 'AGENTS.md')} (project, loaded in your context)`));
  assert.ok(!seen.prompt.includes('read it'), 'claude has every file in its context');
  assert.ok(dry.startup.rules.length >= 4, 'dry-run measures the rules before the worktree exists');
});

test('a codex spawn is told to read the rules its harness does not load, and its startup receipt says which', { skip: NO_STUBS }, (t) => {
  const { h, home, env, report } = setup(t);
  rung(h, 'codex');
  const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json'], { env });
  assert.equal(r.code, 0, r.stderr);
  const seen = report();
  const wt = JSON.parse(r.stdout).cwd;
  const rel = path.relative(h.base, wt);
  const startup = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.cmd === 'startup');
  assert.deepEqual(ours(h, startup.detail.rules), [
    [path.join('home', '.codex', 'AGENTS.md'), 'global', 'read'],
    ['AGENTS.md', 'project', 'read'],
    [path.join(rel, 'AGENTS.md'), 'project', 'harness'],
    [path.join(rel, 'CLAUDE.md'), 'project', 'read'],
    [path.join(rel, 'docs', 'extra.md'), 'import', 'read'],
  ]);
  assert.ok(!startup.detail.rules.some((f) => f.path === path.join(home, '.claude', 'CLAUDE.md')), 'claude\'s global file is not codex\'s rules');
  assert.deepEqual(seen.projectDocs, ['REPO-RULES\n'], 'codex itself loads the worktree AGENTS.md');
  assert.ok(seen.prompt.includes(`- ${path.join(home, '.codex', 'AGENTS.md')} (global, read it)`));
  assert.ok(seen.prompt.includes(`- ${path.join(h.base, 'AGENTS.md')} (project, read it)`));
  assert.ok(seen.prompt.includes(`- ${path.join(wt, 'AGENTS.md')} (project, loaded in your context)`));
  assert.match(seen.prompt, /Read every file marked "read it" before you change anything/);
  assert.match(seen.prompt, /Project goal: prove the engine/);
  assert.deepEqual(seen.mcp, {}, 'no MCP server it did not opt into');
});

test('a command harness is told to read global rules and the repository chain', (t) => {
  const { h, env } = setup(t);
  h.ok(['ladder', 'set', 'small', '--harness', 'command', '--clear', 'profile', '--clear', 'effort', '--clear', 'model', '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}'])]);
  const dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env });
  assert.deepEqual(ours(h, dry.startup.rules).map(([p, scope, loaded]) => [path.basename(p), scope, loaded]), [
    ['CLAUDE.md', 'global', 'read'], ['SHARED.md', 'import', 'read'], ['AGENTS.md', 'global', 'read'],
    ['AGENTS.md', 'project', 'read'], ['AGENTS.md', 'project', 'read'], ['CLAUDE.md', 'project', 'read'], ['extra.md', 'import', 'read'],
  ]);
  const prompt = dry.argv[dry.argv.length - 1];
  assert.match(prompt, /## Goal[\s\S]*## House rules[\s\S]*probe[\s\S]*## Task/);
  assert.ok(prompt.includes('"the agent knows the goal"'), 'the acceptance travels with the brief');
});

for (const harness of ['opencode', 'pi']) {
  test(`${harness} names the user's global rules in the prompt and receipt`, { skip: NO_STUBS }, (t) => {
    const { h, home, env, report } = setup(t);
    const globals = {
      opencode: [path.join(home, '.config', 'opencode', 'AGENTS.md')],
      pi: [path.join(home, '.pi', 'agent', 'AGENTS.md')],
    }[harness];
    for (const file of globals) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'GLOBAL-RULES\n');
    }
    h.ok(['ladder', 'set', 'small', '--harness', harness, '--model', 'stub', '--clear', 'profile', '--clear', 'effort', '--clear', 'args']);
    const dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env });
    const prompt = dry.argv.find((arg) => arg.includes('## House rules'));
    for (const file of globals) {
      assert.ok(dry.startup.rules.some((f) => f.path === file && f.scope === 'global' && f.loaded === 'read'), file);
      assert.ok(prompt.includes(`- ${file} (global, read it)`), file);
    }
    h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { env });
    const receipt = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.cmd === 'startup').detail;
    for (const file of globals) {
      assert.ok(receipt.rules.some((f) => f.path === file && f.loaded === 'read'));
      assert.ok(report().prompt.includes(`- ${file} (global, read it)`));
    }
  });
}

test('agy keeps project instructions but excludes user memory and imported modular rules', { skip: NO_STUBS }, t => {
  const { h, home, env } = setup(t);
  const gemini = path.join(home, '.gemini');
  const memory = path.join(gemini, 'GEMINI.md');
  const modular = path.join(gemini, 'config', 'rules', 'private.md');
  fs.mkdirSync(path.dirname(modular), { recursive: true });
  fs.writeFileSync(memory, 'PLANTED-AGY-MEMORY\n');
  fs.writeFileSync(modular, 'PLANTED-AGY-RULE\n');
  const linkedRule = path.join(home, 'private-rule.md');
  fs.writeFileSync(linkedRule, 'PLANTED-AGY-LINKED-RULE\n');
  fs.symlinkSync(linkedRule, path.join(gemini, 'config', 'rules', 'linked.md'));
  const project = path.join(h.repo, 'AGENTS.md');
  fs.writeFileSync(project, `PROJECT-RULES\n@${memory}\n@${modular}\n@${linkedRule}\n`);
  h.git(['add', 'AGENTS.md']);
  h.git(['commit', '-qm', 'Plant imported memory paths']);
  h.ok(['ladder', 'set', 'small', '--harness', 'agy', '--model', 'stub',
    '--clear', 'profile', '--clear', 'effort', '--clear', 'args']);
  const dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env });
  assert.ok(dry.startup.rules.some(rule => path.basename(rule.path) === 'AGENTS.md' && rule.scope === 'project'));
  assert.ok(dry.startup.rules.every(rule => rule.scope !== 'global' && !rule.path.startsWith(gemini) && rule.path !== linkedRule));
  const prompt = dry.argv.find(arg => arg.includes('## House rules'));
  assert.ok(!prompt.includes(memory));
  assert.ok(!prompt.includes(modular));
  assert.ok(!prompt.includes(linkedRule));
});

test('opencode and pi global discovery follows their configured directories and fallback files', { skip: NO_STUBS }, (t) => {
  const { h, env } = setup(t);
  for (const [harness, key, name] of [['opencode', 'XDG_CONFIG_HOME', 'AGENTS.md'], ['pi', 'PI_CODING_AGENT_DIR', 'CLAUDE.md']]) {
    const dir = path.join(h.base, `${harness}-config`);
    const file = path.join(dir, ...(harness === 'opencode' ? ['opencode'] : []), name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'CUSTOM-GLOBAL\n');
    h.ok(['ladder', 'set', 'small', '--harness', harness, '--model', 'stub', '--clear', 'profile', '--clear', 'effort', '--clear', 'args']);
    const dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: { ...env, [key]: dir } });
    assert.ok(dry.startup.rules.some((f) => f.path === file && f.scope === 'global' && f.loaded === 'read'));
    if (harness === 'pi') {
      h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { env: { ...env, [key]: dir } });
      const nested = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], {
        env: { ...env, HOME: dry.env.HOME, USERPROFILE: dry.env.HOME, [key]: dry.env.PI_CODING_AGENT_DIR },
      });
      assert.ok(nested.startup.rules.some((f) => f.path === file && f.scope === 'global' && f.loaded === 'read'));
      assert.ok(!nested.startup.rules.some((f) => f.path.startsWith(dry.home.path + path.sep)));
    }
  }
});

test('codex prefers AGENTS.override.md in each directory and receipts match what the stub loads', { skip: NO_STUBS }, (t) => {
  const { h, home, env, report } = setup(t);
  for (const dir of [path.join(home, '.codex'), h.base, h.repo]) fs.writeFileSync(path.join(dir, 'AGENTS.override.md'), 'OVERRIDE-RULES\n');
  h.git(['add', '.']);
  h.git(['commit', '-q', '-m', 'override']);
  rung(h, 'codex');
  const r = h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { env });
  const rules = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.cmd === 'startup').detail.rules;
  for (const [dir, loaded] of [[path.join(home, '.codex'), 'read'], [h.base, 'read'], [r.cwd, 'harness']]) {
    assert.ok(rules.some((f) => f.path === path.join(dir, 'AGENTS.override.md') && f.loaded === loaded), dir);
    assert.ok(!rules.some((f) => f.path === path.join(dir, 'AGENTS.md')), dir);
  }
  assert.deepEqual(report().projectDocs, ['OVERRIDE-RULES\n']);
});

test('claude imports rule paths with spaces and follows quoted and escaped nested imports', { skip: NO_STUBS }, (t) => {
  const { h, home, env, report } = setup(t);
  const dir = path.join(home, 'claude config');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '@"quoted rules.md"\n@escaped\\ rules.md\nGLOBAL-SPACES\n');
  fs.writeFileSync(path.join(dir, 'quoted rules.md'), 'QUOTED-SPACES\n');
  fs.writeFileSync(path.join(dir, 'escaped rules.md'), 'ESCAPED-SPACES\n');
  rung(h, 'claude');
  h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { env: { ...env, CLAUDE_CONFIG_DIR: dir } });
  const startup = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.cmd === 'startup').detail;
  for (const name of ['CLAUDE.md', 'quoted rules.md', 'escaped rules.md']) assert.ok(startup.rules.some((f) => f.path === path.join(dir, name) && f.loaded === 'harness'), name);
  for (const text of ['GLOBAL-SPACES', 'QUOTED-SPACES', 'ESCAPED-SPACES']) assert.ok(report().memory.join('\n').includes(text), text);
});

test('claude imports tab-bearing rule paths and its receipt matches the loaded memory', { skip: NO_STUBS || process.platform === 'win32' }, (t) => {
  const { h, home, env, report } = setup(t);
  const dir = path.join(home, 'claude\tconfig');
  fs.mkdirSync(dir);
  const global = path.join(dir, 'CLAUDE.md');
  const nested = path.join(dir, 'nested\trules.md');
  const shared = path.join(home, '.config', 'agents', 'tab\tshared.md');
  fs.writeFileSync(global, '@"nested\trules.md"\n@"~/.config/agents/tab\tshared.md"\nGLOBAL-TABS\n');
  fs.writeFileSync(nested, 'NESTED-TABS\n');
  fs.writeFileSync(shared, 'SHARED-TABS\n');
  rung(h, 'claude');
  h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { env: { ...env, CLAUDE_CONFIG_DIR: dir } });
  const receipt = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.cmd === 'startup').detail;
  const seen = report();
  for (const file of [global, nested, shared]) {
    assert.ok(receipt.rules.some((f) => f.path === file && f.loaded === 'harness'), file);
    assert.ok(seen.prompt.includes(`- ${file} (${file === global ? 'global' : 'import'}, loaded in your context)`), file);
  }
  for (const text of ['GLOBAL-TABS', 'NESTED-TABS', 'SHARED-TABS']) assert.ok(seen.memory.join('\n').includes(text), text);
});

test('claude receipts account for the generated home import when applying the five-hop limit', { skip: NO_STUBS }, (t) => {
  const { h, env, report } = setup(t);
  fs.writeFileSync(path.join(h.repo, 'CLAUDE.md'), '@docs/depth1.md\n');
  for (let depth = 1; depth <= 5; depth++) fs.writeFileSync(path.join(h.repo, 'docs', `depth${depth}.md`), `DEPTH-${depth}\n${depth < 5 ? `@depth${depth + 1}.md\n` : ''}`);
  h.git(['add', '.']);
  h.git(['commit', '-q', '-m', 'deep imports']);
  rung(h, 'claude');
  const r = h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { env });
  const rules = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.cmd === 'startup').detail.rules;
  const deepest = path.join(r.cwd, 'docs', 'depth5.md');
  assert.ok(rules.some((f) => f.path === deepest && f.loaded === 'read'));
  assert.ok(report().prompt.includes(`- ${deepest} (import, read it)`));
  assert.ok(report().memory.join('\n').includes('DEPTH-4'));
  assert.ok(!report().memory.join('\n').includes('DEPTH-5'));
});

test('claude marks a rule path that cannot fit on an import line for reading', { skip: NO_STUBS || process.platform === 'win32' }, (t) => {
  const { h, home, env, report } = setup(t);
  const dir = path.join(home, 'config\nnewline');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'READ-NEWLINE-RULE\n');
  rung(h, 'claude');
  h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { env: { ...env, CLAUDE_CONFIG_DIR: dir } });
  const file = path.join(dir, 'CLAUDE.md');
  const receipt = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.cmd === 'startup').detail;
  assert.ok(receipt.rules.some((f) => f.path === file && f.loaded === 'read'));
  assert.ok(report().prompt.includes(`- ${file} (global, read it)`));
  assert.ok(!report().memory.join('\n').includes('READ-NEWLINE-RULE'));
});

test('a command adapter that reads only {brief} gets the goal, the house rules and the acceptance in the brief file', (t) => {
  const { h, env } = setup(t);
  const out = path.join(h.base, 'brief-seen.txt');
  const script = 'require("node:fs").copyFileSync(process.argv[1], process.argv[2])';
  h.ok(['ladder', 'set', 'small', '--harness', 'command', '--clear', 'profile', '--clear', 'effort', '--clear', 'model', '--command', JSON.stringify([process.execPath, '-e', script, '{brief}', out])]);
  const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { env });
  assert.equal(r.code, 0, r.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /^## Goal\n[\s\S]*Project goal: prove the engine[\s\S]*## House rules[\s\S]*\nprobe\n[\s\S]*## Task/);
  assert.ok(text.includes(`- ${path.join(h.base, 'AGENTS.md')} (project, read it)`), 'the rules chain travels by path');
  assert.ok(text.includes('"the agent knows the goal"'), 'the acceptance travels with the brief');
});

test('a command adapter without an instruction placeholder is refused before startup', (t) => {
  const { h, env } = setup(t);
  const marker = path.join(h.base, 'adapter-started');
  const script = 'require("node:fs").writeFileSync(process.argv[1], "started")';
  h.ok(['ladder', 'set', 'small', '--harness', 'command', '--clear', 'profile', '--clear', 'effort', '--clear', 'model', '--command', JSON.stringify([process.execPath, '-e', script, marker])]);
  for (const mode of ['--dry-run', '--wait']) {
    const r = h.run(['spawn', '--role', 'small', '--task', 'T1', mode], { env });
    assert.notEqual(r.code, 0, mode);
    assert.match(r.stderr, /command.*\{prompt\}.*\{brief\}.*house rules/, mode);
  }
  assert.ok(!fs.existsSync(marker), 'the adapter never starts');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(!events.some((e) => e.cmd === 'startup' || e.cmd === 'spawn'), 'no receipt claims the rules were delivered');
});

// The fixture brief names a directory and a file; the diff touches those, a test, the
// changelog and two files the task never named.
function scoped(t, brief) {
  const { h } = setup(t, brief);
  h.ok(['claim', 'T1', '--agent', 'builder']);
  const wt = h.json(['worktree', 'T1']).path;
  for (const [f, text] of [['lib/a.js', 'a'], ['docs/guide.md', 'g'], ['test/a.test.js', 't'], ['CHANGELOG.md', 'c'], ['other/b.js', 'b'], ['README.md', 'changed']]) {
    fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
    fs.writeFileSync(path.join(wt, f), text);
  }
  h.git(['add', '.'], wt);
  h.git(['commit', '-q', '-m', 'work'], wt);
  return { h, sha: h.git(['rev-parse', 'HEAD'], wt), wt };
}

test('the scope gate flags submitted changes outside the paths the brief and acceptance name', (t) => {
  const { h, sha, wt } = scoped(t, 'Change `lib/` and docs/guide.md; see and/or AGENTS.md/CLAUDE.md for context.\n');
  const r = h.run(['submit', 'T1', '--sha', sha, '--agent', 'builder'], { cwd: wt });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /scope: 2 changed files outside the paths the brief and acceptance name \(lib\/, docs\/guide\.md\): README\.md, other\/b\.js/);
  const event = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).findLast((e) => e.cmd === 'submit');
  assert.deepEqual(event.detail.scope, { basis: 'named', named: ['lib/', 'docs/guide.md'], outside: ['README.md', 'other/b.js'] });
  const task = h.readState('tasks.json').tasks[0];
  assert.ok(task.notes.some((n) => n.text.startsWith('scope: 2 changed files outside')), 'the orchestrator sees it in the task notes');
});

test('quoted commands scope the paths inside them', (t) => {
  const { h, sha, wt } = scoped(t, 'Fix `node lib/a.js`.\n');
  for (const brief of ['Fix `node lib/a.js`.\n', 'Fix "node lib/a.js".\n', "Fix 'node lib/a.js'.\n", 'Fix `lib/a.js --flag`.\n']) {
    h.ok(['brief', 'set', 'T1', '-'], { input: brief });
    const r = h.json(['submit', 'T1', '--sha', sha, '--agent', 'builder'], { cwd: wt });
    assert.deepEqual(r.scope, { basis: 'named', named: ['lib/a.js'], outside: ['README.md', 'docs/guide.md', 'other/b.js'] }, brief);
  }
  fs.writeFileSync(path.join(wt, 'lib', 'file with spaces.js'), 'space path\n');
  h.git(['add', '.'], wt);
  h.git(['commit', '-q', '-m', 'space path'], wt);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Fix "lib/file with spaces.js".\n' });
  const r = h.json(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD'], wt), '--agent', 'builder'], { cwd: wt });
  assert.deepEqual(r.scope, { basis: 'named', named: ['lib/file with spaces.js'], outside: ['README.md', 'docs/guide.md', 'lib/a.js', 'other/b.js'] });
});

test('a brief naming a checkout or registered worktree root scopes the whole repository', (t) => {
  const { h, sha, wt } = scoped(t, 'probe\n');
  for (const root of [h.repo, wt]) {
    h.ok(['brief', 'set', 'T1', '-'], { input: `Change "${root}".\n` });
    const r = h.json(['submit', 'T1', '--sha', sha, '--agent', 'builder'], { cwd: wt });
    assert.deepEqual(r.scope, { basis: 'named', named: ['./'], outside: [] }, root);
  }
});

test('a task that names no repository path is scoped to the whole repository', (t) => {
  const { h, sha, wt } = scoped(t, 'Make it better.\n');
  const out = h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder'], { cwd: wt });
  assert.match(out, /scope: the brief and acceptance name no repository path; the whole repository is in scope/);
  assert.ok(!h.readState('tasks.json').tasks[0].notes.some((n) => n.text.startsWith('scope:')));
});

test('absolute paths in a brief scope the main checkout and a worktree with spaces', (t) => {
  const { h, sha, wt: original } = scoped(t, 'probe\n');
  const wt = path.join(h.base, 'worktree with spaces');
  h.git(['worktree', 'move', original, wt]);
  h.ok(['brief', 'set', 'T1', '-'], { input: `Change "${path.join(wt, 'lib')}/" and ${path.join(h.repo, 'docs', 'guide.md')}.\n` });
  const r = h.json(['submit', 'T1', '--sha', sha, '--agent', 'builder'], { cwd: wt });
  assert.deepEqual(r.scope, { basis: 'named', named: ['lib/', 'docs/guide.md'], outside: ['README.md', 'other/b.js'] });
});

test('scope uses the current origin merge base when the local base is stale', (t) => {
  const { h, wt } = scoped(t, 'Change lib/.\n');
  h.git(['checkout', '-q', '-b', 'advance'], h.repo);
  fs.writeFileSync(path.join(h.repo, 'main-only.md'), 'base change\n');
  h.git(['add', '.']);
  h.git(['commit', '-q', '-m', 'advance base']);
  h.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  h.git(['merge', '--no-ff', '-m', 'merge current base', 'origin/main'], wt);
  const sha = h.git(['rev-parse', 'HEAD'], wt);
  const r = h.json(['submit', 'T1', '--sha', sha, '--agent', 'builder'], { cwd: wt });
  assert.ok(!r.scope.outside.includes('main-only.md'), 'changes only from main are never flagged');
  assert.deepEqual(r.scope.outside, ['README.md', 'docs/guide.md', 'other/b.js']);
});
