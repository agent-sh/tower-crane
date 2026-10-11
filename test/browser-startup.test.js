'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo } = require('./helpers');

function attempt(h, chrome, sandbox) {
  const runner = path.join(h.base, 'browser-runner.js');
  fs.writeFileSync(runner, `
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
    env: { ...h.env, TOWER_CRANE_TEST_CHROME: chrome, TOWER_CRANE_TEST_TMP: h.base, TOWER_CRANE_SANDBOX: sandbox, CHROME_REPORT: path.join(h.base, 'chrome.json') },
    encoding: 'utf8', timeout: 300000,
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

for (const sandbox of ['0', '1']) {
  test(`Chrome startup in sandbox=${sandbox} isolates browser files only inside the sandbox and reports an early exit`, {
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
    if (sandbox === '1') {
      assert.equal(seen.home, profile);
      assert.equal(seen.userProfile, profile);
      for (const dir of [seen.config, seen.cache, seen.tmp, seen.temp, seen.winTmp]) assert.equal(path.dirname(dir), profile);
    } else {
      assert.deepEqual(seen.profileEntries, [], 'host profiles have no sandbox config/cache/temp directories');
      assert.deepEqual([seen.home, seen.config, seen.cache, seen.tmp, seen.temp, seen.winTmp, seen.userProfile],
        [hostEnv.HOME, hostEnv.XDG_CONFIG_HOME, hostEnv.XDG_CACHE_HOME, hostEnv.TMPDIR, hostEnv.TEMP, hostEnv.TMP, hostEnv.USERPROFILE]);
    }
    assert.equal(fs.existsSync(profile), false, 'even a failed launch removes the profile');
  });
}
