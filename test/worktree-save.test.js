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

function moduleFixture(t) {
  return cachedFixture(t, 'save-nested-modules', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Save modules', '--acceptance', 'preserve local work']);
    const leaf = path.join(h.base, 'leaf');
    const outer = path.join(h.base, 'outer');
    for (const dir of [leaf, outer]) {
      fs.mkdirSync(dir);
      h.git(['init', '-q', '-b', 'main'], dir);
      write(dir, 'source.txt', 'tracked source\n');
      h.git(['add', '.'], dir);
      h.git(['commit', '-qm', 'module source'], dir);
    }
    h.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', leaf, 'inner'], outer);
    h.git(['commit', '-qm', 'nested module'], outer);
    h.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', outer, 'module']);
    h.git(['commit', '-qm', 'outer module']);
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

function sparse(file, bytes) {
  const fd = fs.openSync(file, 'w');
  try { fs.ftruncateSync(fd, bytes); } finally { fs.closeSync(fd); }
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

for (const row of [
  { name: 'task', modules: false, orphan: false },
  { name: 'orphan', modules: false, orphan: true },
  { name: 'task with nested submodules', modules: true, orphan: false },
  { name: 'orphan with nested submodules', modules: true, orphan: true },
]) {
  test(`over-limit ${row.name} retries write inventories without duplicating recovery data`, (t) => {
    const h = row.modules ? moduleFixture(t) : fixture(t);
    let wt;
    if (row.orphan) {
      wt = { path: path.join(h.base, 'repo-worktrees', 'untracked-save'), branch: 'tower-crane/untracked-save' };
      h.git(['worktree', 'add', '-b', wt.branch, wt.path, 'main']);
    } else wt = h.json(['worktree', 'T1']);
    if (row.modules) h.git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '-q'], wt.path);
    write(wt.path, 'committed.txt', 'committed\n');
    h.git(['add', 'committed.txt'], wt.path);
    h.git(['commit', '-qm', 'local commit'], wt.path);
    write(wt.path, 'committed.txt', 'dirty tracked content\n');
    write(wt.path, 'notes.txt', 'parent notes\n');
    const child = row.modules ? path.join(wt.path, 'module', 'inner') : wt.path;
    const large = path.join(child, 'large.dat');
    sparse(large, SAVE_FILES_LIMIT + 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!row.orphan && attempt === 0) h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
      else h.ok(['worktree', 'prune', ...(row.orphan ? ['--orphans'] : [])]);
      const root = path.join(h.state, 'worktree-saves');
      for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name);
        assert.deepEqual(fs.readdirSync(dir), ['manifest.json'], 'a refusal must not create bundles, patches or copies');
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
        assert.equal(manifest.bundle, null);
        assert.deepEqual(manifest.copy_limit_exceeded, {
          path: row.modules ? 'module/inner' : '.', bytes: SAVE_FILES_LIMIT + 1 + (row.modules ? 0 : 13),
        });
        let inventory = manifest;
        if (row.modules) inventory = manifest.submodules[0].submodules[0];
        assert.equal(inventory.files_copied, false);
        assert.ok(inventory.file_sizes.some((file) => file.path === 'large.dat' && file.bytes === SAVE_FILES_LIMIT + 1));
      }
      assert.equal(fs.statSync(large).size, SAVE_FILES_LIMIT + 1);
      assert.equal(fs.readFileSync(path.join(wt.path, 'notes.txt'), 'utf8'), 'parent notes\n');
      assert.ok(h.registers(wt.path));
      assert.ok(h.git(['show-ref', '--verify', `refs/heads/${wt.branch}`]));
    }
    // Once the files fit, the same cleanup path must resume normal recovery.
    fs.truncateSync(large, 0);
    h.ok(['worktree', 'prune', ...(row.orphan ? ['--orphans'] : [])]);
    assert.equal(fs.existsSync(wt.path), false);
    assert.ok(!h.registers(wt.path));
  });
}

for (const row of [
  { name: 'nested repository ignore rules', parentRules: false, modules: false },
  { name: 'parent ignore rules for a nested repository', parentRules: true, modules: false },
  { name: 'nested repository inside nested submodules', parentRules: false, modules: true },
  { name: 'nested repository owning an initialized submodule', parentRules: false, modules: false, nestedModule: true },
]) {
  test(`save filtering honors ${row.name}`, (t) => {
    const h = row.modules || row.nestedModule ? moduleFixture(t) : fixture(t);
    const wt = h.json(['worktree', 'T1']);
    if (row.modules) h.git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '-q'], wt.path);
    const checkout = row.modules ? path.join(wt.path, 'module', 'inner') : wt.path;
    const nested = path.join(checkout, 'nested');
    fs.mkdirSync(nested);
    h.git(['init', '-q', '-b', 'main'], nested);
    const rules = 'node_modules/\ntarget/*\n!target/source.js\ncache/\n';
    write(nested, '.gitignore', (row.parentRules ? '' : rules) + 'notes.txt\n');
    write(nested, 'source.js', 'tracked\n');
    write(nested, 'node_modules/tracked.js', 'tracked source\n');
    h.git(['add', '.'], nested);
    h.git(['add', '-f', 'node_modules/tracked.js'], nested);
    h.git(['commit', '-qm', 'nested source and rules'], nested);
    if (row.nestedModule) {
      h.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', path.join(h.base, 'leaf'), 'child'], nested);
      const child = path.join(nested, 'child');
      write(child, '.gitignore', 'target/\nnotes.txt\n');
      h.git(['add', '.gitignore'], child);
      write(child, 'target/source.js', 'tracked child source\n');
      h.git(['add', '-f', 'target/source.js'], child);
      h.git(['commit', '-qm', 'child ignore rules'], child);
      h.git(['add', '.'], nested);
      h.git(['commit', '-qm', 'nested repository submodule'], nested);
      write(child, 'notes.txt', 'child notes\n');
      write(child, 'target/output', 'compiled\n');
      write(child, 'target/source.js', 'edited child source\n');
    }
    const head = h.git(['rev-parse', 'HEAD'], nested);
    h.git(['branch', 'build/local'], nested);
    write(checkout, '.gitignore', 'build/\n' + (row.parentRules
      ? 'nested/node_modules/\nnested/target/*\n!nested/target/source.js\nnested/cache/\n' : ''));
    h.git(['add', '.gitignore'], checkout);
    h.git(['commit', '-qm', 'parent ignore rules'], checkout);
    write(nested, 'notes.txt', 'handwritten\n');
    write(nested, 'node_modules/tracked.js', 'edited tracked source\n');
    write(nested, 'untracked.js', 'new source\n');
    write(nested, 'target/source.js', 'ignore exception\n');
    write(nested, 'target/output', '');
    sparse(path.join(nested, 'target/output'), SAVE_FILES_LIMIT + 1);
    write(nested, 'node_modules/package/index.js', 'installed\n');
    write(nested, 'cache/CACHEDIR.TAG', 'tag');
    write(nested, 'cache/data', 'cached');
    h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
    assert.equal(outcome(h).cmd, 'worktree removed', 'ignored build output must not trigger the guard');
    let saved = outcome(h).detail.saved;
    let manifest = JSON.parse(fs.readFileSync(path.join(saved, 'manifest.json')));
    if (row.modules) {
      saved = JSON.parse(fs.readFileSync(path.join(manifest.submodules[0].saved, 'manifest.json'))).submodules[0].saved;
      manifest = JSON.parse(fs.readFileSync(path.join(saved, 'manifest.json')));
    }
    for (const [file, text] of [
      ['source.js', 'tracked\n'], ['notes.txt', 'handwritten\n'],
      ['untracked.js', 'new source\n'], ['target/source.js', 'ignore exception\n'],
      ['node_modules/tracked.js', 'edited tracked source\n'],
    ]) assert.equal(fs.readFileSync(path.join(saved, 'files', 'nested', file), 'utf8'), text);
    for (const file of ['target/output', 'node_modules/package', 'cache']) {
      assert.equal(fs.existsSync(path.join(saved, 'files', 'nested', file)), false, file);
    }
    assert.deepEqual(manifest.skipped_ignored.map(({ path: dir, bytes }) => ({ path: dir, bytes })), [
      { path: 'nested/cache', bytes: 9 },
      ...(row.nestedModule ? [{ path: 'nested/child/target', bytes: 9 }] : []),
      { path: 'nested/node_modules', bytes: 10 },
      { path: 'nested/target', bytes: SAVE_FILES_LIMIT + 1 },
    ]);
    const restored = path.join(saved, 'files', 'nested');
    assert.equal(h.git(['rev-parse', 'HEAD'], restored), head, 'nested Git commits and refs remain recoverable');
    assert.equal(h.git(['rev-parse', 'build/local'], restored), head, 'ignore patterns must not drop Git refs');
    if (row.nestedModule) {
      assert.equal(fs.readFileSync(path.join(restored, 'child', 'notes.txt'), 'utf8'), 'child notes\n');
      assert.equal(fs.readFileSync(path.join(restored, 'child', 'target/source.js'), 'utf8'), 'edited child source\n');
      assert.equal(h.git(['show', 'HEAD:source.txt'], path.join(restored, 'child')), 'tracked source');
    }
  });
}
