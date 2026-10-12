'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo } = require('./helpers');

function attempt(h, chrome, sandbox, tmp = h.base, before = '') {
  const runner = path.join(h.base, 'browser-runner.js');
  fs.writeFileSync(runner, `
${before}
const { openBrowser, closeBrowser } = require(${JSON.stringify(path.join(__dirname, 'browser.js'))});
const hooks = [];
(async () => {
  let error;
  try { await openBrowser({ after: (fn) => hooks.push(fn) }); }
  catch (e) { error = e.message; }
  finally {
    for (const hook of hooks.reverse()) await hook();
    await closeBrowser?.();
  }
  console.log(JSON.stringify({ error }));
})().catch((e) => { console.error(e); process.exitCode = 1; });
`);
  const r = cp.spawnSync(process.execPath, [runner], {
    env: { ...h.env, TOWER_CRANE_TEST_CHROME: chrome, TOWER_CRANE_TEST_TMP: tmp, TOWER_CRANE_SANDBOX: sandbox, CHROME_REPORT: path.join(h.base, 'chrome.json') },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.status, 0, `${r.error || ''}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('shared Chrome is reaped before teardown returns, including CPU used while closing', {
  skip: process.platform === 'win32' && 'browser fixture uses a shebang and SIGTERM',
}, (t) => {
  const h = makeRepo(t);
  const chrome = path.join(h.base, 'chrome');
  fs.writeFileSync(chrome, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
process.on('SIGTERM', () => {
  const start = process.cpuUsage();
  let cpu;
  do { cpu = process.cpuUsage(start); } while (cpu.user + cpu.system < 200000);
  fs.writeFileSync(process.env.CHROME_REPORT, JSON.stringify({ pid: process.pid, cpu: cpu.user + cpu.system }));
  process.exit(0);
});
// An invalid DevTools endpoint makes openBrowser reject after a successful launch.
fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '1\\n');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  attempt(h, chrome, '1');
  const closed = JSON.parse(fs.readFileSync(path.join(h.base, 'chrome.json'), 'utf8'));
  assert.ok(closed.cpu >= 200000);
  assert.throws(() => process.kill(closed.pid, 0), { code: 'ESRCH' });
  assert.deepEqual(fs.readdirSync(h.base).filter((f) => f.startsWith('tower-crane-chrome-')), []);
});

test('a missing browser reports its spawn error and cleans up its profile', (t) => {
  const h = makeRepo(t);
  const result = attempt(h, path.join(h.base, 'missing-chrome'), '1');
  assert.match(result.error, /Chrome.*ENOENT/s);
  assert.deepEqual(fs.readdirSync(h.base).filter((f) => f.startsWith('tower-crane-chrome-')), []);
});

test('a Chrome profile whose setup fails is removed, and the start rejects', (t) => {
  const h = makeRepo(t);
  // The sandboxed start creates config, cache and tmp inside the profile; a full disk fails the first.
  const result = attempt(h, path.join(h.base, 'missing-chrome'), '1', h.base, `
const fsModule = require('node:fs');
const pathModule = require('node:path');
const mkdirSync = fsModule.mkdirSync;
fsModule.mkdirSync = function (dir, ...rest) {
  if (pathModule.basename(dir) === 'config') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  return mkdirSync.call(this, dir, ...rest);
};`);
  assert.match(result.error, /ENOSPC/);
  assert.deepEqual(fs.readdirSync(h.base).filter((f) => f.startsWith('tower-crane-chrome-')), []);
});

test('a temp root too deep for Chrome\'s socket still starts Chrome, from a shallow profile directory', {
  skip: process.platform === 'win32' && 'browser fixture uses a shebang; Unix socket path limits do not apply on Windows',
}, (t) => {
  const h = makeRepo(t);
  // A gate's TMPDIR sits under TOWER_CRANE_TMP, which can be deeper than the socket path allows.
  const deep = path.join(h.base, ...Array.from({ length: 4 }, (_, i) => `${i}-${'d'.repeat(30)}`));
  fs.mkdirSync(deep, { recursive: true });
  // The fixture's HOME is deep too, so the shallow profile goes to the account's cache root, as it does outside a fixture.
  Object.assign(h.env, { TMPDIR: deep, XDG_CACHE_HOME: path.join(os.userInfo().homedir, '.cache') });
  const chrome = path.join(h.base, 'chrome');
  fs.writeFileSync(chrome, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
// Chrome keeps its singleton socket in the profile only up to 78 bytes (see browser.js), and under
// TMPDIR otherwise, where a socket path must also fit 107 bytes.
const sockets = [path.join(profile, 'SingletonSocket'), path.join(process.env.TMPDIR, 'com.google.Chrome.000000', 'SingletonSocket')];
if (Buffer.byteLength(sockets[0]) > 78 || Buffer.byteLength(sockets[1]) > 107) {
  console.error('Socket path too long');
  process.exit(1);
}
fs.writeFileSync(process.env.CHROME_REPORT, JSON.stringify({ profile, tmp: process.env.TMPDIR }));
// An invalid DevTools endpoint makes openBrowser reject after a successful launch.
fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '1\\n');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const result = attempt(h, chrome, '1', deep);
  assert.doesNotMatch(result.error ?? '', /exit code|Socket path/);
  const { profile, tmp } = JSON.parse(fs.readFileSync(path.join(h.base, 'chrome.json'), 'utf8'));
  assert.equal(profile.startsWith(deep + path.sep), false, profile);
  assert.equal(path.dirname(tmp), profile, 'Chrome\'s temp directory is in the shallow profile, not the deep TMPDIR');
  assert.equal(fs.existsSync(profile), false, 'the shallow profile is removed with the browser');
  assert.deepEqual(fs.readdirSync(deep).filter((f) => f.startsWith('tower-crane-chrome-')), []);
});

for (const sandbox of ['0', '1']) {
  test(`Chrome startup in sandbox=${sandbox} keeps Chrome's temp files in its profile and reports an early exit`, {
    skip: process.platform === 'win32' && 'browser fixture uses a shebang',
  }, (t) => {
    const h = makeRepo(t);
    const chrome = path.join(h.base, 'chrome');
    fs.writeFileSync(chrome, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.CHROME_REPORT, JSON.stringify({
  args: process.argv.slice(2), home: process.env.HOME,
  config: process.env.XDG_CONFIG_HOME, cache: process.env.XDG_CACHE_HOME,
  tmp: process.env.TMPDIR,
  temp: process.env.TEMP, winTmp: process.env.TMP, userProfile: process.env.USERPROFILE,
  profileEntries: fs.readdirSync(process.argv.slice(2).find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length)),
}));
console.error('fixture Chrome sandbox failure');
process.exit(23);
`, { mode: 0o755 });
    const hostEnv = {
      HOME: path.join(h.base, 'host-home'), USERPROFILE: path.join(h.base, 'host-user-profile'),
      XDG_CONFIG_HOME: path.join(h.base, 'host-config'), XDG_CACHE_HOME: path.join(h.base, 'host-cache'),
      TMPDIR: path.join(h.base, 'host-tmp'), TEMP: path.join(h.base, 'host-temp'), TMP: path.join(h.base, 'host-win-tmp'),
    };
    Object.assign(h.env, hostEnv);
    const result = attempt(h, chrome, sandbox);
    assert.match(result.error, /Chrome.*23/s);
    if (sandbox === '1') assert.match(result.error, /fixture Chrome sandbox failure/);
    else assert.doesNotMatch(result.error, /fixture Chrome sandbox failure/, 'host Chrome keeps ignored stderr');
    const seen = JSON.parse(fs.readFileSync(path.join(h.base, 'chrome.json'), 'utf8'));
    assert.equal(seen.args.includes('--no-sandbox'), sandbox === '1' || (process.getuid && process.getuid() === 0));
    assert.equal(seen.args.includes('--disable-dev-shm-usage'), sandbox === '1');
    const profile = seen.args.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    assert.deepEqual(seen.args, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
      ...(sandbox === '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []),
      'about:blank',
    ]);
    assert.equal(path.dirname(profile), h.base);
    for (const dir of [seen.tmp, seen.temp, seen.winTmp]) assert.equal(dir, path.join(profile, 'tmp'));
    if (sandbox === '1') {
      assert.equal(seen.home, profile);
      assert.equal(seen.userProfile, profile);
      for (const dir of [seen.config, seen.cache, seen.tmp, seen.temp, seen.winTmp]) assert.equal(path.dirname(dir), profile);
    } else {
      assert.deepEqual(seen.profileEntries, ['tmp'], 'host profiles have no sandbox config or cache directories');
      assert.deepEqual([seen.home, seen.config, seen.cache, seen.userProfile],
        [hostEnv.HOME, hostEnv.XDG_CONFIG_HOME, hostEnv.XDG_CACHE_HOME, hostEnv.USERPROFILE]);
    }
    assert.equal(fs.existsSync(profile), false, 'even a failed launch removes the profile');
  });
}
