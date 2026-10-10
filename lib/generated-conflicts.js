'use strict';

const fs = require('node:fs');
const path = require('node:path');
const C = require('./gates/common');
const { refuse } = require('./util');

// Inspect and read the same open file even if its path changes meanwhile.
function readRegularFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd) : null;
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'ELOOP'].includes(error.code)) return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Only the fetched base declares which outputs may be replaced unattended.
async function configuration(gc, root, tip) {
  const result = await C.git(gc, root, ['show', `${tip}:package.json`]);
  if (!result.ok) return Object.create(null);
  let pkg;
  try { pkg = JSON.parse(result.stdout); }
  catch { return Object.create(null); }
  const entries = pkg['tower-crane']?.generated;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return Object.create(null);
  const config = Object.create(null);
  for (const [file, value] of Object.entries(entries)) {
    const spec = typeof value === 'string' ? { script: value } : value;
    if (!file || file.startsWith('-') || file.includes('\\') || file.includes('\0')
      || path.posix.isAbsolute(file) || file.split('/').some((part) => !part || part === '.' || part === '..')
      || !spec || typeof spec.script !== 'string' || !spec.script.trim()
      || typeof pkg.scripts?.[spec.script] !== 'string'
      || spec.blocks !== undefined && (!Array.isArray(spec.blocks) || !spec.blocks.length
        || spec.blocks.some((block) => typeof block !== 'string' || !/^[\w :/-]+$/.test(block)))) {
      throw refuse(`invalid generated-file mapping for ${file}`);
    }
    config[file] = spec;
  }
  return config;
}

function stripBlocks(text, blocks) {
  const bodies = [];
  for (const block of blocks) {
    const start = `<!-- ${block}:start -->`;
    const end = `<!-- ${block}:end -->`;
    if (text.split(start).length !== 2 || text.split(end).length !== 2) return null;
    const from = text.indexOf(start) + start.length;
    const to = text.indexOf(end);
    if (to < from) return null;
    bodies.push({ start, end, body: text.slice(from, to) });
    text = text.slice(0, from) + '\n' + text.slice(to);
  }
  return { text, bodies };
}

async function files(gc, dir) {
  const diff = await C.git(gc, dir, ['diff', '--name-only', '--diff-filter=U', '-z']);
  if (!diff.ok) throw refuse(`cannot list conflicting files: ${C.errText(diff)}`);
  return diff.stdout.split('\0').filter(Boolean);
}

// Strip generated blocks before a three-way merge of the hand-written text.
// Restore the old bodies until the generator replaces them, including when a
// mixed merge cannot run its generator until source conflicts are resolved.
async function resolve(gc, dir, config) {
  const generated = [];
  for (const file of await files(gc, dir)) {
    const spec = config[file];
    if (!spec) continue;
    const stages = await Promise.all([1, 2, 3].map((stage) => C.git(gc, dir, ['show', `:${stage}:${file}`])));
    // Whole-file add/add outputs have no ancestor; partial documents need it
    // to merge their hand-written text without choosing one side.
    const required = spec.blocks ? stages : stages.slice(1);
    // Deletions, renames and non-regular files need a worker's judgment.
    const modes = await C.git(gc, dir, ['ls-files', '-u', '--', file]);
    if (required.some((r) => !r.ok) || !modes.ok
      || modes.stdout.trim().split('\n').some((line) => !line.startsWith('100644 ') && !line.startsWith('100755 '))) continue;
    let text = stages[1].stdout;
    let unresolved = false;
    if (spec.blocks) {
      const stripped = stages.map((r) => stripBlocks(r.stdout, spec.blocks));
      if (stripped.some((s) => !s)) continue;
      const scratch = fs.mkdtempSync(path.join(path.dirname(dir), 'generated-merge-'));
      try {
        const names = ['base', 'ours', 'theirs'].map((name, i) => {
          const target = path.join(scratch, name);
          fs.writeFileSync(target, stripped[i].text);
          return target;
        });
        const merged = await C.git(gc, dir, ['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs',
          names[1], names[0], names[2]]);
        if (!merged.ok && !(merged.status > 0 && merged.status <= 127)) throw refuse(`cannot merge hand-written blocks in ${file}`);
        text = merged.stdout;
        unresolved = !merged.ok;
        for (const { start, end, body } of stripped[1].bodies) {
          text = text.replace(start + '\n' + end, start + body + end);
        }
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
    if (spec.blocks) fs.writeFileSync(path.join(dir, file), text);
    else {
      const checkout = await C.git(gc, dir, ['checkout', '--ours', '--', file]);
      if (!checkout.ok) throw refuse(`cannot restore generated file ${file}: ${C.errText(checkout)}`);
    }
    if (!unresolved) {
      const add = await C.git(gc, dir, ['add', '--', file]);
      if (!add.ok) throw refuse(`cannot stage generated file ${file}: ${C.errText(add)}`);
    }
    generated.push(file);
  }
  return { generated, remaining: await files(gc, dir) };
}

async function regenerate(gc, dir, config, generated, remaining, timeout) {
  const commands = [];
  const scripts = new Set(generated.map((file) => config[file].script));
  const outputs = Object.keys(config).filter((file) => scripts.has(config[file].script));
  const before = new Map([...new Set([...outputs, ...remaining])].map((file) => {
    const target = path.join(dir, file);
    return [file, readRegularFile(target)];
  }));
  const rollback = async () => {
    for (const [file, content] of before) {
      if (content) fs.writeFileSync(path.join(dir, file), content);
    }
    const diff = await C.git(gc, dir, ['diff', '--name-only', '-z']);
    const other = diff.stdout.split('\0').filter((file) => file && !before.has(file));
    if (other.length) await C.git(gc, dir, ['checkout', '--', ...other]);
  };
  for (const script of scripts) {
    const command = `npm run ${C.shellQuote(script)}`;
    const result = await C.shell(gc, command, { cwd: dir, timeout, keep: 1 << 20 });
    commands.push({ command, status: result.status, summary: C.errText(result) });
    if (!result.ok) {
      await rollback();
      return { ok: false, commands };
    }
  }
  for (const file of outputs.filter((file) => config[file].blocks)) {
    const original = before.get(file);
    const target = path.join(dir, file);
    const oldText = original && stripBlocks(original.toString('utf8'), config[file].blocks);
    const content = readRegularFile(target);
    const newText = content && stripBlocks(content.toString('utf8'), config[file].blocks);
    if (!oldText || !newText || oldText.text !== newText.text) {
      await rollback();
      return { ok: false, commands, error: `generator changed hand-written text outside declared blocks in ${file}` };
    }
  }
  const resolved = outputs.filter((file) => !remaining.includes(file));
  if (!resolved.length) return { ok: true, commands };
  const add = await C.git(gc, dir, ['add', '--', ...resolved]);
  return { ok: add.ok, commands };
}

module.exports = { configuration, resolve, regenerate, files };
