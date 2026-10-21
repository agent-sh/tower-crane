'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { cachedFixture } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const Archive = require('../lib/archive');

const MIB = 1024 * 1024;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const POSIX = process.platform !== 'win32';

function setTask(h, id, fields) {
  const doc = h.readState('tasks.json');
  Object.assign(doc.tasks.find((t) => t.id === id), fields);
  h.writeState('tasks.json', doc);
}

const task = (h, id) => h.readState('tasks.json').tasks.find((t) => t.id === id);
const manifest = (h, id) => JSON.parse(fs.readFileSync(path.join(h.state, 'archive', id, 'manifest.json'), 'utf8'));
const stored = (h, id, rel) => fs.readFileSync(path.join(h.state, 'archive', id, 'files', ...rel.split('/')));

// T1 submitted with PR 7 and every gate passed, so accept goes straight to acceptance; T2 is open.
// Spawn records a worker's scratch; each test sets T1's the same way.
function ready(t) {
  const h = cachedFixture(t, 'archive-ready', (h) => {
    h.init();
    h.sha = gateFixture(h);
    h.ok(['project', 'set', '--repo', 'acme/demo']);
    h.ok(['task', 'add', '--title', 'Probe', '--acceptance', 'measures it']);
    h.ok(['task', 'add', '--title', 'Uses the probe', '--acceptance', 'reads it']);
    h.ok(['claim', 'T1', '--agent', 'w-1']);
    h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'w-1', '--pr', '7']);
    for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'w-1');
    h.reviewer('T1', 'r-1');
    h.ok(['evidence', 'T1', '--revision', '1', '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'r-1']);
    return { sha: h.sha };
  });
  h.scratch = path.join(h.base, 'scratch', 'T1');
  fs.mkdirSync(path.join(h.scratch, 'probe'), { recursive: true });
  fs.writeFileSync(path.join(h.scratch, 'probe', 'stderr.log'), 'rss_kb 812344\n');
  setTask(h, 'T1', { scratch: h.scratch });
  return h;
}

test('accept archives the scratch with a manifest, cuts a file over the per-file cap and leaves tool caches out', (t) => {
  const h = ready(t);
  fs.writeFileSync(path.join(h.scratch, 'fill.json'), '{"filled": 4096}\n');
  fs.writeFileSync(path.join(h.scratch, 'argv.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  fs.writeFileSync(path.join(h.scratch, 'big.log'), 'x'.repeat(Archive.FILE_BYTES + MIB));
  fs.mkdirSync(path.join(h.scratch, 'npm', '_cacache'), { recursive: true });
  fs.writeFileSync(path.join(h.scratch, 'npm', '_cacache', 'index'), 'download\n');

  h.ok(['accept', 'T1']);
  const t1 = task(h, 'T1');
  assert.equal(t1.status, 'accepted');
  assert.equal(t1.archive.path, 'archive/T1');
  assert.equal(t1.archive.files, 4);
  const m = manifest(h, 'T1');
  assert.equal(m.reason, 'accept');
  assert.equal(m.sha, h.sha);
  assert.deepEqual(m.files.map((f) => f.path), ['argv.bin', 'big.log', 'fill.json', 'probe/stderr.log']);
  for (const f of m.files) {
    const data = stored(h, 'T1', f.path);
    assert.equal(f.sha256, sha256(data), f.path);
    assert.equal(f.stored, data.length, f.path);
    assert.equal(f.size, fs.statSync(path.join(h.scratch, ...f.path.split('/'))).size, f.path);
  }
  const big = m.files.find((f) => f.path === 'big.log');
  assert.equal(big.truncated, true);
  assert.ok(big.stored <= Archive.FILE_BYTES);
  assert.match(stored(h, 'T1', 'big.log').toString().slice(-80), /\[archive: truncated at 8 MiB of 9437184 bytes\]\n$/);
  assert.match(m.notice, /1 file cut at 8 MiB/);
  assert.equal(m.files.find((f) => f.path === 'argv.bin').binary, true);
  assert.deepEqual(stored(h, 'T1', 'argv.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  assert.match(h.ok(['task', 'show', 'T1']), /archive: archive\/T1, 4 files/);
  if (POSIX) {
    assert.equal(fs.statSync(path.join(h.state, 'archive', 'T1')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(h.state, 'archive', 'T1', 'manifest.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(h.state, 'archive', 'T1', 'files', 'fill.json')).mode & 0o777, 0o600);
  }
});

test('a scratch path the notes or the PR body cite is kept whole past the per-file cap', (t) => {
  const h = ready(t);
  const size = Archive.FILE_BYTES + MIB;
  fs.writeFileSync(path.join(h.scratch, 'big.log'), 'y'.repeat(size));
  fs.writeFileSync(path.join(h.scratch, 'probe', 'argv.txt'), 'node --max-old-space-size=512 probe.js\n');
  h.ok(['task', 'note', 'T1', `RSS telemetry: ${h.scratch}/big.log.`]);
  h.ok(['accept', 'T1'], { env: { FIXTURE_PR_BODY: 'Probe argv in `$XDG_CACHE_HOME/probe/argv.txt`.' } });
  const m = manifest(h, 'T1');
  assert.deepEqual(m.cited, ['big.log', 'probe/argv.txt']);
  const big = m.files.find((f) => f.path === 'big.log');
  assert.equal(big.cited, true);
  assert.equal(big.truncated, undefined);
  assert.equal(big.stored, size);
  assert.equal(m.files.find((f) => f.path === 'probe/argv.txt').cited, true);
  assert.equal(m.notice, null);
});

test('accept refuses, naming them, when a cited path is missing or over the hard cap', (t) => {
  const h = ready(t);
  fs.writeFileSync(path.join(h.scratch, 'huge.bin'), Buffer.alloc(Archive.HARD_BYTES + 1, 1));
  h.ok(['task', 'note', 'T1', `fill record: ${h.scratch}/gone.txt and ${h.scratch}/huge.bin`]);
  const r = h.run(['accept', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cited scratch paths cannot be archived: gone\.txt \(missing; cited in a note\); huge\.bin \(33554433 bytes, over the 32 MiB hard cap; cited in a note\); restore each in the task scratch, then retry/);
  assert.equal(task(h, 'T1').status, 'submitted');
  // Only a path the PR body alone cites can be fixed by editing the body, and only then is that offered.
  const both = h.run(['accept', 'T1'], { env: { FIXTURE_PR_BODY: `see ${h.scratch}/gone.txt and $XDG_CACHE_HOME/body.txt` } });
  assert.equal(both.code, 1);
  assert.match(both.stderr, /body\.txt \(missing; cited in the PR body\); gone\.txt \(missing; cited in the PR body, a note\); .*or drop the citation from the PR body where only the PR body cites it/);
  assert.equal(fs.existsSync(path.join(h.state, 'archive', 'T1')), false);
  // Restoring the file and dropping the oversized citation lets it through.
  fs.writeFileSync(path.join(h.scratch, 'gone.txt'), 'back\n');
  fs.rmSync(path.join(h.scratch, 'huge.bin'));
  setTask(h, 'T1', { notes: [{ at: new Date().toISOString(), agent: 'w-1', text: `fill record: ${h.scratch}/gone.txt` }] });
  h.ok(['accept', 'T1']);
  assert.deepEqual(manifest(h, 'T1').cited, ['gone.txt']);
});

test('$XDG_CACHE_HOME a reviewer or the orchestrator wrote is their own cache and does not block accept', (t) => {
  const h = ready(t);
  h.ok(['task', 'note', 'T1', 'replayed the probe into $XDG_CACHE_HOME/probe.log', '--agent', 'r-1']);
  h.ok(['task', 'note', 'T1', 'gate log at ${XDG_CACHE_HOME}/ci.log', '--agent', 'orchestrator']);
  h.ok(['evidence', 'T1', '--type', 'note', '--ok', '--summary', 'checked $XDG_CACHE_HOME/review.txt', '--agent', 'r-1']);
  h.ok(['task', 'note', 'T1', 'telemetry in $XDG_CACHE_HOME/probe/stderr.log', '--agent', 'w-1']);
  h.ok(['accept', 'T1']);
  assert.equal(task(h, 'T1').status, 'accepted');
  assert.deepEqual(manifest(h, 'T1').cited, ['probe/stderr.log']);
});

test('task archive lists an archive and copies it into another task with evidence, for a granted worker', (t) => {
  const h = ready(t);
  h.ok(['accept', 'T1']);
  const listing = h.ok(['task', 'archive', 'T1', '--path', 'probe']);
  assert.match(listing, /probe\/stderr\.log {2}14 bytes {2}sha256 [0-9a-f]{64}/);
  assert.match(h.run(['task', 'archive', 'T1', '--path', 'nothere']).stderr, /holds no nothere/);

  const into = path.join(h.base, 'scratch', 'T2');
  fs.mkdirSync(into, { recursive: true });
  setTask(h, 'T2', { scratch: into });
  h.ok(['claim', 'T2', '--agent', 'w-2']);
  const denied = h.run(['task', 'archive', 'T1', '--into', 'T2', '--agent', 'w-2']);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /grant names T1/);
  assert.match(h.run(['task', 'archive', 'T1', '--grant', 'T2', '--agent', 'w-2']).stderr, /operational/);
  h.ok(['task', 'archive', 'T1', '--grant', 'T2', '--agent', 'orchestrator']);
  assert.deepEqual(task(h, 'T2').archive_grants, ['T1']);

  // A link the worker left at the copy's name is replaced, never followed.
  const outside = path.join(h.base, 'outside.txt');
  fs.writeFileSync(outside, 'keep\n');
  const name = Archive.copyName('T1', 'probe/stderr.log');
  if (POSIX) fs.symlinkSync(outside, path.join(into, name));
  h.ok(['task', 'archive', 'T1', '--into', 'T2', '--path', 'probe/stderr.log', '--agent', 'w-2']);
  assert.equal(name, 'archive-T1-probe%2Fstderr.log');
  assert.equal(fs.lstatSync(path.join(into, name)).isFile(), true);
  assert.equal(fs.readFileSync(path.join(into, name), 'utf8'), 'rss_kb 812344\n');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep\n');
  const evidence = task(h, 'T2').evidence.find((e) => e.type === 'archive');
  assert.equal(evidence.from, 'T1');
  assert.equal(evidence.agent, 'w-2');
  assert.deepEqual(evidence.files.map((f) => [f.path, f.file, f.sha256]), [['probe/stderr.log', name, sha256('rss_kb 812344\n')]]);
  assert.match(h.ok(['task', 'show', 'T2']), /archive ok .* copied 1 file from T1's archive/);
  // The orchestrator needs no grant.
  h.ok(['task', 'archive', 'T1', '--into', 'T2', '--agent', 'orchestrator']);
  assert.equal(task(h, 'T2').evidence.filter((e) => e.type === 'archive').at(-1).files.length, 1);
});

test('the retention sweep removes archives past archive.retention_days', (t) => {
  const h = ready(t);
  h.ok(['accept', 'T1']);
  const file = path.join(h.state, 'archive', 'T1', 'manifest.json');
  const m = manifest(h, 'T1');
  fs.writeFileSync(file, JSON.stringify({ ...m, archived_at: new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString() }));
  h.ok(['project', 'set', '--archive-retention-days', '60', '--agent', 'orchestrator']);
  assert.match(h.ok(['project', 'show']), /archive\.retention_days: 60/);
  h.ok(['task', 'archive', 'T1']);
  h.ok(['project', 'set', '--archive-retention-days', 'null', '--agent', 'orchestrator']);
  assert.match(h.ok(['project', 'show']), /archive\.retention_days: 30/);
  const gone = h.run(['task', 'archive', 'T1']);
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /archive from .* is gone; archives are kept 30 days/);
  assert.equal(fs.existsSync(path.join(h.state, 'archive', 'T1')), false);
  assert.match(h.run(['project', 'set', '--archive-retention-days', '0']).stderr, /positive number of days/);
});

test('archived text passes through the gate log redaction', (t) => {
  const h = ready(t);
  const token = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
  const secret = 'Zx9Qw8Er7Ty6Ui5Op4As3Df2';
  fs.writeFileSync(path.join(h.scratch, 'probe', 'stderr.log'), `auth ${token}\n\x1b[31mkey\x1b[0m ${secret}\n`);
  fs.writeFileSync(path.join(h.scratch, 'raw.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(token)]));
  h.ok(['accept', 'T1'], { env: { ARCHIVE_PROBE_TOKEN: secret } });
  const text = stored(h, 'T1', 'probe/stderr.log').toString();
  assert.equal(text, 'auth [redacted:GITHUB_TOKEN]\nkey [redacted:ARCHIVE_PROBE_TOKEN]\n');
  assert.equal(manifest(h, 'T1').files.find((f) => f.path === 'probe/stderr.log').redacted, true);
  assert.ok(!stored(h, 'T1', 'raw.bin').includes(token));
  assert.equal(manifest(h, 'T1').files.find((f) => f.path === 'raw.bin').binary, true);
});

test('cancel archives the scratch before retirement removes it', (t) => {
  const h = ready(t);
  const scratch = path.join(h.base, 'scratch', 'T2');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'notes.txt'), 'half done\n');
  setTask(h, 'T2', { scratch });
  h.ok(['task', 'update', 'T2', '--status', 'cancelled']);
  const t2 = task(h, 'T2');
  assert.equal(t2.status, 'cancelled');
  assert.equal(t2.scratch, undefined);
  assert.equal(fs.existsSync(scratch), false);
  assert.equal(t2.archive.reason, 'cancel');
  assert.equal(manifest(h, 'T2').reason, 'cancel');
  assert.equal(stored(h, 'T2', 'notes.txt').toString(), 'half done\n');
});

test('citations find the scratch path in its absolute, home and XDG_CACHE_HOME forms', () => {
  const scratch = path.join(os.homedir(), '.cache', 'tower-crane', 'tasks', 'abc123def456', 'T5');
  const home = `~${scratch.slice(os.homedir().length)}`;
  const cases = [
    ['absolute path with a trailing period', `see ${scratch}/rss/stderr.log.`, ['rss/stderr.log']],
    ['home form in backticks', `kept in \`${home}/fill.json\``, ['fill.json']],
    ['XDG_CACHE_HOME in the task\'s own text', 'argv at $XDG_CACHE_HOME/argv.txt and ${XDG_CACHE_HOME}/b.txt', ['argv.txt', 'b.txt']],
    ['a path that leaves the scratch', `${scratch}/../T6/x.log`, []],
    ['another task\'s scratch', `${scratch}9/x.log ${path.dirname(scratch)}/T6/y.log`, []],
    ['the scratch root alone', `everything is in ${scratch}/ and ${scratch}`, []],
    ['a markdown link', `[log](${scratch}/a/b.log)`, ['a/b.log']],
  ];
  for (const [what, text, expected] of cases) {
    const st = { decisions: { decisions: [] }, events: [] };
    assert.deepEqual(Archive.citations(st, { id: 'T5', scratch, notes: [{ agent: 'w-1', text }], evidence: [], claim: { agent: 'w-1' } }), expected, what);
  }
  // $XDG_CACHE_HOME is the scratch only for the task's workers: the claim holder, past claim
  // holders and spawned workers. The scratch path itself cites from anyone.
  const events = [
    { task: 'T5', cmd: 'claim', agent: 'w-1', detail: { holder: 'w-1' } },
    { task: 'T5', cmd: 'claim', agent: 'orchestrator', detail: { holder: 'w-2' } },
    { task: 'T5', cmd: 'spawn', agent: 'orchestrator', detail: { role: 'worker', agent: 'w-3' } },
    { task: 'T5', cmd: 'spawn', agent: 'orchestrator', detail: { role: 'reviewer', agent: 'r-1' } },
    { task: 'T6', cmd: 'claim', agent: 'w-9', detail: { holder: 'w-9' } },
  ];
  const by = [
    ['current claim holder without an event', 'w-0', { agent: 'w-0' }, true],
    ['an earlier claim holder', 'w-1', null, true],
    ['a holder claimed for by the orchestrator', 'w-2', null, true],
    ['a spawned worker', 'w-3', null, true],
    ['a reviewer', 'r-1', null, false],
    ['the orchestrator', 'orchestrator', null, false],
    ['the owner', 'owner', null, false],
    ['another task\'s worker', 'w-9', null, false],
    ['no recorded agent', undefined, null, false],
  ];
  for (const [what, agent, claim, isWorker] of by) {
    const st = { decisions: { decisions: [] }, events };
    const note = { scratch, id: 'T5', claim, notes: [{ agent, text: 'see $XDG_CACHE_HOME/x.log' }], evidence: [] };
    assert.deepEqual(Archive.citations(st, note), isWorker ? ['x.log'] : [], `note by ${what}`);
    const ev = { scratch, id: 'T5', claim, notes: [], evidence: [{ type: 'review', agent, summary: 'see ${XDG_CACHE_HOME}/y.log', findings: [{ body: '$XDG_CACHE_HOME/z.log' }] }] };
    assert.deepEqual(Archive.citations(st, ev), isWorker ? ['y.log', 'z.log'] : [], `evidence by ${what}`);
    const abs = { scratch, id: 'T5', claim, notes: [{ agent, text: `see ${scratch}/a.log` }], evidence: [] };
    assert.deepEqual(Archive.citations(st, abs), ['a.log'], `absolute path by ${what}`);
  }
  // The PR body is the worker's; a decision cites the scratch only by its path.
  const st = { decisions: { decisions: [{ question: `use ${scratch}/d.log`, why: '$XDG_CACHE_HOME/e.log' }] }, events: [] };
  assert.deepEqual(Archive.citations(st, { id: 'T5', scratch, notes: [], evidence: [] }, 'probe at $XDG_CACHE_HOME/f.log'), ['d.log', 'f.log']);
});
