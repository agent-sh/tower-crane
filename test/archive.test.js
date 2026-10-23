'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { cachedFixture, useFixtureUserFile } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const Archive = require('../lib/archive');
const S = require('../lib/state');

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
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
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

test('a refused accept is an inbox item, and the orchestrator drops a stale citation with an audit', (t) => {
  const h = ready(t);
  fs.mkdirSync(path.join(h.scratch, 'runs'));
  h.ok(['task', 'note', 'T1', 'probe runs in $XDG_CACHE_HOME/runs and fill record in $XDG_CACHE_HOME/fill.json', '--agent', 'w-1']);
  const r = h.run(['accept', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fill\.json \(missing; cited in a note\); runs \(an empty directory; cited in a note\); restore each in the task scratch, then retry; the orchestrator drops a stale citation with tower-crane accept T1 --drop-citation PATH --reason R/);
  // A repeat at the same head records no second refusal.
  assert.equal(h.run(['accept', 'T1']).code, 1);
  const refusals = () => events(h).filter((e) => e.cmd === 'archive refused');
  assert.equal(refusals().length, 1);
  const inbox = () => h.json(['inbox', '--agent', 'orchestrator']).items.filter((i) => i.kind === 'archive_refused');
  const [entry] = inbox();
  assert.equal(entry.task, 'T1');
  assert.deepEqual(entry.paths.map((p) => [p.path, p.reason, p.cited_in]), [['fill.json', 'missing', ['a note']], ['runs', 'an empty directory', ['a note']]]);
  assert.equal(entry.action.command, 'tower-crane accept T1');
  assert.equal(entry.drop_citation, "tower-crane accept T1 --drop-citation fill.json --drop-citation runs --reason '<why>'");

  assert.match(h.run(['accept', 'T1', '--drop-citation', 'fill.json']).stderr, /needs --reason/);
  assert.match(h.run(['accept', 'T1', '--drop-citation', 'fill.json', '--reason', 'never written', '--agent', 'w-1']).stderr, /accept\.drop_citation is operational/);
  assert.match(h.run(['accept', 'T1', '--drop-citation', 'other.log', '--reason', 'x', '--agent', 'orchestrator']).stderr, /names no cited path: other\.log; cited: fill\.json, runs/);
  // Dropping one citation still refuses on the other.
  assert.match(h.run(['accept', 'T1', '--drop-citation', 'fill.json', '--reason', 'x', '--agent', 'orchestrator']).stderr, /cannot be archived: runs \(an empty directory/);
  h.ok(['accept', 'T1', '--drop-citation', 'fill.json', '--drop-citation', 'runs', '--reason', 'the probe was rerun under T2', '--agent', 'orchestrator']);
  assert.equal(task(h, 'T1').status, 'accepted');
  assert.deepEqual(inbox(), []);
  const m = manifest(h, 'T1');
  assert.deepEqual(m.cited, []);
  assert.deepEqual(m.dropped.map((d) => [d.path, d.reason, d.by]), [['fill.json', 'the probe was rerun under T2', 'orchestrator'], ['runs', 'the probe was rerun under T2', 'orchestrator']]);
  const log = events(h);
  const accepted = log.findLast((e) => e.cmd === 'accept' && e.task === 'T1');
  assert.deepEqual(accepted.detail.dropped_citations, ['fill.json', 'runs']);
  assert.equal(accepted.detail.reason, 'the probe was rerun under T2');
  const audit = log[log.indexOf(accepted) - 1];
  assert.equal(audit.cmd, 'setting');
  assert.deepEqual(audit.detail.settings, { 'accept.drop_citation': 'operational' });
  // Retirement's refresh keeps the drop and does not cite the paths again.
  // In process, with the fixture's user config, as retirement calls it.
  const config = process.env.TOWER_CRANE_CONFIG;
  process.env.TOWER_CRANE_CONFIG = h.userConfig;
  let again;
  try { again = Archive.save({ stateDir: h.state, cwd: h.repo }, S.loadState(h.state), task(h, 'T1'), { reason: 'accept' }); }
  finally { if (config === undefined) delete process.env.TOWER_CRANE_CONFIG; else process.env.TOWER_CRANE_CONFIG = config; }
  assert.equal(again.missing_cited, undefined);
  assert.deepEqual(manifest(h, 'T1').dropped.map((d) => d.path), ['fill.json', 'runs']);
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

test('a glob or placeholder in a worker note does not block accept on its literal prefix', (t) => {
  const h = ready(t);
  fs.writeFileSync(path.join(h.scratch, 'probe-1.log'), 'rss 1\n');
  fs.writeFileSync(path.join(h.scratch, 'probe-2.log'), 'rss 2\n');
  h.ok(['task', 'note', 'T1', 'RSS runs in $XDG_CACHE_HOME/probe-*.log', '--agent', 'w-1']);
  h.ok(['task', 'note', 'T1', 'layout is $XDG_CACHE_HOME/tower-crane/tasks/<hash>/<task>', '--agent', 'w-1']);
  h.ok(['accept', 'T1']);
  assert.equal(task(h, 'T1').status, 'accepted');
  const m = manifest(h, 'T1');
  assert.deepEqual(m.cited, []);
  assert.deepEqual(m.files.map((f) => f.path).sort(), ['probe-1.log', 'probe-2.log', 'probe/stderr.log']);
});

test('a line location or parentheses in a cited path do not block accept on a path nobody named', (t) => {
  const h = ready(t);
  fs.writeFileSync(path.join(h.scratch, 'report(1).txt'), 'second run\n');
  h.ok(['task', 'note', 'T1', 'RSS peak at $XDG_CACHE_HOME/probe/stderr.log:1', '--agent', 'w-1']);
  h.ok(['task', 'note', 'T1', 'second run in $XDG_CACHE_HOME/report(1).txt', '--agent', 'w-1']);
  h.ok(['accept', 'T1']);
  assert.equal(task(h, 'T1').status, 'accepted');
  assert.deepEqual(manifest(h, 'T1').cited, ['probe/stderr.log', 'report(1).txt']);
});

test('an accept the gates refuse writes no archive, and its --drop-citation carries no weight', (t) => {
  const h = ready(t);
  h.ok(['task', 'note', 'T1', 'fill in $XDG_CACHE_HOME/fill.json', '--agent', 'w-1']);
  gateEvidence(h, 'clean', 'orchestrator', false);
  const r = h.run(['accept', 'T1', '--drop-citation', 'fill.json', '--reason', 'x', '--agent', 'orchestrator']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /T1 cannot be accepted yet: clean: latest clean at .* failed/);
  assert.equal(fs.existsSync(path.join(h.state, 'archive', 'T1')), false);
  assert.deepEqual(events(h).filter((e) => e.cmd === 'archive refused'), []);
  gateEvidence(h, 'clean', 'orchestrator', true);
  // An archive an accept wrote before its acceptance write refused (the head moved) lists the
  // drop with no accept event behind it; the next accept cites the path again.
  const config = process.env.TOWER_CRANE_CONFIG;
  process.env.TOWER_CRANE_CONFIG = h.userConfig;
  try {
    Archive.save({ stateDir: h.state, cwd: h.repo }, S.loadState(h.state), task(h, 'T1'),
      { reason: 'accept', strict: true, drop: [{ path: 'fill.json', reason: 'x', by: 'orchestrator', at: new Date().toISOString() }] });
  } finally { if (config === undefined) delete process.env.TOWER_CRANE_CONFIG; else process.env.TOWER_CRANE_CONFIG = config; }
  assert.deepEqual(manifest(h, 'T1').dropped.map((d) => d.path), ['fill.json']);
  const again = h.run(['accept', 'T1']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /cannot be archived: fill\.json \(missing; cited in a note\)/);
  assert.equal(task(h, 'T1').status, 'submitted');
  h.ok(['accept', 'T1', '--drop-citation', 'fill.json', '--reason', 'never written', '--agent', 'orchestrator']);
  const log = events(h);
  const accepted = log.findLast((e) => e.cmd === 'accept' && e.task === 'T1');
  assert.deepEqual(accepted.detail.dropped_citations, ['fill.json']);
  assert.deepEqual(log[log.indexOf(accepted) - 1].detail.settings, { 'accept.drop_citation': 'operational' });
  assert.deepEqual(manifest(h, 'T1').dropped.map((d) => [d.path, d.reason]), [['fill.json', 'never written']]);
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

// Swaps the scratch's d for .d-link, a link to a host directory, at the nth open, list or chdir that
// names a path in d, as a worker still running in its sandbox could while the save runs.
function swapAt(h, n) {
  const dirs = [path.join(h.scratch, 'd'), path.join(fs.realpathSync.native(h.scratch), 'd')];
  let seen = 0;
  const touch = (p) => {
    if (typeof p !== 'string' || !dirs.some((d) => p === d || p.startsWith(d + path.sep)) || ++seen !== n) return;
    fs.renameSync(path.join(h.scratch, 'd'), path.join(h.scratch, '.d-real'));
    fs.renameSync(path.join(h.scratch, '.d-link'), path.join(h.scratch, 'd'));
  };
  const hooks = [[fs, 'openSync'], [fs, 'readdirSync'], [process, 'chdir']].map(([obj, name]) => {
    const orig = obj[name];
    obj[name] = function hooked(p, ...rest) { touch(p); return orig.call(this, p, ...rest); };
    return () => { obj[name] = orig; };
  });
  return () => { for (const undo of hooks) undo(); };
}

test('a scratch directory swapped for a link while the save runs archives nothing from the link target', { skip: !POSIX }, async (t) => {
  const pinning = Archive.pinning;
  t.after(() => { Archive.pinning = pinning; });
  const rows = [
    ['before it is listed', 1, (m) => assert.match(m.omitted.find((o) => o.path === 'd').reason, /^unreadable: (ELOOP|ENOTDIR|outside the scratch)$/)],
    ['before its first file opens', 2, (m) => assert.deepEqual(m.omitted.filter((o) => o.path.startsWith('d/')).map((o) => [o.path, o.reason]),
      ['f0', 'f1', 'f2'].map((f) => [`d/${f}`, 'outside the scratch']))],
  ];
  for (const mode of pinning === 'fd' ? ['fd', 'cwd'] : ['cwd']) {
    for (const [when, n, check] of rows) {
      await t.test(`${mode}, swapped ${when}`, (st) => {
        const h = ready(st);
        useFixtureUserFile(st, h);
        const host = path.join(h.base, 'swap-target');
        fs.mkdirSync(path.join(h.scratch, 'd'));
        fs.mkdirSync(host);
        for (const f of ['f0', 'f1', 'f2']) {
          fs.writeFileSync(path.join(h.scratch, 'd', f), 'scratch content\n');
          fs.writeFileSync(path.join(host, f), 'HOST-ONLY-CONTENT\n');
        }
        fs.symlinkSync(host, path.join(h.scratch, '.d-link'));
        Archive.pinning = mode;
        const undo = swapAt(h, n);
        try { Archive.save({ stateDir: h.state, cwd: h.repo }, S.loadState(h.state), task(h, 'T1'), { reason: 'cancel' }); } finally { undo(); }
        const m = manifest(h, 'T1');
        assert.deepEqual(m.files.map((f) => f.path), ['probe/stderr.log']);
        assert.ok(!m.files.some((f) => stored(h, 'T1', f.path).includes('HOST-ONLY')));
        check(m);
      });
    }
  }
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
    ['bold and italic emphasis', `**${scratch}/bold.log** and *$XDG_CACHE_HOME/em.log*`, ['bold.log', 'em.log']],
    ['emphasis with a period outside or inside', `**${scratch}/out.log**. and **${scratch}/in.log.**`, ['in.log', 'out.log']],
    ['an HTML closing tag', `<code>${scratch}/c.log</code>`, ['c.log']],
    // A pattern or placeholder names no one file; its prefix is not a citation.
    ['a * glob', 'RSS runs in $XDG_CACHE_HOME/probe-*.log', []],
    ['a trailing * glob', `runs in ${scratch}/rss/*`, []],
    ['a ? glob', '$XDG_CACHE_HOME/probe-?.log', []],
    ['a [] class', '$XDG_CACHE_HOME/probe-[12].log', []],
    ['a {} brace list', '$XDG_CACHE_HOME/probe-{1,2}.log', []],
    ['a <placeholder>', '$XDG_CACHE_HOME/tower-crane/tasks/<hash>/<task>', []],
    ['a shell variable', '$XDG_CACHE_HOME/runs/$RUN/out.log and ${XDG_CACHE_HOME}/runs/${RUN}/err.log', []],
    ['an ellipsis segment', `${scratch}/.../stderr.log and ${scratch}/…/x.log`, []],
    ['a pattern beside a real path', '$XDG_CACHE_HOME/probe-*.log and $XDG_CACHE_HOME/probe-1.log', ['probe-1.log']],
    // A line location points into the file; parentheses belong to the name only when it closes them.
    ['a :line location', '$XDG_CACHE_HOME/probe/stderr.log:12', ['probe/stderr.log']],
    ['a :line:col location with a period', `${scratch}/probe/stderr.log:12:5.`, ['probe/stderr.log']],
    ['a :line-line range', '$XDG_CACHE_HOME/probe/stderr.log:12-40', ['probe/stderr.log']],
    ['a #L location', '$XDG_CACHE_HOME/probe/stderr.log#L12', ['probe/stderr.log']],
    ['a #L range in emphasis', '**$XDG_CACHE_HOME/probe/stderr.log#L12-L40**', ['probe/stderr.log']],
    ['parentheses in a name', '$XDG_CACHE_HOME/out/report(1).txt', ['out/report(1).txt']],
    ['a name with parentheses in a markdown link', `[r](${scratch}/out/report(1).txt)`, ['out/report(1).txt']],
    ['a path inside parentheses', '(see $XDG_CACHE_HOME/a.log) and ($XDG_CACHE_HOME/b.log:3).', ['a.log', 'b.log']],
    ['an unclosed parenthesis after a path', '$XDG_CACHE_HOME/a.log(see above and $XDG_CACHE_HOME/run(1)/out(2', ['a.log', 'run(1)/out']],
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
