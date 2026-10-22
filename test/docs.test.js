'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT } = require('./helpers');
const { makeDocsRepo } = require('./docs-fixture');
const { anchors, links, check } = require('../scripts/doc-links');

test('documentation anchors and links handle Markdown variants in process', () => {
  const variants = [
    ['# tasks.json\n## Repeat\n## Repeat\n<a id="old"></a>', ['tasksjson', 'repeat', 'repeat-1', 'old']],
    ['# `Quoted` & punctuation!\n## Héllo', ['quoted--punctuation', 'héllo']],
    ['```md\n# Hidden\n[a](missing.md)\n```\n## Visible', ['visible']],
    ['~~~md\n# Hidden\n~~~\n<h2 id="named">Heading</h2>', ['named']],
    ['## <span>Visible</span>', ['visible']],
    ['## <script', ['script']],
    ['## <scr<a>ipt>', ['ipt']],
    ['## <<script>script>', ['script']],
    ['## >A<span>B</span><', ['ab']],
    ['## A😀É́', ['aé́']],
  ];
  for (const [text, expected] of variants) assert.deepEqual([...anchors(text)], expected);
  assert.deepEqual(links('`[ignored](missing)`\n[valid](area.md#topic)\n[ref]: <other.md#anchor>\n'),
    [{ target: 'area.md#topic', line: 2 }, { target: 'other.md#anchor', line: 3 }]);
});

test('doc lint rejects broken files and anchors through the real shared check', (t) => {
  const h = makeDocsRepo(t);
  const file = path.join(h.repo, 'docs', 'link-probe.md');
  const run = () => cp.spawnSync(process.execPath, [path.join(h.repo, 'scripts', 'check-shared-files.js')],
    { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 300000 });
  for (const target of ['absent.md', 'state.md#absent', 'state/tasks.md#absent', 'state.md#%ZZ']) {
    fs.writeFileSync(file, `[probe](${target})\n`);
    const result = run();
    assert.equal(result.status, 1, target);
    assert.match(result.stderr, /link-probe.md:1: (missing|invalid)/);
  }
  fs.writeFileSync(file, '[old](state.md#tasksjson)\n[new](state/tasks.md#tasksjson)\n');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

test('the eight state areas, compatibility redirects and every docs link resolve', () => {
  const areas = ['ci', 'containment', 'decisions', 'gates', 'review', 'stacks', 'storage', 'tasks'];
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'docs', 'state')).sort(), areas.map((area) => `${area}.md`));
  const index = fs.readFileSync(path.join(ROOT, 'docs', 'state.md'), 'utf8');
  for (const area of areas) assert.ok(index.includes(`](state/${area}.md)`), area);
  for (const anchor of ['agent-identity', 'authority', 'tasksjson', 'pr-owners', 'acceptance-gates', 'final-review', 'lock', 'repeated-review-failures']) {
    assert.ok(index.includes(`<a id="${anchor}"></a>`), anchor);
  }
  check(ROOT);
});

test('the release workflow checks committed CLI output before regenerating and saving it', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-docs.yml'), 'utf8');
  assert.match(workflow, /release:\s*\n\s*types: \[published\]/);
  assert.ok(workflow.indexOf('npm run docs:cli:check') < workflow.indexOf('npm run docs:cli\n'));
  assert.ok(workflow.indexOf('npm run docs:cli:check') < workflow.indexOf('actions/upload-artifact'));
  const scripts = require('../package.json').scripts;
  assert.equal(scripts['docs:cli'], 'node scripts/cli-docs.js');
  assert.equal(scripts['docs:cli:check'], 'node scripts/cli-docs.js --check');
});

test('release documentation steps reject stale help and prose without overwriting the evidence', (t) => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-docs.yml'), 'utf8');
  const steps = [...workflow.matchAll(/^\s+- run: npm run (\S+)$/gm)].map((match) => match[1]);
  for (const variant of ['clean', 'help drift', 'prose drift']) {
    const h = makeDocsRepo(t);
    const file = path.join(h.repo, 'docs', 'cli.md');
    if (variant === 'help drift') {
      const bin = path.join(h.repo, 'bin', 'tower-crane.js');
      fs.writeFileSync(bin, fs.readFileSync(bin, 'utf8').replace("'show help'", "'show changed help'"));
    } else if (variant === 'prose drift') {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('# CLI', '# Stale CLI'));
    }
    const before = fs.readFileSync(file, 'utf8');
    const scripts = JSON.parse(fs.readFileSync(path.join(h.repo, 'package.json'), 'utf8')).scripts;
    let result;
    for (const step of steps) {
      const [node, ...args] = scripts[step].split(' ');
      assert.equal(node, 'node');
      result = cp.spawnSync(process.execPath, args, { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 300000 });
      if (result.status !== 0) break;
    }
    assert.equal(result.status, variant === 'clean' ? 0 : 1, `${variant}: ${result.stderr}`);
    assert.equal(fs.readFileSync(file, 'utf8'), before, variant);
    if (variant !== 'clean') assert.match(result.stderr, /docs\/cli.md.*drifted/);
  }
});
