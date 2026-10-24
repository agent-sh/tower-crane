'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo } = require('./helpers');
const { HUNG_TEST_MS } = require('./signals');

const fixtureDir = path.join(__dirname, 'fixtures');
const receipt = { repo: 'acme/demo', base: 'main', read_at: new Date(100000).toISOString() };
const artifact = { sha: 'a'.repeat(40), tests: [], map: {} };

const observer = `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { readPublished } = require(${JSON.stringify(path.join(__dirname, 'atomic-file.js'))});
const watched = JSON.parse(process.env.TC_MAP_WATCHED);
const write = fs.writeFileSync;
const open = fs.openSync;
let checked = 0;
const observe = () => {
  for (const [file, json] of watched) {
    const text = readPublished(file, 'utf8');
    if (json) JSON.parse(text);
    else assert.match(text, /^\\d+$/);
  }
  checked++;
};
// A reader runs after truncation, before content is written, including staged files.
fs.writeFileSync = (file, data, ...args) => {
  write(file, '', ...args);
  observe();
  return write(file, data, ...args);
};
fs.openSync = (file, flags, ...args) => {
  const fd = open(file, flags, ...args);
  if (flags === 'w') observe();
  return fd;
};
process.on('exit', () => process.stderr.write('reader observations: ' + checked + '\\n'));
`;

for (const [name, watched, delayed, failed] of [
  ['GitHub call log', 'github', false, false],
  ['superseding poll receipt', 'cache', false, true],
  ['superseding poll clock', 'clock', false, true],
  ['downloaded coverage artifact', 'artifact', false, false],
  ['delayed poll clock', 'clock', true, false],
  ['delayed poll receipt', 'cache', true, false],
]) {
  test(`coverage fixture publishes complete files for ${name}`, (t) => {
    const h = makeRepo(t);
    const files = { github: path.join(h.base, 'github.json'), cache: path.join(h.base, 'tests-map-cache.json'),
      clock: path.join(h.base, 'clock'), artifact: path.join(h.base, 'tests-coverage-map.json') };
    const args = watched === 'artifact' ? ['run', 'download', '42', '-D', h.base]
      : ['api', 'repos/acme/demo/branches/main'];
    const initial = { calls: [], artifact, ...(failed ? { fail: true,
      supersedingPoll: { file: files.cache, receipt } } : {}) };
    fs.writeFileSync(files.github, JSON.stringify(initial));
    fs.writeFileSync(files.cache, JSON.stringify({ old: true }));
    fs.writeFileSync(files.clock, '1');
    fs.writeFileSync(files.artifact, JSON.stringify({ old: true }));
    const env = { ...h.env, TC_MAP_GITHUB: files.github, HOOK_CLOCK_FILE: files.clock,
      TC_MAP_WATCHED: JSON.stringify([[files[watched], watched !== 'clock']]),
      TC_MAP_POLL_DELAY: JSON.stringify({ now: 100000, read_at: receipt.read_at }) };
    const runFixture = delayed ? `
      const S = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'state.js'))});
      S.mutate = (ctx, cmd, fn) => fn({ project: { repo: 'acme/demo', base: 'main' } });
      require(${JSON.stringify(path.join(fixtureDir, 'tests-map-poll-delay.js'))});
      S.mutate({ stateDir: ${JSON.stringify(h.base)} }, 'tests map poll', () => {});
    ` : `
      process.argv = [process.execPath, 'fixture', ...${JSON.stringify(args)}];
      require(${JSON.stringify(path.join(fixtureDir, 'tests-map-gh.js'))});
    `;
    const run = cp.spawnSync(process.execPath, ['-e', observer + runFixture],
      { env, encoding: 'utf8', timeout: HUNG_TEST_MS });
    assert.equal(run.status, failed ? 1 : 0, run.stderr);
    if (failed) assert.match(run.stderr, /GitHub unavailable/);
    assert.match(run.stderr, /reader observations: [1-9]\d*/);
    assert.doesNotMatch(run.stderr, /AssertionError|SyntaxError/);
    if (delayed || failed) {
      assert.equal(fs.readFileSync(files.clock, 'utf8'), '100000');
      assert.deepEqual(JSON.parse(fs.readFileSync(files.cache, 'utf8')), receipt);
    } else if (watched === 'artifact') {
      assert.deepEqual(JSON.parse(fs.readFileSync(files.artifact, 'utf8')), artifact);
    }
    if (!delayed) assert.deepEqual(JSON.parse(fs.readFileSync(files.github, 'utf8')).calls, [args]);
  });
}

for (const count of [2, 4]) {
  test(`concurrent coverage fixture calls retain all ${count} log entries`, async (t) => {
    const h = makeRepo(t);
    const file = path.join(h.base, 'github.json');
    fs.writeFileSync(file, JSON.stringify({ calls: [], artifact }));
    const calls = Array.from({ length: count }, (_, i) => ['api', `repos/acme/demo/branches/branch-${i}`]);
    const runs = await Promise.all(calls.map((args) => new Promise((resolve, reject) => {
      const script = observer + `
        process.argv = [process.execPath, 'fixture', ...${JSON.stringify(args)}];
        require(${JSON.stringify(path.join(fixtureDir, 'tests-map-gh.js'))});
      `;
      const child = cp.spawn(process.execPath, ['-e', script], { env: { ...h.env, TC_MAP_GITHUB: file,
        TC_MAP_WATCHED: JSON.stringify([[file, true]]) }, timeout: HUNG_TEST_MS });
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stderr }));
    })));
    for (const run of runs) assert.equal(run.status, 0, run.stderr);
    const actual = JSON.parse(fs.readFileSync(file, 'utf8')).calls;
    const sorted = (entries) => entries.map((args) => JSON.stringify(args)).sort();
    assert.deepEqual(sorted(actual), sorted(calls));
  });
}
