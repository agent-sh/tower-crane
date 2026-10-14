'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, fixtureLadder, ROOT } = require('./helpers');

// npm 11 prints an array of artifacts; npm 12 prints an object keyed by package name.
function packedArtifact(stdout) {
  const packed = JSON.parse(stdout);
  return Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
}

test('pack output parses from the npm 11 array and npm 12 object shapes', () => {
  for (const shape of ['npm-11', 'npm-12']) {
    const stdout = fs.readFileSync(path.join(ROOT, 'test/fixtures/npm-pack', `${shape}.json`), 'utf8');
    const artifact = packedArtifact(stdout);
    assert.equal(artifact.name, '@agent-sh/tower-crane', shape);
    assert.ok(artifact.files.some((file) => file.path === 'skills/tower-crane/SKILL.md'), shape);
  }
});

test('fixture children disable Node compile caches', (t) => {
  const h = makeRepo(t);
  const child = cp.spawnSync(process.execPath, ['-e', `
const cache = require('node:module').enableCompileCache();
console.log(JSON.stringify(cache));
`], { env: h.env, encoding: 'utf8', timeout: 300000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).status, require('node:module').constants.compileCacheStatus.DISABLED);
});

test('the npm package ships the plugin and loads pi skills through its CLI', (t) => {
  const h = makeRepo(t);
  const args = ['pack', '--dry-run', '--json', '--cache', path.join(h.base, 'npm-cache')];
  const packed = cp.spawnSync(process.env.npm_execpath ? process.execPath : 'npm',
    process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args,
    { cwd: ROOT, env: h.env, encoding: 'utf8', timeout: 300000, shell: !process.env.npm_execpath && process.platform === 'win32' });
  assert.equal(packed.status, 0, packed.stderr);
  const artifact = packedArtifact(packed.stdout);
  assert.equal(artifact.name, '@agent-sh/tower-crane');
  const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(metadata.bin, { 'tower-crane': 'bin/tower-crane.js' });
  const files = artifact.files.map((file) => file.path);
  for (const file of [
    'skills/tower-crane/SKILL.md',
    'skills/tower-crane-work/SKILL.md',
    'skills/tower-crane-review/SKILL.md',
    'agents/tower-crane-worker.md',
    'agents/tower-crane-reviewer.md',
    'standards/default.md',
    path.relative(ROOT, require.resolve('../.claude-plugin/plugin.json')).replace(/\\/g, '/'),
    path.relative(ROOT, require.resolve('../.claude-plugin/marketplace.json')).replace(/\\/g, '/'),
    'components.json',
    '.mcp.json',
    'lib/mcp.js',
    'commands/tower-crane-inbox.md',
    'commands/tower-crane-spawn-ready.md',
    'commands/tower-crane-merge-accepted.md',
    'commands/tower-crane-rework-from-review.md',
    'commands/tower-crane-release-dead.md',
    'hooks/hooks.json',
    'hooks/tower-crane.mjs',
  ]) assert.ok(files.includes(file), `npm package is missing ${file}`);
  assert.ok(!files.includes('commands/tower-crane.md'), 'the skill must be the only tower-crane entry point');
  // The package carries the contract docs the CLI, skills and agent files point to,
  // not the benchmark evidence, screenshots and review records kept in the repository.
  assert.deepEqual(files.filter((file) => file.startsWith('docs/')).sort(), [
    'docs/automation.md', 'docs/builtin-ladder.json', 'docs/cli.md', 'docs/design.md', 'docs/ladder.md', 'docs/state.md',
  ]);
  assert.ok(files.includes('CHANGELOG.md') && files.includes('LICENSE') && files.includes('README.md'));
  assert.ok(!files.some((file) => /^(test|scripts|research|tools|changelog\.d)\/|^\.tower-crane\//.test(file)),
    'tests, scripts, research, fragments and state stay out of the package');
  assert.ok(artifact.size < 2 * 1024 * 1024, `packed size ${artifact.size} bytes`);
  // An installed copy has only the packed files, so a relative link must land on one of them;
  // repository-only files are linked by their GitHub URL.
  const broken = [];
  for (const file of files.filter((f) => f.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const [, link] of text.matchAll(/(?:\]\(|src="|srcset=")([^)"\s]+)/g)) {
      if (/^(https?:|mailto:|#)/.test(link)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), link.split('#')[0])).replace(/\/$/, '');
      if (!files.some((f) => f === target || f.startsWith(`${target}/`))) broken.push(`${file}: ${link}`);
    }
  }
  assert.deepEqual(broken, [], 'shipped Markdown links to files the package leaves out');
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
  for (const [where, version] of [['plugin.json', plugin.version], ['marketplace.json', marketplace.version],
    ...marketplace.plugins.map((p) => [`marketplace.json plugin ${p.name}`, p.version])]) {
    assert.equal(version, metadata.version, `${where} version matches package.json`);
  }
  const components = JSON.parse(fs.readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
  for (const [type, names] of Object.entries(components)) {
    for (const name of names) {
      const file = type === 'skills' ? `skills/${name}/SKILL.md` : `${type}/${name}.md`;
      assert.ok(files.includes(file), `registered component is missing from the package: ${file}`);
    }
  }

  const installed = path.join(h.base, 'installed');
  for (const file of files) {
    const dest = path.join(installed, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), dest);
  }
  const cli = (args) => {
    const r = cp.spawnSync(process.execPath, [path.join(installed, 'bin/tower-crane.js'), ...args],
      { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 300000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  fs.writeFileSync(h.userConfig, JSON.stringify(fixtureLadder()));
  cli(['init', '--name', 'packaged', '--goal', 'load shipped skills']);
  cli(['task', 'add', '--title', 'Packaged task', '--acceptance', 'skills load']);
  cli(['brief', 'set', 'T1', '--file', path.join(installed, 'skills/tower-crane-work/SKILL.md')]);
  for (const [rung, skill] of [['medium', 'tower-crane-work'], ['review', 'tower-crane-review']]) {
    cli(['ladder', 'set', rung, '--harness', 'pi', '--model', 'provider/fixture-model', '--clear', 'profile', '--clear', 'effort']);
    const out = JSON.parse(cli(['spawn', '--role', rung, '--task', 'T1', '--dry-run', '--json']));
    assert.equal(out.argv[out.argv.indexOf('--skill') + 1], path.join(installed, 'skills', skill));
  }
});
