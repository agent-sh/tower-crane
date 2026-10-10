'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Secrets = require('../lib/secrets');

// A spawn job names the rung env under rung_config, route, routes and the
// project ladder, and the settings repeat it.
const job = (rung) => ({
  rung_config: { env: rung }, route: { env: rung }, routes: [{ env: rung }, { env: { ROUTE: 'fallback' } }],
  settings: { env: rung }, dispatch: { project: { env: { P: 'project' }, ladder: { hard: { env: rung } } } },
});

test('split sends a value repeated across the job once, and join restores every env', () => {
  const big = 'x'.repeat(30000);
  const doc = job({ BIG: big, ROUTE: 'primary' });
  const { value, secrets } = Secrets.split(doc);
  assert.ok(!JSON.stringify(value).includes(big));
  assert.deepEqual(value.route.env, { BIG: Secrets.MASK, ROUTE: Secrets.MASK });
  assert.equal(secrets.values.filter((v) => v === big).length, 1);
  assert.ok(JSON.stringify(secrets).length < 31000, 'the 30,000-char value travels once');
  assert.deepEqual(Secrets.join(JSON.parse(JSON.stringify(value)), JSON.parse(JSON.stringify(secrets))), doc);
});

test('a payload that fits one environment entry travels in it; a larger one in a 0600 file deleted on read', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-secrets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const small = Secrets.split(job({ A: 'a' })).secrets;
  const env = Secrets.handoff(small, dir);
  assert.deepEqual(Object.keys(env), [Secrets.ENV]);
  assert.deepEqual(Secrets.receive(env), small);
  assert.deepEqual(env, {});

  const large = Secrets.split(job(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`B${i}`, String(i).repeat(30000)])))).secrets;
  const fileEnv = Secrets.handoff(large, dir);
  assert.deepEqual(Object.keys(fileEnv), [Secrets.FILE]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(fileEnv[Secrets.FILE]).mode & 0o777, 0o600);
  const file = fileEnv[Secrets.FILE];
  assert.deepEqual(Secrets.receive(fileEnv), large);
  assert.deepEqual(fileEnv, {});
  assert.equal(fs.existsSync(file), false, 'the supervisor deletes the file on read');
  assert.equal(Secrets.receive({}), undefined);
});
