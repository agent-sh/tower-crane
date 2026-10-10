'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readText, escapeTableCell } = require('./text');

const ROOT = path.join(__dirname, '..');
const TABLES = ['Plan', 'Stack', 'Run', 'Decisions', 'Views', 'Agents and worktrees', 'Gates'];

function generate(root = ROOT) {
  const { COMMANDS } = require(path.join(root, 'bin', 'tower-crane.js'));
  const source = readText(path.join(root, 'bin', 'tower-crane.js'));
  const body = source.match(/const COMMANDS = \[\n([\s\S]*?)\n\];/);
  if (!body) throw new Error('COMMANDS table is missing');
  const lines = body[1].split('\n').filter((line) => line.trim());
  if (lines.length !== COMMANDS.length || lines.some((line) => !/^  \{ section: .* \},$/.test(line))) {
    throw new Error('COMMANDS must have one entry per line, separated by blank lines');
  }
  if (body[1] !== lines.join('\n\n')) throw new Error('separate COMMANDS entries with one blank line');
  const names = COMMANDS.map((c) => c.name);
  if (new Set(names).size !== names.length || names.join('\n') !== [...names].sort().join('\n')) {
    throw new Error('COMMANDS must be sorted by name with no duplicates');
  }
  if (COMMANDS.some((c) => !TABLES.includes(c.section) || !c.summary
    || (c.description !== undefined && (typeof c.description !== 'string' || !c.description.trim()))
    || /[\r\n]/.test(c.summary + (c.usage || '') + (c.description || '')))) {
    throw new Error('every command needs a known section and single-line usage, summary and description');
  }
  const docPath = path.join(root, 'docs', 'cli.md');
  const original = readText(docPath);
  let generated = original;
  for (const section of TABLES) {
    const start = `<!-- commands:${section}:start -->`;
    const end = `<!-- commands:${section}:end -->`;
    if (original.split(start).length !== 2 || original.split(end).length !== 2) {
      throw new Error(`docs/cli.md needs exactly one ${section} command block`);
    }
    const from = generated.indexOf(start) + start.length;
    const to = generated.indexOf(end);
    if (to < from) throw new Error(`invalid ${section} command block`);
    const commands = COMMANDS.filter((c) => section === 'Stack' ? c.name.startsWith('stack ')
      : c.section === section && !c.name.startsWith('stack '));
    const rows = commands.map((c) => `| \`${escapeTableCell(c.name + (c.usage ? ` ${c.usage}` : ''))}\` | ${escapeTableCell(c.description || c.summary)} |`);
    // Empty table rows separate edits without breaking the Markdown table.
    generated = generated.slice(0, from) + '\n| Command | Does |\n|---|---|\n' + rows.join('\n| | |\n') + '\n' + generated.slice(to);
  }
  return { docPath, original, generated };
}

function check(root = ROOT) {
  const { original, generated } = generate(root);
  if (original !== generated) throw new Error('docs/cli.md command rows drifted; run npm run docs:generate');
}

if (require.main === module) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('usage: node scripts/cli-docs.js [--check]');
    if (process.argv.includes('--check')) check();
    else {
      const { docPath, generated } = generate();
      fs.writeFileSync(docPath, generated);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { generate, check };
