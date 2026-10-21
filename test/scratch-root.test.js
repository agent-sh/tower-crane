'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTaskRepo, pinRung } = require('./helpers');
const { scratchRoot } = require('../lib/scratch-root');

test('command scratch keeps host defaults and selects sandbox temp aliases after explicit overrides', () => {
  const { commandRoot } = require('../lib/scratch-root');
  for (const [env, home, platform, expected] of [
    [{ TMPDIR: '/sentinel', TMP: '/sentinel', TEMP: '/sentinel' }, '/users/me', 'linux', '/users/me/.cache/tower-crane'],
    [{ TOWER_CRANE_TMP: '/override', TOWER_CRANE_SANDBOX: '1', TMPDIR: '/private' }, '/users/me', 'linux', '/override'],
    [{ TOWER_CRANE_SANDBOX: '1', TMPDIR: '/private', TMP: '/other' }, '/users/me', 'linux', '/private'],
    [{ TOWER_CRANE_SANDBOX: '1', TMP: '/private' }, '/users/me', 'linux', '/private'],
    [{ TOWER_CRANE_SANDBOX: '1', TEMP: '/private' }, '/users/me', 'darwin', '/private'],
    [{ TOWER_CRANE_SANDBOX: '1', TMPDIR: 'relative', TMP: '/private' }, '/users/me', 'linux', '/private'],
    [{ TOWER_CRANE_SANDBOX: '1' }, '/users/me', 'linux', '/users/me/.cache/tower-crane'],
    [{ TOWER_CRANE_SANDBOX: '1', TMP: 'C:\\private' }, 'C:\\Users\\me', 'win32', 'C:\\private'],
  ]) assert.equal(commandRoot(env, home, platform), expected);
});

test('scratch roots follow the platform cache and ignore relative or inherited agent caches', () => {
  for (const [platform, home, env, expected] of [
    ['linux', '/users/me', {}, '/users/me/.cache/tower-crane'],
    ['darwin', '/Users/me', { XDG_CACHE_HOME: '/cache' }, '/cache/tower-crane'],
    ['linux', '/users/me', { XDG_CACHE_HOME: 'relative' }, '/users/me/.cache/tower-crane'],
    ['linux', '/users/me', { XDG_CACHE_HOME: '/cache/tower-crane/tasks/0123456789ab/T1' }, '/users/me/.cache/tower-crane'],
    ['win32', 'C:\\Users\\me', { LOCALAPPDATA: 'D:\\cache' }, 'D:\\cache\\tower-crane'],
    ['win32', 'C:\\Users\\me', {}, 'C:\\Users\\me\\AppData\\Local\\tower-crane'],
    ['win32', 'C:\\Users\\me', { LOCALAPPDATA: 'relative' }, 'C:\\Users\\me\\AppData\\Local\\tower-crane'],
  ]) assert.equal(scratchRoot(env, home, platform), expected);
});

test('agent spawns allocate scratch in their own home with system temp unset or pointing at a sentinel', (t) => {
  for (const inherited of [false, true]) {
    const h = makeTaskRepo(t, [{ args: ['--title', 'Scratch', '--acceptance', 'private scratch'], brief: 'Use private scratch.\n' }]);
    const sentinel = path.join(h.base, 'sentinel');
    const log = path.join(h.base, 'spawn.json');
    const script = path.join(h.base, 'scratch-agent.js');
    fs.mkdirSync(sentinel);
    fs.writeFileSync(script, `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
fs.writeFileSync(path.join(dir, 'scratch'), 'written');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ dir, tmp: process.env.TMPDIR, win: [process.env.TMP, process.env.TEMP] }));
`);
    pinRung(h, 'medium', { harness: 'command', command: [process.execPath, script, '{prompt}'] });
    delete h.env.TOWER_CRANE_TMP;
    delete h.env.TMPDIR;
    Object.assign(h.env, { TMP: sentinel, TEMP: sentinel });
    if (inherited) h.env.TMPDIR = sentinel;
    const r = h.run(['spawn', '--task', 'T1', '--wait']);
    assert.equal(r.code, 0, r.stderr);
    const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.deepEqual(fs.readdirSync(sentinel), []);
    assert.deepEqual(seen.win, [seen.tmp, seen.tmp]);
    assert.ok(seen.dir.startsWith(path.join(h.state, 'homes') + path.sep), seen.dir);
  }
});
