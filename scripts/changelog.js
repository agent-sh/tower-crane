'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { readText } = require('./text');

const ROOT = path.join(__dirname, '..');

function fragments(root = ROOT) {
  const dir = path.join(root, 'changelog.d');
  const entries = fs.readdirSync(dir).filter((name) => name !== 'README.md').map((name) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(name) || !fs.statSync(path.join(dir, name)).isFile()) {
      throw new Error(`invalid changelog fragment: ${name}`);
    }
    const text = readText(path.join(dir, name)).trim();
    if (!text.startsWith('- ') || text.includes('\u2014')) {
      throw new Error(`changelog.d/${name} must contain a nonempty Markdown bullet without em dashes`);
    }
    return { name, text };
  });
  const history = cp.execFileSync('git', ['log', '--first-parent', '--diff-merges=first-parent',
    '--diff-filter=A', '--format=', '--name-only', '-z', '--', 'changelog.d/'],
  { cwd: root, encoding: 'utf8', timeout: 30000 });
  const landed = new Map();
  for (const file of history.split('\0').map((file) => file.trim()).filter(Boolean)) {
    const name = file.replace(/\\/g, '/').slice('changelog.d/'.length);
    if (!landed.has(name)) landed.set(name, landed.size);
  }
  return entries.sort((a, b) => (landed.get(a.name) ?? -1) - (landed.get(b.name) ?? -1)
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function assemble(root = ROOT) {
  const archive = readText(path.join(root, 'CHANGELOG.md'));
  if (!archive.startsWith('# Changelog\n')) throw new Error('CHANGELOG.md needs its Changelog heading');
  const entries = fragments(root).map((fragment) => fragment.text);
  return '# Changelog\n\n' + [...entries, archive.slice('# Changelog\n'.length).trim()].filter(Boolean).join('\n\n') + '\n';
}

if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw new Error('usage: node scripts/changelog.js');
    process.stdout.write(assemble());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { fragments, assemble };
