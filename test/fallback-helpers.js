'use strict';

// Shared by the fallback*.test.js files: a task whose primary route fails and the routes it falls back to.

const fs = require('node:fs');
const path = require('node:path');
const { makeTaskRepo, ownerFallbacks } = require('./helpers');
const { readPublished } = require('./atomic-file');

// Independent cases run two at a time on every platform: most of each one waits on its child processes.
const caseConcurrency = 2;

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const supervision = { retries: 2, backoff_ms: 10, max_backoff_ms: 20, stall_ms: 60000 };
// A waiter blocks until its event arrives. The runner's per-test timeout
// (test/run.js) is its only bound: three attempts and a route switch, each a
// supervised harness launch, took up to 14 s on a Windows runner.
const WAIT_TIMEOUT_S = '300';

// The owner's personal fallbacks (helpers.js ownerFallbacks).
function setFallbacks(h, routes, rung = 'easy') {
  ownerFallbacks(h, rung, routes);
}

// Fallbacks edited into the user file by hand, outside the CLI.
function handFallbacks(h, routes, rung = 'easy') {
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { [rung]: { fallbacks: routes } } }));
}

function setup(t, { reason = 'outage', primaryHarness = 'codex', nextHarness = 'codex', chain = false,
  rung = 'easy', webMcp, fallbackWebMcp } = {}) {
  const h = makeTaskRepo(t, [{
    args: ['--title', 'Fallback routes', '--tier', rung,
      '--kind', rung === 'research' ? 'research' : 'code', '--acceptance', 'fresh fallback session'],
    brief: 'Complete the original task brief.\n',
  }]);
  // Harness discovery must use fixture credentials and origin directories.
  Object.assign(h.env, {
    USERPROFILE: h.env.HOME,
    CLAUDE_CONFIG_DIR: path.join(h.env.HOME, '.claude'),
    CODEX_HOME: path.join(h.env.HOME, '.codex'),
    PI_CODING_AGENT_DIR: path.join(h.env.HOME, '.pi', 'agent'),
    GH_CONFIG_DIR: path.join(h.env.HOME, '.config', 'gh'),
    XDG_CONFIG_HOME: path.join(h.env.HOME, '.config'),
    XDG_DATA_HOME: path.join(h.env.HOME, '.local', 'share'),
    OPENCODE_CONFIG_DIR: path.join(h.env.HOME, '.config', 'opencode'),
  });
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  // A gh on PATH and no token in the environment make every route ask gh for
  // one, as on a CI runner; that must happen outside the state lock.
  for (const harness of ['codex', 'claude', 'agy', 'pi', 'opencode', 'gh']) fs.writeFileSync(path.join(bin, harness + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
  const routes = [{ harness: nextHarness, model: 'second', env: { ROUTE_ENV: 'fallback', NODE_TEST_CONTEXT: 'child-v8' } }];
  if (fallbackWebMcp) routes[0].web_mcp = fallbackWebMcp;
  if (chain) routes.push({ harness: 'claude', model: 'third' });
  h.ok(['ladder', 'set', rung, '--harness', primaryHarness, '--model', 'first', '--clear', 'profile', '--clear', 'effort',
    '--env', '{"ROUTE_ENV":"primary","NODE_TEST_WORKER_ID":"outer-worker"}', '--supervision', JSON.stringify(supervision),
    ...(webMcp ? ['--web-mcp', JSON.stringify(webMcp)] : [])]);
  // The fallback env is a grant: the owner writes it through ladder set.
  h.ok(['ladder', 'set', rung, '--fallbacks', JSON.stringify(routes)]);
  h.file = path.join(h.base, 'attempts.json');
  h.spawnEnv = {
    PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''), GH_TOKEN: '', GITHUB_TOKEN: '',
    NODE_OPTIONS: `--require "${path.join(__dirname, 'fixtures', 'fallback-harness.js').replace(/\\/g, '/')}"`,
    TOWER_CRANE_TEST_FALLBACK_FILE: h.file, TOWER_CRANE_TEST_FALLBACK_REASON: reason,
    ...(chain ? { TOWER_CRANE_TEST_FALLBACK_CHAIN: '1' } : {}),
  };
  h.spawn = () => h.run(['spawn', '--task', 'T1', '--wait'], { env: h.spawnEnv });
  h.attempts = () => JSON.parse(readPublished(h.file, 'utf8'));
  return h;
}

module.exports = { caseConcurrency, events, supervision, WAIT_TIMEOUT_S, setFallbacks, handFallbacks, setup };
