#!/usr/bin/env node
'use strict';

const OUTPUT_PIPE_CLOSED = 'tower-crane:output-pipe-closed';
let outputPipeClosed = false;

for (const stream of [process.stdout, process.stderr]) {
  let broken = false;
  stream.on('error', (error) => {
    // libuv reports a pipe whose reader is gone as EPIPE, or EOF on Windows.
    if (['EPIPE', 'EOF'].includes(error.code)) {
      broken = true;
      stream.destroy();
      if (!outputPipeClosed) {
        outputPipeClosed = true;
        process.emit(OUTPUT_PIPE_CLOSED);
      }
      return;
    }
    if (!broken) throw error;
  });
}

const { TowerCraneError, usage, refuse, readStdin } = require('../lib/util');
const { isatty } = require('node:tty');
const S = require('../lib/state');

const { str, bool } = require('../lib/commands-specs');

const GLOBAL = {
  state: str('DIR', 'state directory (default: TOWER_CRANE_STATE, then .tower-crane/ in the main checkout)'),
  agent: str('NAME', 'who is acting (default: TOWER_CRANE_AGENT; task processes cannot use owner; fallback needs an interactive terminal outside a task)'),
  json: bool('machine output on stdout'),
  help: bool('show help'),
};

const COMMANDS = require('node:fs').readdirSync(require('node:path').join(__dirname, '../lib'))
  .filter((name) => /^commands-(?!specs\.js$).*\.js$/.test(name))
  .flatMap((name) => require(`../lib/${name}`))
  .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const GROUPS = new Set(COMMANDS.filter((c) => c.name.includes(' ')).map((c) => c.name.split(' ')[0]));
const SECTIONS = ['Plan', 'Run', 'Decisions', 'Views', 'Agents and worktrees', 'Gates'];

function flagLine(name, spec) {
  const left = `  --${name}${spec.arg ? ` ${spec.arg}` : ''}`;
  return `${left.padEnd(26)} ${spec.help}${spec.type === 'multi' ? ' (repeatable)' : ''}`;
}

function generalHelp() {
  const lines = ['tower-crane: plan, dispatch, review and merge agent work, with state in plain files', '', 'usage: tower-crane <command> [args] [--state DIR] [--agent NAME] [--json]'];
  for (const section of SECTIONS) {
    lines.push('', `${section}:`);
    for (const c of COMMANDS.filter((x) => x.section === section)) lines.push(`  ${c.name.padEnd(16)} ${c.summary}`);
  }
  lines.push('', 'global options:', ...Object.entries(GLOBAL).map(([n, s]) => flagLine(n, s)));
  lines.push('', `exit status: 0 done, 1 refused (reason on stderr), 2 usage error, 3 lock not acquired within ${S.LOCK_WAIT_MS / 1000} s`);
  lines.push('run tower-crane <command> --help for its options, tower-crane --version for the version; docs/cli.md and docs/state.md hold the contract');
  return lines.join('\n');
}

function commandHelp(c) {
  const lines = [`usage: tower-crane ${c.name}${c.usage ? ` ${c.usage}` : ''}`, '', c.summary];
  const flags = Object.entries(c.flags || {});
  if (flags.length) lines.push('', 'options:', ...flags.map(([n, s]) => flagLine(n, s)));
  lines.push('', 'global options:', ...Object.entries(GLOBAL).map(([n, s]) => flagLine(n, s)));
  return lines.join('\n');
}

function groupHelp(group) {
  const lines = [`usage: tower-crane ${group} <subcommand> ...`, ''];
  for (const c of COMMANDS.filter((x) => x.name.startsWith(`${group} `))) lines.push(`  ${c.name.padEnd(16)} ${c.summary}`);
  return lines.join('\n');
}

function convert(name, spec, raw) {
  if (spec.nullable && raw === 'null') return null;
  if (spec.type === 'int') {
    if (!/^-?\d+$/.test(raw)) throw usage(`--${name} needs a whole number, got "${raw}"`);
    return parseInt(raw, 10);
  }
  if (spec.type === 'number') {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) throw usage(`--${name} needs a number, got "${raw}"`);
    return n;
  }
  return raw;
}

// Options take their value from the next token even if it starts with "-",
// so "--minutes -5" reaches validation instead of becoming an unknown flag.
// spans name the token indexes each option took, for the state broker.
// Option names come from the command line, which the state broker takes from
// a sandboxed agent, so only a command's own option names are looked up and
// values collect in a Map; no name can reach Object.prototype.
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

function parseOptions(tokens, specs, where) {
  const flags = new Map();
  const pos = [];
  const spans = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--') {
      pos.push(...tokens.slice(i + 1));
      break;
    }
    if (tok === '-h') {
      flags.set('help', true);
      continue;
    }
    if (!tok.startsWith('--')) {
      pos.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const spec = !RESERVED.has(name) && Object.hasOwn(specs, name) ? specs[name] : null;
    if (!spec) throw usage(`unknown option --${name}${where ? ` for ${where}` : ''}; see tower-crane ${where ? `${where} ` : ''}--help`);
    if (spec.type === 'bool') {
      if (eq !== -1) throw usage(`--${name} takes no value`);
      flags.set(name, true);
      spans.push({ name, from: i, to: i });
      continue;
    }
    const from = i;
    let raw;
    if (eq !== -1) raw = tok.slice(eq + 1);
    else {
      if (i + 1 >= tokens.length) throw usage(`--${name} needs a value (${spec.arg})`);
      raw = tokens[++i];
    }
    spans.push({ name, from, to: i });
    const value = convert(name, spec, raw);
    if (spec.type === 'multi') flags.set(name, [...(flags.get(name) || []), value]);
    else if (flags.has(name)) throw usage(`--${name} was given twice`);
    else flags.set(name, value);
  }
  return { flags: Object.fromEntries(flags), pos, spans };
}

function splitGlobals(flags) {
  const globals = {};
  const own = {};
  for (const [k, v] of Object.entries(flags)) (k in GLOBAL ? globals : own)[k] = v;
  return { globals, own };
}

function resolveCommand(argv) {
  // Global options may come before the command word.
  let i = 0;
  const lead = [];
  while (i < argv.length && argv[i].startsWith('-')) {
    const tok = argv[i];
    const name = tok.replace(/^--?/, '').split('=')[0];
    if (tok === '--version') return { version: true };
    if (tok === '-h' || name === 'help' || name === 'json') {
      lead.push(tok);
      i += 1;
    } else if ((name === 'state' || name === 'agent') && tok.startsWith('--')) {
      lead.push(tok);
      if (!tok.includes('=')) lead.push(argv[i + 1]);
      i += tok.includes('=') ? 1 : 2;
    } else {
      throw usage(`unknown option ${tok}; put command options after the command`);
    }
  }
  const word = argv[i];
  if (word === undefined || word === 'help') {
    const topic = word === 'help' ? argv.slice(i + 1).join(' ') : '';
    return { help: topic || true, lead };
  }
  if (GROUPS.has(word)) {
    const sub = argv[i + 1];
    const cmd = sub && !sub.startsWith('-') ? COMMANDS.find((c) => c.name === `${word} ${sub}`) : null;
    if (!cmd) {
      const parent = COMMANDS.find((c) => c.name === word);
      if (parent) return { cmd: parent, rest: argv.slice(i + 1), lead };
      const rest = argv.slice(i + 1);
      if (rest.includes('--help') || rest.includes('-h') || sub === undefined) return { groupHelp: word, lead, bare: sub === undefined };
      throw usage(`unknown command "${word} ${sub}"; run tower-crane ${word} --help`);
    }
    return { cmd, rest: argv.slice(i + 2), lead };
  }
  const cmd = COMMANDS.find((c) => c.name === word);
  if (!cmd) throw usage(`unknown command "${word}"; run tower-crane --help`);
  return { cmd, rest: argv.slice(i + 1), lead };
}

function checkPositionals(cmd, pos) {
  const spec = cmd.pos || [];
  const required = spec.filter((p) => !p.startsWith('[')).length;
  const variadic = spec.some((p) => p.endsWith('...'));
  if (pos.length < required) throw usage(`${cmd.name} needs ${spec.filter((p) => !p.startsWith('[')).join(' ')}; usage: tower-crane ${cmd.name} ${cmd.usage || ''}`.trim());
  if (!variadic && pos.length > spec.length) throw usage(`unexpected argument "${pos[spec.length]}" for ${cmd.name}`);
}

async function main(argv) {
  // State discovery can start Git before authentication; children get no key.
  const ownerCredential = process.env.TOWER_CRANE_OWNER_KEY;
  delete process.env.TOWER_CRANE_OWNER_KEY;
  const AutomationKey = require('../lib/automation-key');
  const out = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  let resolved;
  let jsonOut = argv.includes('--json');
  let automationCredential;
  try {
    // A helper writes its key on stdin before any input the command reads.
    automationCredential = AutomationKey.take(process.env);
    resolved = resolveCommand(argv);
    if (resolved.version) {
      out(require('../package.json').version);
      return 0;
    }
    if (resolved.help) {
      if (resolved.help === true) {
        if (argv.length) {
          out(generalHelp());
          return 0;
        }
        process.stderr.write(`${generalHelp()}\n`);
        return 2;
      }
      const c = COMMANDS.find((x) => x.name === resolved.help);
      if (c) out(commandHelp(c));
      else if (GROUPS.has(resolved.help)) out(groupHelp(resolved.help));
      else throw usage(`no help for "${resolved.help}"; run tower-crane --help`);
      return 0;
    }
    if (resolved.groupHelp) {
      if (!resolved.bare) {
        out(groupHelp(resolved.groupHelp));
        return 0;
      }
      process.stderr.write(`${groupHelp(resolved.groupHelp)}\n`);
      return 2;
    }
    const { cmd } = resolved;
    const parsed = parseOptions([...resolved.lead, ...resolved.rest], { ...(cmd.flags || {}), ...GLOBAL }, cmd.name);
    const { globals, own } = splitGlobals(parsed.flags);
    jsonOut = !!globals.json;
    if (globals.help) {
      out(commandHelp(cmd));
      return 0;
    }
    checkPositionals(cmd, parsed.pos);
    for (const r of cmd.required || []) {
      if (own[r] === undefined) throw usage(`${cmd.name} needs --${r}; usage: tower-crane ${cmd.name} ${cmd.usage}`);
    }
    let agent = globals.agent ?? process.env.TOWER_CRANE_AGENT;
    // Inspect descriptors without initializing stdin and changing pipe flags.
    const ownerTerminal = isatty(0) && isatty(1);
    // Terminal fallback identifies ordinary actions; owner powers need a named identity.
    const agentExplicit = agent !== undefined;
    if (agent === undefined) {
      if (ownerTerminal && process.env.TOWER_CRANE_TASK === undefined) agent = 'owner';
      else throw usage('no agent: pass --agent NAME or set TOWER_CRANE_AGENT');
    }
    if (!agent.trim()) throw usage('no agent: pass --agent NAME or set TOWER_CRANE_AGENT');
    const identity = agent.trim();
    let stateDir;
    const locate = () => stateDir ??= S.locateStateDir(globals.state, process.env, process.cwd());
    // A wait at "now" starts at the log's end as of this point. Orchestrator
    // discovery below takes seconds on a cold Windows host, and events written
    // meanwhile must reach the waiter.
    const startCursor = cmd.name === 'wait' && (own.after === undefined || own.after === 'now')
      ? require('../lib/events').startCursor(locate()) : undefined;
    const authority = require('../lib/authority');
    const ownerConfigDir = identity === 'owner'
      ? authority.checkOwner(process.env, ownerCredential, ownerTerminal, () => authority.ownerProject(locate()), cmd.name === 'init')
      : undefined;
    // Check the resolved identity before forwarding; the broker separately
    // verifies requests against the identity it spawned.
    if (process.env.TOWER_CRANE_BROKER && !require('../lib/broker').READS.has(cmd.name)) {
      const input = argv.includes('-') ? readStdin() : undefined;
      let forwarded = argv;
      if (cmd.name === 'submit') {
        const sha = T.resolveSubmitSha({ cwd: process.cwd(), env: process.env, stateDir: locate(),
          pos: parsed.pos, flags: own }, own.sha);
        const tokens = [...resolved.lead, ...resolved.rest];
        const span = parsed.spans.find((s) => s.name === 'sha');
        tokens.splice(span.from, span.to - span.from + 1, '--sha', sha);
        forwarded = ['submit', ...tokens];
      }
      const res = await require('../lib/broker').forward(process.env.TOWER_CRANE_BROKER, forwarded, locate(), input);
      if (res) {
        process.stdout.write(res.stdout || '');
        process.stderr.write(res.stderr || '');
        return res.code;
      }
    }
    if (process.env.TOWER_CRANE_BROKER && cmd.name === 'wait' && require('../lib/broker').serves(process.env.TOWER_CRANE_BROKER, locate())) {
      require('../lib/broker').scopeWait(own, identity, process.env);
    }
    const ctx = {
      cwd: process.cwd(),
      env: process.env,
      agent: identity,
      agentExplicit,
      ownerTerminal,
      ownerConfigDir,
      json: !!globals.json,
      flags: own,
      pos: parsed.pos,
      request: { command: cmd.name, flags: own, pos: parsed.pos },
      stateDir: cmd.name === 'mcp' ? undefined : locate(),
      ...(cmd.name === 'mcp' ? { resolveStateDir: locate } : {}),
      ...(startCursor === undefined ? {} : { startCursor }),
    };
    // Engine provenance comes from the helper's key, never from TOWER_CRANE_VIA alone.
    ctx.automation = AutomationKey.verify(process.env, automationCredential, ctx.stateDir, identity);
    // A command reads the event log several times: the first read parses it
    // and later ones only what was appended since.
    const releaseEvents = ctx.stateDir ? S.retainEvents(ctx.stateDir) : () => {};
    let res;
    let releaseController;
    try {
      await require('../lib/authority').awaitSpawnRecord(ctx);
      require('../lib/orchestrator').command(ctx, cmd.name);
      releaseController = await require('../lib/containment').registerController(ctx, cmd.name);
      res = await cmd.run(ctx);
    } finally {
      releaseController?.();
      releaseEvents();
    }
    if (res && !res.printed) {
      if (ctx.json) out(JSON.stringify(res.data, null, 2));
      else if (res.text !== undefined) out(res.text);
    }
    return (res && res.code) || 0;
  } catch (e) {
    if (e instanceof TowerCraneError) {
      process.stderr.write(`tower-crane: ${e.message}\n`);
      return e.code;
    }
    process.stderr.write(`tower-crane: ${jsonOut ? e.message : e.stack || e.message}\n`);
    return 1;
  }
}

// A queued no-op write completes after prior bytes, so natural exit waits for healthy output.
function flushStream(stream) {
  if (stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      stream.removeListener('close', done);
      resolve();
    };
    stream.once('close', done);
    stream.write('', done);
  });
}

if (require.main === module) {
  if (!process.env.TOWER_CRANE_BROKER) {
    const releaseRuntime = require('../lib/runtime').hold();
    process.once('exit', releaseRuntime);
  }
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    return Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
  });
}

module.exports = { main, COMMANDS, GLOBAL, resolveCommand, parseOptions, generalHelp, commandHelp, groupHelp };
