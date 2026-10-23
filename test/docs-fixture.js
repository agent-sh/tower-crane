'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, ROOT } = require('./helpers');
const { links } = require('../scripts/doc-links');
const { readText } = require('../scripts/text');

function makeDocsRepo(t, { crlfCommandSource = false } = {}) {
  return cachedFixture(t, `docs-repo:${crlfCommandSource}`, (h) => {
    for (const name of ['bin', 'lib', 'scripts', 'docs', 'changelog.d', '.github', 'skills', 'agents', 'standards', 'commands']) {
      fs.cpSync(path.join(ROOT, name), path.join(h.repo, name), { recursive: true });
    }
    for (const name of ['package.json', 'CHANGELOG.md', 'README.md', 'AGENTS.md', '.gitattributes']) {
      fs.copyFileSync(path.join(ROOT, name), path.join(h.repo, name));
    }
    if (crlfCommandSource) {
      for (const name of fs.readdirSync(path.join(h.repo, 'lib')).filter((file) => /^commands-.*\.js$/.test(file))) {
        const file = path.join(h.repo, 'lib', name);
        fs.writeFileSync(file, readText(file).replace(/\n/g, '\r\n'));
      }
    }
    // Documentation also cites repository research artifacts outside the contract.
    for (const name of fs.readdirSync(path.join(ROOT, 'docs'), { recursive: true }).filter((file) => file.endsWith('.md'))) {
      const source = path.join(ROOT, 'docs', name);
      for (const { target } of links(readText(source))) {
        if (/^[a-z][a-z0-9+.-]*:|^[/#]/i.test(target)) continue;
        const from = path.resolve(path.dirname(source), decodeURIComponent(target.split('#')[0]));
        const relative = path.relative(ROOT, from);
        const to = path.join(h.repo, relative);
        if (fs.existsSync(to)) continue;
        if (relative.startsWith('..')) throw new Error(`fixture link outside repository: ${target}`);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    }
    // Copies from a Windows checkout still need Git's normalized index form.
    h.git(['-c', 'core.autocrlf=input', 'add', '.']);
    h.git(['commit', '-qm', 'documentation fixture']);
  });
}

module.exports = { makeDocsRepo };
