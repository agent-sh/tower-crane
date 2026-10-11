'use strict';

const { waitOnRepo } = require('./signals');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, cachedFixture, BIN } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const { waitFor } = require('./canary');
const { shellQuote } = require('../lib/gates/common');

const ghStub = path.join(__dirname, 'fixtures', 'automation-gh.js');
const harness = path.join(__dirname, 'fixtures', 'automation-harness.js');

function setup(t, { kind = 'code', ci = 'success', repo } = {}) {
  const h = repo || makeRepo(t);
  h.sha = gateFixture(h);
  h.init(['--repo', 'acme/demo', '--base', 'main']);
  const tools = path.join(h.base, 'tools');
  fs.writeFileSync(path.join(tools, 'gh'), `#!/usr/bin/env node\nrequire(${JSON.stringify(ghStub)});\n`);
  fs.chmodSync(path.join(tools, 'gh'), 0o755);
  delete h.env.NODE_OPTIONS;
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(tools, 'gh.cmd'), `@"${process.execPath}" "${ghStub}" %*\r\n`);
    const preload = path.join(h.base, 'offline-gh.js');
    // Windows cannot spawn a .cmd directly. Resolve PATH first so agent
    // policy shims still run before the offline GitHub executable.
    fs.writeFileSync(preload, `const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),run=cp.spawnSync;
cp.spawnSync=(cmd,args,opts)=>{
  if(cmd!=='gh')return run(cmd,args,opts);
  const env=opts?.env||process.env;
  for(const dir of String(env.PATH||env.Path||'').split(path.delimiter)){
    for(const ext of ['.exe','.cmd','.bat']){
      const file=path.join(dir,cmd+ext);
      if(!fs.existsSync(file))continue;
      if(ext==='.exe')return run(file,args,opts);
      const quoted=[file,...args].map(arg=>'"'+String(arg).replace(/"/g,'""')+'"').join(' ');
      return run(env.ComSpec||env.COMSPEC||'cmd.exe',['/d','/s','/c','"'+quoted+'"'],
        {...opts,windowsVerbatimArguments:true});
    }
  }
  return run(cmd,args,opts);
};\n`);
    h.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  }
  h.env.AUTOMATION_GITHUB = path.join(h.base, 'github.json');
  h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
  h.saveGithub = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(state));
  h.saveGithub({ root: h.repo, prs: { 7: {
    state: 'OPEN', headRefOid: h.sha, headRefName: 'fixture-change',
    headRepository: { nameWithOwner: 'acme/demo' }, url: 'https://github.com/acme/demo/pull/7',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefName: 'main',
  } }, ci: { [h.sha]: ci } });
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works', '--kind', kind]);
  h.ok(['brief', 'set', 'T1', '-'], { input: '# Change\n\nImplement the acceptance.\n' });
  h.submit = (id = 'T1', sha = h.sha, pr = '7') => {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', sha, '--pr', pr, '--agent', 'worker']);
  };
  h.consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return h;
}

function generatedSetup(t) {
  const h = cachedFixture(t, 'generated-conflicts', (repo) => {
    const h = setup(null, { repo });
    h.git(['switch', 'main']);
    fs.mkdirSync(path.join(h.repo, 'docs'));
    fs.writeFileSync(path.join(h.repo, 'left.txt'), 'base\n');
    fs.writeFileSync(path.join(h.repo, 'right.txt'), 'base\n');
    fs.writeFileSync(path.join(h.repo, 'package.json'), JSON.stringify({
      scripts: { 'docs:generate': 'node generate.js' },
      'tower-crane': { generated: {
        'docs/cli.md': { script: 'docs:generate', blocks: ['commands:Run'] },
        'generated.txt': 'docs:generate',
      } },
    }));
    fs.writeFileSync(path.join(h.repo, 'generate.js'), `const fs = require('node:fs');
const rows = fs.readFileSync('left.txt', 'utf8').trim() + ' / ' + fs.readFileSync('right.txt', 'utf8').trim();
const file = 'docs/cli.md';
const text = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, text.replace(/(<!-- commands:Run:start -->)[\\s\\S]*?(<!-- commands:Run:end -->)/, '$1\\n' + rows + '\\n$2'));
fs.writeFileSync('generated.txt', rows + '\\n');
`);
    const doc = (rows, intro = 'Hand-written intro.') => `${intro}\n\n<!-- commands:Run:start -->\n${rows}\n<!-- commands:Run:end -->\n`;
    fs.writeFileSync(path.join(h.repo, 'docs', 'cli.md'), doc('base / base'));
    fs.writeFileSync(path.join(h.repo, 'generated.txt'), 'base / base\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'declare generated outputs']);
    const declared = h.git(['rev-parse', 'HEAD']);
    h.git(['switch', 'fixture-change']);
    h.git(['merge', '--no-edit', declared]);
    fs.writeFileSync(path.join(h.repo, 'left.txt'), 'branch\n');
    fs.writeFileSync(path.join(h.repo, 'docs', 'cli.md'), doc('branch / base'));
    fs.writeFileSync(path.join(h.repo, 'generated.txt'), 'branch / base\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'branch generated rows']);
    const sha = h.git(['rev-parse', 'HEAD']);
    h.git(['switch', 'main']);
    fs.writeFileSync(path.join(h.repo, 'right.txt'), 'main\n');
    fs.writeFileSync(path.join(h.repo, 'docs', 'cli.md'), doc('base / main'));
    fs.writeFileSync(path.join(h.repo, 'generated.txt'), 'base / main\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'main generated rows']);
    const baseTip = h.git(['rev-parse', 'HEAD']);
    const remote = path.join(h.base, 'origin.git');
    h.git(['init', '--bare', remote]);
    h.git(['remote', 'add', 'origin', remote]);
    h.git(['push', 'origin', 'main', 'fixture-change']);
    h.git(['switch', 'fixture-change']);
    const state = h.github();
    state.remote = remote;
    state.ci = { [sha]: 'pending' };
    Object.assign(state.prs['7'], { headRefOid: sha, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    h.saveGithub(state);
    return { sha, baseTip, remote };
  });
  h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
  h.saveGithub = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(state));
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  h.consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  h.submit = () => {
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', h.sha, '--branch', 'fixture-change', '--pr', '7', '--agent', 'worker']);
  };
  return h;
}

test('generated mappings recognize only declared paths, including names shared with object properties', async () => {
  const G = require('../lib/generated-conflicts');
  for (const [pkg, names] of [
    [{}, []],
    [{ scripts: { generate: 'node generate.js' }, 'tower-crane': { generated: { 'docs/cli.md': 'generate' } } }, ['docs/cli.md']],
    [{ scripts: { generate: 'node generate.js' }, 'tower-crane': { generated: { constructor: 'generate', toString: 'generate' } } }, ['constructor', 'toString']],
  ]) {
    const config = await G.configuration({ exec: () => ({ status: 0, stdout: JSON.stringify(pkg) }) }, 'repo', 'base');
    assert.deepEqual(Object.keys(config), names);
    assert.equal(config.__proto__, undefined);
    for (const name of ['constructor', 'toString']) if (!names.includes(name)) assert.equal(config[name], undefined);
  }
});

test('generated-only conflicts merge, regenerate and push without rework or a worker', (t) => {
  const h = generatedSetup(t);
  h.submit();
  h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.notEqual(task.sha, h.sha, JSON.stringify(h.logs().filter((e) => e.cmd === 'automation')));
  assert.equal(h.git(['rev-parse', 'fixture-change']), task.sha);
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), task.sha);
  assert.equal(h.git(['rev-parse', `${task.sha}^1`]), h.sha);
  assert.equal(h.git(['rev-parse', `${task.sha}^2`]), h.baseTip);
  assert.match(fs.readFileSync(path.join(h.repo, 'docs', 'cli.md'), 'utf8'), /branch \/ main/);
  assert.equal(fs.readFileSync(path.join(h.repo, 'generated.txt'), 'utf8'), 'branch / main\n');
  assert.equal(h.git(['status', '--porcelain']), '');
  assert.equal(h.logs().filter((e) => e.cmd === 'rework' || e.cmd === 'spawn').length, 0);
  assert.ok(task.evidence.some((e) => e.type === 'tests' && e.ok && e.sha === h.sha), 'old evidence remains historical');
  assert.ok(task.evidence.some((e) => e.type === 'tests' && e.ok && e.sha === task.sha), 'gates rerun on the repaired head');
  assert.ok(h.logs().some((e) => e.cmd === 'generated merge' && e.detail.phase === 'pushed'));
});

test('a sole docs conflict regenerates every declared output of its script', (t) => {
  const h = generatedSetup(t);
  h.git(['switch', 'main']);
  fs.writeFileSync(path.join(h.repo, 'generated.txt'), 'branch / base\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'align other generated output']);
  h.git(['push', 'origin', 'main']);
  h.git(['switch', 'fixture-change']);
  h.submit();
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.notEqual(task.sha, h.sha);
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), task.sha);
  assert.equal(fs.readFileSync(path.join(h.repo, 'generated.txt'), 'utf8'), 'branch / main\n');
  const receipt = h.logs().find((e) => e.cmd === 'generated merge' && e.detail.phase === 'prepared');
  assert.deepEqual(receipt.detail.generated, ['docs/cli.md']);
  assert.equal(h.logs().some((e) => e.cmd === 'rework' || e.cmd === 'spawn'), false);
});

for (const partial of [false, true]) {
  test(`an add/add conflict in a declared ${partial ? 'partially' : 'wholly'} generated file ${partial ? 'keeps its hand-written conflict' : 'repairs without rework'}`, (t) => {
    const h = generatedSetup(t);
    const file = partial ? 'new-doc.md' : 'new-generated.txt';
    const content = (side) => partial
      ? `${side} intro.\n<!-- commands:Run:start -->\n${side} rows\n<!-- commands:Run:end -->\n`
      : `${side} output\n`;
    h.git(['switch', 'main']);
    const manifest = path.join(h.repo, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    pkg['tower-crane'].generated[file] = partial
      ? { script: 'docs:generate', blocks: ['commands:Run'] } : 'docs:generate';
    fs.writeFileSync(manifest, JSON.stringify(pkg));
    if (!partial) {
      fs.appendFileSync(path.join(h.repo, 'generate.js'), "fs.writeFileSync('new-generated.txt', rows + '\\n');\n");
      fs.writeFileSync(path.join(h.repo, 'docs', 'cli.md'),
        fs.readFileSync(path.join(h.repo, 'docs', 'cli.md'), 'utf8').replace('base / main', 'branch / base'));
      fs.writeFileSync(path.join(h.repo, 'generated.txt'), 'branch / base\n');
    }
    fs.writeFileSync(path.join(h.repo, file), content('main'));
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'main introduces generated output']);
    h.git(['push', 'origin', 'main']);
    h.git(['switch', 'fixture-change']);
    fs.writeFileSync(path.join(h.repo, file), content('branch'));
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'branch introduces generated output']);
    h.git(['push', 'origin', 'fixture-change']);
    h.sha = h.git(['rev-parse', 'HEAD']);
    const ancestor = h.git(['merge-base', 'main', 'fixture-change']);
    assert.equal(h.git(['ls-tree', ancestor, '--', file]), '', 'the conflict has no ancestor blob');
    const github = h.github();
    github.prs['7'].headRefOid = h.sha;
    h.saveGithub(github);
    h.submit();
    h.consume();
    const task = h.readState('tasks.json').tasks[0];
    if (partial) {
      assert.equal(task.status, 'rework');
      assert.equal(task.sha, h.sha);
      assert.equal(h.git(['diff', '--name-only', '--diff-filter=U']), file);
      const text = fs.readFileSync(path.join(h.repo, file), 'utf8');
      assert.match(text, /branch intro\./);
      assert.match(text, /main intro\./);
    } else {
      assert.equal(task.status, 'submitted');
      assert.notEqual(task.sha, h.sha);
      assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), task.sha);
      assert.equal(h.git(['rev-parse', `${task.sha}^1`]), h.sha);
      assert.equal(h.git(['rev-parse', `${task.sha}^2`]), h.git(['rev-parse', 'main']));
      assert.equal(fs.readFileSync(path.join(h.repo, file), 'utf8'), 'branch / main\n');
      assert.equal(h.git(['status', '--porcelain']), '');
      assert.equal(h.logs().some((e) => e.cmd === 'rework' || e.cmd === 'spawn'), false);
      const receipt = h.logs().find((e) => e.cmd === 'generated merge' && e.detail.phase === 'pushed');
      assert.deepEqual(receipt.detail.generated, [file]);
    }
  });
}

test('an accepted generated-only conflict returns to submitted with old review kept historical', (t) => {
  const h = generatedSetup(t);
  const github = h.github();
  Object.assign(github.prs['7'], { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  github.ci[h.sha] = 'success';
  h.saveGithub(github);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const accepted = h.readState('tasks.json').tasks[0];
  assert.equal(accepted.status, 'accepted');
  const conflicting = h.github();
  Object.assign(conflicting.prs['7'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  h.saveGithub(conflicting);
  h.consume();
  const repaired = h.readState('tasks.json').tasks[0];
  assert.equal(repaired.status, 'submitted');
  assert.notEqual(repaired.sha, h.sha);
  assert.equal(repaired.revision, accepted.revision);
  assert.equal(repaired.submitted_by, 'worker');
  assert.ok(repaired.evidence.some((e) => e.type === 'review' && e.sha === h.sha));
  assert.equal(repaired.evidence.some((e) => e.type === 'review' && e.sha === repaired.sha), false);
  assert.equal(h.logs().some((e) => e.cmd === 'rework'), false);
});

test('the queue defers real generated conflicts while GitHub still reports the accepted head clean', (t) => {
  const h = generatedSetup(t);
  const github = h.github();
  Object.assign(github.prs['7'], { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  github.ci[h.sha] = 'success';
  h.saveGithub(github);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  h.consume();
  const deferred = h.readState('tasks.json').tasks[0];
  assert.equal(deferred.status, 'accepted');
  assert.equal(deferred.sha, h.sha);
  assert.equal(h.git(['rev-parse', 'HEAD']), h.sha);
  assert.equal(h.git(['status', '--porcelain']), '');
  assert.equal(h.logs().some((e) => e.cmd === 'rework' || e.cmd === 'generated merge' || e.cmd === 'head check'), false);
  assert.equal(h.github().calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
  const confirmed = h.github();
  Object.assign(confirmed.prs['7'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  h.saveGithub(confirmed);
  h.consume();
  const repaired = h.readState('tasks.json').tasks[0];
  assert.equal(repaired.status, 'submitted');
  assert.notEqual(repaired.sha, h.sha);
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), repaired.sha);
  assert.equal(h.logs().some((e) => e.cmd === 'rework'), false);
});

for (const mergeable of ['MERGEABLE', 'UNKNOWN']) {
  test(`a post-merge sweep defers mixed generated conflicts with ${mergeable} mergeability until GitHub confirms them`, (t) => {
    const h = generatedSetup(t);
    h.git(['switch', 'main']);
    fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'main changes hand-written source']);
    h.git(['push', 'origin', 'main']);
    h.git(['switch', '-qc', 'independent-change']);
    fs.writeFileSync(path.join(h.repo, 'other.txt'), 'Independent change.\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'independent submitted change']);
    h.git(['push', 'origin', 'independent-change']);
    const other = h.git(['rev-parse', 'HEAD']);
    const github = h.github();
    Object.assign(github.prs['7'], { mergeable, mergeStateStatus: mergeable === 'UNKNOWN' ? 'UNKNOWN' : 'CLEAN' });
    github.prs['8'] = { ...github.prs['7'], headRefOid: other, headRefName: 'independent-change',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', url: 'https://github.com/acme/demo/pull/8' };
    github.ci[other] = 'success';
    github.advanceBase = true;
    h.saveGithub(github);
    h.submit();
    h.ok(['task', 'add', '--title', 'Independent', '--acceptance', 'works', '--kind', 'docs']);
    h.ok(['claim', 'T2', '--agent', 'other-worker']);
    h.ok(['submit', 'T2', '--sha', other, '--branch', 'independent-change', '--pr', '8', '--agent', 'other-worker']);
    for (const type of ['clean', 'ci']) h.ok(['check', type, 'T2', '--agent', 'orchestrator']);
    h.reviewer('T2', 'other-reviewer');
    h.ok(['evidence', 'T2', '--type', 'review', '--sha', other, '--ok', '--agent', 'other-reviewer']);
    h.ok(['accept', 'T2', '--agent', 'orchestrator']);
    h.consume();
    assert.equal(h.github().prs['8'].state, 'MERGED', 'the confirmed merge triggers the sweep');
    const deferred = h.readState('tasks.json').tasks[0];
    assert.equal(deferred.status, 'submitted');
    assert.equal(deferred.sha, h.sha);
    assert.equal(h.git(['rev-parse', 'fixture-change']), h.sha);
    assert.equal(h.git(['status', '--porcelain']), '');
    assert.equal(h.logs().some((e) => e.task === 'T1' && ['rework', 'generated merge'].includes(e.cmd)), false);
    const confirmed = h.github();
    Object.assign(confirmed.prs['7'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    h.saveGithub(confirmed);
    h.consume();
    assert.equal(h.readState('tasks.json').tasks[0].status, 'rework');
    const receipt = h.logs().find((e) => e.task === 'T1' && e.cmd === 'generated merge' && e.detail.phase === 'mixed');
    assert.ok(receipt, 'confirmation prepares the mixed merge');
    assert.deepEqual(receipt.detail.remaining, ['value.js']);
    assert.equal(h.git(['diff', '--name-only', '--diff-filter=U'], receipt.detail.path), 'value.js');
    assert.equal(fs.readFileSync(path.join(receipt.detail.path, 'generated.txt'), 'utf8'), 'branch / main\n');
  });
}

test('mixed conflicts keep a prepared merge with generated files staged and only hand-written files unresolved', (t) => {
  const h = generatedSetup(t);
  h.git(['switch', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'hand-written conflict']);
  h.git(['push', 'origin', 'main']);
  h.git(['switch', 'fixture-change']);
  h.submit();
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.equal(task.sha, h.sha);
  assert.equal(h.git(['diff', '--name-only', '--diff-filter=U']), 'value.js');
  assert.equal(h.git(['rev-parse', 'MERGE_HEAD']), h.git(['rev-parse', 'main']));
  assert.equal(fs.readFileSync(path.join(h.repo, 'generated.txt'), 'utf8'), 'branch / main\n');
  assert.match(task.notes.at(-1).text, /conflicts with main: value\.js\./);
  assert.match(task.notes.at(-1).text, /generated files are pre-resolved: docs\/cli\.md, generated\.txt/);
});

test('mixed binary outputs preserve the branch bytes when generation must wait for source resolution', (t) => {
  const h = generatedSetup(t);
  for (const [branch, bytes] of [['main', [0, 254, 67]], ['fixture-change', [0, 255, 66]]]) {
    h.git(['switch', branch]);
    fs.writeFileSync(path.join(h.repo, 'generated.txt'), Buffer.from(bytes));
    if (branch === 'main') {
      fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
      fs.writeFileSync(path.join(h.repo, 'generate.js'), 'process.exit(1);\n');
    }
    h.git(['add', '.']);
    h.git(['commit', '-qm', `binary output on ${branch}`]);
    h.git(['push', 'origin', branch]);
  }
  h.sha = h.git(['rev-parse', 'HEAD']);
  const github = h.github();
  github.prs['7'].headRefOid = h.sha;
  h.saveGithub(github);
  h.submit();
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'rework');
  assert.equal(h.git(['diff', '--name-only', '--diff-filter=U']), 'value.js');
  assert.equal(h.git(['rev-parse', ':generated.txt']), h.git(['rev-parse', `${h.sha}:generated.txt`]));
  assert.deepEqual(fs.readFileSync(path.join(h.repo, 'generated.txt')), Buffer.from([0, 255, 66]));
});

test('a hand-written conflict within a generated document still needs rework', (t) => {
  const h = generatedSetup(t);
  for (const [branch, intro] of [['main', 'Main intro.'], ['fixture-change', 'Branch intro.']]) {
    h.git(['switch', branch]);
    const file = path.join(h.repo, 'docs', 'cli.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Hand-written intro.', intro));
    h.git(['add', '.']);
    h.git(['commit', '-qm', `change intro on ${branch}`]);
    h.git(['push', 'origin', branch]);
  }
  h.sha = h.git(['rev-parse', 'HEAD']);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  h.saveGithub(state);
  h.submit();
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'rework');
  assert.equal(h.git(['diff', '--name-only', '--diff-filter=U']), 'docs/cli.md');
  const text = fs.readFileSync(path.join(h.repo, 'docs', 'cli.md'), 'utf8');
  assert.match(text, /<<<<<<< ours[\s\S]*Branch intro\.[\s\S]*Main intro\./);
  assert.match(text, /<!-- commands:Run:start -->\nbranch \/ main\n<!-- commands:Run:end -->/);
  assert.equal(fs.readFileSync(path.join(h.repo, 'generated.txt'), 'utf8'), 'branch / main\n');
});

test('dirty worktrees defer generated-file repair without losing work or requesting rework', (t) => {
  const h = generatedSetup(t);
  h.submit();
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Unsaved work.\n');
  const before = h.git(['status', '--porcelain']);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.equal(task.sha, h.sha);
  assert.equal(h.git(['rev-parse', 'HEAD']), h.sha);
  assert.equal(h.git(['status', '--porcelain']), before);
  assert.ok(h.logs().some((e) => e.cmd === 'automation' && /dirty worktree/.test(e.detail.error)));
});

test('a failing generator aborts a generated-only merge and retains the submission for retry', (t) => {
  const h = generatedSetup(t);
  h.git(['switch', 'main']);
  const file = path.join(h.repo, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.scripts['docs:generate'] = 'node -e "process.exit(1)"';
  fs.writeFileSync(file, JSON.stringify(pkg));
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'generator fails']);
  h.git(['push', 'origin', 'main']);
  h.git(['switch', 'fixture-change']);
  h.submit();
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  assert.equal(h.git(['rev-parse', 'HEAD']), h.sha);
  assert.equal(h.git(['status', '--porcelain']), '');
  assert.ok(h.logs().some((e) => e.cmd === 'automation' && /generation failed/.test(e.detail.error)));
  assert.equal(h.logs().some((e) => e.cmd === 'rework'), false);
});

test('failed generation restores modified source files and removes new files before retry', (t) => {
  const h = generatedSetup(t);
  h.git(['switch', 'main']);
  const script = path.join(h.repo, 'generate.js');
  fs.writeFileSync(script, "const fs=require('node:fs'); fs.writeFileSync('README.md','changed'); fs.writeFileSync('leftover.txt','new'); process.exit(1);\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'generator writes before failing']);
  h.git(['push', 'origin', 'main']);
  h.git(['switch', 'fixture-change']);
  h.submit();
  const before = fs.readFileSync(path.join(h.repo, 'README.md'), 'utf8');
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  assert.equal(h.git(['rev-parse', 'HEAD']), h.sha);
  assert.equal(h.git(['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(path.join(h.repo, 'README.md'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(h.repo, 'leftover.txt')), false);
  h.consume();
  assert.ok(h.logs().filter((e) => e.cmd === 'automation' && /generation failed/.test(e.detail.error)).length >= 2);
});

test('generation cannot commit edits to hand-written text outside declared blocks', (t) => {
  const h = generatedSetup(t);
  h.git(['switch', 'main']);
  fs.appendFileSync(path.join(h.repo, 'generate.js'), "fs.appendFileSync('docs/cli.md', 'Unexpected hand-written text.\\n');\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'generator changes hand-written text']);
  h.git(['push', 'origin', 'main']);
  h.git(['switch', 'fixture-change']);
  h.submit();
  const before = fs.readFileSync(path.join(h.repo, 'docs', 'cli.md'), 'utf8');
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  assert.equal(h.git(['rev-parse', 'HEAD']), h.sha);
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), h.sha);
  assert.equal(fs.readFileSync(path.join(h.repo, 'docs', 'cli.md'), 'utf8'), before);
  assert.equal(h.git(['status', '--porcelain']), '');
  assert.ok(h.logs().some((e) => e.cmd === 'automation' && /outside declared blocks/.test(e.detail.error)));
});

for (const mismatch of ['fork head', 'origin repository']) {
  test(`generated-file repair defers a mismatched ${mismatch} before changing or pushing the branch`, (t) => {
    const h = generatedSetup(t);
    const state = h.github();
    if (mismatch === 'fork head') state.prs['7'].headRepository.nameWithOwner = 'someone/fork';
    else state.pushRepository = 'other/repository';
    h.saveGithub(state);
    h.submit();
    h.consume();
    assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
    assert.equal(h.git(['rev-parse', 'HEAD']), h.sha);
    assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), h.sha);
    assert.equal(h.git(['status', '--porcelain']), '');
    assert.ok(h.logs().some((e) => e.cmd === 'automation' && /repository/.test(e.detail.error)));
    assert.equal(h.logs().some((e) => e.cmd === 'generated merge' || e.cmd === 'rework'), false);
  });
}

test('a failed generated-file push retries the prepared merge without a worker or another generation', (t) => {
  const h = generatedSetup(t);
  const hook = path.join(h.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  h.submit();
  h.consume();
  const before = h.readState('tasks.json').tasks[0];
  assert.equal(before.status, 'submitted');
  assert.equal(before.sha, h.sha);
  const prepared = h.logs().filter((e) => e.cmd === 'generated merge' && e.detail.phase === 'prepared');
  assert.equal(prepared.length, 1);
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), h.sha);
  fs.rmSync(hook);
  h.consume();
  const after = h.readState('tasks.json').tasks[0];
  assert.equal(after.status, 'submitted');
  assert.equal(after.sha, prepared[0].detail.sha);
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), after.sha);
  assert.equal(h.logs().filter((e) => e.cmd === 'generated merge' && e.detail.phase === 'prepared').length, 1);
  assert.equal(h.logs().some((e) => e.cmd === 'rework' || e.cmd === 'spawn'), false);
});

test('submission runs real software gates once through the existing waiter', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  assert.equal(h.consume().code, 2);
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true], ['ci', false]]);
  assert.ok(task.evidence.every((e) => e.commands.length && e.source === `check ${e.type}`));
  assert.equal(task.status, 'submitted');
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 3, 'duplicate event delivery runs no gate twice');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0, 'pending CI starts no model');
});

test('CI completion refreshes a pending or failed receipt at the exact head and merges after review', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.consume();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const bad = h.github();
  bad.ci[h.sha] = 'failure';
  h.saveGithub(bad);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  const good = h.github();
  good.ci[h.sha] = 'success';
  h.saveGithub(good);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'accepted');
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => e.ok), [false, false, true]);
  assert.equal(task.evidence.at(-1).type, 'merge');
  const calls = h.github().calls.filter((a) => a[0] === 'pr' && a[1] === 'merge');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('--match-head-commit') + 1], h.sha);
  assert.equal(h.run(['ci', 'completed', 'T1', '--sha', 'fffffff', '--agent', 'orchestrator']).code, 1);
  assert.equal(h.run(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'worker']).code, 1);
});

test('a passing gate reruns in the next reaction after its pinned command changes', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.ok(['check', 'tests', 'T1']);
  const runs = () => h.logs().filter((e) => e.cmd === 'check tests').length;
  const before = runs();
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(0)"']);
  h.consume();
  assert.equal(runs(), before + 1, 'the reaction reruns tests under the new command');
  const latest = h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest.gate_policy.tests_cmd, 'node -e "process.exit(0)"');
});

test('a passing gate reruns in the next reaction after its tests mode changes', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(0)"', '--tests-mode', 'run-only']);
  h.submit();
  h.ok(['check', 'tests', 'T1']);
  const runs = () => h.logs().filter((e) => e.cmd === 'check tests').length;
  const before = runs();
  h.ok(['project', 'set', '--tests-mode', 'none']);
  h.consume();
  assert.equal(runs(), before + 1, 'the reaction reruns tests under the new mode');
  const latest = h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest.tests_mode, 'none');
});

test('a failed gate at unchanged inputs waits for gates retry, which reruns it', (t) => {
  const h = setup(t, { ci: 'pending' });
  const marker = path.join(h.base, 'infra-failed-once');
  const script = path.join(h.base, 'flaky-tests.js');
  fs.writeFileSync(script, `const fs = require('node:fs');\nif (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);\nfs.writeFileSync(${JSON.stringify(marker)}, '');\nprocess.exit(1);\n`);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  const runs = () => h.logs().filter((e) => e.cmd === 'check tests').length;
  const latest = () => h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests').at(-1);
  h.consume();
  assert.equal(runs(), 1);
  assert.equal(latest().ok, false, 'the first run fails as infrastructure would');
  h.consume();
  assert.equal(runs(), 1, 'a failure at unchanged inputs is not retried without an explicit retry');
  assert.equal(h.run(['gates', 'retry', 'T1', '--agent', 'worker']).code, 1);
  assert.equal(runs(), 1);
  h.ok(['gates', 'retry', 'T1', '--agent', 'orchestrator']);
  assert.equal(runs(), 2);
  assert.equal(latest().ok, true, 'the retry at the same inputs passes');
});

test('gates retry exits nonzero while a retried gate still fails', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(1)"', '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  const latest = () => h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest().ok, false);
  const retry = h.run(['gates', 'retry', 'T1', '--agent', 'orchestrator']);
  assert.equal(retry.code, 1, `a retry that still fails must exit nonzero: ${retry.stdout}${retry.stderr}`);
  assert.match(retry.stdout, /tests/);
  assert.equal(latest().ok, false, 'the retry ran at the same inputs and still fails');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
});

test('an accepted task with green gates merges in the event reaction without an agent turn', (t) => {
  const h = setup(t);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const spawns = () => h.logs().filter((e) => e.cmd === 'spawn').length;
  const recorded = spawns();
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const notification = JSON.parse(h.ok(['wait', '--types', 'merged', '--timeout', '300', '--agent', 'orchestrator']));
  assert.equal(notification.type, 'merged', 'startup catches up accepted PRs and retains its automatic merge event');
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(spawns(), recorded);
  h.consume();
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 1);
});

test('a merge sends another conflicting PR to rework with real filenames and preserves its worktree', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.git(['switch', '-qc', 'other-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'conflicting change']);
  const other = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works', '--kind', 'docs']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefOid: other, headRefName: 'other-change' };
  github.advanceBase = true;
  h.saveGithub(github);
  h.submit('T2', other, '8');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const before = h.git(['status', '--porcelain']);
  h.consume();
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.match(fs.readFileSync(path.join(h.state, 'briefs', 'T2.md'), 'utf8'), /value\.js/);
  assert.equal(h.git(['status', '--porcelain']), before);
  assert.equal(h.git(['rev-parse', 'HEAD']), other);
  assert.equal(fs.readFileSync(path.join(h.repo, 'value.js'), 'utf8'), 'module.exports = 2;\n');
  assert.equal(h.git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
});

test('startup reconciles a newly conflicting PR after a merge happened without a waiter', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.consume();
  h.git(['switch', '-qc', 'other-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'other submitted change']);
  const other = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works', '--kind', 'docs']);
  const state = h.github();
  state.prs['8'] = { ...state.prs['7'], headRefOid: other, headRefName: 'other-change' };
  h.saveGithub(state);
  h.submit('T2', other, '8');
  h.consume();
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[1].status, 'submitted');
  const ci = h.logs().findLast((e) => e.cmd === 'check ci' && e.task === 'T2');
  assert.ok(h.logs().some((e) => e.cmd === 'automation' && e.detail.source === ci.id && e.detail.phase === 'done'));

  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const changed = h.github();
  changed.advanceBase = true;
  h.saveGithub(changed);
  h.ok(['merge', 'T1', '--agent', 'orchestrator']);
  const conflicting = h.github();
  conflicting.prs['8'].mergeable = 'CONFLICTING';
  conflicting.prs['8'].mergeStateStatus = 'DIRTY';
  h.saveGithub(conflicting);
  const before = h.git(['rev-parse', 'HEAD']);
  const event = JSON.parse(h.ok(['wait', '--types', 'rework', '--timeout', '300', '--agent', 'orchestrator']));
  assert.equal(event.task, 'T2');
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /value\.js/);
  assert.equal(h.git(['rev-parse', 'HEAD']), before);
});

test('a matching UNKNOWN head runs submission gates during the same wait', async (t) => {
  const h = setup(t);
  h.submit();
  const state = h.github();
  state.prs['7'].mergeable = state.prs['7'].mergeStateStatus = 'UNKNOWN';
  state.becomeMergeableAfterView = true;
  h.saveGithub(state);
  const result = await h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0.2', '--agent', 'orchestrator']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(result.code, 2, result.stderr);
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => ['tests', 'clean'].includes(e.type)).map((e) => [e.type, e.ok]),
    [['tests', true], ['clean', true]]);
  assert.equal(task.status, 'submitted');
  assert.equal(h.github().prs['7'].mergeable, 'MERGEABLE');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  const unknown = h.github();
  unknown.prs['7'].mergeable = unknown.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(unknown);
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted',
    'UNKNOWN still blocks acceptance even with earlier passing CI and independent review');
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('a submitted PR that GitHub reports UNKNOWN, then CONFLICTING, goes to rework before any suite runs', (t) => {
  const h = setup(t);
  h.git(['switch', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'main moves value']);
  h.submit();
  const github = h.github();
  Object.assign(github.prs['7'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', unknownViews: 1 });
  h.saveGithub(github);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.equal(h.logs().filter((e) => ['check tests', 'check clean'].includes(e.cmd)).length, 0, 'no suite or clean runs');
  assert.equal(h.github().calls.filter((a) => a[0] === 'pr' && a[1] === 'view').length, 2, 'the UNKNOWN read is retried once');
});

test('startup retains gate evidence when main moves and the submitted head stays mergeable', (t) => {
  const h = setup(t);
  h.submit();
  h.consume();
  const before = h.readState('tasks.json').tasks[0].evidence;
  h.git(['switch', 'main']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Independent base update.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-qm', 'advance main']);
  h.consume();
  const after = h.json(['task', 'show', 'T1']);
  assert.deepEqual(after.evidence, before);
  assert.ok(after.gates.gates.filter((g) => g.type !== 'review').every((g) => g.ok));
});

test('stale or unknown PR heads and missing review never merge', (t) => {
  const h = setup(t);
  h.submit();
  const state = h.github();
  state.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(state);
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 0);
  state.prs['7'].headRefOid = h.sha;
  state.prs['7'].mergeable = 'UNKNOWN';
  state.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(state);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  state.prs['7'].mergeable = 'MERGEABLE';
  state.prs['7'].mergeStateStatus = 'CLEAN';
  h.saveGithub(state);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted', 'green software gates still require independent review');
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('a completion webhook is only a hint, rejects another repository and ignores stale heads', (t) => {
  const h = setup(t, { kind: 'docs', ci: 'failure' });
  h.submit();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const payload = { repository: { full_name: 'acme/demo' }, action: 'completed',
    check_suite: { head_sha: h.sha, status: 'completed', conclusion: 'success' } };
  const deliver = () => h.run(['ci', 'webhook', '-', '--agent', 'orchestrator'], { input: JSON.stringify(payload) });
  assert.equal(deliver().code, 0);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).ok, false, 'GitHub failure wins over payload success');
  payload.repository.full_name = 'acme/other';
  assert.equal(deliver().code, 1);
  payload.repository.full_name = 'acme/demo';
  payload.check_suite.head_sha = 'a'.repeat(40);
  assert.deepEqual(JSON.parse(h.ok(['ci', 'webhook', '-', '--json', '--agent', 'orchestrator'],
    { input: JSON.stringify(payload) })).tasks, []);
  payload.check_suite.head_sha = h.sha;
  const state = h.github();
  state.ci[h.sha] = 'success';
  h.saveGithub(state);
  assert.equal(deliver().code, 0);
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('concurrent event consumers execute each submission gate only once', async (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const results = await Promise.all([
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']),
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']),
  ]);
  assert.ok(results.every((r) => r.code === 2), JSON.stringify(results));
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.map((e) => e.type), ['tests', 'clean', 'ci']);
});

// A slow stub suite records each run's start and end, so the log shows how
// many gate executors ran at once across every consumer process.
function slowSuite(h, { executors, crash = false, release = null } = {}) {
  const runs = path.join(h.base, 'suite-runs.log');
  const suite = path.join(h.base, 'tools', 'slow-suite.js');
  fs.writeFileSync(suite, `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(runs)}, '+\\n');
const crash = ${JSON.stringify(crash ? path.join(h.base, 'crashed') : null)};
if (crash && !fs.existsSync(crash)) {
  fs.writeFileSync(crash, '');
  const events = fs.readFileSync(${JSON.stringify(path.join(h.state, 'events.jsonl'))}, 'utf8').trim().split('\\n').map(JSON.parse);
  process.kill(events.findLast((e) => e.cmd === 'automation' && e.detail.phase === 'running').detail.pid, 'SIGKILL');
}
const finish = () => fs.appendFileSync(${JSON.stringify(runs)}, '-\\n');
const release = ${JSON.stringify(release)};
if (release) {
  const starts = fs.readFileSync(${JSON.stringify(runs)}, 'utf8').split('\\n').filter((m) => m === '+').length;
  fs.writeFileSync(${JSON.stringify(path.join(h.base, 'suite-started-'))} + starts, '');
  const watcher = fs.watch(require('node:path').dirname(release), check);
  function check() { if (fs.existsSync(release)) { watcher.close(); finish(); } }
  check();
} else {
  setTimeout(finish, 2500); // wait-allow: exercise overlapping gate completions with staggered commands
}
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    ...(executors ? ['--executors', String(executors)] : []), '--agent', 'orchestrator']);
  for (const id of ['T1', 'T2', 'T3']) {
    if (id !== 'T1') h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  return () => {
    let now = 0;
    let peak = 0;
    const marks = fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim().split('\n') : [];
    for (const mark of marks) peak = Math.max(peak, now += mark === '+' ? 1 : -1);
    return { starts: marks.filter((m) => m === '+').length, peak };
  };
}

test('gate executors across several watchers stay within gates.executors and queue the rest in order', async (t) => {
  const h = setup(t);
  const release = path.join(h.base, 'release-suite');
  const runs = slowSuite(h, { release });
  assert.match(h.ok(['project', 'show']), /gates\.executors: 2/);
  const watchers = [0, 1, 2].map(() =>
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']));
  try {
    assert.notEqual(await fileWritten(path.join(h.base, 'suite-started-2')), null, 'two executors start');
    // Keep both slots occupied until a watcher has queued the third submission.
    assert.equal(h.consume().code, 2);
    const queued = h.logs().filter((e) => e.cmd === 'automation queued' && e.detail.executors === 2);
    assert.ok(queued.some((e) => e.task === 'T3'), JSON.stringify(queued));
  } finally {
    fs.writeFileSync(release, '');
  }
  assert.notEqual(await fileWritten(path.join(h.base, 'suite-started-3')), null, 'the third executor starts');
  const results = await Promise.all(watchers);
  assert.ok(results.every((r) => r.code === 2), JSON.stringify(results));
  assert.deepEqual(runs(), { starts: 3, peak: 2 });
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.equal(started.at(-1), 'T3', 'the queued submission runs after a slot frees');
  for (const task of h.readState('tasks.json').tasks) {
    assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true]], task.id);
  }
});

test('a killed executor releases its gate executor slot', (t) => {
  const h = setup(t);
  const runs = slowSuite(h, { executors: 1, crash: true });
  assert.notEqual(h.consume().code, 2, 'the suite kills the first executor');
  h.consume();
  assert.equal(runs().starts, 4, 'the killed run is retried and the other two run');
  for (const task of h.readState('tasks.json').tasks) {
    assert.deepEqual(task.evidence.map((e) => e.type), ['tests', 'clean'], task.id);
  }
});

test('older queued work takes a freed executor slot before a newer arrival', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const suite = path.join(h.base, 'tools', 'stall-suite.js');
  // The first run holds the only slot until T2 is queued behind it, then
  // dies, leaving a free slot and T2 still waiting.
  fs.writeFileSync(suite, `const fs = require('node:fs');
const flag = ${JSON.stringify(path.join(h.base, 'stalled'))};
if (fs.existsSync(flag)) process.exit(0);
fs.writeFileSync(flag, '');
const read = () => fs.readFileSync(${JSON.stringify(events)}, 'utf8').trim().split('\\n').map(JSON.parse);
const until = Date.now() + 300000;
const poll = () => {
  const log = read();
  if (log.some((e) => e.cmd === 'automation queued' && e.task === 'T2') || Date.now() > until) {
    process.kill(log.findLast((e) => e.cmd === 'automation' && e.detail.phase === 'running').detail.pid, 'SIGKILL');
    process.exit(1);
  }
  setTimeout(poll, 50); // wait-allow: probe cadence only; the release signal and hung-test timeout bound this fixture
};
poll();
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    '--executors', '1', '--agent', 'orchestrator']);
  h.ok(['task', 'add', '--title', 'Change T2', '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['task', 'add', '--title', 'Change T3', '--acceptance', 'it works', '--kind', 'code']);
  for (const id of ['T1', 'T2']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.notEqual(await waitFor(path.join(h.base, 'stalled')), null, 'the first executor starts');
  h.consume();
  assert.notEqual((await holder).code, 2, 'the stalled executor is killed');
  assert.ok(h.logs().some((e) => e.cmd === 'automation queued' && e.task === 'T2' && e.detail.executors === 1));
  const offset = fs.statSync(events).size;
  h.ok(['claim', 'T3', '--agent', 'worker']);
  h.ok(['submit', 'T3', '--sha', h.sha, '--agent', 'worker']);
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started, ['T1', 'T1', 'T2', 'T3'], 'queued T1 and T2 run before the newer T3');
  for (const task of h.readState('tasks.json').tasks) {
    assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true]], task.id);
  }
});

// The first gate run holds the only executor until the test writes `release`;
// it writes `stalled` once it starts.
function holdSuite(h) {
  const suite = path.join(h.base, 'tools', 'hold-suite.js');
  const stalled = path.join(h.base, 'stalled');
  const release = path.join(h.base, 'release');
  fs.writeFileSync(suite, `const fs = require('node:fs');
if (fs.existsSync(${JSON.stringify(stalled)})) process.exit(0);
fs.writeFileSync(${JSON.stringify(stalled)}, '');
const poll = () => (fs.existsSync(${JSON.stringify(release)}) ? process.exit(0) : setTimeout(poll, 50)); // wait-allow: probe cadence only; the release signal and hung-test timeout bound this fixture
poll();
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    '--executors', '1', '--agent', 'orchestrator']);
  return { stalled, release };
}

test('gates prioritize runs the last queued task first; status and inbox show the gate queue', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  // The three tasks submitted after the held run queue behind it.
  const { stalled, release } = holdSuite(h);
  for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.notEqual(await waitFor(stalled), null, 'the first executor starts');
  const offset = fs.statSync(events).size;
  for (const id of ['T2', 'T3', 'T4']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'automation queued').map((e) => e.task), ['T2', 'T3', 'T4']);

  const refused = h.run(['gates', 'prioritize', 'T4', '--reason', 'gate fix first', '--agent', 'worker']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /operational/);
  // T1 holds the executor, so it has no queued work to move.
  const idle = h.run(['gates', 'prioritize', 'T1', '--reason', 'gate fix first', '--agent', 'orchestrator']);
  assert.notEqual(idle.code, 0);
  assert.match(idle.stderr, /no queued gate work/);
  assert.ok(!h.logs().some((e) => e.cmd === 'gates prioritize'), 'refused requests log nothing');

  h.ok(['gates', 'prioritize', 'T4', '--reason', 'T134 shrinks every later gate run', '--agent', 'orchestrator']);
  const event = h.logs().findLast((e) => e.cmd === 'gates prioritize');
  assert.deepEqual([event.task, event.detail.reason], ['T4', 'T134 shrinks every later gate run']);
  const text = h.ok(['status']);
  assert.match(text, /^gate running: T1$/m);
  assert.match(text, /^gate queue: T4 \(prioritized: T134 shrinks every later gate run\), T2, T3$/m);
  const queue = h.json(['status']).gate_queue;
  assert.deepEqual(queue.running, ['T1']);
  assert.deepEqual(queue.queued.map((q) => q.id), ['T4', 'T2', 'T3']);
  assert.equal(queue.queued[0].prioritized.reason, 'T134 shrinks every later gate run');
  assert.equal(queue.queued[1].prioritized, null);
  assert.deepEqual(h.json(['inbox', '--agent', 'orchestrator']).gate_queue, queue, 'inbox carries the same queue');
  assert.match(h.ok(['inbox', '--agent', 'orchestrator']), /^gate queue: T4 \(prioritized: T134 shrinks every later gate run\), T2, T3$/m);

  fs.writeFileSync(release, '');
  // A zero-timeout wait with no matching type exits 2 once its drain is done.
  assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started, ['T1', 'T4', 'T2', 'T3'], 'the prioritized T4 runs before T2 and T3, which keep their order');
  const changes = h.logs().filter(e => e.cmd === 'setting' && e.detail.settings['gates.priority']);
  assert.deepEqual(changes.map(e => e.detail), [{
    command: 'gates prioritize', actor: 'orchestrator', mode: 'cli',
    settings: { 'gates.priority': 'operational' },
  }], 'only the successful priority change writes a setting audit');
});

// Each gate run stalls until the test writes its `release-N` file, so the test
// can read status while run N is in progress.
function stepSuite(h, { executors = 1 } = {}) {
  const suite = path.join(h.base, 'tools', 'step-suite.js');
  fs.writeFileSync(suite, `const fs = require('node:fs');
const path = require('node:path');
const base = ${JSON.stringify(h.base)};
const counter = path.join(base, 'runs');
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
fs.writeFileSync(counter, String(n));
fs.writeFileSync(path.join(base, 'stalled-' + n), '');
const release = path.join(base, 'release-' + n);
const poll = () => (fs.existsSync(release) ? process.exit(0) : setTimeout(poll, 50)); // wait-allow: probe cadence only; the release signal and hung-test timeout bound this fixture
poll();
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    '--executors', String(executors), '--agent', 'orchestrator']);
  return (n) => ({ stalled: path.join(h.base, `stalled-${n}`), release: path.join(h.base, `release-${n}`) });
}

test('a request moves only the reactions queued when it was made', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const { stalled, release } = holdSuite(h);
  for (const id of ['T2', 'T3']) h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.notEqual(await waitFor(stalled), null, 'the first executor starts');
  const offset = fs.statSync(events).size;
  for (const id of ['T2', 'T3']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'automation queued').map((e) => e.task), ['T2', 'T3']);

  // T3's review is recorded, but no watcher has queued it when the request is made.
  h.reviewer('T3', 'reviewer', h.sha);
  const before = fs.statSync(events).size;
  h.ok(['evidence', 'T3', '--type', 'review', '--sha', h.sha, '--revision', h.revision('T3'), '--ok', '--agent', 'reviewer']);
  h.ok(['gates', 'prioritize', 'T3', '--reason', 'gate fix first', '--agent', 'orchestrator']);
  h.run(['wait', '--after', String(before), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'automation queued').map((e) => e.task), ['T2', 'T3', 'T3'],
    'the review queues after the request');

  fs.writeFileSync(release, '');
  assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started, ['T1', 'T3', 'T2', 'T3'],
    'the submission queued at the request runs first; the review queued after it keeps its place behind T2');
});

test('a reaction that is running is not queued: status and prioritize leave it out', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const run = stepSuite(h);
  for (const id of ['T2', 'T3']) h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.notEqual(await waitFor(run(1).stalled), null, 'the first executor starts');
  const offset = fs.statSync(events).size;
  for (const id of ['T2', 'T3']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);

  fs.writeFileSync(run(1).release, '');
  assert.notEqual(await waitFor(run(2).stalled), null, 'T2 takes the executor next');
  const text = h.ok(['status']);
  assert.match(text, /^gate running: T2$/m);
  assert.match(text, /^gate queue: T3$/m, 'T2 is running, so only T3 waits');
  const refused = h.run(['gates', 'prioritize', 'T2', '--reason', 'gate fix first', '--agent', 'orchestrator']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /no queued gate work/);

  fs.writeFileSync(run(2).release, '');
  assert.notEqual(await waitFor(run(3).stalled), null, 'T3 runs last');
  fs.writeFileSync(run(3).release, '');
  assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started, ['T1', 'T2', 'T3'], 'each task runs once, in submission order');
});

test('a follow-up queued behind a live reaction can be prioritized and runs first', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const { stalled, release } = holdSuite(h);
  h.ok(['task', 'add', '--title', 'Change T2', '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.notEqual(await waitFor(stalled), null, 'the first executor starts');
  const offset = fs.statSync(events).size;
  // T1 has a live reaction, so T2 and then T1's CI completion queue behind it.
  h.ok(['claim', 'T2', '--agent', 'worker']);
  h.ok(['submit', 'T2', '--sha', h.sha, '--agent', 'worker']);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.match(h.ok(['status']), /^gate queue: T2; blocked behind their running reactions: T1$/m, 'the follow-up waits behind the running reaction');

  h.ok(['gates', 'prioritize', 'T1', '--reason', 'CI follow-up first', '--agent', 'orchestrator']);
  const event = h.logs().findLast((e) => e.cmd === 'gates prioritize');
  assert.deepEqual([event.task, event.detail.reason], ['T1', 'CI follow-up first']);
  const text = h.ok(['status']);
  assert.match(text, /^gate running: T1$/m);
  assert.match(text, /^gate queue: T2; blocked behind their running reactions: T1 \(prioritized: CI follow-up first\)$/m);
  const queue = h.json(['status']).gate_queue;
  assert.deepEqual(queue.queued.map((q) => q.id), ['T2']);
  assert.deepEqual(queue.blocked.map((q) => q.id), ['T1']);

  fs.writeFileSync(release, '');
  assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started, ['T1', 'T1', 'T2'], 'the prioritized follow-up runs before T2');
});

test('status shows a blocked follow-up apart from the queue the next free executor takes', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  // Two executors hold T1 and T2, so T3 and T1's CI follow-up queue. T1's
  // follow-up waits for T1's own reaction, so T3 is the next work taken.
  const run = stepSuite(h, { executors: 2 });
  for (const id of ['T2', 'T3']) h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const first = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.notEqual(await waitFor(run(1).stalled), null, 'T1 takes the first executor');
  const offset = fs.statSync(events).size;
  h.ok(['claim', 'T2', '--agent', 'worker']);
  h.ok(['submit', 'T2', '--sha', h.sha, '--agent', 'worker']);
  const second = h.runAsync(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.notEqual(await waitFor(run(2).stalled), null, 'T2 takes the second executor');

  const queued = fs.statSync(events).size;
  h.ok(['claim', 'T3', '--agent', 'worker']);
  h.ok(['submit', 'T3', '--sha', h.sha, '--agent', 'worker']);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  h.run(['wait', '--after', String(queued), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.match(h.ok(['status']), /^gate running: T1, T2$/m);
  assert.match(h.ok(['status']), /^gate queue: T3; blocked behind their running reactions: T1$/m);

  h.ok(['gates', 'prioritize', 'T1', '--reason', 'CI follow-up first', '--agent', 'orchestrator']);
  assert.match(h.ok(['inbox', '--agent', 'orchestrator']), /^gate queue: T3; blocked behind their running reactions: T1 \(prioritized: CI follow-up first\)$/m);
  const queue = h.json(['status']).gate_queue;
  assert.deepEqual([queue.running, queue.queued.map((q) => q.id), queue.blocked.map((q) => q.id)], [['T1', 'T2'], ['T3'], ['T1']]);

  fs.writeFileSync(run(2).release, '');
  assert.notEqual(await waitFor(run(3).stalled), null, 'T3 takes the freed executor before the blocked follow-up');
  const started = () => h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started(), ['T1', 'T2', 'T3'], 'the blocked follow-up has not started');
  assert.match(h.ok(['status']), /^gate queue: none; blocked behind their running reactions: T1 \(prioritized: CI follow-up first\)$/m);

  fs.writeFileSync(run(1).release, '');
  fs.writeFileSync(run(3).release, '');
  assert.equal((await first).code, 2, 'the first executor drains its follow-up');
  assert.equal((await second).code, 2, 'the second executor finishes');
  assert.deepEqual(started(), ['T1', 'T2', 'T3', 'T1'], 'the prioritized follow-up runs after its own reaction and T3');
});

for (const reason of ['unknown mergeability', 'transport error']) {
  test(`startup retries ${reason} without a new lifecycle event`, (t) => {
    const h = setup(t, { kind: 'docs' });
    h.submit();
    h.reviewer('T1', 'reviewer');
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    const state = h.github();
    if (reason === 'transport error') state.failView = true;
    else state.prs['7'].mergeable = state.prs['7'].mergeStateStatus = 'UNKNOWN';
    h.saveGithub(state);
    h.consume();
    assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
    assert.equal(h.logs().findLast((e) => e.cmd === 'automation').detail.phase,
      reason === 'transport error' ? 'error' : 'deferred');
    const recovered = h.github();
    recovered.failView = false;
    recovered.prs['7'].mergeable = 'MERGEABLE';
    recovered.prs['7'].mergeStateStatus = 'CLEAN';
    h.saveGithub(recovered);
    h.ok(['wait', '--types', 'merged', '--timeout', '300', '--agent', 'orchestrator']);
    assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).type, 'merge');
    assert.equal(h.github().prs['7'].state, 'MERGED');
  });
}

test('startup confirms the accepted head after the executor dies between remote merge and receipt', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const crash = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'],
    { env: { AUTOMATION_CRASH_AFTER_MERGE: '1' } });
  assert.notEqual(crash.code, 0);
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge'), false);
  assert.equal(h.logs().findLast((e) => e.cmd === 'automation').detail.phase, 'running');
  h.ok(['wait', '--types', 'merged', '--timeout', '300', '--agent', 'orchestrator']);
  const receipt = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(receipt.type, 'merge');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.sha, h.sha);
  assert.equal(receipt.ref, h.sha);
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 1, 'confirmation does not repeat the remote merge');
});

test('a remotely merged different head produces failed merge evidence', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const state = h.github();
  state.prs['7'].state = 'MERGED';
  state.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(state);
  h.consume();
  const receipt = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(receipt.type, 'merge');
  assert.equal(receipt.ok, false);
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);
});

function configureHarness(h, { rules = false } = {}) {
  const home = path.join(h.base, 'home');
  fs.mkdirSync(home, { recursive: true });
  Object.assign(h.env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), XDG_CACHE_HOME: path.join(home, '.cache'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), npm_config_cache: path.join(home, 'npm'),
    GH_TOKEN: 'automation-fixture', STUB_RUN: '[]',
    AUTOMATION_CONTEXT_DIR: path.join(h.base, 'context'),
  });
  fs.mkdirSync(h.env.AUTOMATION_CONTEXT_DIR);
  if (rules) fs.writeFileSync(path.join(h.base, 'AGENTS.md'), 'Read the acceptance before changing code.\n');
  h.ok(['task', 'update', 'T1', '--tier', 'easy']);
  for (const rung of ['easy', 'review']) h.ok(['ladder', 'set', rung, '--harness', 'command', '--command',
    JSON.stringify([process.execPath, harness, BIN, 'auto', '{prompt}']),
    ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((f) => ['--clear', f])]);
}

function startupContexts(h, withRules) {
  const startups = h.logs().filter((e) => e.cmd === 'startup');
  assert.deepEqual(startups.map((e) => e.detail.role), ['worker', 'reviewer']);
  for (const { task, detail } of startups) {
    const report = JSON.parse(fs.readFileSync(path.join(h.env.AUTOMATION_CONTEXT_DIR, `${detail.agent}.json`), 'utf8'));
    assert.equal(report.harness, 'command');
    assert.equal(report.args[2], report.prompt, 'the shared stub records the delivered argument');
    assert.match(report.prompt, /^## Goal\n/);
    assert.ok(report.prompt.includes(`Project goal: ${detail.goal}`));
    const target = JSON.parse(/## Task\s+```json\n([\s\S]*?)\n```/.exec(report.prompt)[1]);
    assert.equal(target.id, task);
    assert.equal(target.title, detail.target.title);
    assert.equal(target.acceptance.length, detail.target.acceptance);
    assert.equal(detail.receives_prompt, true);
    assert.equal(detail.prompt_bytes, Buffer.byteLength(report.prompt));
    assert.equal(detail.prompt_tokens, Math.ceil(detail.prompt_bytes / 4));
    assert.equal(report.prompt.includes('## House rules'), detail.rules.length > 0);
    if (withRules) {
      assert.ok(detail.rules.some((r) => r.path === path.join(h.base, 'AGENTS.md') && r.loaded === 'read'));
      for (const rule of detail.rules) assert.ok(report.prompt.includes(rule.path));
    } else {
      // A temp root beneath another checkout can inherit that checkout's rules.
      assert.equal(detail.rules.some((rule) => rule.path === path.join(h.base, 'AGENTS.md')), false);
      for (const rule of detail.rules) assert.ok(report.prompt.includes(rule.path));
      assert.equal(detail.rules_bytes, detail.rules.reduce((bytes, rule) => bytes + rule.bytes, 0));
      assert.equal(detail.rules_tokens, Math.ceil(detail.rules_bytes / 4));
    }
  }
}

test('a worker identity cannot authorize reactions by passing the orchestrator name', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const result = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'],
    { env: { TOWER_CRANE_AGENT: 'worker', TOWER_CRANE_TASK: 'T1' } });
  assert.equal(result.code, 2);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
});

test('a worker that names its own identity cannot complete CI or run reactions as the orchestrator', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const worker = { env: { TOWER_CRANE_AGENT: 'worker-T1-1' } };
  const completed = h.run(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'worker-T1-1'], worker);
  assert.equal(completed.code, 1, completed.stderr);
  assert.match(completed.stderr, /ci completed is an orchestrator or owner command/);
  const waited = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'worker-T1-1'], worker);
  assert.equal(waited.code, 2, waited.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
  assert.equal(h.logs().filter((e) => e.cmd === 'ci completed').length, 0);
  h.consume();
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.map((e) => e.type), ['tests', 'clean', 'ci'],
    'the orchestrator still runs the reactions');
});

test('supervisor reactions pin unconfigured gates and bypass the real restrictive agent shims', async (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node test/value.test.js' } }));
  h.git(['add', 'package.json']);
  h.git(['commit', '-qm', 'detectable test command']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  h.saveGithub(state);
  h.ok(['project', 'set', '--tests-cmd', 'null', '--clean-cmd', 'null']);
  configureHarness(h);
  h.env.AUTOMATION_POLICY_PROBE = path.join(h.base, 'policy-probe.jsonl');
  h.ok(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  await waitOnRepo(h, () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok));
  const pins = h.logs().filter((e) => e.cmd === 'gates pin');
  assert.deepEqual(pins.map((e) => e.detail.key), ['tests_cmd', 'clean_cmd']);
  assert.ok(pins.every((e) => e.agent === 'orchestrator' && e.detail.authority === 'orchestrator'));
  const probes = fs.readFileSync(h.env.AUTOMATION_POLICY_PROBE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(probes.length, 2);
  assert.ok(probes.every((p) => p.denials.every((d) => d.status === 126 && /not allowed/.test(d.stderr))), JSON.stringify(probes));
  assert.ok(probes.every((p) => p.path.includes(path.join(h.state, 'homes'))));
  startupContexts(h, false);
});

test('a supervised worker submission runs gates and dispatches the offline reviewer after exit', async (t) => {
  const h = setup(t);
  configureHarness(h, { rules: true });
  const hold = path.join(h.base, 'worker-hold');
  const spawned = h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'],
    { env: { AUTOMATION_WORKER_HOLD: hold } });
  try {
    await waitOnRepo(h, () => fs.existsSync(hold));
    h.consume();
    assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 0,
      'a worker still running after submit blocks review dispatch');
  } finally {
    fs.writeFileSync(`${hold}.go`, '');
    assert.equal((await spawned).code, 0);
  }
  // Reviewer completion has its own CLI command deadline after worker exit.
  await waitOnRepo(h, () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok));
  const events = h.logs();
  const review = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const exit = events.findIndex((e) => e.cmd === 'spawn exit' && e.detail.role === 'worker');
  assert.ok(review > exit);
  const workerStartup = events.findIndex((e) => e.cmd === 'startup' && e.detail.role === 'worker');
  const worker = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'worker');
  const reviewStartup = events.findIndex((e) => e.cmd === 'startup' && e.detail.role === 'reviewer');
  assert.ok(workerStartup >= 0 && workerStartup < worker && worker < exit);
  assert.ok(reviewStartup > exit && reviewStartup < review);
  startupContexts(h, true);
  assert.equal(events.filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 1);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

// A second PR that touches other files, and a suite command that logs each
// run with PR #7's state at that moment.
function queueFixture(t) {
  const h = setup(t);
  h.git(['switch', '-qc', 'second-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'other.js'), 'module.exports = 2;\n');
  fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'test', 'other.test.js'), "require('node:assert/strict').equal(require('../other'), 2);\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'second change']);
  h.second = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.ok(['task', 'add', '--title', 'Second', '--acceptance', 'works']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefOid: h.second, headRefName: 'second-change' };
  github.ci[h.second] = 'success';
  h.saveGithub(github);
  h.suiteLog = path.join(h.base, 'suites.jsonl');
  const suite = path.join(h.base, 'suite.js');
  fs.writeFileSync(suite, `const fs = require('node:fs'), path = require('node:path');
const gh = JSON.parse(fs.readFileSync(${JSON.stringify(h.env.AUTOMATION_GITHUB)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(h.suiteLog)}, JSON.stringify({ pr7: gh.prs['7'].state }) + '\\n');
// A gate run that fails once, as gates did for tasks accepted before evidence.
const failOnce = ${JSON.stringify(path.join(h.base, 'fail-once'))};
if (fs.existsSync(failOnce)) { fs.rmSync(failOnce); process.exit(1); }
// One run moves main while it runs, as another merge landing would.
if (fs.existsSync(${JSON.stringify(path.join(h.base, 'move-main-once'))})) {
  fs.rmSync(${JSON.stringify(path.join(h.base, 'move-main-once'))});
  const git = (a) => require('node:child_process').execFileSync('git', ['-C', ${JSON.stringify(h.repo)}, ...a], { encoding: 'utf8' }).trim();
  git(['update-ref', 'refs/heads/main', git(['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'lands during the check'])]);
}
// Another CLI acting while the suite runs.
const during = ${JSON.stringify(path.join(h.base, 'during-check.js'))};
if (fs.existsSync(during)) {
  const script = during + '.ran';
  fs.renameSync(during, script);
  require(script);
}
for (const f of fs.readdirSync('test')) if (f.endsWith('.test.js')) require(path.resolve('test', f));
`);
  h.ok(['project', 'set', '--tests-cmd', `${shellQuote(process.execPath)} ${shellQuote(suite)}`]);
  h.suites = () => (fs.existsSync(h.suiteLog)
    ? fs.readFileSync(h.suiteLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  h.moveMain = (file = 'README.md', text = 'Independent base update.\n') => {
    h.git(['switch', '-q', 'main']);
    fs.appendFileSync(path.join(h.repo, file), text);
    h.git(['add', file]);
    h.git(['commit', '-qm', 'advance main']);
  };
  h.submit();
  h.submit('T2', h.second, '8');
  h.consume();
  for (const id of ['T1', 'T2']) {
    const gates = h.json(['task', 'show', id]).gates.gates;
    assert.ok(gates.filter((g) => g.type !== 'review').every((g) => g.ok), JSON.stringify(gates));
  }
  return h;
}

const headChecks = (h) => h.logs().filter((e) => e.cmd === 'head check');
// A merge settles earlier receipts into evidence files; the CLI reads them back.
const softwareEvidence = (h, id) => h.json(['task', 'show', id]).evidence
  .filter((e) => ['tests', 'clean', 'ci'].includes(e.type));

function acceptBoth(h) {
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.reviewer('T2', 'reviewer');
  h.ok(['evidence', 'T2', '--revision', h.revision('T2'), '--type', 'review', '--sha', h.second, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  h.ok(['accept', 'T2', '--agent', 'orchestrator']);
}

test('main moves: a mergeable PR keeps its evidence and merges after one head-of-line check', (t) => {
  const h = queueFixture(t);
  const before = softwareEvidence(h, 'T1');
  h.moveMain();
  const suites = h.suites().length;
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.deepEqual(softwareEvidence(h, 'T1'), before, 'a base move reruns no gate and resets no evidence');
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(h.suites().length - suites, 1);
  const checks = headChecks(h);
  assert.deepEqual(checks.map((e) => [e.task, e.detail.ok, e.detail.base_sha]), [['T1', true, h.git(['rev-parse', 'main'])]]);
  assert.ok(checks[0].detail.commands.some((c) => c.args.includes('merge')));
  h.consume();
  assert.equal(headChecks(h).length, 1, 'a repeated reaction does not run the suite again');
});

test('the head of the line that turns CONFLICTING goes to rework with its files and the next PR merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.moveMain('value.js', '');
  const github = h.github();
  github.prs['7'].mergeable = 'CONFLICTING';
  github.prs['7'].mergeStateStatus = 'DIRTY';
  h.saveGithub(github);
  h.consume();
  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(t1.status, 'rework');
  assert.match(t1.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.equal(h.github().prs['7'].state, 'OPEN');
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.deepEqual(headChecks(h).map((e) => e.task), ['T2']);
});

test('two queued PRs run exactly one full suite each at their turn and none before', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  h.moveMain();
  const suites = h.suites().length;
  const blocked = h.github();
  blocked.prs['7'].mergeable = blocked.prs['7'].mergeStateStatus = 'UNKNOWN';
  blocked.advanceBase = true;
  h.saveGithub(blocked);
  h.consume();
  assert.equal(h.suites().length, suites, 'nothing runs while the head of the line waits');
  assert.equal(headChecks(h).length, 0);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false, 'the second PR does not jump the line');
  const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.equal(stopped.detail.blocked.task, 'T1');
  assert.match(stopped.detail.blocked.reason, /mergeability of PR #7 is UNKNOWN/);

  const ready = h.github();
  ready.prs['7'].mergeable = 'MERGEABLE';
  ready.prs['7'].mergeStateStatus = 'CLEAN';
  h.saveGithub(ready);
  // The wait runs both suites in this process: 55s alone and 119s with the
  // whole file running in parallel, so a shorter timeout fails under load.
  h.ok(['wait', '--types', 'merged', '--task', 'T2', '--timeout', '300', '--agent', 'orchestrator']);
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['7', '8']);
  assert.deepEqual(h.suites().slice(suites), [{ pr7: 'OPEN' }, { pr7: 'MERGED' }],
    'T1 runs its suite before merging; T2 runs its suite only after T1 merged');
  assert.deepEqual(headChecks(h).map((e) => [e.task, e.detail.ok]), [['T1', true], ['T2', true]]);
  assert.equal(headChecks(h)[1].detail.base_sha, h.sha, 'T2 is checked against main after T1 landed');
});

test('a base that moves during the head check gets a new check before the merge', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  fs.writeFileSync(path.join(h.base, 'move-main-once'), '');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  const checks = headChecks(h);
  assert.equal(checks.length, 2, 'the check against the old base does not authorize the merge');
  assert.notEqual(checks[0].detail.base_sha, checks[1].detail.base_sha);
  assert.equal(checks[1].detail.base_sha, h.git(['rev-parse', 'main']));
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('a head replaced during its check is checked again at the new sha before the merge', (t) => {
  const h = queueFixture(t);
  h.git(['switch', '-q', 'fixture-change']);
  fs.writeFileSync(path.join(h.repo, 'NOTES.md'), 'Replacement head.\n');
  h.git(['add', 'NOTES.md']);
  h.git(['commit', '-qm', 'replacement head']);
  const replacement = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.moveMain();
  // Rework, resubmit and reaccept T1 at a new head while its suite runs.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const cp = require('node:child_process'), fs = require('node:fs');
const env = ${JSON.stringify(h.env)};
const cli = (...a) => cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, ...a], { cwd: ${JSON.stringify(h.repo)}, env, encoding: 'utf8' });
const file = env.AUTOMATION_GITHUB;
cli('rework', 'T1', '--reason', 'replace the head', '--agent', 'orchestrator');
const gh = JSON.parse(fs.readFileSync(file, 'utf8'));
gh.prs['7'].headRefOid = ${JSON.stringify(replacement)};
gh.ci[${JSON.stringify(replacement)}] = 'success';
fs.writeFileSync(file, JSON.stringify(gh));
cli('claim', 'T1', '--agent', 'worker');
cli('submit', 'T1', '--sha', ${JSON.stringify(replacement)}, '--pr', '7', '--agent', 'worker');
for (const gate of ['tests', 'clean', 'ci']) cli('check', gate, 'T1', '--agent', 'orchestrator');
const events = ${JSON.stringify(path.join(h.state, 'events.jsonl'))};
const revision = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(h.state, 'tasks.json'))}, 'utf8')).tasks.find((x) => x.id === 'T1').revision;
const at = new Date().toISOString();
fs.appendFileSync(events, [
  { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail: { agent: 'reviewer', role: 'reviewer', rung: 'review', sha: ${JSON.stringify(replacement)}, revision, pid: 999999, attempt: 1 } },
  { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T1', detail: { agent: 'reviewer', pid: 999999, attempt: 1, code: 0 } },
].map((e) => JSON.stringify(e) + '\\n').join(''));
cli('evidence', 'T1', '--type', 'review', '--sha', ${JSON.stringify(replacement)}, '--ok', '--agent', 'reviewer');
cli('accept', 'T1', '--agent', 'orchestrator');
`);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.equal(fs.existsSync(path.join(h.base, 'during-check.js.ran')), true, 'the replacement ran during the check');
  assert.deepEqual(headChecks(h).map((e) => [e.detail.sha, e.detail.ok]), [[h.sha, true], [replacement, true]],
    'the check of the old head does not authorize merging the new one');
  const merges = h.github().calls.filter((a) => a[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.equal(merges[0][merges[0].indexOf('--match-head-commit') + 1], replacement);
  const order = h.logs().filter((e) => e.cmd === 'head check' || e.cmd === 'merge').map((e) => e.cmd);
  assert.deepEqual(order, ['head check', 'head check', 'merge']);
});

test('a head that stops the line and then goes to rework lets the PR behind it merge', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  const blocked = h.github();
  blocked.prs['7'].mergeable = blocked.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(blocked);
  h.consume();
  assert.equal(h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done').detail.blocked.task, 'T1');
  assert.equal(h.github().prs['8'].state, 'OPEN');

  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.moveMain('value.js', '');
  const conflicting = h.github();
  conflicting.prs['7'].mergeable = 'CONFLICTING';
  conflicting.prs['7'].mergeStateStatus = 'DIRTY';
  h.saveGithub(conflicting);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(t1.status, 'rework');
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
});

test('a merged-head suite timeout stops the queue without reworking an accepted task', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  h.ok(['project', 'set', '--tests-timeout-min', '0.05', '--agent', 'orchestrator']);
  fs.appendFileSync(path.join(h.base, 'suite.js'), `
console.log('# Subtest: test/slow.test.js');
setInterval(() => {}, 1000);
`);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  const check = headChecks(h).at(-1).detail;
  assert.equal(check.ok, false);
  assert.equal(check.infrastructure_failure, true);
  assert.equal(check.timeout.minutes, 0.05);
  assert.deepEqual(check.timeout.running_files, ['test/slow.test.js']);
  assert.match(check.summary, /timed out after 0\.05 min/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);
  const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.match(stopped.detail.blocked.reason, /timed out after 0\.05 min/);
});

test('a head check that fails after its settings changed checks again under the current settings', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  const cmd = h.readState('project.json').gates.tests_cmd;
  // The suite fails, but only after another CLI replaced the tests command.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const cp = require('node:child_process');
cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, 'project', 'set', '--tests-cmd', ${JSON.stringify(`${cmd} again`)}, '--agent', 'orchestrator'],
  { cwd: ${JSON.stringify(h.repo)}, env: ${JSON.stringify(h.env)}, encoding: 'utf8' });
process.exitCode = 1;
`);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.equal(fs.existsSync(path.join(h.base, 'during-check.js.ran')), true, 'the settings changed during the check');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted', 'the stale failure sends nothing to rework');
  const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.match(stopped.detail.blocked.reason, /tests evidence command policy/, 'the line restarted on the current command');

  h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  h.consume();
  assert.deepEqual(headChecks(h).map((e) => [e.detail.command, e.detail.ok]), [[cmd, false], [`${cmd} again`, true]]);
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('an accepted PR that already merged without current evidence is confirmed and the PR behind it merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  // T1 is a legacy task: its tests evidence no longer passes and its PR
  // landed on GitHub before tower-crane recorded merge evidence.
  fs.writeFileSync(path.join(h.base, 'fail-once'), '');
  h.run(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false);
  const github = h.github();
  github.prs['7'].state = 'MERGED';
  github.prs['7'].mergeCommit = { oid: 'c'.repeat(40) };
  h.saveGithub(github);
  h.consume();
  const [t1, t2] = h.readState('tasks.json').tasks;
  const receipt = t1.evidence.at(-1);
  assert.deepEqual([receipt.type, receipt.ok, receipt.sha, receipt.ref], ['merge', true, h.sha, 'c'.repeat(40)]);
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8'], 'the landed PR is not merged again');
  assert.equal(h.logs().filter((e) => e.cmd === 'queue skipped').length, 0);
});

test('a head the queue cannot advance is reported once and the PR behind it merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  const github = h.github();
  github.prs['7'].state = 'MERGED';
  github.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(github);
  h.consume();
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.equal(h.readState('tasks.json').tasks[1].evidence.at(-1).type, 'merge');
  const done = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.equal(done.detail.blocked.task, 'T1');
  assert.deepEqual(done.detail.skipped.map((s) => s.task), ['T1']);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const skips = h.logs().filter((e) => e.cmd === 'queue skipped');
  assert.deepEqual(skips.map((e) => [e.task, e.detail.sha]), [['T1', h.sha]], 'a later pass does not report the same head again');
  assert.match(skips[0].detail.reason, /merged with head f+, not the accepted/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

for (const failure of ['failView', 'invalidView']) {
  test(`an unreadable queue head (${failure}) is skipped once and the ready PR behind it merges`, (t) => {
    const h = queueFixture(t);
    acceptBoth(h);
    const github = h.github();
    github.prs['7'][failure] = true;
    h.saveGithub(github);
    const offset = h.logs().length;

    h.ok(['ci', 'completed', 'T2', '--sha', h.second, '--agent', 'orchestrator']);
    assert.equal(h.github().prs['8'].state, 'MERGED');
    const [t1, t2] = h.readState('tasks.json').tasks;
    assert.equal(t1.status, 'accepted');
    assert.ok(!t1.evidence.some((e) => e.type === 'merge'));
    assert.equal(t2.evidence.at(-1).type, 'merge');
    assert.equal(t2.evidence.at(-1).ok, true);
    const done = h.logs().slice(offset).findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
    assert.equal(done.detail.blocked.task, 'T1');
    assert.deepEqual(done.detail.skipped.map((s) => s.task), ['T1']);

    // The confirmed merge event starts another pass while T1 is still unreadable.
    h.consume();
    const events = h.logs().slice(offset);
    assert.ok(events.filter((e) => e.cmd === 'merge queue' && e.detail.phase === 'done').length >= 2);
    assert.ok(!events.some((e) => e.cmd === 'merge queue' && e.detail.phase === 'error'));
    const skips = events.filter((e) => e.cmd === 'queue skipped');
    assert.deepEqual(skips.map((e) => [e.task, e.detail.sha, e.detail.revision]), [['T1', h.sha, t1.revision]]);
    assert.match(skips[0].detail.reason, failure === 'failView'
      ? /Could not resolve PullRequest number 7/ : /cannot read PR #7 mergeability/);
    assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8']);
  });
}

test('a concurrent CI completion retries a skipped head in the next drain pass', async (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  h.moveMain();
  const failed = h.github();
  failed.ci[h.sha] = 'failure';
  h.saveGithub(failed);
  assert.equal(h.run(['check', 'ci', 'T1', '--agent', 'orchestrator']).code, 1);
  const green = h.github();
  green.ci[h.sha] = 'success';
  h.saveGithub(green);

  const paused = path.join(h.base, 'queue-paused');
  const resume = path.join(h.base, 'queue-resume');
  // Hold T2's head check after T1 is skipped, until a second command
  // records T1's passing CI and requests another queue pass.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(paused)}, '');
const until = Date.now() + 300000;
const poll = () => {
  if (fs.existsSync(${JSON.stringify(resume)})) return;
  if (Date.now() > until) throw new Error('queue was not resumed');
  setTimeout(poll, 25); // wait-allow: probe cadence only; the release signal and hung-test timeout bound this fixture
};
poll();
`);
  const offset = h.logs().length;
  const first = h.runAsync(['ci', 'completed', 'T2', '--sha', h.second, '--agent', 'orchestrator']);
  let result;
  try {
    assert.notEqual(await waitFor(paused), null, 'T2 holds the queue after T1 is skipped');
    const skipped = h.logs().slice(offset).find((e) => e.cmd === 'queue skipped');
    assert.equal(skipped?.task, 'T1');
    assert.match(skipped.detail.reason, /ci: latest ci .* failed/);
    h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
    assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
    assert.ok(h.logs().slice(offset).some((e) => e.cmd === 'merge queue' && e.detail.phase === 'requested'));
  } finally {
    fs.writeFileSync(resume, '');
    result = await first;
  }
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8', '7'],
    'both commands finish with both PRs merged, without a later notification');
  for (const task of h.readState('tasks.json').tasks) {
    const receipt = task.evidence.findLast((e) => e.type === 'merge');
    assert.equal(receipt?.ok, true, task.id);
    assert.equal(receipt.sha, task.sha);
  }
  const events = h.logs().slice(offset);
  assert.equal(events.filter((e) => e.cmd === 'queue skipped').length, 1);
  const passes = events.filter((e) => e.cmd === 'merge queue');
  assert.equal(passes.filter((e) => e.detail.phase === 'running').length, 2);
  assert.equal(passes.at(-1).detail.phase, 'done');
  assert.equal(passes.at(-1).detail.blocked, null);
  assert.deepEqual(passes.at(-1).detail.skipped, []);
});
