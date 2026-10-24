'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');
const { HUNG_TEST_MS } = require('./signals');

for (const tool of ['test-coverage', 'test-options', 'suite-profile']) {
  test(`${tool} executes scratch selection and removes its allocation`, {
    skip: tool === 'suite-profile' && process.platform !== 'linux' ? 'profile CPU comes from /proc' : false,
  }, async (t) => {
    for (const mode of ['home', 'cache', 'tmp', 'test-tmp', 'sandbox-tmpdir', 'sandbox-tmp', 'sandbox-temp']) {
      await t.test(mode, (t) => {
        const h = makeRepo(t);
        const sentinel = path.join(h.base, 'sentinel');
        const cache = path.join(h.base, 'cache');
        const override = path.join(h.base, 'override');
        const privateTmp = path.join(h.base, 'private');
        const allocations = path.join(h.base, 'allocations.jsonl');
        const report = path.join(h.base, 'report.json');
        fs.mkdirSync(sentinel);
        const env = { ...h.env, USERPROFILE: h.env.HOME, XDG_CACHE_HOME: '', LOCALAPPDATA: '',
          TOWER_CRANE_TMP: '', TOWER_CRANE_TEST_TMP: '', TOWER_CRANE_SANDBOX: '0',
          TMPDIR: sentinel, TMP: sentinel, TEMP: sentinel, TC_SCRATCH_LOG: allocations,
          TC_OPTIONS_STOP_LOG: report };
        let expected = path.join(h.env.HOME, ...(process.platform === 'win32'
          ? ['AppData', 'Local'] : ['.cache']), 'tower-crane');
        if (mode === 'home') delete env.TMPDIR;
        if (mode === 'cache') {
          Object.assign(env, { XDG_CACHE_HOME: cache, LOCALAPPDATA: cache });
          expected = path.join(cache, 'tower-crane');
        }
        if (mode === 'tmp' || mode === 'test-tmp') {
          env.TOWER_CRANE_TMP = override;
          expected = override;
          if (mode === 'test-tmp') {
            env.TOWER_CRANE_TEST_TMP = path.join(h.base, 'test-override');
            expected = env.TOWER_CRANE_TEST_TMP;
          }
        }
        if (mode.startsWith('sandbox-')) {
          env.TOWER_CRANE_SANDBOX = '1';
          const alias = { 'sandbox-tmpdir': 'TMPDIR', 'sandbox-tmp': 'TMP', 'sandbox-temp': 'TEMP' }[mode];
          for (const name of ['TMPDIR', 'TMP', 'TEMP']) delete env[name];
          env[alias] = privateTmp;
          expected = privateTmp;
        }
        const argv = ['--require', path.join(ROOT, 'test', 'fixtures', 'scratch-record.js')];
        if (tool === 'test-options') {
          argv.push('--require', path.join(ROOT, 'test', 'fixtures', 'options-scratch-stop.js'));
        }
        argv.push(path.join(ROOT, 'scripts', `${tool}.js`));
        if (tool !== 'test-options') {
          const fixture = path.join(h.base, 'tiny.test.js');
          fs.writeFileSync(fixture, `
const test = require('node:test');
const assert = require('node:assert/strict');
const { scratchRoot } = require(${JSON.stringify(path.join(ROOT, 'lib', 'scratch-root.js'))});
test('coverage fixture', () => {
  assert.ok(scratchRoot({}, 'fixture-home').endsWith('tower-crane'));
});
`);
          argv.push(...(tool === 'test-coverage' ? ['--jobs', '1'] : ['--test-concurrency=1']),
            '--json', report, fixture);
        }
        const result = cp.spawnSync(process.execPath, argv, {
          cwd: ROOT, env, encoding: 'utf8', timeout: HUNG_TEST_MS,
        });
        assert.equal(result.status, tool === 'test-options' ? 1 : 0, result.stderr);
        if (tool === 'test-options') {
          assert.match(result.stderr, /option measurement stopped for scratch probe/);
        }
        const prefix = tool === 'suite-profile' ? 'suite-profile-'
          : `tower-crane-${tool === 'test-options' ? 'options' : 'coverage'}-`;
        const dirs = fs.readFileSync(allocations, 'utf8').trim().split('\n').map(JSON.parse)
          .filter((dir) => path.basename(dir).startsWith(prefix));
        assert.equal(dirs.length, 1, JSON.stringify(dirs));
        assert.equal(path.dirname(dirs[0]), expected, mode);
        assert.equal(fs.existsSync(dirs[0]), false, 'script cleanup removes its allocation');
        assert.deepEqual(fs.readdirSync(sentinel), [], 'inherited system temp stays empty');
        const data = JSON.parse(fs.readFileSync(report, 'utf8'));
        if (tool === 'test-options') {
          assert.equal(data.scratch, dirs[0]);
          assert.equal(data.fixture, true);
          assert.equal(data.service, true);
        } else if (tool === 'test-coverage') {
          assert.equal(data.length, 1);
          assert.ok(data[0].lines > 0, JSON.stringify(data));
        } else {
          assert.equal(data.status, 0);
          assert.equal(data.files.length, 1);
          assert.equal(data.tests.length, 1);
        }
      });
    }
  });
}
