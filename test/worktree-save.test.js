'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { cachedFixture, ROOT } = require('./helpers');
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
  return h.events().filter((e) => e.task === 'T1' && ['worktree removed', 'worktree kept'].includes(e.cmd)).at(-1);
}

function sparse(file, bytes) {
  const fd = fs.openSync(file, 'w');
  try { fs.ftruncateSync(fd, bytes); } finally { fs.closeSync(fd); }
}

function recoverySnapshot(dir) {
  const rows = [];
  function visit(relative) {
    const entries = fs.readdirSync(path.join(dir, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else {
        // Size and digest must describe the same read, even if a file changes.
        const content = fs.readFileSync(path.join(dir, child));
        rows.push({ path: child, bytes: content.length,
          digest: createHash('sha256').update(content).digest('hex') });
      }
    }
  }
  visit('');
  return rows;
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

test('worktree measurement replays recovery data and rejects incomplete or unsafe input', (t) => {
  const h = fixture(t);
  const wt = h.json(['worktree', 'T1']);
  write(wt.path, '.gitignore', 'notes/\n');
  write(wt.path, 'tracked.bin', Buffer.from([0]));
  h.git(['add', '.gitignore', 'tracked.bin'], wt.path);
  h.git(['commit', '-qm', 'measurement baseline'], wt.path);
  write(wt.path, 'tracked.bin', Buffer.from([0, 255, 1]));
  write(wt.path, 'source.js', 'source\n');
  write(wt.path, 'notes/draft.txt', 'handwritten\n');
  write(wt.path, 'data.bin', Buffer.from([0, 255, 1]));
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  const saved = outcome(h).detail.saved;
  const manifest = JSON.parse(fs.readFileSync(path.join(saved, 'manifest.json')));
  assert.ok(manifest.bundle);
  assert.ok(fs.statSync(path.join(saved, 'tracked.patch')).size > 0);
  const baseline = h.git(['rev-parse', 'HEAD'], ROOT);
  const command = path.join(__dirname, 'worktree-save-measure.js');
  const original = recoverySnapshot(saved);
  for (const row of [
    { name: 'valid', valid: true },
    { name: 'arguments', noArgs: true, error: /usage: node test\/worktree-save-measure.js/ },
    { name: 'bundle', field: 'bundle', error: /needs a save with a commit bundle and head/ },
    { name: 'head', field: 'head', error: /needs a save with a commit bundle and head/ },
    { name: 'unsafe', unsafe: true, error: /unsafe path in input manifest/ },
  ]) {
    const input = row.valid ? saved : path.join(h.base, `measurement-${row.name}`);
    if (!row.valid && !row.noArgs) {
      fs.cpSync(saved, input, { recursive: true });
      const changed = { ...manifest, files: [...manifest.files] };
      if (row.field) changed[row.field] = null;
      if (row.unsafe) changed.files.push('../outside');
      fs.writeFileSync(path.join(input, 'manifest.json'), JSON.stringify(changed));
    }
    const result = cp.spawnSync(process.execPath, [command, ...(row.noArgs ? [] : [input, baseline])],
      { cwd: ROOT, env: h.env, encoding: 'utf8', timeout: 300000 });
    assert.ifError(result.error);
    assert.equal(result.status, row.valid ? 0 : 1, `${row.name}: ${result.stderr}`);
    if (row.valid) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.original, saved);
      assert.equal(report.baseline_ref, baseline);
      assert.deepEqual(report.original_size,
        { files: original.length, bytes: original.reduce((sum, file) => sum + file.bytes, 0) });
      assert.equal(report.runs.length, 3);
      for (const sample of report.runs) {
        assert.equal(sample.before.files, original.length);
        assert.equal(sample.after.files, original.length);
        assert.ok(sample.before.bytes > 0);
        assert.ok(sample.after.bytes > 0);
        assert.deepEqual(sample.before_local_files, { files: 3, bytes: 22 });
        assert.deepEqual(sample.after_local_files, { files: 3, bytes: 22 });
        assert.deepEqual(sample, report.runs[0], 'replaying the same checkout must give stable counts');
      }
    } else assert.match(result.stderr, row.error, row.name);
    assert.deepEqual(recoverySnapshot(saved), original, `${row.name} must leave the source recovery directory intact`);
  }
});

test('recovery snapshots keep sizes and digests consistent when files change before reading', (t) => {
  const h = fixture(t);
  const read = fs.readFileSync;
  for (const row of [
    { name: 'growth', before: 'old', after: 'longer contents' },
    { name: 'shrinkage', before: 'long contents', after: 'x' },
    { name: 'same length', before: 'old', after: 'new' },
    { name: 'path replacement', before: 'old', after: 'replacement contents', replace: true },
  ]) {
    const dir = path.join(h.base, `snapshot-${row.name}`);
    const relative = path.join('nested', 'notes.txt');
    const file = path.join(dir, relative);
    write(dir, relative, row.before);
    let changed = false;
    const mock = t.mock.method(fs, 'readFileSync', function (input, ...args) {
      if (input === file && !changed) {
        changed = true;
        if (row.replace) {
          write(h.base, 'replacement.txt', row.after);
          fs.renameSync(path.join(h.base, 'replacement.txt'), file);
        } else fs.writeFileSync(file, row.after);
      }
      return read.call(this, input, ...args);
    });
    try {
      assert.deepEqual(recoverySnapshot(dir), [{ path: relative, bytes: Buffer.byteLength(row.after),
        digest: createHash('sha256').update(row.after).digest('hex') }], row.name);
      assert.equal(changed, true, row.name);
    } finally { mock.mock.restore(); }
  }
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
  { name: 'parent-ignored vendor repository', ignoredRepository: true },
  { name: 'parent-ignored vendor repository inside nested submodules', ignoredRepository: true, modules: true },
  { name: 'parent-ignored vendor repository owning an initialized submodule', ignoredRepository: true, nestedModule: true },
  { name: 'parent-ignored repository beneath a generated directory', ignoredRepository: true, ancestor: 'generated' },
  { name: 'parent-ignored repository beneath a cache-tagged directory', ignoredRepository: true, ancestor: 'cache-tag' },
]) {
  test(`save filtering honors ${row.name}`, (t) => {
    const h = row.modules || row.nestedModule ? moduleFixture(t) : fixture(t);
    const wt = h.json(['worktree', 'T1']);
    if (row.modules) h.git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '-q'], wt.path);
    const checkout = row.modules ? path.join(wt.path, 'module', 'inner') : wt.path;
    const nestedPath = row.ancestor === 'generated' ? 'build/lib' : row.ancestor === 'cache-tag' ? 'cache/lib'
      : row.ignoredRepository ? 'vendor/lib' : 'nested';
    const nested = path.join(checkout, nestedPath);
    fs.mkdirSync(nested, { recursive: true });
    h.git(['init', '-q', '-b', 'main'], nested);
    const generated = ['node_modules', 'target', 'dist', 'build', '.venv', '__pycache__', '.next'];
    const trackedFiles = generated.map((dir) => `${dir}/${dir === 'build' ? 'main.c' : 'tracked.js'}`);
    trackedFiles.push('cache/tracked.js');
    const rules = generated.filter((dir) => dir !== 'target').map((dir) => `${dir}/\n`).join('')
      + 'target/*\n!target/source.js\ncache/\n';
    write(nested, '.gitignore', (row.parentRules ? '' : rules) + 'notes.txt\n');
    write(nested, 'source.js', 'tracked\n');
    for (const file of trackedFiles) write(nested, file, 'tracked source\n');
    if (row.ignoredRepository) write(nested, 'target/source.js', 'tracked exception\n');
    h.git(['add', '.'], nested);
    h.git(['add', '-f', ...trackedFiles], nested);
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
    h.git(['checkout', '-qb', 'build/local'], nested);
    write(nested, 'source.js', 'local commit\n');
    h.git(['commit', '-qam', 'local work'], nested);
    const head = h.git(['rev-parse', 'HEAD'], nested);
    write(checkout, '.gitignore', 'build/\n' + (row.ignoredRepository ? `${nestedPath.split('/')[0]}/\n` : '')
      + (row.parentRules ? rules.split('\n').filter(Boolean)
        .map((rule) => rule.startsWith('!') ? `!${nestedPath}/${rule.slice(1)}` : `${nestedPath}/${rule}`).join('\n') + '\n' : ''));
    h.git(['add', '.gitignore'], checkout);
    h.git(['commit', '-qm', 'parent ignore rules'], checkout);
    write(nested, 'notes.txt', 'handwritten\n');
    for (const file of trackedFiles) write(nested, file, 'edited tracked source\n');
    for (const dir of generated.filter((dir) => !['target', 'node_modules'].includes(dir))) {
      write(nested, `${dir}/output`, 'compiled\n');
    }
    write(nested, 'untracked.js', 'new source\n');
    write(nested, 'target/source.js', 'ignore exception\n');
    write(nested, 'target/output', '');
    sparse(path.join(nested, 'target/output'), SAVE_FILES_LIMIT + 1);
    write(nested, 'node_modules/package/index.js', 'installed\n');
    write(nested, 'cache/CACHEDIR.TAG', 'tag');
    write(nested, 'cache/data', 'cached');
    if (row.ancestor === 'cache-tag') write(checkout, 'cache/CACHEDIR.TAG', 'tag');
    h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
    assert.equal(outcome(h).cmd, 'worktree removed', 'ignored build output must not trigger the guard');
    let saved = outcome(h).detail.saved;
    let manifest = JSON.parse(fs.readFileSync(path.join(saved, 'manifest.json')));
    if (row.modules) {
      saved = JSON.parse(fs.readFileSync(path.join(manifest.submodules[0].saved, 'manifest.json'))).submodules[0].saved;
      manifest = JSON.parse(fs.readFileSync(path.join(saved, 'manifest.json')));
    }
    for (const [file, text] of [
      ['source.js', 'local commit\n'], ['target/source.js', 'ignore exception\n'],
      ...(!row.ancestor ? [['notes.txt', 'handwritten\n'], ['untracked.js', 'new source\n']] : []),
      ...trackedFiles.map((file) => [file, 'edited tracked source\n']),
    ]) assert.equal(fs.readFileSync(path.join(saved, 'files', nestedPath, file), 'utf8'), text);
    for (const file of ['target/output', 'node_modules/package', 'cache/data', 'cache/CACHEDIR.TAG',
      ...generated.filter((dir) => !['target', 'node_modules'].includes(dir)).map((dir) => `${dir}/output`),
      ...(row.ancestor ? ['notes.txt', 'untracked.js'] : [])]) {
      assert.equal(fs.existsSync(path.join(saved, 'files', nestedPath, file)), false, file);
    }
    const skipped = [
      { path: `${nestedPath}/cache`, bytes: 9 },
      ...(row.nestedModule ? [{ path: `${nestedPath}/child/target`, bytes: 9 }] : []),
      ...generated.map((dir) => ({ path: `${nestedPath}/${dir}`,
        bytes: dir === 'target' ? SAVE_FILES_LIMIT + 1 : dir === 'node_modules' ? 10 : 9 })),
    ];
    const expectedSkipped = row.ancestor
      ? [{ path: nestedPath.split('/')[0], bytes: skipped.reduce((sum, entry) => sum + entry.bytes, 0)
        + Buffer.byteLength('handwritten\nnew source\n') + (row.ancestor === 'cache-tag' ? 3 : 0) }]
      : skipped.sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(manifest.skipped_ignored.map(({ path: dir, bytes }) => ({ path: dir, bytes })), expectedSkipped);
    const restored = path.join(saved, 'files', nestedPath);
    assert.equal(h.git(['symbolic-ref', 'HEAD'], restored), 'refs/heads/build/local', 'the active branch remains recoverable');
    assert.equal(h.git(['rev-parse', 'HEAD'], restored), head, 'nested Git commits and refs remain recoverable');
    assert.equal(h.git(['rev-parse', 'build/local'], restored), head, 'ignore patterns must not drop Git refs');
    assert.equal(h.git(['reflog', 'show', '--format=%H', 'build/local'], restored).split('\n')[0], head,
      'ignore patterns must not drop Git reflogs');
    if (row.nestedModule) {
      assert.equal(fs.readFileSync(path.join(restored, 'child', 'notes.txt'), 'utf8'), 'child notes\n');
      assert.equal(fs.readFileSync(path.join(restored, 'child', 'target/source.js'), 'utf8'), 'edited child source\n');
      assert.equal(h.git(['show', 'HEAD:source.txt'], path.join(restored, 'child')), 'tracked source');
    }
  });
}
