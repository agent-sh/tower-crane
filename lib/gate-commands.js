'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const FIELDS = ['tests_cmd', 'clean_cmd', 'tests_proof_cmd'];
// The tests settings that decide which proof counts. Evidence records them with its commands.
const TESTS_SETTINGS = ['paths', 'keep', 'expensive', 'tests_map', 'ci_required', 'ci_local'];

function errors(gates) {
  if (gates == null) return [];
  if (typeof gates !== 'object' || Array.isArray(gates)) return ['project.json gates must be an object'];
  return FIELDS.filter((key) => gates[key] != null
    && (typeof gates[key] !== 'string' || !gates[key].trim() || gates[key].includes('\0')))
    .map((key) => `project.json gates.${key} must be a non-blank command string without NUL bytes or null`)
    .concat(gates.executors != null && (!Number.isInteger(gates.executors) || gates.executors < 1)
      ? ['project.json gates.executors must be a positive integer or null'] : [])
    .concat(require('./gate-timeouts').errors(gates));
}

function resolve(project, type) {
  const bad = errors(project.gates);
  if (bad.length) return { error: bad.join('; ') };
  const keys = type === 'tests' ? ['tests_cmd', 'tests_proof_cmd'] : ['clean_cmd'];
  const policy = Object.fromEntries(keys.map((key) => [key, project.gates?.[key]?.trim() || null]));
  if (type === 'tests') {
    // Records the effective matcher: null is the default layouts or default manifests, [] keeps nothing.
    const tests = project.tests && typeof project.tests === 'object' && !Array.isArray(project.tests) ? project.tests : {};
    Object.assign(policy, { paths: tests.paths ?? null, keep: tests.keep ?? null, expensive: tests.expensive === true });
    if (tests.map != null) {
      policy.tests_map = tests.map;
      policy.ci_required = project.ci?.required ?? [];
      policy.ci_local = project.ci?.local ?? null;
    }
  }
  return { policy };
}

function select(project, type, args = {}, mode) {
  const current = resolve(project, type);
  if (current.error) return current;
  const key = `${type}_cmd`;
  const command = current.policy[key];
  if (!command && mode !== 'none') {
    return { error: `no ${type === 'tests' ? 'test' : 'cleanup'} command pinned in project.json gates.${key}; none was detected; the orchestrator or the owner sets it with tower-crane project set --${type}-cmd CMD` };
  }
  if (args.cmd !== undefined && args.cmd.trim() !== command) {
    return { error: `--cmd differs from the pinned project.json gates.${key}; the orchestrator or the owner changes it with project set --${type}-cmd CMD` };
  }
  if (type === 'clean' && process.env.TOWER_CRANE_CLEAN_CMD?.trim()
    && process.env.TOWER_CRANE_CLEAN_CMD.trim() !== command) {
    return { error: 'TOWER_CRANE_CLEAN_CMD differs from the pinned project.json gates.clean_cmd; the orchestrator or the owner changes it with project set --clean-cmd CMD' };
  }
  if (type === 'tests' && args['proof-cmd'] !== undefined
    && args['proof-cmd'].trim() !== current.policy.tests_proof_cmd) {
    return { error: '--proof-cmd differs from the pinned project.json gates.tests_proof_cmd; the orchestrator or the owner changes it with project set --tests-proof-cmd CMD' };
  }
  return { ...current, command };
}

function mismatch(entry, project, task) {
  const type = entry.type;
  const current = resolve(project, type);
  if (current.error) return current.error;
  const remedy = `run tower-crane check ${type} ${task.id} again`;
  if (!isDeepStrictEqual(entry.gate_policy, current.policy)) {
    const commandsMatch = Object.keys(current.policy).filter((key) => !TESTS_SETTINGS.includes(key))
      .every((key) => isDeepStrictEqual(entry.gate_policy?.[key], current.policy[key]));
    return type === 'tests' && entry.gate_policy && commandsMatch
      ? `tests evidence no longer matches the tests paths, keep, expensive, map or required CI setting; ${remedy}`
      : `${type} evidence command policy is missing or no longer matches the pinned commands; ${remedy}`;
  }
  if (!entry.commands.every((c) => c && typeof c.command === 'string' && Array.isArray(c.args))) {
    return `${type} command receipts are malformed; ${remedy}`;
  }
  if (type === 'tests' && entry.tests_mode === 'none') {
    return entry.commands.every((c) => c.command === 'git') ? null : `tests mode none has a shell command receipt; ${remedy}`;
  }
  const command = current.policy[`${type}_cmd`];
  const runs = entry.commands.filter((c) => c.command !== 'git');
  const { shellQuote } = require('./gates/common');
  const paths = entry.receipt?.proof_tests;
  const proof = Array.isArray(paths) && paths.length && paths.every((p) => typeof p === 'string' && p)
    && current.policy.tests_proof_cmd?.includes('{tests}')
    ? current.policy.tests_proof_cmd.replaceAll('{tests}', paths.map(shellQuote).join(' ')) : null;
  const headPaths = entry.receipt?.head_tests;
  const mapped = type === 'tests' && task.pr && entry.receipt?.head_mode === 'mapped'
    && project.tests?.map != null && project.tests.expensive === true
    && project.ci?.local == null && project.ci?.required?.length && Array.isArray(headPaths) && headPaths.length
    && headPaths.every((p) => require('./tests-map').settingError({ source: [p] }) === null)
    && current.policy.tests_proof_cmd?.includes('{tests}')
    ? require('./tests-map').expand(current.policy.tests_proof_cmd, headPaths) : null;
  const headCommand = mapped || command;
  const matches = type === 'tests'
    ? runs.some((c) => c.command === headCommand && c.status === 0 && !c.signal)
      && runs.every((c) => c.args.length === 0 && (c.command === headCommand || (proof && c.command === proof)))
    : runs.length === 1 && runs.every((c) => {
      const suffix = c.command.slice(`${command} ${shellQuote(c.cwd)} `.length);
      const base = /--base=([a-f0-9]{40,64})/.exec(suffix)?.[1];
      return base && c.command === `${command} ${shellQuote(c.cwd)} ${shellQuote(`--base=${base}`)} --json`
        && c.status === 0 && !c.signal && c.args.length === 0;
    });
  return command && matches ? null : `${type} command receipts do not match the pinned command; ${remedy}`;
}

function onPath(name, env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) {
          fs.accessSync(p, fs.constants.X_OK);
          return p;
        }
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

// The command a missing pin would get: npm test when package.json has a real
// test script, and the configured cleanup tool (TOWER_CRANE_CLEAN_CMD, deslop
// on PATH, or the deslop plugin's script).
function detect(root, key, env = process.env) {
  const { shellQuote } = require('./gates/common');
  if (key === 'tests_cmd') {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch {
      return null;
    }
    const script = pkg?.scripts?.test;
    // npm init writes a test script that only fails.
    if (typeof script !== 'string' || !script.trim() || /no test specified/.test(script)) return null;
    return { value: 'npm test', from: 'package.json scripts.test' };
  }
  if (key === 'clean_cmd') {
    const configured = (env.TOWER_CRANE_CLEAN_CMD || '').trim();
    if (configured) return { value: configured, from: 'TOWER_CRANE_CLEAN_CMD' };
    const bin = onPath('deslop', env);
    if (bin) return { value: shellQuote(bin), from: 'deslop on PATH' };
    const home = env.HOME || env.USERPROFILE || require('node:os').homedir();
    const script = path.join(home, '.agentsys', 'plugins', 'deslop', 'scripts', 'detect.js');
    if (fs.existsSync(script)) return { value: `${shellQuote(process.execPath)} ${shellQuote(script)}`, from: script };
  }
  return null;
}

// An unpinned gate command does not block the run: when the orchestrator or
// the owner runs a gate that needs one, it pins the detected command under
// its own identity, and the gates pin event and status show it to the owner.
// Workers and reviewers pin nothing. keys are the missing pins the caller
// needs; returns what was pinned.
function heal(ctx, keys) {
  const S = require('./state');
  const Authority = require('./authority');
  if (!keys.length) return [];
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  if (!repo) return [];
  const events = S.readEvents(ctx.stateDir);
  const identity = Authority.actor(ctx, events);
  if (identity !== 'owner' && !Authority.isOrchestrator(identity, events)) return [];
  const found = keys.map((key) => [key, detect(repo.root, key, ctx.env || process.env)]).filter(([, d]) => d);
  if (!found.length) return [];
  return S.mutate(ctx, 'gates pin', (st, emit) => {
    const who = Authority.enforce(ctx, st, found.map(([key]) => `gates.${key}`), { emit });
    const pinned = [];
    for (const [key, d] of found) {
      if (st.project.gates?.[key] != null) continue;
      st.project.gates = { ...(st.project.gates || {}), [key]: d.value };
      emit(null, { key, value: d.value, from: d.from, authority: who });
      pinned.push({ key, ...d });
    }
    return pinned;
  });
}

module.exports = { FIELDS, errors, resolve, select, mismatch, detect, heal };
