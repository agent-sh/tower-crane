'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { saveFilePlan } = require('../lib/worktree');
const SAVE_FILES_LIMIT = 100 * 1024 * 1024;

function fixture(t) {
  return cachedFixture(t, 'save-files', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Save files', '--acceptance', 'preserve local work']);
  });
}

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function outcome(h) {
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return events.filter((e) => e.task === 'T1' && ['worktree removed', 'worktree kept'].includes(e.cmd)).at(-1);
}

test('a save preserves source and ignored notes, skips ignored build trees and lists storage bytes', (t) => {
  const h = fixture(t);
  const wt = h.json(['worktree', 'T1']);
  write(wt.path, '.gitignore', 'target/\nnode_modules/\nnotes.txt\n');
  h.git(['add', '.gitignore'], wt.path);
  h.git(['commit', '-qm', 'Ignore generated files and local notes'], wt.path);
  write(wt.path, 'target/CACHEDIR.TAG', 'Signature: 8a477f597d28d172789f06886806bc55\n');
  write(wt.path, 'target/debug/output', 'compiled\n');
  write(wt.path, 'node_modules/package/index.js', 'installed\n');
  write(wt.path, 'notes.txt', 'handwritten\n');
  write(wt.path, 'source.js', 'source\n');
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);

  const event = outcome(h);
  assert.equal(event.cmd, 'worktree removed');
  const saved = event.detail.saved;
  const manifest = JSON.parse(fs.readFileSync(path.join(saved, 'manifest.json')));
  assert.deepEqual(manifest.files, ['notes.txt', 'source.js']);
  assert.equal(fs.readFileSync(path.join(saved, 'files/notes.txt'), 'utf8'), 'handwritten\n');
  assert.equal(fs.readFileSync(path.join(saved, 'files/source.js'), 'utf8'), 'source\n');
  assert.equal(fs.existsSync(path.join(saved, 'files/target')), false);
  assert.equal(fs.existsSync(path.join(saved, 'files/node_modules')), false);
  assert.deepEqual(manifest.skipped_ignored.map(({ path: dir, bytes }) => ({ path: dir, bytes })), [
    { path: 'node_modules', bytes: Buffer.byteLength('installed\n') },
    { path: 'target', bytes: Buffer.byteLength('Signature: 8a477f597d28d172789f06886806bc55\ncompiled\n') },
  ]);
  assert.equal(manifest.files_copied, true);
  assert.equal(manifest.files_bytes, Buffer.byteLength('handwritten\nsource\n'));
  assert.ok(!h.registers(wt.path));
  function bytes(dir) {
    return fs.readdirSync(dir).reduce((sum, name) => {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      return sum + (stat.isDirectory() ? bytes(file) : stat.size);
    }, 0);
  }
  const total = bytes(path.join(h.state, 'worktree-saves'));
  assert.equal(h.json(['worktree', 'list']).worktree_saves_bytes, total);
  assert.match(h.ok(['worktree', 'list']), new RegExp(`worktree-saves: ${total} bytes`));
});

test('the copy limit records all file sizes and keeps the checkout and branch', (t) => {
  const h = fixture(t);
  const wt = h.json(['worktree', 'T1']);
  const large = path.join(wt.path, 'large.dat');
  const fd = fs.openSync(large, 'w');
  fs.ftruncateSync(fd, SAVE_FILES_LIMIT + 1);
  fs.closeSync(fd);
  write(wt.path, 'notes.txt', 'keep me\n');
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  const event = outcome(h);
  assert.equal(event.cmd, 'worktree kept');
  assert.match(event.detail.reason, /copy limit.*paths and sizes recorded.*checkout kept/);
  const manifest = JSON.parse(fs.readFileSync(path.join(event.detail.saved, 'manifest.json')));
  assert.equal(manifest.files_copied, false);
  assert.equal(manifest.files_limit_bytes, SAVE_FILES_LIMIT);
  assert.deepEqual(manifest.file_sizes, [
    { path: 'large.dat', bytes: SAVE_FILES_LIMIT + 1 },
    { path: 'notes.txt', bytes: 8 },
  ]);
  assert.equal(manifest.files_bytes, SAVE_FILES_LIMIT + 9);
  assert.equal(fs.existsSync(path.join(event.detail.saved, 'files')), false);
  assert.equal(fs.statSync(large).size, SAVE_FILES_LIMIT + 1);
  assert.equal(fs.readFileSync(path.join(wt.path, 'notes.txt'), 'utf8'), 'keep me\n');
  assert.ok(h.registers(wt.path));
  assert.ok(h.git(['show-ref', '--verify', `refs/heads/${wt.branch}`]));
});

test('save file planning distinguishes ignored directories from source and never follows links', (t) => {
  const h = fixture(t);
  const root = path.join(h.base, 'plan');
  const variants = [
    ...['node_modules', 'target', 'dist', 'build', '.venv', '__pycache__', '.next']
      .map((dir) => ({ file: `nested/${dir}/output`, skip: `nested/${dir}` })),
    { file: 'custom-cache/data', skip: 'custom-cache', tag: true },
    { file: 'notes/draft.txt' },
    { file: 'build-notes/draft.txt' },
    { file: 'target.txt' },
  ];
  for (const row of variants) {
    write(root, row.file, 'abc');
    if (row.tag) write(root, `${row.skip}/CACHEDIR.TAG`, 'tag');
    const plan = saveFilePlan(root, [], [row.file]);
    assert.deepEqual(plan.entries, row.skip ? [] : [{ path: row.file, bytes: 3 }], row.file);
    assert.deepEqual(plan.skipped_ignored.map(({ path: dir, bytes }) => ({ path: dir, bytes })),
      row.skip ? [{ path: row.skip, bytes: 3 }] : [], row.file);
    // An ignore exception can make source inside a generated tree untracked.
    assert.deepEqual(saveFilePlan(root, [row.file], []).entries, [{ path: row.file, bytes: 3 }]);
  }
  write(root, 'nested-repo/source.txt', 'abc');
  assert.deepEqual(saveFilePlan(root, ['nested-repo/'], []).entries,
    [{ path: 'nested-repo/source.txt', bytes: 3 }]);
  if (process.platform !== 'win32') {
    const outside = path.join(h.base, 'outside');
    write(outside, 'secret.txt', 'do not copy');
    fs.symlinkSync(outside, path.join(root, 'link'));
    const plan = saveFilePlan(root, ['link'], []);
    assert.deepEqual(plan.entries, [{ path: 'link', bytes: fs.lstatSync(path.join(root, 'link')).size }]);
  }
  write(root, 'CACHEDIR.TAG', 'tag');
  assert.deepEqual(saveFilePlan(root, [], ['notes/draft.txt']).skipped_ignored,
    [{ path: '.', reason: 'cache-tag', bytes: 3 }]);
});
