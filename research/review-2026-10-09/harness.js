'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const Module = require('node:module');
const assert = require('node:assert/strict');

const CHECKOUT_ROOT = path.resolve(__dirname, '../..');
const ROOT = process.env.T144_ENGINE_ROOT ? path.resolve(process.env.T144_ENGINE_ROOT) : CHECKOUT_ROOT;
const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
assert.ok(path.resolve(cache).startsWith('/home/') && /\/\.cache(?:\/|$)/.test(path.resolve(cache)),
  'Set XDG_CACHE_HOME to a writable agent directory under ~/.cache');
const scratch = path.join(cache, 'T144-probes');
fs.mkdirSync(scratch, { recursive: true });
// No inherited broker, project state, gate command or task can reach a fixture.
for (const key of Object.keys(process.env)) if (key.startsWith('TOWER_CRANE_')) delete process.env[key];
Object.assign(process.env, {
  TOWER_CRANE_TEST_TMP: scratch,
  TOWER_CRANE_TMP: scratch,
  TMPDIR: scratch,
});
const H = require(path.join(ROOT, 'test/helpers'));
const S = require(path.join(ROOT, 'lib/state'));
const P = require(path.join(ROOT, 'lib/processes'));

function repo() {
  const h = H.makeRepo();
  h.env.TOWER_CRANE_AGENT = 'orchestrator';
  h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
  h.env.TMPDIR = path.join(h.base, 'tmp');
  fs.mkdirSync(h.env.TMPDIR);
  process.env.GIT_CONFIG_GLOBAL = h.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.TOWER_CRANE_CONFIG = h.userConfig;
  const run = h.run;
  h.run = (args, opts) => run(args.includes('--agent') ? args : [...args, '--agent', 'orchestrator'], opts);
  h.ok = (args, opts) => {
    const r = h.run(args, opts);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}\n${r.stdout}`);
    return r.stdout.trim();
  };
  h.json = (args, opts) => JSON.parse(h.ok([...args, '--json'], opts));
  h.events = () => S.readEvents(h.state);
  h.snapshot = () => S.loadState(h.state);
  return h;
}

function task(h, kind = 'docs', title = 'Probe') {
  const t = h.json(['task', 'add', '--title', title, '--kind', kind, '--acceptance', 'probe']);
  return t.id;
}

function submit(h, id, sha = h.git(['rev-parse', 'HEAD']), pr) {
  h.ok(['claim', id, '--agent', `worker-${id}`]);
  h.ok(['submit', id, '--sha', sha, ...(pr ? ['--pr', String(pr)] : []), '--agent', `worker-${id}`]);
}

// Expose private functions in memory. The checkout's source is never changed.
function load(file, names = [], replacements = {}) {
  const filename = path.join(ROOT, file);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire = mod.require.bind(mod);
  mod.require = (name) => Object.hasOwn(replacements, name) ? replacements[name] : nativeRequire(name);
  mod._compile(fs.readFileSync(filename, 'utf8') + `\nObject.assign(module.exports, {${names.join(',')}});\n`, filename);
  return mod.exports;
}

// Replay synthetic concurrent receipts on a clone of CLI-created scratch state.
// These events are never appended to a project's state files.
function replay(initial) {
  const st = structuredClone(initial);
  const state = {
    ...S,
    loadState: () => st,
    readEvents: () => st.events,
    withLock: (_dir, fn) => fn(),
    mutate: (ctx, cmd, fn) => fn(st, (id, detail, other) => {
      const e = event(other || cmd, id, detail);
      e.agent = ctx.agent;
      st.events.push(e);
    }),
  };
  const ctx = { stateDir: st.dir, cwd: path.dirname(st.dir), agent: 'orchestrator',
    agentExplicit: true, env: { ...process.env, TOWER_CRANE_AGENT: 'orchestrator' }, flags: {}, pos: ['T1'] };
  return { st, state, ctx };
}

let next = 0;
function event(cmd, taskId, detail = {}) {
  return { id: `probe-${++next}`, at: new Date().toISOString(), agent: 'orchestrator', cmd, task: taskId, detail };
}

function receipt(source, extra = {}) {
  return event('automation', source.task, { source: source.id, phase: 'running',
    pid: process.pid, ...P.identity(process.pid), ...extra });
}

function out(r) {
  return { code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

module.exports = { ROOT, CHECKOUT_ROOT, scratch, H, S, P, fs, path, cp, assert, repo, task, submit, load, replay, event, receipt, out };
