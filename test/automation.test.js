'use strict';

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
  h.consume = () => {
    h.ok(['project', 'set', '--paused', 'manual generated conflict probe']);
    return h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  };
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
  h.ok(['task', 'note', 'T1', 'live orchestrator', '--agent', 'orchestrator'], { env: { CLAUDE_SESSION_ID: 'holder' } });
  const holder = h.readState('tasks.json').orchestrator_lease;
  h.consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'owner'],
    { env: { CLAUDE_SESSION_ID: 'engine-waiter' } });
  h.submit();
  assert.equal(h.consume().code, 2);
  assert.equal(h.readState('tasks.json').orchestrator_lease.session_id, holder.session_id, 'automation inherits the holder');
  assert.deepEqual(h.readState('tasks.json').orchestrator_lease, holder, 'background gates do not extend the session idle window');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true], ['ci', false]]);
  assert.ok(task.evidence.every((e) => e.commands.length && e.source === `check ${e.type}`));
  assert.equal(task.status, 'submitted');
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 3, 'duplicate event delivery runs no gate twice');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0, 'pending CI starts no model');
});

test('background reactions leave vacant, released, taken-over and expired leases available for handoff', (t) => {
  const h = setup(t, { ci: 'pending' });
  const lease = () => h.readState('tasks.json').orchestrator_lease ?? null;
  const holder = { env: { CLAUDE_SESSION_ID: 'holder' } };
  const acquire = () => h.ok(['task', 'note', 'T1', 'native session', '--agent', 'orchestrator'], holder);
  const react = (opts) => h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'owner'], opts);
  h.submit();
  react();
  assert.equal(lease(), null, 'a monitor cannot become the first orchestrator');
  acquire();
  const live = lease();
  react();
  assert.deepEqual(lease(), live, 'background work cannot renew the holder');
  h.ok(['orchestrator', 'release', '--agent', 'orchestrator'], holder);
  react();
  assert.equal(lease(), null, 'background work cannot undo release');
  acquire();
  h.ok(['orchestrator', 'takeover', '--agent', 'owner']);
  react();
  assert.equal(lease(), null, 'background work cannot undo takeover');
  acquire();
  const expired = lease();
  const env = {
    TOWER_CRANE_TEST_NOW: String(Date.parse(expired.heartbeat) + h.readState('project.json').limits.lease_minutes * 60000 + 1),
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(__dirname, 'fixtures', 'clock.js'))}`,
  };
  react({ env });
  assert.deepEqual(lease(), expired, 'background work cannot revive an idle session');
  h.ok(['task', 'note', 'T1', 'replacement session', '--agent', 'orchestrator'],
    { env: { ...env, CLAUDE_SESSION_ID: 'replacement' } });
  assert.notEqual(lease().session_id, expired.session_id);
});

test('CI completion refreshes a pending receipt at the exact head and merges after review', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.consume();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const bad = h.github();
  bad.ci[h.sha] = 'pending';
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

function reconciledFixture(t) {
  const h = cachedFixture(t, 'reconciled-submission', (repo) => {
    const h = setup(null, { repo });
    h.submit();
    h.consume();
    return { sha: h.sha };
  });
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  h.reconcile = () => h.run(['wait', '--types', 'never', '--timeout', '0.01', '--agent', 'orchestrator']);
  return h;
}

for (const reaction of ['submit', 'reconcile']) {
  test(`${reaction} reworks a resubmitted revision whose tests fail, before its missing gates run`, (t) => {
    const h = reconciledFixture(t);
    h.ok(['brief', 'set', 'T1', '-', '--agent', 'orchestrator'],
      { input: '# Change\n\nVerify the revised acceptance.\n' });
    h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(1)"', '--tests-mode', 'run-only']);
    h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.revision, 2);
    assert.ok(task.evidence.every((e) => e.revision === 1), 'only historical evidence survives resubmission');
    const checks = () => h.logs().filter((e) => e.cmd.startsWith('check '));
    const count = checks().length;
    if (reaction === 'reconcile') {
      // T155's submit reaction recorded a revision-2 tests failure, then
      // finished before clean and CI. Startup must settle that failure into rework.
      assert.equal(h.run(['check', 'tests', 'T1', '--agent', 'orchestrator']).code, 1);
      const source = h.logs().findLast((e) => e.cmd === 'submit').id;
      fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
        at: new Date().toISOString(), agent: 'orchestrator', cmd: 'automation', task: 'T1',
        detail: { source, phase: 'done' },
      }) + '\n');
      assert.equal(h.reconcile().code, 2);
    } else {
      assert.equal(h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0',
        '--agent', 'orchestrator']).code, 2);
    }
    assert.deepEqual(checks().slice(count).map((e) => [e.cmd, e.detail.ok, e.detail.revision]),
      [['check tests', false, 2]]);
    const after = h.json(['task', 'show', 'T1']);
    // Automation refills the free worker slot with the reworked task, so it may already be claimed again.
    assert.ok(h.logs().some((e) => e.cmd === 'rework' && e.task === 'T1'), 'a deterministic failure reworks before clean and ci run');
    assert.ok(['rework', 'in_progress'].includes(after.status), after.status);
    assert.equal(after.gates.gates.find((g) => g.type === 'tests').ok, false);
    h.reconcile();
    assert.equal(checks().length, count + 1, 'a reworked task runs no more gates');
  });
}

for (const obsolete of ['revision', 'sha']) {
  for (const reaction of ['submit', 'reconcile']) {
    test(`${reaction} runs software gates with only earlier ${obsolete} evidence`, (t) => {
      const h = reconciledFixture(t);
      // Keep an audited failure too: only a failure at the current revision
      // and head can wait for an explicit retry.
      h.env.FIXTURE_GATE_OK = '0';
      assert.equal(h.run(['check', 'clean', 'T1']).code, 1);
      delete h.env.FIXTURE_GATE_OK;
      const previous = h.json(['task', 'show', 'T1']);
      const checks = () => h.logs().filter((e) => e.cmd.startsWith('check '));
      const count = checks().length;
      let sha = h.sha;
      if (obsolete === 'revision') {
        h.ok(['brief', 'set', 'T1', '-', '--agent', 'orchestrator'],
          { input: '# Change\n\nVerify the revised acceptance.\n' });
      } else {
        fs.appendFileSync(path.join(h.repo, 'README.md'), 'Resubmitted change.\n');
        h.git(['add', 'README.md']);
        h.git(['commit', '-qm', 'resubmitted head']);
        sha = h.git(['rev-parse', 'HEAD']);
        const github = JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
        github.prs[7].headRefOid = sha;
        github.ci[sha] = 'success';
        fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(github));
      }
      h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
      const submitted = h.json(['task', 'show', 'T1']);
      assert.equal(submitted.revision, obsolete === 'revision' ? 2 : previous.revision);
      assert.deepEqual(submitted.evidence, previous.evidence, 'resubmission keeps historical receipts');
      assert.ok(submitted.gates.gates.filter((g) => g.type !== 'review').every((g) => !g.ok));
      if (reaction === 'reconcile') {
        // A completed submit reaction must not suppress startup reconciliation.
        const events = h.logs();
        const source = events.findLast((e) => e.cmd === 'submit').id;
        fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
          at: new Date().toISOString(), agent: 'orchestrator', cmd: 'automation', task: 'T1',
          detail: { source, phase: 'done' },
        }) + '\n');
        assert.deepEqual(h.json(['status']).gate_queue, { running: [], queued: [], blocked: [] });
        assert.equal(h.reconcile().code, 2);
      } else {
        assert.equal(h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0',
          '--agent', 'orchestrator']).code, 2);
      }
      assert.deepEqual(checks().slice(count).map((e) => [e.cmd, e.detail.ok, e.detail.sha, e.detail.revision]),
        ['tests', 'clean', 'ci'].map((type) => [`check ${type}`, true, sha, submitted.revision]));
      const after = h.json(['task', 'show', 'T1']);
      assert.ok(after.gates.gates.filter((g) => g.type !== 'review').every((g) => g.ok));
      assert.equal(after.status, 'submitted', 'software evidence does not replace independent review');
      h.reconcile();
      assert.equal(checks().length, count + 3, 'current receipts prevent duplicate runs');
    });
  }
}

for (const entries of ['absent', 'unaudited pass', 'unaudited failure']) {
  test(`startup reconciles missing software evidence with ${entries} entries and an empty queue`, (t) => {
    const h = reconciledFixture(t);
    const tasks = h.readState('tasks.json');
    const task = tasks.tasks[0];
    if (entries === 'absent') task.evidence = [];
    else for (const entry of task.evidence) entry.ok = entries === 'unaudited pass';
    fs.writeFileSync(path.join(h.state, 'tasks.json'), JSON.stringify(tasks));
    const events = h.logs().filter((e) => !['check tests', 'check clean', 'check ci'].includes(e.cmd));
    fs.writeFileSync(path.join(h.state, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
    const before = h.json(['task', 'show', 'T1']);
    assert.ok(before.gates.gates.filter((g) => g.type !== 'review').every((g) => !g.ok));
    assert.deepEqual(h.json(['status']).gate_queue, { running: [], queued: [], blocked: [] });
    assert.ok(events.some((e) => e.cmd === 'automation' && e.detail.phase === 'done'));

    assert.equal(h.reconcile().code, 2);
    const checks = h.logs().filter((e) => e.cmd.startsWith('check '));
    assert.deepEqual(checks.map((e) => [e.cmd, e.detail.ok, e.detail.sha, e.detail.revision]),
      ['tests', 'clean', 'ci'].map((type) => [`check ${type}`, true, h.sha, task.revision]));
    const after = h.json(['task', 'show', 'T1']);
    assert.ok(after.gates.gates.filter((g) => g.type !== 'review').every((g) => g.ok));
    assert.equal(after.status, 'submitted', 'software evidence does not replace independent review');
    h.reconcile();
    assert.equal(h.logs().filter((e) => e.cmd.startsWith('check ')).length, 3, 'valid receipts prevent duplicate runs');
  });
}

test('startup reconciles tests evidence staled by a tests keep setting change after a completed reaction', (t) => {
  const h = reconciledFixture(t);
  const checks = () => h.logs().filter((e) => e.cmd.startsWith('check '));
  const before = checks();
  assert.deepEqual(h.json(['status']).gate_queue, { running: [], queued: [], blocked: [] });
  h.ok(['project', 'set', '--tests-keep', '["test/**","docs/**"]']);
  const stale = h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests');
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /tests evidence no longer matches/);
  assert.equal(h.reconcile().code, 2);
  const added = checks().slice(before.length);
  assert.deepEqual(added.map((e) => [e.cmd, e.detail.ok]), [['check tests', true]]);
  assert.deepEqual(added[0].detail.gate_policy.keep, ['test/**', 'docs/**']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, true);
});

test('a deterministic test failure reworks with its failing test names and output tail', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'failing-tests.js');
  // Fails only at the submitted head: the base holds value.js at 0, so the same test passes there.
  fs.writeFileSync(script, "const fs = require('node:fs');\nif (!fs.readFileSync('value.js', 'utf8').includes('1')) process.exit(0);\nconsole.log('# Subtest: test/sum.test.js');\nconsole.log('not ok 1 - sums two numbers');\nconsole.log('  expected 3 got 4');\nprocess.exit(1);\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  const runs = h.logs().filter((e) => e.cmd === 'check tests');
  assert.equal(runs.length, 1, 'a failure that is not infrastructure is not retried');
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  const latest = task.evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest.ok, false);
  assert.deepEqual(latest.test_failure.names, ['sums two numbers']);
  const reason = h.logs().findLast((e) => e.cmd === 'rework').detail.reason;
  assert.match(reason, /^tests failed at [0-9a-f]{7,}: /);
  assert.match(reason, /Failing tests:\n- sums two numbers/);
  assert.match(reason, /expected 3 got 4/);
  assert.equal(latest.main_failure, undefined, 'a failure that passes on main is the change\'s');
});

test('a timed-out test run retries once at its head and the passing retry keeps the task submitted', (t) => {
  const h = setup(t, { ci: 'pending' });
  const marker = path.join(h.base, 'timed-out-once');
  const script = path.join(h.base, 'slow-once.js');
  fs.writeFileSync(script, `const fs = require('node:fs');\nif (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);\nfs.writeFileSync(${JSON.stringify(marker)}, '');\nsetTimeout(() => {}, 10000);\n`);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only', '--tests-timeout-min', '0.05']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'the timeout runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => [e.ok, e.infrastructure_failure === true]),
    [[false, true], [true, false]]);
  assert.equal(task.status, 'submitted');
});

test('a timeout that repeats at its head reworks after the retry', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'hang.js');
  fs.writeFileSync(script, 'setTimeout(() => {}, 10000);\n');
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only', '--tests-timeout-min', '0.05']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /timed out after 0\.05 min/);
});

test('a test run killed by a signal retries once and reworks when the retry is also killed', { skip: process.platform === 'win32' }, (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'killed.js');
  fs.writeFileSync(script, 'process.kill(process.pid, \'SIGKILL\');\n');
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2);
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => e.runner_crash === true), [true, true]);
  assert.equal(task.status, 'rework');
});

test('a test command that is not installed stays submitted, and the inbox asks the orchestrator to pin one', (t) => {
  const h = setup(t, { ci: 'success' });
  h.ok(['project', 'set', '--tests-cmd', 'tower-crane-no-such-tool', '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 1, 'a missing command is not retried');
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.equal(task.evidence.filter((e) => e.type === 'tests').at(-1).ok, false);
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 0);
  assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', false], ['clean', true], ['ci', true]]);
  const items = h.json(['inbox', '--agent', 'orchestrator']).items.filter((i) => i.kind === 'gate_config');
  assert.deepEqual(items.map((i) => [i.task, i.gate, i.setting, i.addressed_to]), [['T1', 'tests', 'gates.tests_cmd', 'orchestrator']]);
  assert.deepEqual(items[0].action.argv.slice(0, 3), ['project', 'set', '--tests-cmd']);
  assert.equal(h.json(['inbox', '--agent', 'orchestrator']).items.some((i) => i.kind === 'gate_failed'), false, 'no failed-gate item for configuration');
});

for (const [configuration, failure] of [['tests', 'ci'], ['tests', 'clean'], ['clean', 'ci']]) {
  test(`a ${configuration} configuration failure does not hide an audited ${failure} failure`, (t) => {
    const h = setup(t, { ci: failure === 'ci' ? 'failure' : 'pending' });
    delete h.env.TOWER_CRANE_CLEAN_CMD;
    h.ok(['project', 'set', `--${configuration}-cmd`,
      configuration === 'tests' ? 'null' : 'tower-crane-no-such-cleaner']);
    if (failure === 'clean') {
      const script = path.join(h.base, 'incomplete-clean.js');
      fs.writeFileSync(script, "console.log(JSON.stringify({items: [], failedChecks: ['cannot scan changed source']}));\n");
      h.ok(['project', 'set', '--clean-cmd', `node ${shellQuote(script)}`]);
    }
    h.submit();
    h.ok(['project', 'set', '--paused', 'inspect gate settlement']);
    assert.equal(h.run(['check', failure, 'T1', '--agent', 'orchestrator']).code, 1);
    h.consume();
    const task = h.readState('tasks.json').tasks[0];
    assert.equal(task.status, 'rework');
    assert.deepEqual(task.evidence.filter((e) => e.type === configuration).at(-1).config_failure,
      { key: `${configuration}_cmd` });
    const receipts = task.evidence.filter((e) => e.type === failure);
    assert.equal(receipts.length, failure === 'clean' ? 2 : 1, 'cleanup retries once; the audited CI verdict reworks without rerunning');
    assert.ok(receipts.every((e) => !e.ok));
    if (failure === 'clean') assert.ok(receipts.every((e) => e.infrastructure_failure));
    else assert.equal(receipts[0].confirmed_failure, true);
    const reworks = h.logs().filter((e) => e.cmd === 'rework' && e.task === 'T1');
    assert.equal(reworks.length, 1);
    assert.match(reworks[0].detail.reason, new RegExp(`^${failure} failed at [0-9a-f]+: `));
    assert.match(reworks[0].detail.reason, failure === 'clean' ? /cannot scan changed source/ : /failing: test \(failure\)/);
    assert.deepEqual(h.json(['status']).gate_queue, { running: [], queued: [], blocked: [] });
    h.consume();
    assert.equal(h.logs().filter((e) => e.cmd === `check ${failure}`).length, receipts.length, 'settlement starts no extra gate runs');
  });
}

test('a missing pinned test command stays submitted with a gate_config item for the orchestrator, not a rework', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['project', 'set', '--tests-cmd', 'null']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 1);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').at(-1).config_failure, { key: 'tests_cmd' });
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 0);
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'gate_config');
  assert.equal(item.then, 'gates retry T1');
  assert.match(item.summary, /no test command pinned in project\.json gates\.tests_cmd/);
});

test('a proof run killed after the change is reverted retries once and reworks when the retry is also killed', { skip: process.platform === 'win32' }, (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'proof-killed.js');
  // Passes at the submitted head, where value.js is 1, and is killed once the change is reverted to 0.
  fs.writeFileSync(script, "const fs = require('node:fs');\nif (fs.readFileSync('value.js', 'utf8').includes('0')) process.kill(process.pid, 'SIGKILL');\n");
  h.ok(['project', 'set', '--tests-cmd', 'node test/value.test.js', '--tests-mode', 'prove', '--tests-expensive', 'true',
    '--tests-proof-cmd', `node ${shellQuote(script)} {tests}`]);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'the killed proof runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => [e.ok, e.runner_crash === true]), [[false, true], [false, true]]);
  assert.equal(task.status, 'rework');
});

test('a missing pinned proof command stays submitted with a gate_config item for the orchestrator, not a rework', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['project', 'set', '--tests-cmd', 'node test/value.test.js', '--tests-mode', 'prove', '--tests-expensive', 'true', '--tests-proof-cmd', 'null']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 1);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').at(-1).config_failure, { key: 'tests_proof_cmd' });
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 0);
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'gate_config');
  assert.equal(item.setting, 'gates.tests_proof_cmd');
  assert.equal(item.then, 'gates retry T1');
});

test('a change that adds no test reworks with the reason, and the worker adds a test', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.git(['switch', '-qc', 'no-test-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['commit', '-qam', 'change without a test']);
  const sha = h.git(['rev-parse', 'HEAD']);
  const github = h.github();
  Object.assign(github.prs['7'], { headRefOid: sha, headRefName: 'no-test-change' });
  h.saveGithub(github);
  h.submit('T1', sha);
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 1, 'a change with no test is not retried');
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.equal(task.evidence.filter((e) => e.type === 'tests').at(-1).worker_failure, true);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^tests failed at [0-9a-f]{7,}: no test covers this change: .*adds or changes no test file/);
});

test('a CI run that was cancelled retries once and reworks when it is cancelled again', (t) => {
  const h = setup(t, { ci: 'cancelled' });
  h.submit();
  h.consume();
  const checks = h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs'));
  assert.equal(checks.length, 2, 'a cancelled run is read once more and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => [e.ok, e.infrastructure_failure === true]),
    [[false, true], [false, true]]);
  // A refill may claim the reworked task before this read, so the rework event is the proof.
  assert.ok(h.logs().some((e) => e.cmd === 'rework' && e.task === 'T1'), 'the cancelled run reworks');
  assert.ok(['rework', 'in_progress'].includes(task.status), task.status);
});

test('a CI run that needs action sends a submitted task to rework at once, with its conclusion', (t) => {
  const h = setup(t, { ci: 'action_required' });
  h.submit();
  h.consume();
  assert.equal(h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs')).length, 1, 'a verdict on the change is not retried');
  const task = h.readState('tasks.json').tasks[0];
  // A refill may claim the reworked task before this read, so the rework event is the proof.
  assert.ok(h.logs().some((e) => e.cmd === 'rework' && e.task === 'T1'), 'the action-required run reworks');
  assert.ok(['rework', 'in_progress'].includes(task.status), task.status);
  assert.equal(task.evidence.filter((e) => e.type === 'ci').at(-1).worker_failure, true);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^ci failed at [0-9a-f]+: .*action_required/s);
});

test('a CI run that times out retries once and reworks when it times out again', (t) => {
  const h = setup(t, { ci: 'timed_out' });
  h.submit();
  h.consume();
  const checks = h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs'));
  assert.equal(checks.length, 2, 'the CI gate reads GitHub once more and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => [e.ok, e.infrastructure_failure === true]),
    [[false, true], [false, true]]);
  // A refill may claim the reworked task before this read, so the rework event is the proof.
  assert.ok(h.logs().some((e) => e.cmd === 'rework' && e.task === 'T1'), 'the timed-out run reworks');
  assert.ok(['rework', 'in_progress'].includes(task.status), task.status);
});

test('a failed CI run sends a submitted task to rework with the failing run', (t) => {
  const h = setup(t, { ci: 'failure' });
  h.submit();
  h.consume();
  assert.equal(h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs')).length, 1, 'a code failure is not retried');
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.equal(task.evidence.filter((e) => e.type === 'ci').at(-1).confirmed_failure, true);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^ci failed at [0-9a-f]+: .*failing: test \(failure\)/s);
});

test('a CI timeout after a pending check retries once: the pending receipt is not a failure', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.consume();
  const checkRuns = () => h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs')).length;
  const before = checkRuns();
  const timedOut = h.github();
  timedOut.ci[h.sha] = 'timed_out';
  h.saveGithub(timedOut);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(checkRuns() - before, 2, 'the first timeout reads CI once more before it reworks');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => [e.ok, e.infrastructure_failure === true]),
    [[false, false], [false, true], [false, true]]);
  assert.equal(task.status, 'rework');
});

test('a local CI command killed by a signal retries once and reworks when the retry is killed too', { skip: process.platform === 'win32' }, (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'local-killed.js');
  fs.writeFileSync(script, 'process.kill(process.pid, \'SIGKILL\');\n');
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, script], timeout: 5 })]);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, 2, 'the killed run runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => e.runner_crash === true), [true, true]);
  assert.equal(task.status, 'rework');
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^ci failed at [0-9a-f]+: local CI killed by SIGKILL/);
});

test('a local CI command that times out retries once and reworks when the retry times out too', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'local-hang.js');
  fs.writeFileSync(script, 'setTimeout(() => {}, 10000);\n');
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, script], timeout: 0.05 })]);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, 2, 'the timeout runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => e.infrastructure_failure === true), [true, true]);
  assert.equal(task.status, 'rework');
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^ci failed at [0-9a-f]+: local CI timed out/);
});

test('a test that also fails on main retries once, then reworks with the main failure to link', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'known-failure.js');
  fs.writeFileSync(script, "console.log('# Subtest: test/known.test.js');\nconsole.log('not ok 1 - known base failure');\nprocess.exit(1);\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'the failure that also fails on main runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => e.main_failure?.names), [['known base failure'], ['known base failure']]);
  assert.equal(task.status, 'rework');
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^tests failed at [0-9a-f]+: .*Also fails on main at [0-9a-f]+: known base failure/s);
});

test('a test gate that fails by hand while the watcher runs reworks, not left submitted', async (t) => {
  const h = setup(t, { ci: 'pending' });
  const flag = path.join(h.base, 'broken');
  const script = path.join(h.base, 'breaks-when-flagged.js');
  fs.writeFileSync(script, `const fs = require('node:fs');\nif (fs.existsSync(${JSON.stringify(flag)})) process.exit(1);\n`);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  const finished = () => h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'done').length;
  const before = finished();
  const offset = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  const watcher = h.runAsync(['wait', '--after', String(offset), '--types', 'never', '--timeout', '8', '--agent', 'orchestrator']);
  // The watcher's startup reconcile settles the submission first; the failure comes after it.
  for (let i = 0; i < 100 && finished() === before; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(finished() > before, 'the watcher reconciled the submitted task');
  fs.writeFileSync(flag, '');
  assert.equal(h.run(['check', 'tests', 'T1']).code, 1);
  assert.equal((await watcher).code, 2, 'the watcher runs to its deadline');
  const task = h.readState('tasks.json').tasks[0];
  // The refill may claim the reworked task again before the watcher exits, so the rework event is the proof.
  assert.ok(['rework', 'in_progress'].includes(task.status), `a failure recorded by a manual check reworks at once: ${task.status}`);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^tests failed at [0-9a-f]+: /);
});

test('a test that also fails on main reworks without a quality climb on a task with a tier range', async (t) => {
  const h = refillFixture(t);
  for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
  h.ok(['task', 'update', 'T1', '--tier', 'easy..medium']);
  const script = path.join(h.base, 'known-failure.js');
  fs.writeFileSync(script, "console.log('# Subtest: test/known.test.js');\nconsole.log('not ok 1 - known base failure');\nprocess.exit(1);\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'the failure that also fails on main runs once more');
  assert.notEqual(await waitFor(h.marker('T1')), null, 'the refill claims the reworked task');
  const task = h.readState('tasks.json').tasks[0];
  // The worker holds its claim so the test checks settlement after refill, without racing it.
  assert.equal(task.status, 'in_progress');
  assert.equal(task.claim.from, 'rework');
  assert.equal(task.revision, 2);
  const reworks = h.logs().filter((e) => e.cmd === 'rework' && e.task === 'T1');
  assert.equal(reworks.length, 1);
  assert.match(reworks[0].detail.reason, /^tests failed at [0-9a-f]+: .*Also fails on main at [0-9a-f]+: known base failure/s);
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => [e.main_failure?.names, e.confirmed_failure]),
    [[['known base failure'], undefined], [['known base failure'], undefined]]);
  assert.equal(task.tier, 'easy', 'a failure that also fails on main is not the change\'s, so it does not climb');
  assert.deepEqual(task.escalations ?? [], []);
});

test('a run with a failing name that does not fail on main keeps its verdict and reworks at once', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'partly-known.js');
  fs.writeFileSync(script, "const fs = require('node:fs');\nconsole.log('# Subtest: test/known.test.js');\nconsole.log('not ok 1 - known base failure');\nif (fs.readFileSync('value.js', 'utf8').includes('1')) console.log('not ok 2 - change breaks a test');\nprocess.exit(1);\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 1, 'a failure with a name the change added is not retried');
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  const latest = task.evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest.confirmed_failure, true);
  assert.equal(latest.main_failure, undefined, 'only a run whose every failing name also fails on main is not the change\'s');
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /change breaks a test/);
});

test('a test that fails on a newer origin main retries once though the local base is behind', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'fails-with-value.js');
  fs.writeFileSync(script, "const fs = require('node:fs');\nif (!fs.readFileSync('value.js', 'utf8').includes('1')) process.exit(0);\nconsole.log('# Subtest: test/sum.test.js');\nconsole.log('not ok 1 - sums two numbers');\nprocess.exit(1);\n");
  // origin/main moved past local main with the change's value, so the failure exists only on the newer base.
  const moved = h.git(['commit-tree', h.git(['rev-parse', 'fixture-change^{tree}']), '-p', 'main', '-m', 'main moved']);
  h.git(['update-ref', 'refs/remotes/origin/main', moved]);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'the failure that also fails on origin main runs once more');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => e.main_failure?.names), [['sums two numbers'], ['sums two numbers']]);
  assert.ok(['rework', 'in_progress'].includes(task.status), task.status);
  assert.ok(h.logs().some((e) => e.cmd === 'rework' && e.task === 'T1'), 'the second failure reworks');
});

test('gates retry exits nonzero while a retried gate still fails', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(1)"', '--tests-mode', 'run-only']);
  h.submit();
  h.run(['check', 'tests', 'T1']);
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
  const notification = JSON.parse(h.ok(['wait', '--types', 'merged', '--timeout', '5', '--agent', 'orchestrator']));
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
  h.ok(['project', 'set', '--paused', 'manual conflict probe']);
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
  const event = JSON.parse(h.ok(['wait', '--types', 'rework', '--timeout', '5', '--agent', 'orchestrator']));
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
  const result = await h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0.2', '--agent', 'orchestrator']);
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
  h.ok(['project', 'set', '--paused', 'manual conflict probe']);
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
  const h = setup(t, { kind: 'docs', ci: 'pending' });
  h.submit();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const payload = { repository: { full_name: 'acme/demo' }, action: 'completed',
    check_suite: { head_sha: h.sha, status: 'completed', conclusion: 'success' } };
  const deliver = () => h.run(['ci', 'webhook', '-', '--agent', 'orchestrator'], { input: JSON.stringify(payload) });
  assert.equal(deliver().code, 0);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).ok, false, 'GitHub pending wins over payload success');
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
  const poll = () => (fs.existsSync(release) ? finish() : setTimeout(poll, 50));
  poll();
} else {
  setTimeout(finish, 2500);
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
    assert.notEqual(await waitFor(path.join(h.base, 'suite-started-2'), { ms: 60000 }), null, 'two executors start');
    // Keep both slots occupied until a watcher has queued the third submission.
    assert.equal(h.consume().code, 2);
    const queued = h.logs().filter((e) => e.cmd === 'automation queued' && e.detail.executors === 2);
    assert.ok(queued.some((e) => e.task === 'T3'), JSON.stringify(queued));
  } finally {
    fs.writeFileSync(release, '');
  }
  assert.notEqual(await waitFor(path.join(h.base, 'suite-started-3'), { ms: 60000 }), null, 'the third executor starts');
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
const until = Date.now() + 20000;
const poll = () => {
  const log = read();
  if (log.some((e) => e.cmd === 'automation queued' && e.task === 'T2') || Date.now() > until) {
    process.kill(log.findLast((e) => e.cmd === 'automation' && e.detail.phase === 'running').detail.pid, 'SIGKILL');
    process.exit(1);
  }
  setTimeout(poll, 50);
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
const poll = () => (fs.existsSync(${JSON.stringify(release)}) ? process.exit(0) : setTimeout(poll, 50));
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
const poll = () => (fs.existsSync(release) ? process.exit(0) : setTimeout(poll, 50));
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
    h.ok(['wait', '--types', 'merged', '--timeout', '5', '--agent', 'orchestrator']);
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
  h.ok(['wait', '--types', 'merged', '--timeout', '5', '--agent', 'orchestrator']);
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

for (const tier of ['medium', 'easy..medium']) {
test(`automation reworks a current ${tier} failed review once with its full findings, even before software passes`, (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['task', 'update', 'T1', '--tier', tier]);
  h.submit();
  h.ok(['project', 'set', '--paused', 'inspect review findings']);
  h.reviewer('T1', 'reviewer');
  const github = h.github();
  const ref = 'https://github.com/acme/demo/pull/7#issuecomment-123';
  const body = `Review (Tower Crane) at ${h.sha}\nVerdict: FAIL\nlib/change.js:12 - handle the missing input`;
  github.comments = [{ id: 123, body, html_url: ref }];
  h.saveGithub(github);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
    '--fail', '--summary', 'one blocking finding', '--ref', ref, '--agent', 'reviewer']);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.equal(task.revision, 2);
  const reason = h.logs().find((e) => e.cmd === 'rework').detail.reason;
  assert.ok(reason.includes(body));
  assert.ok(reason.includes(ref));
  assert.ok(h.ok(['brief', 'get', 'T1']).includes(body));
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 1, 'replay never reworks the review twice');
});
}

for (const stale of ['head', 'revision', 'superseded verdict']) {
  test(`automation ignores a failed review with a stale ${stale}`, (t) => {
    const h = setup(t, { ci: 'pending' });
    h.submit();
    h.reviewer('T1', 'reviewer', stale === 'head' ? 'aaaaaaa' : h.sha);
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review',
      '--sha', stale === 'head' ? 'aaaaaaa' : h.sha, '--fail', '--summary', 'old finding', '--agent', 'reviewer']);
    if (stale === 'revision') {
      h.ok(['rework', 'T1', '--reason', 'new revision', '--agent', 'orchestrator']);
      h.submit();
    } else if (stale === 'superseded verdict') {
      h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
        '--ok', '--agent', 'reviewer']);
    }
    const before = h.logs().filter((e) => e.cmd === 'rework').length;
    h.consume();
    assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
    assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, before);
  });
}

for (const tier of ['medium', 'easy..medium']) {
  for (const comment of ['missing', 'mismatched']) {
    test(`a ${tier} ${comment} linked review comment keeps the wait host running`, (t) => {
      const h = setup(t, { ci: 'pending' });
      h.ok(['task', 'update', 'T1', '--tier', tier]);
      h.submit();
      h.ok(['project', 'set', '--paused', 'inspect review refusal']);
      h.reviewer('T1', 'reviewer');
      const ref = 'https://github.com/acme/demo/pull/7#issuecomment-123';
      if (comment === 'mismatched') {
        const github = h.github();
        github.comments = [{ id: 123, html_url: ref,
          body: `Review (Tower Crane) at ${'f'.repeat(40)}\nVerdict: FAIL\nwrong head` }];
        h.saveGithub(github);
      }
      h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
        '--fail', '--summary', 'one blocking finding', '--ref', ref, '--agent', 'reviewer']);
      const brief = h.ok(['brief', 'get', 'T1']);
      const result = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0.1',
        '--agent', 'orchestrator']);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /linked review comment does not identify/);
      const task = h.readState('tasks.json').tasks[0];
      assert.equal(task.status, 'submitted');
      assert.equal(task.revision, 1);
      assert.equal(h.ok(['brief', 'get', 'T1']), brief);
    });
  }
}

test('observation-only waits retain ranged full-findings recovery', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['task', 'update', 'T1', '--tier', 'easy..medium']);
  h.submit();
  h.ok(['project', 'set', '--paused', 'inspect observed recovery']);
  h.reviewer('T1', 'reviewer');
  const ref = 'https://github.com/acme/demo/pull/7#issuecomment-123';
  const body = `Review (Tower Crane) at ${h.sha}\nVerdict: FAIL\nlib/change.js:12 - handle the missing input`;
  const github = h.github();
  github.comments = [{ id: 123, body, html_url: ref }];
  h.saveGithub(github);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
    '--fail', '--summary', 'one blocking finding', '--ref', ref, '--agent', 'reviewer']);
  const spawns = h.logs().filter((e) => e.cmd === 'spawn').length;
  const result = h.run(['wait', '--observe', '--after', '0', '--types', 'never', '--timeout', '0.1',
    '--agent', 'orchestrator']);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'rework');
  assert.equal(h.readState('tasks.json').tasks[0].revision, 2);
  assert.ok(h.ok(['brief', 'get', 'T1']).includes(body));
  assert.ok(h.ok(['brief', 'get', 'T1']).includes(ref));
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, spawns);
});

for (const command of ['accept', 'spawn review']) {
  test(`${command} sends a current failed review to full-findings rework instead of repeating review`, (t) => {
    const h = setup(t, { ci: 'pending' });
    h.submit();
    h.reviewer('T1', 'reviewer');
    const ref = 'https://github.com/acme/demo/pull/7#issuecomment-456';
    const body = `Review (Tower Crane) at ${h.sha}\nVerdict: FAIL\nlib/change.js:22 - reject the empty request`;
    const github = h.github();
    github.comments = [{ id: 456, body, html_url: ref }];
    h.saveGithub(github);
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
      '--fail', '--summary', 'one blocking finding', '--ref', ref, '--agent', 'reviewer']);
    const before = h.logs().filter((e) => e.cmd === 'spawn').length;
    const args = command === 'accept' ? ['accept', 'T1'] : ['spawn', '--task', 'T1', '--role', 'review'];
    const result = h.run([...args, '--agent', 'orchestrator']);
    assert.equal(result.code, 1, result.stderr || result.stdout);
    const task = h.readState('tasks.json').tasks[0];
    assert.equal(task.status, 'rework');
    assert.equal(task.revision, 2);
    assert.ok(h.ok(['brief', 'get', 'T1']).includes(body));
    assert.ok(h.ok(['brief', 'get', 'T1']).includes(ref));
    assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, before);
    assert.equal(h.logs().filter((e) => e.cmd.startsWith('check ')).length, 0);
  });
}

function refillFixture(t) {
  const h = cachedFixture(null, 'automation-refill', (repo) => {
    const h = setup(null, { ci: 'pending', repo });
    configureHarness(h);
    h.ok(['project', 'set', '--workers', '1']);
    for (const id of ['T2', 'T3', 'T4']) {
      h.ok(['task', 'add', '--title', id, '--acceptance', 'works', '--tier', 'easy',
        ...(id === 'T4' ? ['--dep', 'T3'] : [])]);
      h.ok(['brief', 'set', id, '-'], { input: `Implement ${id}.\n` });
    }
    const script = path.join(h.base, 'refill-worker.js');
    fs.writeFileSync(script, `const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const task = process.env.TOWER_CRANE_TASK;
cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, 'claim', task], { stdio: 'pipe' });
const file = path.join(process.env.AUTOMATION_CONTEXT_DIR, task);
fs.writeFileSync(file, '');
fs.writeFileSync(file + '.prompt', process.argv[2]);
if (process.env.REFILL_ORPHAN) {
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(file + '.orphan', String(child.pid));
}
const poll = () => fs.existsSync(file + '.go') ? fs.writeFileSync(file + '.exited', '') : setTimeout(poll, 25);
poll();
`);
    h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, script, '{prompt}'])]);
    return { sha: h.sha };
  });
  h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
  h.saveGithub = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(state));
  h.submit = () => {
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '7', '--agent', 'worker']);
  };
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  h.consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  h.marker = (id) => path.join(h.env.AUTOMATION_CONTEXT_DIR, id);
  t.after(async () => {
    const ids = h.readState('tasks.json').tasks.map((task) => task.id);
    for (const id of ids) fs.writeFileSync(`${h.marker(id)}.go`, '');
    for (const id of ids) {
      if (fs.existsSync(h.marker(id))) await waitFor(`${h.marker(id)}.exited`);
    }
    await h.cleanup();
  });
  return h;
}

test('a ranged review recovery refusal does not stop unrelated gates or worker refill', async (t) => {
  const h = refillFixture(t);
  h.ok(['task', 'update', 'T1', '--tier', 'easy..medium']);
  h.submit();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
    '--fail', '--summary', 'one blocking finding',
    '--ref', 'https://github.com/acme/demo/pull/7#issuecomment-123', '--agent', 'reviewer']);
  h.ok(['claim', 'T2', '--agent', 'worker-2']);
  h.ok(['submit', 'T2', '--sha', h.sha, '--pr', '7', '--agent', 'worker-2']);
  const result = h.run(['wait', '--after', '0', '--types', 'spawn', '--task', 'T3',
    '--timeout', '15', '--agent', 'orchestrator']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).task, 'T3');
  assert.match(result.stderr, /linked review comment does not identify/);
  assert.notEqual(await waitFor(h.marker('T3')), null);
  assert.ok(h.logs().some((e) => e.task === 'T2' && e.cmd === 'check tests'),
    'the unrelated submission still runs its software gates');
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.equal(task.revision, 1);
});

test('automation retains an exited worker claim until its lost monitor process group is empty', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const h = refillFixture(t);
  const spawn = h.json(['spawn', '--task', 'T1', '--agent', 'orchestrator'], { env: { REFILL_ORPHAN: '1' } });
  assert.notEqual(await waitFor(`${h.marker('T1')}.orphan`), null);
  const orphan = Number(fs.readFileSync(`${h.marker('T1')}.orphan`, 'utf8'));
  const cursor = String(fs.statSync(path.join(h.state, 'events.jsonl')).size);
  const waiting = h.runAsync(['wait', '--after', cursor, '--types', 'spawn', '--timeout', '15', '--agent', 'orchestrator']);
  try {
    process.kill(spawn.monitor_pid, 'SIGKILL');
    process.kill(spawn.pid, 'SIGKILL');
    fs.writeFileSync(`${h.marker('T1')}.exited`, '');
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(h.readState('tasks.json').tasks[0].claim?.agent, spawn.agent, 'the orphan keeps its worker slot');
    assert.equal(fs.existsSync(h.marker('T3')), false);
  } finally {
    try { process.kill(orphan, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  const result = await waiting;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).task, 'T3');
  assert.notEqual(await waitFor(h.marker('T3')), null);
});

test('automation reports unchanged dispatch refusals once and retries after the brief changes', async (t) => {
  const h = refillFixture(t);
  for (const id of ['T1', 'T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
  h.ok(['task', 'add', '--title', 'Missing brief', '--acceptance', 'works', '--tier', 'easy']);
  const started = path.join(h.base, 'wait-started');
  const waiter = h.runAsync(['wait', '--types', 'spawn', '--timeout', '15', '--agent', 'orchestrator'],
    { hooks: { HOOK_WATCH_READY: started } });
  assert.notEqual(await waitFor(started), null);
  for (let i = 0; i < 3; i++) {
    h.ok(['task', 'note', 'T5', `unrelated progress ${i}`]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  h.ok(['brief', 'set', 'T5', '-'], { input: 'Implement the acceptance.\n' });
  const result = await waiter;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).task, 'T5');
  assert.equal(result.stderr.match(/has no brief/g)?.length, 1, result.stderr);
  assert.notEqual(await waitFor(h.marker('T5')), null, 'the changed brief retries dispatch');
});

test('automation dispatches rework-ready work with the failed review findings', async (t) => {
  const h = refillFixture(t);
  h.ok(['task', 'update', 'T4', '--dep', 'T1']);
  h.submit();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
    '--fail', '--summary', 'lib/change.js:12 - handle the missing input', '--agent', 'reviewer']);
  h.consume();
  assert.notEqual(await waitFor(h.marker('T1')), null, 'rework is dispatched without a manual command');
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'in_progress');
  assert.equal(task.claim.from, 'rework');
  assert.equal(task.revision, 2);
  assert.match(fs.readFileSync(`${h.marker('T1')}.prompt`, 'utf8'), /lib\/change.js:12 - handle the missing input/);
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 1);
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker').length, 1);
});

for (const trigger of ['exit', 'release --dead', 'merge']) {
  test(`automation refills after ${trigger} in unblocking-first order and concurrent watchers respect the worker limit`, async (t) => {
    const h = refillFixture(t);
    if (trigger === 'merge') {
      h.submit();
      h.reviewer('T1', 'reviewer');
      h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
        '--ok', '--agent', 'reviewer']);
      const github = h.github();
      github.ci[h.sha] = 'success';
      h.saveGithub(github);
    } else {
      h.json(['spawn', '--task', 'T1', '--agent', 'orchestrator']);
      assert.notEqual(await waitFor(h.marker('T1')), null, 'first worker claims the slot');
      fs.writeFileSync(`${h.marker('T1')}.go`, '');
      assert.notEqual(await waitFor(`${h.marker('T1')}.exited`), null);
      if (trigger === 'release --dead') {
        // Foreground observation records the exit before the explicit batch release.
        h.run(['wait', '--after', '0', '--observe', '--types', 'worker-exited', '--timeout', '5', '--agent', 'orchestrator']);
        h.ok(['release', '--dead', '--agent', 'orchestrator']);
      }
    }
    const cursor = trigger === 'release --dead' ? String(fs.statSync(path.join(h.state, 'events.jsonl')).size) : '0';
    const watchers = [h.runAsync(['wait', '--after', cursor, '--task', 'T3', '--types', 'spawn', '--timeout', '15', '--agent', 'orchestrator']),
      h.runAsync(['wait', '--after', cursor, '--task', 'T3', '--types', 'spawn', '--timeout', '15', '--agent', 'orchestrator'])];
    const results = await Promise.all(watchers);
    assert.ok(results.every((r) => r.code === 0 && JSON.parse(r.stdout).task === 'T3'), JSON.stringify(results));
    assert.notEqual(await waitFor(h.marker('T3')), null, `the task unblocking T4 takes the free slot: ${JSON.stringify(results)}`);
    const spawns = h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker');
    assert.deepEqual(spawns.map((e) => e.task), trigger === 'merge' ? ['T3'] : ['T1', 'T3']);
    const st = require('../lib/state').loadState(h.state);
    assert.equal(require('../lib/tasks').workerHolders(st, Date.now()).length, 1);
    h.consume();
    assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker').length, spawns.length);
  });
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
    assert.equal(report.prompt.includes('## House rules'), withRules);
    if (withRules) {
      assert.ok(detail.rules.some((r) => r.path === path.join(h.base, 'AGENTS.md') && r.loaded === 'read'));
      for (const rule of detail.rules) assert.ok(report.prompt.includes(rule.path));
    } else {
      assert.deepEqual(detail.rules, []);
      assert.equal(detail.rules_bytes, 0);
      assert.equal(detail.rules_tokens, 0);
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
  const deadline = Date.now() + 60000;
  while (!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok)) {
    if (Date.now() > deadline) throw new Error(JSON.stringify(h.logs().slice(-10)));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const pins = h.logs().filter((e) => e.cmd === 'gates pin');
  assert.deepEqual(pins.map((e) => e.detail.key), ['tests_cmd', 'clean_cmd']);
  assert.ok(pins.every((e) => e.agent === 'orchestrator' && e.detail.authority === 'orchestrator'));
  const probes = fs.readFileSync(h.env.AUTOMATION_POLICY_PROBE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(probes.length, 2);
  assert.ok(probes.every((p) => p.denials.every((d) => d.status === 126 && /not allowed/.test(d.stderr))), JSON.stringify(probes));
  assert.ok(probes.every((p) => p.path.includes(path.join(h.state, 'homes'))));
  startupContexts(h, false);
});

test('large review dispatch hands revuto findings to the reviewer and an ok that ignores a P1 is refused', async (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, 'large.md'), 'A focused review reads this diff. '.repeat(1000) + '\n');
  h.git(['add', 'large.md']);
  h.git(['commit', '-qm', 'large review diff']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  configureHarness(h);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  state.ci[h.sha] = 'success';
  const comment = (id, body, extra = {}) => ({ id, in_reply_to_id: null, path: 'src.js', line: 3, original_line: 3, body,
    user: 'revuto-review[bot]', original_commit_id: h.sha, html_url: `https://github.com/acme/demo/pull/7#discussion_r${id}`, ...extra });
  state.comments = [
    comment(101, '[P1] The loop never terminates on empty input.'),
    comment(102, '[P2] Missing null check.'),
    { ...comment(103, '[resolved]\nFixed by the guard above.'), in_reply_to_id: 102, user: 'worker' },
    comment(104, 'Nit: rename this.'),
    comment(105, '[P1] Outdated finding.', { line: null }),
    comment(106, '[P1] Not from revuto.', { user: 'someone' }),
  ];
  h.saveGithub(state);
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  const deadline = Date.now() + 60000;
  while (!h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.role === 'reviewer')) {
    if (Date.now() > deadline) throw new Error(JSON.stringify(h.logs().slice(-10)));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.deepEqual(review.detail.revuto.map((f) => [f.id, f.severity, f.reply]), [[101, 'P1', null], [102, 'P2', 103], [104, null, null]]);
  const brief = fs.readFileSync(path.join(h.state, 'reviews', `T1-${h.sha}.md`), 'utf8');
  assert.match(brief, /## Revuto findings/);
  assert.match(brief, /### \[P1\] src\.js:3 \(comment 101\)\n\n\[P1\] The loop never terminates on empty input\./);
  assert.match(brief, /### \[P2\] src\.js:3 \(comment 102, resolved in reply 103\)/);
  assert.match(brief, /### src\.js:3 \(comment 104\)/);
  assert.doesNotMatch(brief, /Outdated finding|Not from revuto/);
  const contextFile = path.join(h.env.AUTOMATION_CONTEXT_DIR, `${review.detail.agent}.json`);
  assert.ok(fs.existsSync(contextFile), fs.readFileSync(review.detail.log, 'utf8'));
  const { prompt } = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  assert.match(prompt, /Read .*reviews.* for the diff at/);
  assert.match(prompt, /## Revuto findings/);
  assert.match(prompt, /### \[P1\] src\.js:3 \(comment 101\)\n\n\[P1\] The loop never terminates on empty input\./);
  assert.match(prompt, /## Gate results/);
  assert.doesNotMatch(prompt, /diff --git a\/large.md/);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.evidence.some((e) => e.type === 'review'), false, 'the reviewer ok was refused');
  assert.equal(task.status, 'submitted');
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', review.detail.agent]);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /review ok refused; revuto \[P1\] comment 101 at src\.js:3 \(https:\/\/github\.com\/acme\/demo\/pull\/7#discussion_r101\)/);
  assert.doesNotMatch(refused.stderr, /comment 10[2-6]/);
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--fail', '--agent', review.detail.agent]);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('brokered review evidence clears a revuto finding whose file changed since the comment', async (t) => {
  const h = setup(t);
  configureHarness(h);
  const state = h.github();
  const before = h.git(['rev-parse', `${h.sha}^`]);
  const comment = (id, commit) => ({ id, in_reply_to_id: null, path: 'value.js', line: 1, original_line: 1, body: `[P1] finding ${id}`,
    user: 'revuto-review[bot]', original_commit_id: commit, html_url: null });
  // value.js changed between before and the head; nothing changed after the head.
  state.comments = [comment(201, before), comment(202, h.sha)];
  h.saveGithub(state);
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  const deadline = Date.now() + 60000;
  while (!h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.role === 'reviewer')) {
    if (Date.now() > deadline) throw new Error(JSON.stringify(h.logs().slice(-10)));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.deepEqual(review.detail.revuto.map((f) => [f.id, f.changed]), [[201, true], [202, false]]);
  // The state broker runs evidence with TOWER_CRANE_VIA=broker, where tower-crane reads no repository.
  const broker = { env: { ...h.env, TOWER_CRANE_VIA: 'broker' } };
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', review.detail.agent, '--state', h.state], broker);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /review ok refused; revuto \[P1\] comment 202 at value\.js:1 has no code change/);
  assert.doesNotMatch(refused.stderr, /comment 201/);
});

test('revuto findings on bracketed paths require a change to the literal file', async (t) => {
  const h = setup(t);
  configureHarness(h);
  fs.mkdirSync(path.join(h.repo, 'routes'));
  fs.writeFileSync(path.join(h.repo, 'routes', '[id].js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(h.repo, 'routes', 'i.js'), 'module.exports = 1;\n');
  h.git(['add', 'routes']);
  h.git(['commit', '-qm', 'add route fixtures']);
  const commented = h.git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(h.repo, 'routes', 'i.js'), 'module.exports = 2;\n');
  h.git(['add', 'routes']);
  h.git(['commit', '-qm', 'change sibling route']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  state.ci[h.sha] = 'success';
  state.comments = [{ id: 401, in_reply_to_id: null, path: 'routes/[id].js', line: 1,
    body: '[P1] The dynamic route is still broken.', user: 'revuto-review[bot]', original_commit_id: commented }];
  h.saveGithub(state);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  const first = await h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  assert.equal(first.code, 1, first.stdout + first.stderr);
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.equal(review.detail.revuto[0].changed, false);
  const broker = { env: { ...h.env, TOWER_CRANE_VIA: 'broker' } };
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok',
    '--agent', review.detail.agent, '--state', h.state], broker);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /review ok refused; revuto \[P1\] comment 401 at routes\/\[id\]\.js:1/);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok), false);

  fs.writeFileSync(path.join(h.repo, 'routes', '[id].js'), 'module.exports = 2;\n');
  h.git(['add', 'routes']);
  h.git(['commit', '-qm', 'fix dynamic route']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  const updated = h.github();
  updated.prs['7'].headRefOid = h.sha;
  updated.ci[h.sha] = 'success';
  h.saveGithub(updated);
  h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '7', '--agent', 'worker']);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  const fixed = await h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
  const latest = h.logs().findLast((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.equal(latest.detail.revuto[0].changed, true);
  assert.ok(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok && e.sha === h.sha));
});

test('revuto replies require an explicit resolution and later discussion reopens the finding', async (t) => {
  const h = setup(t);
  configureHarness(h);
  const state = h.github();
  const before = h.git(['rev-parse', `${h.sha}^`]);
  const finding = (id, commit = h.sha) => ({ id, in_reply_to_id: null, path: 'value.js', line: 1,
    body: `[P1] finding ${id}`, user: 'revuto-review[bot]', original_commit_id: commit });
  const reply = (id, thread, body) => ({ id, in_reply_to_id: thread, user: 'worker', body });
  state.comments = [
    finding(301), reply(311, 301, 'I can still reproduce this. This is not fixed.'),
    finding(302), reply(312, 302, '[resolved]\nFixed by the guard above.'),
    finding(303, before), reply(313, 303, 'Please explain this change.'),
    finding(304), reply(314, 304, 'Not fixed yet.'), reply(324, 304, '[RESOLVED]'),
    finding(305), reply(315, 305, '[resolved]'), reply(325, 305, 'I can still reproduce this.'),
    finding(306), reply(316, 306, '> [resolved]\nThis is a quote, not a resolution.'),
  ];
  h.saveGithub(state);
  // A tracked worker lets automatic reactions dispatch another reviewer after
  // a refused verdict; this test controls both snapshots with native submission.
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  const first = await h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  assert.equal(first.code, 1, first.stdout + first.stderr);
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const broker = { env: { ...h.env, TOWER_CRANE_VIA: 'broker' } };
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok',
    '--agent', review.detail.agent, '--state', h.state], broker);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  for (const id of [301, 305, 306]) assert.match(refused.stderr, new RegExp(`comment ${id} at value\\.js:1`));
  assert.doesNotMatch(refused.stderr, /comment 30[234]/);
  assert.deepEqual(review.detail.revuto.map((f) => [f.id, f.reply, f.resolved, f.changed]), [
    [301, 311, false, false], [302, 312, true, false], [303, 313, false, true],
    [304, 324, true, false], [305, 325, false, false], [306, 316, false, false],
  ]);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review'), false);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);

  const updated = h.github();
  for (const id of [301, 305, 306]) updated.comments.push(reply(id + 100, id, '[resolved]\nVerified at this head.'));
  h.saveGithub(updated);
  const rerun = await h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  assert.equal(rerun.code, 0, rerun.stdout + rerun.stderr);
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker').length, 0);
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 2);
  assert.ok(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok));
});

test('a supervised worker submission runs gates and dispatches the offline reviewer after exit', async (t) => {
  const h = setup(t);
  configureHarness(h, { rules: true });
  const hold = path.join(h.base, 'worker-hold');
  const spawned = h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'],
    { env: { AUTOMATION_WORKER_HOLD: hold } });
  const deadline = Date.now() + 60000;
  try {
    while (!fs.existsSync(hold)) {
      if (Date.now() > deadline) throw new Error('worker did not submit');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    h.consume();
    assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 0,
      'a worker still running after submit blocks review dispatch');
  } finally {
    fs.writeFileSync(`${hold}.go`, '');
    assert.equal((await spawned).code, 0);
  }
  // Reviewer completion has its own CLI command deadline after worker exit.
  const reviewDeadline = Date.now() + 60000;
  while (!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok)) {
    if (Date.now() > reviewDeadline) throw new Error(JSON.stringify(h.logs().slice(-10)));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
  h.ok(['project', 'set', '--paused', 'manual queue conflict probe']);
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
  h.ok(['wait', '--types', 'merged', '--task', 'T2', '--timeout', '120', '--agent', 'orchestrator']);
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
  // The owner reworks and reaccepts T1 at a new head while its suite runs.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const cp = require('node:child_process'), fs = require('node:fs');
const env = ${JSON.stringify(h.env)};
const cli = (...a) => cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, ...a], { cwd: ${JSON.stringify(h.repo)}, env, encoding: 'utf8' });
const file = env.AUTOMATION_GITHUB;
cli('rework', 'T1', '--reason', 'replace the head', '--agent', 'owner');
const gh = JSON.parse(fs.readFileSync(file, 'utf8'));
gh.prs['7'].headRefOid = ${JSON.stringify(replacement)};
gh.ci[${JSON.stringify(replacement)}] = 'success';
fs.writeFileSync(file, JSON.stringify(gh));
cli('claim', 'T1', '--agent', 'worker');
cli('submit', 'T1', '--sha', ${JSON.stringify(replacement)}, '--pr', '7', '--agent', 'worker');
for (const gate of ['tests', 'clean', 'ci']) cli('check', gate, 'T1', '--agent', 'owner');
const events = ${JSON.stringify(path.join(h.state, 'events.jsonl'))};
const revision = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(h.state, 'tasks.json'))}, 'utf8')).tasks.find((x) => x.id === 'T1').revision;
const at = new Date().toISOString();
fs.appendFileSync(events, [
  { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail: { agent: 'reviewer', role: 'reviewer', rung: 'review', sha: ${JSON.stringify(replacement)}, revision, pid: 999999, attempt: 1 } },
  { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T1', detail: { agent: 'reviewer', pid: 999999, attempt: 1, code: 0 } },
].map((e) => JSON.stringify(e) + '\\n').join(''));
cli('evidence', 'T1', '--type', 'review', '--sha', ${JSON.stringify(replacement)}, '--ok', '--agent', 'reviewer');
cli('accept', 'T1', '--agent', 'owner');
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
setTimeout(() => {}, 10000);
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
  // The suite fails, but only after the owner replaces the tests command.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const cp = require('node:child_process');
cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, 'project', 'set', '--tests-cmd', ${JSON.stringify(`${cmd} again`)}, '--agent', 'owner'],
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
const until = Date.now() + 20000;
const poll = () => {
  if (fs.existsSync(${JSON.stringify(resume)})) return;
  if (Date.now() > until) throw new Error('queue was not resumed');
  setTimeout(poll, 25);
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
