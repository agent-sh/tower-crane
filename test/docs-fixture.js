'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, ROOT } = require('./helpers');
const { links } = require('../scripts/doc-links');
const { readText } = require('../scripts/text');

function makeDocsRepo(t, { crlfCheckout = false } = {}) {
  return cachedFixture(t, `docs-repo:${crlfCheckout}`, (h) => {
    for (const name of ['bin', 'lib', 'scripts', 'docs', 'changelog.d', '.github', 'skills', 'agents', 'standards', 'commands']) {
      fs.cpSync(path.join(ROOT, name), path.join(h.repo, name), { recursive: true });
    }
    for (const name of ['package.json', 'CHANGELOG.md', 'README.md', 'AGENTS.md', '.gitattributes']) {
      fs.copyFileSync(path.join(ROOT, name), path.join(h.repo, name));
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
    const checkout = (autocrlf) => {
      // A fresh destination applies checkout filters even when index stats match.
      const staged = path.join(h.base, 'docs-checkout');
      h.git(['-c', `core.autocrlf=${autocrlf}`, 'checkout-index', '--all', `--prefix=${staged}${path.sep}`]);
      fs.cpSync(staged, h.repo, { recursive: true });
      fs.rmSync(staged, { recursive: true, force: true });
    };
    if (crlfCheckout) {
      checkout('true');
      h.git(['-c', 'core.autocrlf=input', 'add', '.']);
    }
    checkout('false');
    // Refresh the cached sizes recorded from the original CRLF copies.
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'documentation fixture']);
  });
}

module.exports = { makeDocsRepo };
