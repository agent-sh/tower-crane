'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ALLOWLIST = 'tools/model-literals.json';
const aliases = Object.keys(require('../lib/ladder').BUILTIN.claude_aliases || {})
  .map(alias => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const selection = new RegExp(String.raw`\b(?:claude-[\w.-]+|gpt-[\w.-]+|opus|sonnet|haiku|sol|luna|astra${aliases ? '|' + aliases : ''})\b`, 'gi');

function modelSelections(root, env = process.env) {
  const files = cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, env, encoding: 'utf8' }).split('\0').filter(Boolean);
  const allowfile = path.join(root, ALLOWLIST);
  const entries = fs.existsSync(allowfile) ? JSON.parse(fs.readFileSync(allowfile, 'utf8')) : [];
  if (!Array.isArray(entries) || entries.some(entry => !entry
    || typeof entry.path !== 'string' || !entry.path
    || typeof entry.text !== 'string' || !entry.text
    || typeof entry.reason !== 'string' || !entry.reason.trim())) {
    throw new Error(`${ALLOWLIST}: each entry requires an exact path, text and reason`);
  }
  const allowed = new Set(entries.map(entry => JSON.stringify([entry.path, entry.text])));
  const violations = [];
  for (const file of new Set(files)) {
    const code = /^(?:lib|bin)\/.*\.(?:js|cjs|mjs)$/.test(file);
    const json = file.endsWith('.json') && !/^(?:docs|changelog\.d)\//.test(file) && file !== ALLOWLIST;
    if (!code && !json) continue;
    let text = fs.readFileSync(path.join(root, file), 'utf8');
    if (file === 'lib/ladder.js') {
      text = text.replace(/const BUILTIN = \{[\s\S]*?\n\};/, block => block.replace(/[^\r\n]/g, ' '));
    }
    for (const match of text.matchAll(selection)) {
      if (allowed.has(JSON.stringify([file, match[0]]))) continue;
      const line = text.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${line}: ${match[0]}`);
    }
  }
  return violations;
}

module.exports = { modelSelections };

if (require.main === module) {
  const violations = modelSelections(path.resolve(__dirname, '..'));
  for (const violation of violations) console.error(violation);
  process.exitCode = violations.length ? 1 : 0;
}
