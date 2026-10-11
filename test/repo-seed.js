'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const { tempRoot } = require('./tmp-root');

function writeObject(repo, type, content) {
  const body = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
  const oid = crypto.createHash('sha1').update(body).digest('hex');
  const file = path.join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.deflateSync(body));
  return oid;
}

function writeIndex(repo, oid, file, size) {
  const name = Buffer.from(file);
  const entry = Buffer.alloc(62 + name.length + 1);
  entry.writeUInt32BE(0o100644, 24);
  entry.writeUInt32BE(size, 36);
  Buffer.from(oid, 'hex').copy(entry, 40);
  entry.writeUInt16BE(name.length, 60);
  name.copy(entry, 62);
  const padding = (8 - (entry.length % 8)) % 8;
  const header = Buffer.alloc(12);
  header.write('DIRC', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);
  const body = Buffer.concat([header, entry, Buffer.alloc(padding)]);
  const checksum = crypto.createHash('sha1').update(body).digest();
  fs.writeFileSync(path.join(repo, '.git', 'index'), Buffer.concat([body, checksum]));
}

function createRepoSeed(tmpRoot = tempRoot()) {
  fs.mkdirSync(tmpRoot, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpRoot, 'tower-crane-seed-')));
  const repo = path.join(base, 'repo');
  try {
    fs.mkdirSync(repo);
    const gitDir = path.join(repo, '.git');
    for (const dir of ['hooks', 'info', 'objects/info', 'objects/pack', 'refs/heads', 'refs/tags', 'logs/refs/heads']) {
      fs.mkdirSync(path.join(gitDir, dir), { recursive: true });
    }
    fs.writeFileSync(
      path.join(gitDir, 'config'),
      `[core]\n\trepositoryformatversion = 0\n\tfilemode = ${process.platform !== 'win32'}\n\tbare = false\n\tlogallrefupdates = true\n\tignorecase = ${process.platform === 'win32'}\n\tautocrlf = false\n`,
    );
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(gitDir, 'description'), "Unnamed repository; edit this file 'description' to name the repository.\n");
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n');
    const readme = Buffer.from('# test\n');
    const blob = writeObject(repo, 'blob', readme);
    const tree = writeObject(repo, 'tree', Buffer.concat([Buffer.from('100644 README.md\0'), Buffer.from(blob, 'hex')]));
    const commit = writeObject(repo, 'commit', Buffer.from(
      `tree ${tree}\nauthor tower-crane test <test@example.invalid> 1700000000 +0000\ncommitter tower-crane test <test@example.invalid> 1700000000 +0000\n\ninit\n`,
    ));
    fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), `${commit}\n`);
    const identity = 'tower-crane test <test@example.invalid>';
    const reflog = `${'0'.repeat(40)} ${commit} ${identity} 1700000000 +0000\tcommit (initial): init\n`;
    fs.writeFileSync(path.join(gitDir, 'logs', 'HEAD'), reflog);
    fs.writeFileSync(path.join(gitDir, 'logs', 'refs', 'heads', 'main'), reflog);
    fs.writeFileSync(path.join(repo, 'README.md'), readme);
    writeIndex(repo, blob, 'README.md', readme.length);
    return { base, repo };
  } catch (error) {
    cleanupRepoSeed({ base });
    throw error;
  }
}

function cleanupRepoSeed(seed) {
  fs.rmSync(seed.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

module.exports = { createRepoSeed, cleanupRepoSeed };
