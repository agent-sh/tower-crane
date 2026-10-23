'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT } = require('./helpers');
const { makeDocsRepo } = require('./docs-fixture');
const { anchors, links, check } = require('../scripts/doc-links');

test('scratch contracts agree across state areas, CLI prose and command help', (t) => {
  const { scratchRoot } = require('../lib/scratch-root');
  const name = path.posix.basename(scratchRoot({}, '/users/me', 'linux'));
  for (const [file, pattern] of [
    ['docs/state/storage.md', new RegExp(`\\$XDG_CACHE_HOME/${name}`)],
    ['docs/state/containment.md', new RegExp(`then \`${name}\` under the user's cache`)],
    ['scripts/cli-reference.md', new RegExp(`\`${name}\` under the user's cache`)],
    ['docs/cli.md', new RegExp(`default ${name} under the user cache`)],
    ['docs/state/tasks.md', /Agents do not inherit the dispatcher's Node runtime controls:[^\n]*`NODE_V8_COVERAGE`/],
    ['docs/ladder.md', /each clears[^\n]*`NODE_V8_COVERAGE`/],
  ]) {
    assert.match(fs.readFileSync(path.join(ROOT, file), 'utf8'), pattern, file);
  }
  const h = makeDocsRepo(t);
  const result = cp.spawnSync(process.execPath, [path.join(h.repo, 'bin', 'tower-crane.js'),
    'project', 'set', '--help'], { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 300000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`default ${name} under the user cache`));
});

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
  for (const anchor of ['agent-identity', 'authority', 'tasksjson', 'pr-owners', 'acceptance-gates', 'final-review', 'lock', 'repeated-review-failures', 'live-window-replay-2026-10-21-t451']) {
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

// docs/cli.md is generated whole, so unrelated command edits that meet in its
// help section must resolve through the repository's own generated mapping.
test('unrelated command help edits that conflict in docs/cli.md resolve as generated output', async (t) => {
  const G = require('../lib/generated-conflicts');
  const h = makeDocsRepo(t);
  const gc = {};
  const edit = (branch, file, from, to) => {
    h.git(['checkout', '-q', '-b', branch, 'main']);
    const target = path.join(h.repo, 'lib', file);
    const text = fs.readFileSync(target, 'utf8');
    assert.ok(text.includes(from), from);
    fs.writeFileSync(target, text.replace(from, to));
    const result = cp.spawnSync(process.execPath, ['scripts/cli-docs.js'], { cwd: h.repo, env: h.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    h.git(['commit', '-qam', branch]);
  };
  edit('claim-help', 'commands-tasks.js', "summary: 'take a ready task for --agent'", "summary: 'take a ready task for the --agent'");
  edit('event-help', 'commands-events.js', "summary: 'print one event with its detail, as a wake line names it'",
    "summary: 'print one event and its detail, as a wake line names it'");
  const merge = cp.spawnSync('git', ['merge', '-q', '--no-edit', 'claim-help'], { cwd: h.repo, env: h.env, encoding: 'utf8' });
  assert.notEqual(merge.status, 0, 'the two help edits must meet in docs/cli.md');
  assert.deepEqual(await G.files(gc, h.repo), ['docs/cli.md']);
  const config = await G.configuration(gc, h.repo, 'main');
  const { generated, remaining } = await G.resolve(gc, h.repo, config);
  assert.deepEqual({ generated, remaining }, { generated: ['docs/cli.md'], remaining: [] });
  const regenerated = await G.regenerate(gc, h.repo, config, generated, remaining, 120000);
  assert.ok(regenerated.ok, JSON.stringify(regenerated));
  const docs = fs.readFileSync(path.join(h.repo, 'docs', 'cli.md'), 'utf8');
  assert.match(docs, /take a ready task for the --agent/);
  assert.match(docs, /print one event and its detail/);
  const check = cp.spawnSync(process.execPath, ['scripts/cli-docs.js', '--check'], { cwd: h.repo, env: h.env, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

// Contributor guidance must name the sources of the generated file; an
// instruction to edit docs/cli.md itself fails the check and is then erased.
test('contributor guidance points CLI prose at its template and state prose at docs/state', () => {
  const rows = [
    ['AGENTS.md', ['scripts/cli-reference.md', 'docs/state/']],
    ['scripts/cli-reference.md', ['scripts/cli-reference.md', 'lib/commands-*.js']],
    ['docs/cli.md', ['scripts/cli-reference.md', 'lib/commands-*.js']],
  ];
  for (const [file, names] of rows) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /details (and examples )?outside the generated blocks/, file);
    assert.doesNotMatch(text, /COMMANDS` in `bin\/tower-crane\.js`/, file);
    for (const name of names) assert.ok(text.includes(name), `${file} names ${name}`);
  }
});

// The worker skill is role text for every project's workers (lib/spawn.js puts it in each worker
// prompt), so it must not carry this repository's own docs layout.
test('the worker skill names no Tower Crane repository docs paths', () => {
  const text = fs.readFileSync(path.join(ROOT, 'skills/tower-crane-work/SKILL.md'), 'utf8');
  for (const name of ['scripts/cli-reference.md', 'docs/state/', 'docs/cli.md']) {
    assert.ok(!text.includes(name), `skills/tower-crane-work/SKILL.md names ${name}`);
  }
});
