'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');

// npm 11 prints an array of artifacts; npm 12 prints an object keyed by package name.
function packedArtifact(stdout) {
  const packed = JSON.parse(stdout);
  return Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
}

test('pack output parses from the npm 11 array and npm 12 object shapes', () => {
  for (const shape of ['npm-11', 'npm-12']) {
    const stdout = fs.readFileSync(path.join(ROOT, 'test/fixtures/npm-pack', `${shape}.json`), 'utf8');
    const artifact = packedArtifact(stdout);
    assert.equal(artifact.name, '@agentsys/tower-crane', shape);
    assert.ok(artifact.files.some((file) => file.path === 'skills/tower-crane/SKILL.md'), shape);
  }
});

test('the npm package ships the plugin and loads pi skills through its CLI', (t) => {
  const h = makeRepo(t);
  const args = ['pack', '--dry-run', '--json', '--cache', path.join(h.base, 'npm-cache')];
  const packed = cp.spawnSync(process.env.npm_execpath ? process.execPath : 'npm',
    process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args,
    { cwd: ROOT, env: h.env, encoding: 'utf8', timeout: 300000, shell: !process.env.npm_execpath && process.platform === 'win32' });
  assert.equal(packed.status, 0, packed.stderr);
  const artifact = packedArtifact(packed.stdout);
  assert.equal(artifact.name, '@agentsys/tower-crane');
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
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
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
  cli(['init', '--name', 'packaged', '--goal', 'load shipped skills']);
  cli(['task', 'add', '--title', 'Packaged task', '--acceptance', 'skills load']);
  cli(['brief', 'set', 'T1', '--file', path.join(installed, 'skills/tower-crane-work/SKILL.md')]);
  for (const [rung, skill] of [['medium', 'tower-crane-work'], ['review', 'tower-crane-review']]) {
    cli(['ladder', 'set', rung, '--harness', 'pi', '--model', 'openai/gpt-5.5', '--clear', 'profile', '--clear', 'effort']);
    const out = JSON.parse(cli(['spawn', '--role', rung, '--task', 'T1', '--dry-run', '--json']));
    assert.equal(out.argv[out.argv.indexOf('--skill') + 1], path.join(installed, 'skills', skill));
  }
});
