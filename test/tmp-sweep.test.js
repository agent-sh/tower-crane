'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { makeRepo, copyRepo, ROOT, HARNESS_GUARD } = require('./helpers');
const { HUNG_TEST_MS } = require('./signals');
const tmp = require('./tmp-root');

const OWNER_FILE = '.tower-crane-test-owner.json';
const AGE_MS = 2 * 60 * 60 * 1000;

function owner(pid, at = Date.now() - AGE_MS - 1000) {
  let pidns = null;
  if (process.platform === 'linux') pidns = fs.readlinkSync('/proc/self/ns/pid');
  return { pid, host: os.hostname(), pidns, at };
}

function deadPid() {
  const child = cp.spawnSync(process.execPath, ['-e', ''], { timeout: HUNG_TEST_MS });
  assert.equal(child.status, 0, String(child.error || child.stderr));
  return child.pid;
}

function plant(root, name, record) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (record) fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify(record));
  fs.writeFileSync(path.join(dir, 'payload'), 'abandoned fixture\n');
  return dir;
}

test('runner startup removes only an old fixture with a dead owner and reports count and bytes', (t) => {
  const h = makeRepo(t);
  const root = path.join(h.base, 'sweep');
  const pid = deadPid();
  const dead = plant(root, 'old-dead', owner(pid));
  const live = plant(root, 'old-live', owner(process.pid));
  const fresh = plant(root, 'fresh-dead', owner(pid, Date.now()));
  const expectedBytes = fs.readdirSync(dead).reduce((sum, file) => sum + fs.lstatSync(path.join(dead, file)).size, 0);
  const probe = path.join(h.base, 'probe.test.js');
  fs.writeFileSync(probe, "require('node:test')('probe', () => {});\n");
  const result = cp.spawnSync(process.execPath, [path.join(ROOT, 'test', 'run.js'), probe], {
    cwd: ROOT,
    env: { ...h.env, TOWER_CRANE_TEST_TMP: root },
    encoding: 'utf8',
    timeout: HUNG_TEST_MS,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(fs.existsSync(dead), false, 'startup must remove the abandoned fixture');
  assert.equal(fs.existsSync(live), true, 'the old live fixture must survive');
  assert.equal(fs.existsSync(fresh), true, 'the fresh fixture must survive');
  assert.match(result.stderr, new RegExp(`^Test tmp sweep: removed 1 directories, ${expectedBytes} bytes$`, 'm'));
});

test('shared fixtures and harness guards record their creating process', (t) => {
  const h = makeRepo(t);
  for (const dir of [h.base, HARNESS_GUARD.dir]) {
    const record = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'));
    assert.equal(record.pid, process.pid);
    assert.equal(record.host, os.hostname());
    assert.ok(record.at <= Date.now());
  }
});

test('fixture copies retain their new creator instead of inheriting source ownership', (t) => {
  const h = makeRepo(t);
  fs.writeFileSync(path.join(h.base, OWNER_FILE), JSON.stringify(owner(deadPid())));
  const copy = copyRepo(t, h.base);
  const record = JSON.parse(fs.readFileSync(path.join(copy.base, OWNER_FILE), 'utf8'));
  assert.equal(record.pid, process.pid);
  assert.ok(record.at > Date.now() - AGE_MS); // wait-allow: the copied fixture must have a fresh creation time under the sweep's age contract.
});

test('sweep retains unmarked, malformed and unverifiable owners', (t) => {
  const h = makeRepo(t);
  const root = path.join(h.base, 'sweep');
  const pid = deadPid();
  for (const [name, record] of [
    ['unmarked', null],
    ['foreign-host', { ...owner(pid), host: 'another-host.invalid' }],
    ['foreign-namespace', { ...owner(pid), pidns: 'another-namespace' }],
    ['invalid-pid', { ...owner(pid), pid: 0 }],
    ['missing-age', { ...owner(pid), at: undefined }],
    ['future-age', owner(pid, Date.now() + AGE_MS)],
  ]) plant(root, name, record);
  const malformed = plant(root, 'malformed');
  fs.writeFileSync(path.join(malformed, OWNER_FILE), '{');
  const nonregular = plant(root, 'nonregular');
  fs.mkdirSync(path.join(nonregular, OWNER_FILE));
  const before = fs.readdirSync(root).sort();
  assert.deepEqual(tmp.sweepTempRoot(root), { count: 0, bytes: 0 });
  assert.deepEqual(fs.readdirSync(root).sort(), before);
});

test('sweep keeps fixtures at the age boundary and when the PID probe is uncertain', (t) => {
  const h = makeRepo(t);
  const root = path.join(h.base, 'sweep');
  const now = Date.now();
  plant(root, 'boundary', owner(deadPid(), now - AGE_MS));
  assert.deepEqual(tmp.sweepTempRoot(root, now), { count: 0, bytes: 0 });
  for (const code of ['EPERM', 'EACCES', 'EIO']) {
    t.mock.method(require('./signals'), 'killPid', () => { throw Object.assign(new Error('probe failed'), { code }); });
    assert.deepEqual(tmp.sweepTempRoot(root, now + 1), { count: 0, bytes: 0 }, code);
    t.mock.restoreAll();
  }
});

test('sweep never follows directory or owner symlinks outside its root', (t) => {
  const h = makeRepo(t);
  const root = path.join(h.base, 'sweep');
  const outside = plant(h.base, 'outside', owner(deadPid()));
  fs.mkdirSync(root);
  const top = path.join(root, 'top-link');
  const dead = plant(root, 'old-dead', owner(deadPid()));
  const markerLink = plant(root, 'marker-link');
  const nested = path.join(dead, 'nested-link');
  fs.symlinkSync(outside, top, process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(outside, nested, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    fs.symlinkSync(path.join(outside, OWNER_FILE), path.join(markerLink, OWNER_FILE), 'file');
  } catch (error) {
    // Windows junctions need no privilege; file symlinks do on some runners.
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
  }
  const expectedBytes = fs.readdirSync(dead).reduce((sum, file) => sum + fs.lstatSync(path.join(dead, file)).size, 0);
  const snapshot = fs.readdirSync(outside).map((file) => [file, fs.readFileSync(path.join(outside, file), 'utf8')]);
  assert.deepEqual(tmp.sweepTempRoot(root), { count: 1, bytes: expectedBytes });
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.lstatSync(top).isSymbolicLink(), true);
  assert.equal(fs.existsSync(markerLink), true);
  assert.deepEqual(fs.readdirSync(outside).map((file) => [file, fs.readFileSync(path.join(outside, file), 'utf8')]), snapshot);
  assert.deepEqual(tmp.sweepTempRoot(top), { count: 0, bytes: 0 });
  assert.deepEqual(tmp.sweepTempRoot(path.join(h.base, 'absent')), { count: 0, bytes: 0 });
});

test('sweep retains fixtures when ownership markers change while being opened', async (t) => {
  const h = makeRepo(t);
  const pid = deadPid();
  const outside = plant(h.base, 'race-outside', owner(pid));
  const outsideMarker = path.join(outside, OWNER_FILE);
  const snapshot = fs.readFileSync(outsideMarker, 'utf8');
  let fileSymlinks = true;
  try { fs.symlinkSync(outsideMarker, path.join(h.base, 'link-probe'), 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    fileSymlinks = false;
  }
  for (const [when, replacement] of [
    ['before-open', 'symlink'],
    ['after-open', 'symlink'],
    ['after-open', 'live-owner'],
    ['after-open', 'removed'],
    ['after-read', 'live-owner-in-place'],
    ['before-open', 'directory-link'],
    ['before-open', 'root-link'],
  ]) {
    await t.test(`${when}: ${replacement}`, (row) => {
      if (replacement === 'symlink' && !fileSymlinks) {
        row.skip('Windows file symlinks require privilege on this runner');
        return;
      }
      const root = path.join(h.base, `${when}-${replacement}`);
      const dir = plant(root, 'fixture', owner(pid));
      const marker = path.join(dir, OWNER_FILE);
      const otherRoot = path.join(h.base, `${when}-${replacement}-outside`);
      const otherDir = plant(otherRoot, 'fixture', owner(pid));
      const otherSnapshot = fs.readFileSync(path.join(otherDir, OWNER_FILE), 'utf8');
      const open = fs.openSync;
      const read = fs.readFileSync;
      let swapped = false;
      let opened;
      const swap = () => {
        swapped = true;
        if (replacement === 'live-owner-in-place') {
          fs.writeFileSync(marker, JSON.stringify({ ...owner(process.pid), note: 'new live owner' }));
          return;
        }
        if (replacement === 'directory-link' || replacement === 'root-link') {
          const from = replacement === 'root-link' ? root : dir;
          const to = replacement === 'root-link' ? otherRoot : otherDir;
          fs.renameSync(from, `${from}-before`);
          fs.symlinkSync(to, from, process.platform === 'win32' ? 'junction' : 'dir');
          return;
        }
        fs.unlinkSync(marker);
        if (replacement === 'symlink') fs.symlinkSync(outsideMarker, marker, 'file');
        else if (replacement === 'live-owner') fs.writeFileSync(marker, JSON.stringify(owner(process.pid)));
      };
      row.mock.method(fs, 'openSync', (file, ...args) => {
        if (file !== marker || swapped) return open(file, ...args);
        if (when === 'before-open') swap();
        const fd = open(file, ...args);
        opened = fd;
        try {
          if (when === 'after-open') swap();
          return fd;
        } catch (error) { fs.closeSync(fd); throw error; }
      });
      // The pathname reader's native fast path bypasses JavaScript openSync.
      row.mock.method(fs, 'readFileSync', (file, ...args) => {
        if (when === 'after-read' && file === opened && !swapped) {
          const text = read(file, ...args);
          swap();
          return text;
        }
        if (file !== marker || swapped) return read(file, ...args);
        if (when === 'before-open') {
          swap();
          return read(file, ...args);
        }
        const fd = open(file, fs.constants.O_RDONLY);
        try {
          if (when === 'after-open') swap();
          const text = read(fd, ...args);
          if (when === 'after-read') swap();
          return text;
        }
        finally { fs.closeSync(fd); }
      });
      assert.deepEqual(tmp.sweepTempRoot(root), { count: 0, bytes: 0 });
      assert.equal(swapped, true, 'the marker must change at the intended race point');
      assert.equal(fs.existsSync(dir), true);
      if (opened !== undefined) assert.throws(() => fs.fstatSync(opened), { code: 'EBADF' });
      assert.equal(fs.readFileSync(outsideMarker, 'utf8'), snapshot);
      assert.equal(fs.readFileSync(path.join(otherDir, OWNER_FILE), 'utf8'), otherSnapshot);
    });
  }
});
