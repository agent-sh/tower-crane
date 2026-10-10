'use strict';

const fs = require('node:fs');
const path = require('node:path');
const S = require('./state');
const L = require('./ladder');
const { refuse, usage } = require('./util');

const needed = (task) => task?.kind === 'design' || (task?.needs || []).includes('browser');

function userEnv(env, home) {
  return { ...env, TOWER_CRANE_CONFIG: env.TOWER_CRANE_CONFIG || path.join(home, '.config', 'tower-crane', 'config.json') };
}

function servers(env, home) {
  return [...new Set(L.readUser(userEnv(env, home))?.browser_kit || ['playwright'])];
}

function attachment(task, harness, env, origin) {
  if (!needed(task)) return null;
  let requested;
  try { requested = servers(env, origin.home); } catch {
    return { requested: [], attached: [], omitted: [], warning: `browser kit unavailable on ${harness}: cannot read the user kit configuration; running without it` };
  }
  const supported = L.ISOLATED.includes(harness);
  let attached = [];
  try { if (supported && requested.length) attached = require('./agents').availableMcp(harness, origin, requested); } catch {
    return { requested, attached: [], omitted: requested, warning: `browser kit unavailable on ${harness}: cannot read the user harness configuration; running without it` };
  }
  const omitted = requested.filter((name) => !attached.includes(name));
  const source = harness === 'claude' ? `${path.join(origin.claude.dir, 'mcp.json')} or ${origin.claude.json}`
    : harness === 'agy' ? path.join(origin.agy || path.join(origin.home, '.gemini'), 'config', 'mcp_config.json')
    : path.join(origin.codex, 'config.toml');
  const warning = !requested.length ? `browser kit disabled on ${harness}; running without it`
    : omitted.length ? `browser kit omitted on ${harness}: ${omitted.join(', ')} ${supported ? `not configured in ${source}` : 'cannot attach on this harness'}; running without it` : null;
  return { requested, attached, omitted, warning };
}

function requireRoute(task, routes, env, origin) {
  if (!(task?.needs || []).includes('browser')) return;
  const kits = routes.map((route) => attachment(task, route.harness, env, origin));
  if (!kits.some((kit) => kit.attached.length)) {
    throw refuse(`${task.id} explicitly needs browser, but no route can provide its browser kit: ${kits.map((kit) => kit.warning).join('; ')}`);
  }
}

function show(ctx) {
  const home = require('./agents').origin(ctx.env).home;
  const names = servers(ctx.env, home);
  const file = L.userFile(userEnv(ctx.env, home));
  return { data: { servers: names, file }, text: `browser kit: ${names.join(', ') || '(empty)'}\nuser file: ${file}` };
}

function set(ctx) {
  let names;
  try { names = JSON.parse(ctx.flags.servers); } catch { throw usage('--servers must be a JSON array of MCP server names'); }
  const errors = L.browserKitErrors(names);
  if (errors.length) throw usage(errors.join('; '));
  names = [...new Set(names)];
  const home = require('./agents').origin(ctx.env).home;
  const file = L.userFile(userEnv(ctx.env, home));
  S.mutate(ctx, 'browser-kit set', (st, emit, commit) => {
    require('./authority').enforce(ctx, st, ['browser_kit'], { change: { user_file: file, servers: names }, emit, commit });
    let doc = {};
    if (fs.existsSync(file)) {
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw refuse(`${file} must hold a valid JSON object`); }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw refuse(`${file} must hold an object`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    S.writeAtomic(file, S.json({ ...doc, browser_kit: names }));
    emit(null, { file, servers: names });
  });
  return { data: { servers: names, file }, text: `browser kit: ${names.join(', ') || '(empty)'}; wrote ${file}` };
}

module.exports = { needed, servers, attachment, requireRoute, show, set };
