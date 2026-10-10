'use strict';

// The model ladder: which harness, model and effort runs each kind of work.
// Pure config logic with no state access, so state.js can validate with it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refuse } = require('./util');
const SpawnSettings = require('./spawn-settings');

const HARNESSES = ['claude', 'codex', 'opencode', 'agy', 'pi', 'command'];
const RUNGS = ['orchestrator', 'easy', 'medium', 'hard', 'research', 'review', 'small'];
const TIERS = ['easy', 'medium', 'hard', 'research'];
// What an agent on each rung is called, in its name and its prompt: every
// tier does a worker's job, whichever model it runs.
const JOBS = { orchestrator: 'orchestrator', easy: 'worker', medium: 'worker', hard: 'worker', research: 'worker', review: 'reviewer', small: 'small' };
const FIELDS = ['harness', 'model', 'profile', 'provider', 'effort', 'args', 'command', 'supervision', 'tools', 'mcp', 'web_mcp', ...SpawnSettings.FIELDS];
const SUPERVISION = { retries: 5, backoff_ms: 30000, max_backoff_ms: 600000, stall_ms: 300000, usage_ms: 30000, progress_paths: [] };
const MIN_USAGE_MS = 1000;

function tierSpec(value) {
  if (TIERS.includes(value)) return { tier: value };
  if (typeof value !== 'string') return null;
  const parts = value.split('..');
  if (parts.length !== 2 || !parts.every((v) => TIERS.includes(v))
    || TIERS.indexOf(parts[0]) > TIERS.indexOf(parts[1])) return null;
  return { tier: parts[0], tier_range: { min: parts[0], max: parts[1] } };
}

function supervisionErrors(v) {
  if (!isObject(v)) return ['supervision must be an object'];
  const errs = [];
  for (const k of Object.keys(v)) {
    if (!(k in SUPERVISION)) errs.push(`supervision: unknown field ${k}`);
    else if (k === 'progress_paths') {
      if (!Array.isArray(v[k]) || !v[k].every((p) => isWord(p) && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'))) errs.push('supervision.progress_paths must be relative paths inside the worktree');
    } else if (!Number.isSafeInteger(v[k]) || v[k] < (k === 'retries' ? 0 : 1)) errs.push(`supervision.${k} must be ${k === 'retries' ? 'a non-negative' : 'a positive'} integer`);
  }
  const r = { ...SUPERVISION, ...v };
  if (r.max_backoff_ms < r.backoff_ms) errs.push('supervision.max_backoff_ms must be at least backoff_ms');
  return errs;
}

function supervision(rung) {
  const config = { ...SUPERVISION, ...rung.supervision };
  return { ...config, usage_ms: Math.max(MIN_USAGE_MS, config.usage_ms) };
}

// Harnesses with generated homes and native MCP selection.
// Pi isolates its config and tools but has no native MCP support.
const ISOLATED = ['claude', 'codex', 'agy'];
// The only flags a claude, codex, agy or pi rung's args may hold, and how many values
// each takes; everything else, the flags the agent file decides included, is
// refused. A codex -c may set only the keys below.
const SAFE_ARGS = {
  claude: { '--verbose': 0, '--max-turns': 1, '--fallback-model': 1, '--append-system-prompt': 1 },
  codex: { '--skip-git-repo-check': 0, '--ephemeral': 0, '--color': 1, '--disable': 1, '-c': 'key' },
  agy: { '--print-timeout': 1 },
  pi: { '--no-session': 0, '--verbose': 0 },
};
// The codex config keys an agent home keeps from the user's files, and the
// only ones a rung may set with -c: model, provider and auth-store choices.
const CODEX_KEYS = ['model', 'model_provider', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity',
  'model_context_window', 'model_auto_compact_token_limit', 'model_supports_reasoning_summaries', 'review_model', 'service_tier',
  'preferred_auth_method', 'forced_login_method', 'forced_chatgpt_workspace_id', 'cli_auth_credentials_store',
  'openai_base_url', 'chatgpt_base_url', 'oss_provider'];

function unsafeArgs(h, args) {
  const safe = SAFE_ARGS[h];
  if (!safe) return [];
  const bad = [];
  for (let i = 0; i < args.length; i++) {
    const kind = Object.prototype.hasOwnProperty.call(safe, args[i]) ? safe[args[i]] : undefined;
    if (kind === undefined) bad.push(args[i]);
    else if (kind === 1) i++;
    else if (kind === 'key') {
      const key = String(args[++i] || '').split('=')[0].trim();
      if (!CODEX_KEYS.includes(key)) bad.push(`-c ${key}`);
    }
  }
  return bad;
}

// Reasoning effort in each CLI's own terms. opencode passes it as --variant,
// whose names each provider defines, so any single word goes through there.
const EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  opencode: null,
  agy: ['low', 'medium', 'high', 'max'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  command: [],
};

const USES = {
  orchestrator: 'plans, dispatches, gates, merges',
  easy: 'default tier for S tasks',
  medium: 'default tier for M tasks',
  hard: 'default tier for L tasks',
  research: 'default tier for research',
  review: 'clean-context reviews',
  small: 'mechanical checks',
};

const BUILTIN = {
  harness: 'codex',
  ladder: {
    orchestrator: { harness: 'claude', model: 'opus', effort: 'high' },
    easy: { harness: 'claude', model: 'claude-haiku-5-5', effort: 'high' },
    medium: { profile: 'sol', effort: 'high' },
    hard: { harness: 'claude', model: 'opus', effort: 'medium' },
    research: { harness: 'claude', model: 'opus', effort: 'high' },
    review: { harness: 'claude', model: 'claude-haiku-5-5', effort: 'high' },
    small: { harness: 'claude', model: 'claude-haiku-5-5', effort: 'high' },
  },
};

const SOURCE = { project: 'project', user: 'user file', 'built-in': 'built-in' };
const MODEL_ALIASES = new Map([
  ['sol', 'openai.gpt-6.1-sol'],
  ['gpt-6.1-sol', 'openai.gpt-6.1-sol'],
  ['openai.gpt-6.1-sol', 'openai.gpt-6.1-sol'],
  ['luna', 'openai.gpt-6-luna'],
  ['gpt-6-luna', 'openai.gpt-6-luna'],
  ['openai.gpt-6-luna', 'openai.gpt-6-luna'],
  ['opus', 'claude-opus-5-5'],
  ['claude-opus-5-5', 'claude-opus-5-5'],
]);

function defaultTier(kind, size) {
  if (kind === 'research') return 'research';
  return { S: 'easy', M: 'medium', L: 'hard' }[size] || 'medium';
}

function userFile(env = process.env) {
  return env.TOWER_CRANE_CONFIG ? path.resolve(env.TOWER_CRANE_CONFIG) : path.join(os.homedir(), '.config', 'tower-crane', 'config.json');
}

const isWord = (v) => typeof v === 'string' && v.trim() !== '';
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function webMcpErrors(value) {
  if (!isObject(value)) return ['web_mcp must be an object {name, command, args}'];
  const errs = Object.keys(value).filter(k => !['name', 'command', 'args'].includes(k)).map(k => `web_mcp: unknown field ${k}; no env or secrets are stored`);
  if (!isWord(value.name) || !/^[\w-]+$/.test(value.name)) errs.push('web_mcp.name must contain only letters, digits, underscores or hyphens');
  if (!isWord(value.command)) errs.push('web_mcp.command must be a non-empty string');
  if (!Array.isArray(value.args) || !value.args.every(a => typeof a === 'string')) errs.push('web_mcp.args must be an array of strings');
  return errs;
}

function rungShape(where, r, errs, user = false, fallback = false, research = where === 'ladder research') {
  if (!isObject(r)) return errs.push(`${where} must be an object`);
  for (const k of Object.keys(r)) if (!FIELDS.includes(k) && k !== 'fallbacks') errs.push(`${where}: unknown field ${k}; a rung takes ${FIELDS.join(', ')}`);
  if (r.harness !== undefined && !HARNESSES.includes(r.harness)) errs.push(`${where}: harness must be one of ${HARNESSES.join(', ')}`);
  for (const k of ['model', 'profile', 'provider', 'effort']) if (r[k] !== undefined && !isWord(r[k])) errs.push(`${where}: ${k} must be a non-empty string`);
  if (r.args !== undefined && (!Array.isArray(r.args) || !r.args.every((a) => typeof a === 'string'))) errs.push(`${where}: args must be an array of strings`);
  for (const k of ['command', 'tools', 'mcp']) if (r[k] !== undefined && (!Array.isArray(r[k]) || !r[k].length || !r[k].every(isWord))) errs.push(`${where}: ${k} must be a non-empty array of strings`);
  if (r.supervision !== undefined) errs.push(...supervisionErrors(r.supervision).map((e) => `${where}: ${e}`));
  if (r.web_mcp !== undefined) {
    errs.push(...webMcpErrors(r.web_mcp).map(e => `${where}: ${e}`));
    if (!research) errs.push(`${where}: web_mcp applies only to research`);
    if (r.mcp !== undefined) errs.push(`${where}: web_mcp cannot be combined with mcp; only the web server loads`);
  }
  if (r.fallbacks !== undefined) {
    if (!user) errs.push(`${where}: fallbacks belong only in the user file, not the project`);
    else if (fallback) errs.push(`${where}: fallback routes cannot have fallbacks`);
    else if (!Array.isArray(r.fallbacks)) errs.push(`${where}: fallbacks must be an array of routes`);
    else r.fallbacks.forEach((route, i) => rungShape(`${where} fallback ${i + 1}`, route, errs, true, true, research));
  }
  errs.push(...SpawnSettings.errors(r).map((e) => `${where}: ${e}`));
  return errs;
}

function browserKitErrors(value) {
  return Array.isArray(value) && value.every((name) => isWord(name) && !name.includes('\0'))
    ? [] : ['browser_kit must be an array of non-blank MCP server names without NUL bytes'];
}

// Shape of { harness, ladder } as project.json and the user file hold it.
// Either may leave out the harness or any rung; the next layer fills it.
function shapeErrors(doc, user = false) {
  const errs = SpawnSettings.errors(doc);
  if (doc.browser_kit !== undefined) errs.push(...browserKitErrors(doc.browser_kit));
  if (doc.harness !== undefined && !HARNESSES.includes(doc.harness)) errs.push(`harness must be one of ${HARNESSES.join(', ')}`);
  if (doc.ladder !== undefined) {
    if (!isObject(doc.ladder)) errs.push('ladder must be an object of rungs');
    else {
      for (const [name, r] of Object.entries(doc.ladder)) {
        if (!RUNGS.includes(name)) errs.push(`ladder: unknown rung ${name}; the rungs are ${RUNGS.join(', ')}`);
        else rungShape(`ladder ${name}`, r, errs, user);
      }
    }
  }
  return errs;
}

function readUser(env = process.env) {
  const file = userFile(env);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw refuse(`cannot read ${file} (${e.code || e.message})`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw refuse(`${file} is not valid JSON (${e.message}); fix it or remove it`);
  }
  if (!isObject(doc)) throw refuse(`${file} must hold an object { "harness", "ladder" }; fix it or remove it`);
  const errs = shapeErrors(doc, true);
  if (errs.length) throw refuse(`${file} is invalid: ${errs.join('; ')}; fix it or remove it`);
  return doc;
}

const copy = (v) => JSON.parse(JSON.stringify(v));

// Fields in FIELDS order, so files and output read the same way every time.
function ordered(r) {
  const out = {};
  for (const k of FIELDS) if (r[k] !== undefined) out[k] = copy(r[k]);
  return out;
}

// Each rung, and the default harness, comes whole from the first layer that
// has it: the project, then the user file, then the built-in defaults. The
// user file always supplies personal fallbacks, independently of the primary.
function resolve(project, env = process.env, user = readUser(env)) {
  const p = project || {};
  const pl = isObject(p.ladder) ? p.ladder : {};
  const ul = user && isObject(user.ladder) ? user.ladder : {};
  let harness = BUILTIN.harness;
  let harnessFrom = 'built-in';
  if (p.harness !== undefined) [harness, harnessFrom] = [p.harness, 'project'];
  else if (user && user.harness !== undefined) [harness, harnessFrom] = [user.harness, 'user'];
  const ladder = {};
  for (const name of RUNGS) {
    let own = BUILTIN.ladder[name];
    let from = 'built-in';
    if (pl[name] !== undefined) [own, from] = [pl[name], 'project'];
    else if (ul[name] !== undefined && (ul[name].fallbacks === undefined || Object.keys(ordered(ul[name])).length)) [own, from] = [ul[name], 'user'];
    own = ordered(own);
    ladder[name] = { own, from, harness: own.harness || harness, harness_from: own.harness ? 'rung' : 'default' };
    if (ul[name]?.fallbacks !== undefined) {
      ladder[name].fallbacks = copy(ul[name].fallbacks);
      ladder[name].fallbacks_from = 'user';
    }
  }
  return { harness, harness_from: harnessFrom, user_file: userFile(env), ladder };
}

// What a rung needs on the harness it resolves to. A field another harness
// would use is refused rather than ignored: dropping a codex profile on pi
// would quietly run a model nobody chose.
function rungErrors(name, entry, layers) {
  const r = entry.own;
  const h = entry.harness;
  const why = [];
  if (r.profile !== undefined && h !== 'codex') why.push('profile applies only to codex');
  if (r.provider !== undefined && !['pi', 'claude'].includes(h)) why.push('provider applies only to pi and claude');
  if (h === 'claude' && r.provider !== undefined && !['anthropic', 'bedrock'].includes(r.provider)) why.push('claude provider must be anthropic or bedrock');
  if (r.tools !== undefined && ![...ISOLATED, 'pi'].includes(h)) why.push(`tools applies only to ${ISOLATED.join(', ')} and pi`);
  if (r.mcp !== undefined && !ISOLATED.includes(h)) why.push(h === 'pi' ? 'MCP opt-ins are unsupported on pi' : `mcp applies only to ${ISOLATED.join(' and ')}`);
  if (h === 'pi') {
    const unknown = (r.tools || []).filter((tool) => !['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'].includes(tool));
    if (unknown.length) why.push(`pi tools must be built-ins: read, bash, edit, write, grep, find, ls; unknown ${unknown.join(', ')}`);
  }
  if (r.web_mcp !== undefined && h !== 'claude') why.push('web_mcp applies only to claude');
  if (r.web_mcp !== undefined && r.mcp !== undefined) why.push('web_mcp cannot be combined with mcp; only the web server loads');
  const bad = unsafeArgs(h, r.args || []);
  if (bad.length) why.push(`args may only use ${Object.keys(SAFE_ARGS[h]).join(', ')}; refused ${bad.join(', ')}`);
  if (h === 'command') {
    if (r.command === undefined) why.push('needs a command array');
    for (const k of ['model', 'effort']) if (r[k] !== undefined) why.push(`${k} does not apply (put it in the command array)`);
  } else {
    if (r.command !== undefined) why.push('command applies only to the command harness');
    if (h === 'codex' ? r.model === undefined && r.profile === undefined : r.model === undefined) why.push(h === 'codex' ? 'needs a model or a profile' : 'needs a model');
    const allowed = EFFORTS[h];
    if (r.effort !== undefined && allowed && !allowed.includes(r.effort)) why.push(`effort must be one of ${allowed.join(', ')}, not "${r.effort}"`);
    if (r.effort !== undefined && !allowed && !/^[\w.-]+$/.test(r.effort)) why.push(`effort must be a single word, not "${r.effort}"`);
  }
  if (!why.length) return [];
  const from = entry.from === 'project' ? '' : `, from the ${entry.from === 'user' ? `user file ${layers.user_file}` : 'built-in defaults'}`;
  return [`ladder ${name} (${h}${entry.harness_from === 'default' ? ', the default harness' : ''}${from}): ${why.join(', ')}`];
}

// Everything wrong with a project's ladder once the layers are applied. Only
// writes, spawn and validate ask this: a project whose missing rungs fall
// back to a user file that changed since must still load, or no command could
// repair it.
function check(project, env = process.env) {
  const errs = shapeErrors(project || {});
  if (errs.length) return errs;
  const layers = resolve(project, env);
  for (const name of RUNGS) errs.push(...rungErrors(name, layers.ladder[name], layers));
  return errs;
}

// The rung as spawn and the views use it: its own fields plus the harness it
// runs on.
function rungOf(layers, name) {
  const e = layers.ladder[name];
  return { ...e.own, harness: e.harness, ...(e.fallbacks !== undefined ? { fallbacks: e.fallbacks } : {}) };
}

function routes(rung) {
  const { fallbacks = [], ...primary } = rung;
  return [primary, ...fallbacks.map((route) => ({
    ...(primary.supervision ? { supervision: primary.supervision } : {}),
    ...((route.harness || primary.harness) === 'claude' && primary.web_mcp ? { web_mcp: primary.web_mcp } : {}),
    ...route, harness: route.harness || primary.harness,
  }))];
}

// Which model a rung runs, for telling two rungs apart. codex -m overrides
// the model a profile names, so a profile tells rungs apart only when neither
// names a model; two rungs with the same -m and different profiles run the
// same model.
function identity(rung) {
  if (rung.harness === 'command') return `command ${JSON.stringify(rung.command || [])}`;
  const model = rung.model ? `model ${rung.model}` : `profile ${rung.profile || ''}`;
  return [rung.harness, model, rung.provider || ''].join('|');
}

// Usage records, Codex profiles and configured prices can name the same model
// differently. Keep one identity for comparison without collapsing distinct
// provider models into a family name.
function modelIdentity(value) {
  const model = String(value || '').trim();
  if (!model || model.startsWith('command ')) return model;
  const normalized = model.toLowerCase();
  const leaf = normalized.split('/').at(-1);
  return MODEL_ALIASES.get(normalized) || MODEL_ALIASES.get(leaf) || normalized;
}

function describe(rung) {
  const parts = [];
  if (rung.model) parts.push(`model ${rung.model}`);
  if (rung.profile) parts.push(`profile ${rung.profile}`);
  if (rung.provider) parts.push(`provider ${rung.provider}`);
  if (rung.effort) parts.push(`effort ${rung.effort}`);
  if (rung.command) parts.push(`command ${JSON.stringify(rung.command)}`);
  if (rung.args && rung.args.length) parts.push(`args ${JSON.stringify(rung.args)}`);
  if (rung.supervision) parts.push(`supervision ${JSON.stringify(rung.supervision)}`);
  if (rung.fallbacks) parts.push(`fallbacks ${JSON.stringify(rung.fallbacks)}`);
  if (rung.tools) parts.push(`tools ${JSON.stringify(rung.tools)}`);
  if (rung.mcp) parts.push(`mcp ${JSON.stringify(rung.mcp)}`);
  if (rung.web_mcp) parts.push(`web_mcp ${JSON.stringify(rung.web_mcp)}`);
  for (const k of SpawnSettings.FIELDS) if (rung[k] !== undefined) parts.push(`${k} ${JSON.stringify(rung[k])}`);
  return parts.join(', ');
}

module.exports = {
  HARNESSES, ISOLATED, SAFE_ARGS, CODEX_KEYS, RUNGS, TIERS, JOBS, FIELDS, EFFORTS, USES, BUILTIN, SOURCE,
  defaultTier, userFile, readUser, shapeErrors, resolve, rungErrors, check, rungOf, identity, modelIdentity, describe, ordered,
  SUPERVISION, MIN_USAGE_MS, supervision, supervisionErrors, webMcpErrors, routes, tierSpec,
  browserKitErrors,
};
