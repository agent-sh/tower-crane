'use strict';

// Drives a page in headless Chrome over the DevTools protocol, for the tests
// that check what the serve pages do in a browser. Node's own fetch and
// WebSocket are enough, so it adds no dependency; tests skip when no Chrome
// is installed (TOWER_CRANE_TEST_CHROME names one that is not on PATH).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

function findChrome() {
  if (process.env.TOWER_CRANE_TEST_CHROME) return process.env.TOWER_CRANE_TEST_CHROME;
  if (typeof WebSocket === 'undefined') return null;
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of NAMES) {
      const file = path.join(dir, name);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

const CHROME = findChrome();

async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// One Chrome per test process: a start costs seconds of CPU, a tab almost
// nothing. Each openBrowser call gets its own tab, closed after its test, so
// emulation, scripts and session storage never cross tests.
let chrome;
function startChrome() {
  chrome ||= launch().catch((error) => {
    chrome = null;
    throw error;
  });
  return chrome;
}

async function closeBrowser() {
  const started = chrome;
  chrome = null;
  if (started) await (await started).close();
}

// Chrome keeps its singleton socket in the profile directory only while that path is at most 78
// bytes (Google Chrome 155, measured with profiles of 62 and 63 bytes). Its temp directory holds
// a socket too, so spawnChrome gives Chrome a TMPDIR inside the profile: that socket adds 45 bytes,
// which the same 62-byte profile limit keeps under the 108-byte Unix path limit. A temp root deep
// enough to overflow that (a gate's TMPDIR under TOWER_CRANE_TMP) moves the profile to the first
// directory whose path fits, on disk, and the browser's teardown removes it. An on-disk cache can
// work where /var/tmp is read-only. A gate's XDG_CACHE_HOME can
// also be a deep task cache, so a fitting account cache is tried by allocating the profile there.
// If that allocation fails, or no root fits, use the first root and let Chrome report its socket error.
const CHROME_SOCKET_PATH = 78;

function createProfile() {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const bases = [process.env.TOWER_CRANE_TEST_TMP || os.tmpdir(), os.tmpdir(), cache];
  const fits = (base) => Buffer.byteLength(path.join(base, 'tower-crane-chrome-000000', 'SingletonSocket')) <= CHROME_SOCKET_PATH;
  const create = (base) => {
    fs.mkdirSync(base, { recursive: true });
    return fs.mkdtempSync(path.join(base, 'tower-crane-chrome-'));
  };
  const base = bases.find(fits);
  if (base) return create(base);
  const accountCache = path.join(os.userInfo().homedir, '.cache');
  if (fits(accountCache)) {
    try { return create(accountCache); }
    catch {
      // An agent sandbox can make even a short account cache read-only.
    }
  }
  return create(bases[0]);
}

// The profile is removed when a start fails at any point, including its own setup; a started browser
// removes it in close.
async function launch() {
  const profile = createProfile();
  try {
    return await spawnChrome(profile);
  } catch (error) {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

async function spawnChrome(profile) {
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions'];
  const sandboxed = process.env.TOWER_CRANE_SANDBOX === '1';
  // The caller's TMPDIR can be too deep for Chrome's socket, so Chrome's temp directory is
  // inside the profile, where the browser's teardown removes it with the rest.
  const tmp = path.join(profile, 'tmp');
  fs.mkdirSync(tmp);
  let env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  // Chrome's user/SUID sandbox cannot nest in the harness's outer sandbox.
  // Temp-backed shared memory avoids granting writes to the host's /dev/shm.
  if (sandboxed) {
    args.push('--no-sandbox', '--disable-dev-shm-usage');
    const config = path.join(profile, 'config');
    const cache = path.join(profile, 'cache');
    for (const dir of [config, cache]) fs.mkdirSync(dir);
    // Crashpad and first-run caches must not write under the agent's HOME.
    env = { ...env, HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache };
  } else if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  const proc = cp.spawn(CHROME, [...args, 'about:blank'], {
    env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  let failure = null;
  proc.stderr?.on('data', (data) => { stderr = (stderr + data).slice(-16384); });
  proc.on('error', (error) => { failure = error.message; });
  const closed = new Promise((resolve) => proc.on('close', (code, signal) => {
    failure ||= signal ? `signal ${signal}` : `exit code ${code}`;
    resolve();
  }));
  const remove = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const portFile = path.join(profile, 'DevToolsActivePort');
  // A first start on a fresh machine builds the font cache, which takes 10 s
  // or more on a busy CI runner; a Chrome killed before it finishes leaves the
  // next start cold too.
  let port;
  try {
    port = await until(() => {
      if (failure) throw new Error(failure);
      return fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0];
    }, 'Chrome to start', 60000);
  } catch (error) {
    proc.kill();
    await closed;
    remove();
    throw new Error(`Chrome failed to start (${CHROME}): ${error.message}${stderr ? `\n${stderr.trim()}` : ''}`);
  }
  // File teardown refs and reaps Chrome before the runner records child CPU.
  proc.unref();
  proc.stderr?.unref?.();
  const lastResort = () => {
    proc.kill('SIGKILL');
    remove();
  };
  process.once('exit', lastResort);
  const close = async () => {
    proc.ref();
    proc.stderr?.ref?.();
    proc.kill();
    const deadline = setTimeout(() => proc.kill('SIGKILL'), 5000);
    try {
      await closed;
      remove();
    } finally {
      clearTimeout(deadline);
      process.removeListener('exit', lastResort);
    }
  };
  return { port, close };
}

async function openBrowser(t) {
  const { port } = await startChrome();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  t.after(() => fetch(`http://127.0.0.1:${port}/json/close/${targets.id}`).then((r) => r.text()));
  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  // Protocol events (Network.requestWillBeSent and the like), in order.
  const seen = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method) seen.push(msg);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  t.after(() => ws.close());
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  // Runs an expression in the page and returns its value; a promise is awaited.
  const inPage = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
    return r.result.value;
  };
  // Calls a page function (a function or its source) with values passed as
  // protocol arguments, so no value is ever spliced into page code.
  const call = async (fn, ...args) => {
    const { result } = await send('Runtime.evaluate', { expression: 'globalThis' });
    const r = await send('Runtime.callFunctionOn', { functionDeclaration: String(fn), objectId: result.objectId, arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: true });
    await send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
    return r.result.value;
  };
  return {
    send,
    seen,
    inPage,
    call,
    // Types into whatever has focus, as a keyboard would: a disabled field
    // cannot hold focus, so nothing lands there.
    type: (text) => send('Input.insertText', { text }),
    until: (expression, what, ms) => until(() => inPage(expression).catch(() => false), what, ms),
    restored: (expression, what, ms) => until(() => inPage(`document.documentElement.hasAttribute('data-position-restored') && (${expression})`).catch(() => false), what, ms),
    // A served page drops serve's one-time key from the address bar.
    goto: async (url) => {
      await send('Page.navigate', { url });
      const shown = new URL(url);
      shown.search = '';
      const hrefs = JSON.stringify([url, shown.href]);
      await until(() => inPage(`${hrefs}.includes(location.href) && document.readyState === 'complete'`).catch(() => false), `${url} to load`);
    },
  };
}

module.exports = { CHROME, openBrowser, closeBrowser };
