'use strict';

// Replay a real recovery directory in a disposable repository. The original
// save stays untouched, and both implementations receive the same checkout.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const { makeRepo, ROOT } = require('./helpers');

const baselineRef = process.argv[3];
if (!process.argv[2] || !baselineRef) throw new Error('usage: node test/worktree-save-measure.js SAVE_DIRECTORY BASELINE_REF');
const original = path.resolve(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(path.join(original, 'manifest.json')));
if (!manifest.bundle || !manifest.head) throw new Error('measurement needs a save with a commit bundle and head');
const lib = path.join(ROOT, 'lib', 'worktree.js');

function implementation(source) {
  const mod = new Module(lib, module);
  mod.filename = lib;
  mod.paths = Module._nodeModulePaths(path.dirname(lib));
  mod._compile(`${source}\nmodule.exports.measureSave = saveWork;\n`, lib);
  return mod.exports.measureSave;
}

const before = implementation(cp.execFileSync('git', ['show', `${baselineRef}:lib/worktree.js`],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: Infinity }));
const after = implementation(fs.readFileSync(lib, 'utf8'));

function measure(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) return { files: 1, bytes: stat.size };
  return fs.readdirSync(dir).reduce((sum, name) => {
    const next = measure(path.join(dir, name));
    return { files: sum.files + next.files, bytes: sum.bytes + next.bytes };
  }, { files: 0, bytes: 0 });
}

const cleanups = [];
const h = makeRepo({ after: (fn) => cleanups.push(fn) });
async function main() {
  try {
    h.git(['fetch', path.join(original, manifest.bundle), 'HEAD']);
    h.init();
    const checkout = path.join(h.base, 'replay');
    h.git(['worktree', 'add', '--detach', checkout, manifest.head]);
    const patch = path.join(original, 'tracked.patch');
    if (fs.existsSync(patch) && fs.statSync(patch).size) h.git(['apply', '--binary', patch], checkout);
    for (const file of manifest.files || []) {
      const source = path.join(original, 'files', file);
      const target = path.join(checkout, file);
      if (!path.relative(path.join(original, 'files'), source).startsWith('..')
        && !path.relative(checkout, target).startsWith('..')) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
      } else throw new Error('unsafe path in input manifest');
    }
    const ctx = { stateDir: h.state, cwd: h.repo };
    const hit = { path: checkout, head: manifest.head, branch: null };
    const results = [];
    for (let i = 0; i < 3; i++) {
      const oldSave = before({ root: h.repo }, ctx, hit, 'before', false, true);
      const newSave = after({ root: h.repo }, ctx, hit, 'after', false, true);
      results.push({ before: measure(oldSave), after: measure(newSave),
        before_local_files: measure(path.join(oldSave, 'files')),
        after_local_files: measure(path.join(newSave, 'files')) });
    }
    process.stdout.write(JSON.stringify({ original, original_size: measure(original),
      baseline_ref: baselineRef, runs: results }, null, 2) + '\n');
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
