'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { refuse } = require('./util');

const FIELDS = ['sandbox', 'env', 'env_file', 'scope'];
// Node runtime controls belong to the process that set
// them. Agents inherit none; git/gh shims clear even an agent's own values.
const NODE_INJECT = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_PRESERVE_SYMLINKS', 'NODE_PRESERVE_SYMLINKS_MAIN', 'NODE_COMPILE_CACHE', 'NODE_V8_COVERAGE'];
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const word = (v) => typeof v === 'string' && v.trim() && !v.includes('\0');
const reserved = (k) => /^(HOME|USERPROFILE|CODEX_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PATH|TOWER_CRANE_.*)$/i.test(k);
const key = (k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !reserved(k);

// A host pattern for claude's network.allowedDomains, by the rule Claude
// Code 2.1.296's schema states: a domain with a dot (example.com),
// localhost, an IPv6 literal in brackets, or *. and a domain of two labels
// or more (*.example.com), each with an optional :port of 1 to 65535 with no
// leading zero. More than one colon outside brackets is refused, so an
// IPv6 literal needs its brackets. The schema calls * too broad, yet the
// sandbox proxy honors a bare * as every host (measured 2026-10-14), so * is
// taken here as the explicit opt-in to that; *.com and a single label (pypi)
// are refused. The host is ASCII letters, digits, dots, hyphens and *, or
// hex digits, colons and dots in brackets, so a fullwidth or zero-width
// character, an ideographic full stop, # or @ is refused before the
// shared-suffix check reads the name.
function domainPattern(value) {
  if (value === '*') return true;
  if (typeof value !== 'string' || !value) return false;
  const port = (p) => p === undefined || (/^[1-9][0-9]{0,4}$/.test(p) && Number(p) <= 65535);
  if (value.startsWith('[')) {
    const m = /^\[([0-9A-Fa-f:.]+)\](?::(.*))?$/.exec(value);
    return !!m && require('node:net').isIP(m[1]) === 6 && port(m[2]);
  }
  const parts = value.split(':');
  if (parts.length > 2 || !port(parts[1])) return false;
  const host = parts[0];
  if (!/^[A-Za-z0-9.*-]+$/.test(host)) return false;
  if (host === 'localhost') return true;
  if (host.startsWith('*.')) {
    const rest = host.slice(2);
    if (!rest.includes('.') || rest.startsWith('.') || rest.endsWith('.')) return false;
    return rest.split('.').every((label) => label.length > 0 && !label.includes('*'));
  }
  if (host.includes('*')) return false;
  return host.includes('.') && !host.startsWith('.') && !host.endsWith('.');
}

// Suffixes under which many owners have names: a wildcard over one reaches
// every tenant's host. Claude's schema takes *.co.uk or *.github.io, so the
// mistake is caught here. A short built-in list, not the Public Suffix
// List: two-letter country domains under the usual second levels, and the
// hosting and cloud zones where agents most often fetch.
const SHARED_SUFFIXES = ['github.io', 'gitlab.io', 'amazonaws.com', 'cloudfront.net', 'elasticbeanstalk.com',
  'windows.net', 'azurewebsites.net', 'azureedge.net', 'azurestaticapps.net', 'cloudapp.net',
  'appspot.com', 'run.app', 'web.app', 'firebaseapp.com', 'cloudfunctions.net', 'herokuapp.com',
  'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'r2.dev', 'trycloudflare.com', 'fly.dev',
  'onrender.com', 'railway.app', 'ngrok.io', 'ngrok.app', 'ngrok-free.app', 'glitch.me', 'repl.co',
  'surge.sh', 'digitaloceanspaces.com', 'ondigitalocean.app', 'blogspot.com', 'myshopify.com', 'hf.space',
  'googleapis.com', 'googleusercontent.com', 'supabase.co', 'azurecr.io', 'deno.dev', 'pythonanywhere.com', 'loca.lt',
  'me.uk', 'id.au', 'eu.org', 'uk.com', 'us.com', 'blogspot.co.uk',
  // Request capture services: any tenant reads what a listed host is sent.
  'oast.fun', 'interact.sh', 'pipedream.net', 'burpcollaborator.net'];
const COUNTRY_SECOND = /^(?:co|com|net|org|ac|edu|gov|gob|go|ne|or|ltd|plc|sch|nic|mil)\.[a-z]{2}$/;

// The shared suffix a wildcard pattern covers, or null.
function sharedSuffix(value) {
  if (typeof value !== 'string' || !value.startsWith('*.')) return null;
  const rest = value.slice(2).replace(/:\d+$/, '').toLowerCase();
  if (COUNTRY_SECOND.test(rest)) return rest;
  return SHARED_SUFFIXES.find((s) => rest === s || rest.endsWith(`.${s}`)) || null;
}

// What is wrong with a sandbox.domains list, one line per entry.
function domainProblems(list) {
  return list.flatMap((d) => {
    if (!domainPattern(d)) return [`${JSON.stringify(d)} is not a host pattern claude's sandbox takes`];
    const shared = sharedSuffix(d);
    return shared ? [`${d} covers ${shared}, a suffix many owners share; name the hosts instead`] : [];
  });
}

// Whether claude's proxy lets an entry's host and port through a list, by
// its own match (2.1.296): * is every host, *.example.com every name under
// example.com but not example.com itself, and a pattern with a port only
// that port. remoteHosts names an http or https remote's default port (80,
// 443) when its URL names none, so host:443 covers a portless https remote;
// an entry without a port, such as an ssh remote, is covered only by a
// pattern without one.
function domainCovered(list, entry) {
  const split = (v) => {
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(v);
    return m ? { host: m[1].toLowerCase(), port: m[2] } : { host: v.toLowerCase(), port: undefined };
  };
  const want = split(entry);
  return list.some((pattern) => {
    if (pattern === '*') return true;
    const p = split(pattern);
    if (p.port !== undefined && p.port !== want.port) return false;
    return p.host.startsWith('*.') ? want.host.endsWith(p.host.slice(1)) : p.host === want.host;
  });
}

function errors(doc) {
  const errs = [];
  if (doc.sandbox !== undefined) {
    const s = doc.sandbox;
    if (!object(s)) errs.push('sandbox must be an object');
    else {
      for (const k of Object.keys(s)) if (!['write', 'read', 'session_bus', 'domains'].includes(k)) errs.push(`sandbox: unknown field ${k}`);
      if (s.domains !== undefined && (!Array.isArray(s.domains) || !s.domains.every(domainPattern))) {
        errs.push('sandbox.domains must be an array of host patterns: example.com, *.example.com (two labels or more after *.), localhost or [::1], each with an optional :port (1 to 65535, no leading zero), or * for every host; *.com, single labels and an IPv6 literal without brackets are refused');
      } else if (s.domains !== undefined) {
        errs.push(...domainProblems(s.domains).map((p) => `sandbox.domains: ${p}`));
      }
      for (const k of ['write', 'read']) {
        if (s[k] !== undefined && (!Array.isArray(s[k]) || !s[k].every(word))) errs.push(`sandbox.${k} must be an array of non-blank paths without NUL bytes`);
      }
      if (s.session_bus !== undefined && typeof s.session_bus !== 'boolean') errs.push('sandbox.session_bus must be true or false');
    }
  }
  if (doc.env !== undefined && (!object(doc.env) || !Object.entries(doc.env).every(([k, v]) => key(k) && typeof v === 'string' && !v.includes('\0')))) {
    errs.push('env must be an object of variable names and string values without NUL bytes; HOME, USERPROFILE, PATH, harness homes and TOWER_CRANE_* are reserved');
  }
  if (doc.env_file !== undefined && !word(doc.env_file)) errs.push('env_file must be a non-blank path without NUL bytes');
  if (doc.scope !== undefined && (!object(doc.scope) || !Object.entries(doc.scope).every(([k, v]) =>
    /^[A-Za-z][A-Za-z0-9]*$/.test(k) && word(v) && !/[\r\n]/.test(v)))) {
    errs.push('scope must be an object of systemd property names and non-blank string values without NUL bytes or newlines');
  }
  return errs;
}

function resolve(project, rung) {
  return {
    sandbox: { ...project.sandbox, ...rung.sandbox,
      // Allowed hosts add up: a rung extends the project's list.
      ...(project.sandbox?.domains || rung.sandbox?.domains
        ? { domains: [...new Set([...(project.sandbox?.domains || []), ...(rung.sandbox?.domains || [])])] } : {}) },
    env: { ...project.env, ...rung.env },
    env_file: rung.env_file ?? project.env_file,
    // A personal fallback route's env_file, with the content the owner approved (route-grants.js).
    ...(rung.env_file !== undefined && rung.env_file_sha256 ? { env_file_sha256: rung.env_file_sha256 } : {}),
    scope: rung.scope ?? project.scope,
  };
}

function expand(value, home, cwd) {
  const p = value === '~' ? home : /^~[/\\]/.test(value) ? path.join(home, value.slice(2)) : value;
  return path.resolve(cwd, p);
}

function prepare(settings, home, cwd) {
  return {
    ...settings,
    sandbox: { ...settings.sandbox, ...Object.fromEntries(['write', 'read'].map((k) => [k, (settings.sandbox[k] || []).map((p) => expand(p, home, cwd))])) },
    env_file: settings.env_file ? expand(settings.env_file, home, cwd) : undefined,
  };
}

function scoped(settings) {
  return !!settings.scope && Object.keys(settings.scope).length > 0;
}

function scopeCommand(settings, argv) {
  if (!scoped(settings)) return argv;
  return ['systemd-run', '--user', '--scope', '--quiet', '--expand-environment=no',
    ...Object.entries(settings.scope).flatMap(([k, v]) => ['-p', `${k}=${v}`]), '--', ...argv];
}

// EnvironmentFile quoting is not shell evaluation. Only an initial quote
// starts a quoted value; unquoted interior quotes remain literal.
function parseEnv(text, file) {
  const env = Object.create(null);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let assignmentLine = 1;
  const bad = () => { throw refuse(`invalid env_file ${file} at line ${assignmentLine}`); };
  const take = () => {
    const c = text[i++];
    if (c === '\n') line++;
    return c;
  };
  while (i < text.length) {
    while (i < text.length && /[ \t\r\n]/.test(text[i])) take();
    if (i === text.length) break;
    if (text[i] === '#' || text[i] === ';') {
      while (i < text.length && take() !== '\n') {}
      continue;
    }
    assignmentLine = line;
    let name = '';
    while (i < text.length && !['=', '\n'].includes(text[i])) name += take();
    name = name.trim();
    if (take() !== '=' || !key(name)) bad();
    while (i < text.length && /[ \t\r]/.test(text[i])) take();
    const quote = ['"', "'"].includes(text[i]) ? take() : null;
    let value = '';
    let whitespace = '';
    let closed = !quote;
    while (i < text.length) {
      const c = take();
      if (quote && c === quote) { closed = true; break; }
      if (!quote && c === '\n') break;
      if (c === '\\' && quote !== "'") {
        if (i === text.length) bad();
        const next = take();
        if (next === '\n') continue;
        if (quote === '"' && !['\\', '$', '`', '"'].includes(next)) value += '\\';
        value += whitespace + next;
        whitespace = '';
      } else if (!quote && /[ \t\r]/.test(c)) whitespace += c;
      else {
        value += whitespace + c;
        whitespace = '';
      }
    }
    if (!closed) bad();
    if (quote) {
      while (i < text.length && /[ \t\r]/.test(text[i])) take();
      if (i < text.length && take() !== '\n') bad();
    }
    if (value.includes('\0')) bad();
    env[name] = value;
  }
  return env;
}

function agentEnv(settings) {
  let fromFile = {};
  if (settings.env_file) {
    let bytes;
    try { bytes = fs.readFileSync(settings.env_file); }
    catch (e) { throw refuse(`cannot read env_file ${settings.env_file} (${e.code})`); }
    if (settings.env_file_sha256 && require('node:crypto').createHash('sha256').update(bytes).digest('hex') !== settings.env_file_sha256) {
      throw refuse(`env_file ${settings.env_file} changed since the owner approved its fallback route, so the route does not run; the owner approves the new content by writing the list again with tower-crane ladder set RUNG --fallbacks JSON`);
    }
    fromFile = parseEnv(bytes.toString('utf8'), settings.env_file);
  }
  return { ...fromFile, ...settings.env };
}

// A parent test runner's context makes an agent's node --test skip all files.
// The dispatcher's harness session ids would name the wrong session in the
// agent's orchestrator lease, and engine provenance belongs to the helpers
// that set it for their own CLI children.
const SESSION_ENV = ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'];
const DISPATCHER_ONLY = new Set([...SESSION_ENV, 'TOWER_CRANE_VIA', 'TOWER_CRANE_AUTOMATION_KEY_FD']);
// Also drops an outer spawn's run marker: a supervisor or harness started
// from inside an agent is not that agent's to stop (lib/processes.js).
function cleanDispatcherEnv(env) {
  return Object.fromEntries(Object.entries(require('./processes').withoutRunMarks(env)).filter(([name]) => !/^NODE_TEST_/i.test(name)
    && !DISPATCHER_ONLY.has(process.platform === 'win32' ? name.toUpperCase() : name)));
}

// Apply before configured env overlays, which may opt into a preload.
function cleanAgentEnv(env) {
  const out = Object.fromEntries(Object.entries(cleanDispatcherEnv(env)).filter(([name]) =>
    !NODE_INJECT.includes(process.platform === 'win32' ? name.toUpperCase() : name)));
  // An empty value blocks Node's parent fallback and survives the job handoff.
  out.NODE_V8_COVERAGE = '';
  return out;
}

module.exports = { FIELDS, NODE_INJECT, SESSION_ENV, errors, domainPattern, domainProblems, domainCovered, resolve, prepare, agentEnv, cleanAgentEnv, cleanDispatcherEnv, scoped, scopeCommand };
