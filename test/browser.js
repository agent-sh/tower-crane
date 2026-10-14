'use strict';

const { waitUntil, HUNG_TEST_MS, killPid } = require('./signals');

// Drives a page in headless Chrome over the DevTools protocol, for the tests
// that check what the serve pages do in a browser. Node's own fetch and
// WebSocket are enough, so it adds no dependency; tests skip when no Chrome
// is installed (TOWER_CRANE_TEST_CHROME names one that is not on PATH).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { tempRoot } = require('./tmp-root');

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

const until = (fn) => waitUntil(fn);

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
// directory whose path fits in the cache, and the browser's teardown removes it. The account's
// cache remains a short fallback when XDG_CACHE_HOME also names a deep task directory.
const CHROME_SOCKET_PATH = 78;

function createProfile() {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const bases = [tempRoot(), path.join(cache, 'tct'), path.join(os.userInfo().homedir, '.cache', 'tct')].map((base) => path.resolve(base));
  const fits = (base) => Buffer.byteLength(path.join(base, 'tower-crane-chrome-000000', 'SingletonSocket')) <= CHROME_SOCKET_PATH;
  const create = (base) => {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    return fs.mkdtempSync(path.join(base, 'tower-crane-chrome-'));
  };
  if (process.platform === 'win32' || fits(bases[0])) return create(bases[0]);
  for (const base of new Set(bases.slice(1))) {
    if (!fits(base)) continue;
    try { return create(base); }
    catch (error) {
      // macOS sandboxes refuse with EPERM; Linux permissions and read-only mounts use the others.
      if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;
    }
  }
  // A refused cache must not hide the browser's own startup error.
  return create(bases[0]);
}

// Live processes as pid -> [ppid, start]. An orphan zombie nobody reaps cannot run or write, so
// zombies are left out. Linux also records the start time, so a reused pid is never taken for one
// of Chrome's; other Unix systems list the table with ps. Windows keeps a single-process teardown.
function processTable() {
  const table = new Map();
  if (process.platform === 'win32') return table;
  if (process.platform !== 'linux') {
    for (const line of cp.execFileSync('ps', ['-A', '-o', 'pid=,ppid=,stat='], { encoding: 'utf8' }).trim().split('\n')) {
      const [pid, ppid, stat] = line.trim().split(/\s+/);
      if (!stat.startsWith('Z')) table.set(Number(pid), [Number(ppid), '']);
    }
    return table;
  }
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try { stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; }
    // The executable name can contain spaces and parentheses, so fields start after its last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (!['Z', 'X'].includes(fields[0])) table.set(Number(name), [Number(fields[1]), fields[19]]);
  }
  return table;
}

// Updates a process tree (pid -> start) to its members still alive plus their new descendants.
function liveTree(tree) {
  const table = processTable();
  for (const [pid, start] of tree) if (table.get(pid)?.[1] !== start) tree.delete(pid);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, [ppid, start]] of table) {
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.set(pid, start);
        grew = true;
      }
    }
  }
  return tree;
}

function chromeTree(pid) {
  const self = processTable().get(pid);
  return self ? liveTree(new Map([[pid, self[1]]])) : new Map();
}

// The browser itself is signalled through its ChildProcess, which knows once it has been reaped and
// its pid may belong to another process.
function signalTree(tree, signal, browser) {
  for (const pid of tree.keys()) {
    if (pid === browser) continue;
    try { killPid(pid, signal); } catch { /* It exited since the table was read. */ }
  }
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
  // Chrome's zygotes, renderers and utility processes outlive the browser process for a moment, and
  // the network service writes its cache index and state into the profile on its way out, which
  // recreates a removed profile. Stopping signals the whole tree, read before the browser's exit
  // orphans it, and the profile is removed only after every process in it has gone.
  const stop = async () => {
    const tree = chromeTree(proc.pid);
    proc.kill();
    signalTree(tree, 'SIGTERM', proc.pid);
    const deadline = setTimeout(() => { // wait-allow: teardown grace before SIGKILL of Chrome's tree
      proc.kill('SIGKILL');
      signalTree(liveTree(tree), 'SIGKILL', proc.pid);
    }, 5000);
    try {
      await closed;
      await until(() => liveTree(tree).size === 0, 'Chrome\'s processes to exit');
    } finally {
      clearTimeout(deadline);
    }
  };
  const portFile = path.join(profile, 'DevToolsActivePort');
  // A first start on a fresh machine builds the font cache, which takes 10 s
  // or more on a busy CI runner; a Chrome killed before it finishes leaves the
  // next start cold too.
  let port;
  try {
    port = await waitUntil(() => {
      if (failure) throw new Error(failure);
      return fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0];
    }, { paths: [portFile] });
  } catch (error) {
    try { await stop(); } finally { remove(); }
    throw new Error(`Chrome failed to start (${CHROME}): ${error.message}${stderr ? `\n${stderr.trim()}` : ''}`);
  }
  // File teardown refs and reaps Chrome before the runner records child CPU.
  proc.unref();
  proc.stderr?.unref?.();
  // An exit handler cannot await, so it kills the tree and blocks until it is gone; a killed
  // process runs no more code and goes within milliseconds.
  const lastResort = () => {
    const tree = chromeTree(proc.pid);
    proc.kill('SIGKILL');
    signalTree(tree, 'SIGKILL', proc.pid);
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (const end = Date.now() + 5000; liveTree(tree).size && Date.now() < end;) Atomics.wait(pause, 0, 0, 10); // wait-allow: an exit handler cannot await; killed processes go within milliseconds
    remove();
  };
  process.once('exit', lastResort);
  const close = async () => {
    proc.ref();
    proc.stderr?.ref?.();
    try {
      await stop();
    } finally {
      remove();
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
    until: (expression) => until(() => inPage(expression).catch(() => false)),
    restored: (expression) => until(() => inPage(`document.documentElement.hasAttribute('data-position-restored') && (${expression})`).catch(() => false)),
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
