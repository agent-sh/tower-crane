'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT, TMP_ROOT } = require('./helpers');

const SCRIPT = path.join(ROOT, 'scripts', 'suites-per-accept.js');

function eventLog(t, events) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-suites-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(base, 'events.jsonl');
  // The last line is cut short, as when a writer is mid-append.
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n{"at":"2026-10-21T`);
  return file;
}

const measure = (...args) => cp.spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('suites-per-accept counts suites per accepted task and the suites run before each failed review', (t) => {
  const tests = (task, at, sha, revision) => ({ at, cmd: 'check tests', task, detail: { sha, revision } });
  const file = eventLog(t, [
    tests('T1', '2026-10-20T23:00:00Z', 'aaaa', 1),
    // Before the window: not in `suites`, but still a suite the failed review below threw away.
    tests('T1', '2026-10-20T20:00:00Z', 'aaaa', 1),
    tests('T1', '2026-10-21T01:00:00Z', 'aaaa1111', 1),
    // Another head and another revision run no suite before the review below.
    tests('T1', '2026-10-21T01:30:00Z', 'bbbb', 1),
    tests('T1', '2026-10-21T01:40:00Z', 'aaaa', 2),
    { at: '2026-10-21T02:00:00Z', cmd: 'evidence', task: 'T1', detail: { type: 'review', ok: false, sha: 'aaaa', revision: 1 } },
    { at: '2026-10-21T02:30:00Z', cmd: 'evidence', task: 'T1', detail: { type: 'review', ok: true, sha: 'cccc', revision: 3 } },
    tests('T1', '2026-10-21T03:00:00Z', 'aaaa', 1),
    tests('T2', '2026-10-21T04:00:00Z', 'dddd', 1),
    { at: '2026-10-21T05:00:00Z', cmd: 'accept', task: 'T2' },
    { at: '2026-10-21T05:10:00Z', cmd: 'accept', task: 'T2' },
    { at: '2026-10-21T14:00:00Z', cmd: 'accept', task: 'T1' },
  ]);
  const r = measure(file, '2026-10-20T21:00:00Z', '2026-10-21T13:00:00Z');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    from: '2026-10-20T21:00:00Z', to: '2026-10-21T13:00:00Z', suites: 6, accepted: 1,
    suites_per_accepted: 6, failed_reviews: 1, suites_before_failed_review: 3,
  });
  const empty = measure(file, '2026-10-22T00:00:00Z', '2026-10-23T00:00:00Z');
  assert.equal(JSON.parse(empty.stdout).suites_per_accepted, null, 'a window with no accept has no ratio');
});

test('suites-per-accept without its three arguments prints usage and exits 2', () => {
  const r = measure('events.jsonl');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^usage: node scripts\/suites-per-accept\.js EVENTS_JSONL FROM_ISO TO_ISO/);
});
