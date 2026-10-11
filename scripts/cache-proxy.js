#!/usr/bin/env node
'use strict';

// Prompt-cache proxy: sits between an agent harness and Bedrock, forwards every
// request unchanged unless a lever is set, and logs one JSON line per request with
// prefix hashes, cache read and write tokens, cost, and the first point where the
// request diverges from the closest earlier one. Request text stays in memory for
// the comparison and is never written; the log holds hashes, paths and counts.
// The client's Authorization header is forwarded as received and never read.
//
//   node scripts/cache-proxy.js [--port 18790] [--log FILE] [--runtime URL] [--mantle URL]
//     [--cache-key KEY] [--inherit-cache-key] [--breakpoint MARKER] [--breakpoint-ttl 5m|1h] [--normalize]
//     [--turn-breakpoint] [--developer-breakpoint] [--skeleton DIR] [--prices FILE]
//   node scripts/cache-proxy.js report FILE
//
// Claude Code: ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:18790
// Codex: [model_providers.amazon-bedrock] base_url = "http://127.0.0.1:18790/openai/v1"

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const zlib = require('node:zlib');

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'accept-encoding']);
const RETAINED = 64;
const ANTHROPIC_MAX_BREAKPOINTS = 4;

// USD per million tokens, list prices: input, output, 5-minute and 1-hour cache
// writes, cache reads. Only the measured models have defaults, each from a cited
// price page, kept in docs so a model swap edits data rather than code; unknown
// models log no cost; --prices FILE adds or overrides entries keyed by model id
// with the same fields.
const PRICES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'cache-proxy-prices.json'), 'utf8'));

function parseArgs(argv) {
  const opts = {
    port: 18790,
    log: null,
    runtime: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    mantle: 'https://bedrock-mantle.us-east-1.api.aws',
    cacheKey: null,
    breakpoint: null,
    breakpointTtl: null,
    normalize: false,
    turnBreakpoint: false,
    developerBreakpoint: false,
    inheritCacheKey: false,
    prices: null,
    skeleton: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--port') opts.port = Number(next());
    else if (arg === '--log') opts.log = next();
    else if (arg === '--runtime') opts.runtime = next().replace(/\/$/, '');
    else if (arg === '--mantle') opts.mantle = next().replace(/\/$/, '');
    else if (arg === '--cache-key') opts.cacheKey = next();
    else if (arg === '--breakpoint') opts.breakpoint = next();
    else if (arg === '--breakpoint-ttl') opts.breakpointTtl = next();
    else if (arg === '--normalize') opts.normalize = true;
    else if (arg === '--turn-breakpoint') opts.turnBreakpoint = true;
    else if (arg === '--developer-breakpoint') opts.developerBreakpoint = true;
    else if (arg === '--inherit-cache-key') opts.inheritCacheKey = true;
    else if (arg === '--skeleton') opts.skeleton = next();
    else if (arg === '--prices') opts.prices = JSON.parse(fs.readFileSync(next(), 'utf8'));
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0) throw new Error('--port must be an integer');
  if (opts.breakpointTtl && !['5m', '1h'].includes(opts.breakpointTtl)) throw new Error('--breakpoint-ttl is 5m or 1h');
  return opts;
}

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const short = text => sha(text).slice(0, 12);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter(k => k !== 'cache_control').sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// A request becomes an ordered list of segments in the order the provider builds
// its prefix: tools, then the system prompt or instructions, then the conversation.
// A segment is one tool, one system block or one message content block.
function segments(kind, body) {
  const out = [];
  const add = (path, value, breakpoint = false) => {
    const text = typeof value === 'string' ? value : canonical(value);
    out.push({ path, text, breakpoint });
  };
  const marked = block => (block && typeof block === 'object' && block.cache_control) || false;
  if (kind === 'anthropic') {
    (body.tools || []).forEach((tool, i) => add(`tools[${i}]`, tool, marked(tool)));
    if (typeof body.system === 'string') add('system[0]', body.system);
    else (body.system || []).forEach((block, i) => add(`system[${i}]`, block.type === 'text' ? block.text : block, marked(block)));
    (body.messages || []).forEach((message, i) => {
      const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
      content.forEach((block, j) => add(`messages[${i}].content[${j}]`,
        `${message.role}:${block.type === 'text' ? block.text : canonical(block)}`, marked(block)));
    });
  } else if (kind === 'openai') {
    (body.tools || []).forEach((tool, i) => add(`tools[${i}]`, tool));
    if (body.instructions !== undefined) add('instructions', String(body.instructions));
    if (typeof body.input === 'string') add('input[0]', body.input);
    else (body.input || []).forEach((item, i) => {
      if (item && item.type === 'message' && Array.isArray(item.content)) {
        item.content.forEach((part, j) => add(`input[${i}].content[${j}]`,
          `${item.role}:${part.text !== undefined ? part.text : canonical(part)}`));
      } else add(`input[${i}]`, item);
    });
  }
  let previous = '';
  for (const segment of out) {
    segment.chars = segment.text.length;
    segment.cum = previous = sha(previous + sha(segment.text));
  }
  return out;
}

function hashes(kind, segs) {
  const staticEnd = segs.findIndex(s => !/^(tools|system|instructions)/.test(s.path));
  const staticSegs = staticEnd === -1 ? segs : segs.slice(0, staticEnd);
  return {
    static: staticSegs.length ? staticSegs[staticSegs.length - 1].cum.slice(0, 12) : null,
    full: segs.length ? segs[segs.length - 1].cum.slice(0, 12) : null,
    breakpoints: kind === 'anthropic'
      ? segs.filter(s => s.breakpoint).map(s => ({ path: s.path, hash: s.cum.slice(0, 12), control: s.breakpoint }))
      : undefined,
  };
}

// Request settings outside the prompt also decide a cache hit (thinking, tool
// choice, betas). Known settings with short values are logged as sent so two
// requests can be compared; any other field, and anything long, is logged as a hash
// so a field that carries a credential never reaches the log.
const PROMPT_FIELDS = new Set(['messages', 'system', 'tools', 'input', 'instructions']);
const PLAIN_FIELDS = new Set(['anthropic_version', 'anthropic_beta', 'max_tokens', 'max_output_tokens', 'temperature',
  'top_p', 'top_k', 'stop_sequences', 'stream', 'thinking', 'tool_choice', 'output_config', 'context_management',
  'model', 'reasoning', 'text', 'store', 'parallel_tool_calls', 'include', 'service_tier', 'truncation',
  'prompt_cache_retention']);
function params(body) {
  const out = {};
  for (const key of Object.keys(body).sort()) {
    if (PROMPT_FIELDS.has(key)) continue;
    const text = canonical(body[key]);
    out[key] = !PLAIN_FIELDS.has(key) || text.length > 200 ? `sha:${short(text)}` : body[key];
  }
  return out;
}

// The request's structure with every string longer than 24 characters replaced by
// its hash and length: field names, roles, block types and order stay readable,
// prompt text and anything secret-sized do not.
function skeleton(value) {
  if (typeof value === 'string') return value.length > 24 ? `<sha:${short(value)} len:${value.length}>` : value;
  if (Array.isArray(value)) return value.map(skeleton);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'metadata' ? `<sha:${short(canonical(v))}>` : skeleton(v)]));
  }
  return value;
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

// Compares a request with one earlier request: the shared prefix in segments and
// characters, and where the two part when neither extends the other.
function compare(current, earlier) {
  let k = 0;
  while (k < current.segs.length && k < earlier.segs.length && current.segs[k].cum === earlier.segs[k].cum) k++;
  let shared = 0;
  for (let i = 0; i < k; i++) shared += current.segs[i].chars;
  const result = { against: earlier.id, shared_segments: k, shared_chars: shared };
  if (k === current.segs.length && k === earlier.segs.length) return { ...result, relation: 'identical' };
  if (k === earlier.segs.length) return { ...result, relation: 'extends' };
  if (k === current.segs.length) return { ...result, relation: 'prefix_of' };
  const offset = firstDifference(current.segs[k].text, earlier.segs[k].text);
  return {
    ...result,
    shared_chars: shared + offset,
    relation: 'diverged',
    segment: current.segs[k].path,
    earlier_segment: earlier.segs[k].path,
    offset,
    chars: current.segs[k].chars,
    earlier_chars: earlier.segs[k].chars,
  };
}

function closest(current, retained) {
  let best = null;
  for (const earlier of retained) {
    if (earlier.kind !== current.kind) continue;
    const result = compare(current, earlier);
    if (!best || result.shared_chars > best.shared_chars
      || (result.shared_chars === best.shared_chars && earlier.id > best.against)) best = result;
  }
  return best;
}

// Levers. Each returns a list of what it changed so the log shows the rewrite.

function pinCacheKey(body, key) {
  if (body.prompt_cache_key === key) return [];
  const had = body.prompt_cache_key !== undefined;
  body.prompt_cache_key = key;
  return [had ? 'cache_key:replaced' : 'cache_key:added'];
}

// prompt_cache_key separates cache reuse between groups of requests. A codex fork
// starts a new thread with a new key, so its first request misses the parent's
// cache although it repeats the parent's conversation. A request that extends an
// earlier one, all of its segments including conversation, under a different key
// takes that earlier request's key; the longest such request wins. Sharing only the
// leading developer messages is not enough: every codex session opens with them.
function inheritFrom(current, retained) {
  let parent = null;
  let longest = 0;
  for (const earlier of retained) {
    if (earlier.kind !== current.kind || earlier.cacheKey === undefined || earlier.cacheKey === current.cacheKey) continue;
    if (!earlier.segs.some(s => s.path.startsWith('input'))) continue;
    const result = compare(current, earlier);
    if (result.relation === 'extends' && result.shared_segments >= longest) {
      parent = earlier;
      longest = result.shared_segments;
    }
  }
  return parent;
}

function countBreakpoints(body) {
  let n = 0;
  const visit = list => { for (const block of list || []) if (block && block.cache_control) n++; };
  visit(body.tools);
  if (Array.isArray(body.system)) visit(body.system);
  for (const message of body.messages || []) if (Array.isArray(message.content)) visit(message.content);
  return n;
}

// Puts a cache breakpoint right after the first occurrence of marker in the system
// prompt or the conversation, splitting that text block in two. When the request
// already carries the provider's maximum, the breakpoint nearest before the new one
// is dropped: the new one covers the same prefix and more. When nothing before it
// can go, the request is left as it was; the provider rejects a fifth breakpoint.
function insertBreakpoint(body, marker, ttl) {
  const draft = structuredClone(body);
  const changes = placeBreakpoint(draft, marker, ttl);
  if (countBreakpoints(draft) > ANTHROPIC_MAX_BREAKPOINTS) return ['breakpoint:over_limit'];
  changes.push(...orderTtls(draft));
  Object.assign(body, draft);
  return changes;
}

// Anthropic rejects a request whose 1-hour breakpoint comes after a 5-minute one.
// An added breakpoint can break that order either way, so every breakpoint before
// a 1-hour one is raised to 1 hour. Billing does not change: 1-hour write tokens
// run up to the last 1-hour breakpoint whatever the TTLs before it.
function orderTtls(body) {
  const order = [];
  (body.tools || []).forEach((block, i) => order.push([`tools[${i}]`, block]));
  if (Array.isArray(body.system)) body.system.forEach((block, i) => order.push([`system[${i}]`, block]));
  (body.messages || []).forEach((message, i) => {
    if (Array.isArray(message.content)) message.content.forEach((block, j) => order.push([`messages[${i}][${j}]`, block]));
  });
  const changes = [];
  let later = false;
  for (let i = order.length - 1; i >= 0; i--) {
    const [name, block] = order[i];
    if (!block || !block.cache_control) continue;
    if (block.cache_control.ttl === '1h') later = true;
    else if (later) {
      block.cache_control = { ...block.cache_control, ttl: '1h' };
      changes.push(`ttl:promoted ${name}`);
    }
  }
  return changes;
}

function placeBreakpoint(body, marker, ttl) {
  const control = ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
  if (typeof body.system === 'string') body.system = [{ type: 'text', text: body.system }];
  const lists = [['system', body.system || []]];
  (body.messages || []).forEach((message, i) => {
    if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }];
    lists.push([`messages[${i}]`, message.content || []]);
  });
  const order = [];
  for (const [name, list] of lists) list.forEach((block, j) => order.push({ name, list, j, block }));
  const at = order.findIndex(({ block }) => block.type === 'text' && block.text.includes(marker));
  if (at === -1) return ['breakpoint:marker_missing'];
  const { name, list, j, block } = order[at];
  const end = block.text.indexOf(marker) + marker.length;
  const changes = [];
  if (end === block.text.length) {
    if (block.cache_control) return ['breakpoint:already_marked'];
    block.cache_control = control;
  } else {
    const rest = { ...block, text: block.text.slice(end) };
    const head = { type: 'text', text: block.text.slice(0, end), cache_control: control };
    list.splice(j, 1, head, rest);
    changes.push(`breakpoint:split ${name}[${j}]`);
  }
  if (countBreakpoints(body) > ANTHROPIC_MAX_BREAKPOINTS) {
    for (let i = at - 1; i >= 0; i--) {
      if (order[i].block.cache_control) {
        delete order[i].block.cache_control;
        changes.push(`breakpoint:dropped ${order[i].name}[${order[i].j}]`);
        break;
      }
    }
    if (countBreakpoints(body) > ANTHROPIC_MAX_BREAKPOINTS && Array.isArray(body.tools)) {
      const tool = body.tools.findLast(t => t.cache_control);
      if (tool) { delete tool.cache_control; changes.push('breakpoint:dropped tools'); }
    }
  }
  return changes.length ? changes : ['breakpoint:marked'];
}

// Claude Code in print mode ends each request with a role system message and puts
// its last breakpoint there. On the next turn that message sits mid-conversation,
// and the entry written at it is not read back. Marking the last block before the
// trailing system messages writes an entry the next turn's prefix matches.
function turnBreakpoint(body, ttl) {
  const messages = body.messages || [];
  let last = messages.length - 1;
  while (last >= 0 && messages[last].role === 'system') last--;
  if (last === messages.length - 1 || last < 0) return [];
  const message = messages[last];
  if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }];
  const block = message.content[message.content.length - 1];
  if (!block || block.cache_control) return [];
  block.cache_control = ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
  const changes = [`turn_breakpoint:messages[${last}]`];
  if (countBreakpoints(body) > ANTHROPIC_MAX_BREAKPOINTS) {
    const system = (Array.isArray(body.system) ? body.system : []).find(b => b.cache_control);
    if (system) { delete system.cache_control; changes.push('turn_breakpoint:dropped first system breakpoint'); }
  }
  changes.push(...orderTtls(body));
  return changes;
}

// Volatile content a harness writes into its system prompt: today's date, the
// working directory (also inside paths derived from it, such as a per-project
// memory directory), and the git status snapshot. Normalizing takes it out of the
// system prompt so tools plus system stay byte-identical across directories and
// days. Lines are moved and the directory becomes $CWD (or $CWD_SLUG), with a note
// giving the real values; the note goes into the message that already states the
// working directory, else the start of the first user message, so the model still
// sees everything and every turn rewrites the same way.
const VOLATILE = [
  /^.*\b(?:Today's date is|Current date:|current date is)\b.*$/gim,
  /^.*\b(?:Primary working directory|Working directory|cwd)\s*:.*$/gim,
  /^.*\bIs (?:a|directory a) git repo(?:sitory)?\s*:.*$/gim,
  /^gitStatus:[\s\S]*?(?=\n\n(?![ \t])[^\n]*\S|$(?![\s\S]))/gm,
];
const CWD_LINE = /(?:Primary working directory|Working directory|cwd)\s*:\s*(\S+)/i;

function textBlocks(message) {
  if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }];
  return (message.content || []).filter(b => b.type === 'text');
}

function normalize(body) {
  if (typeof body.system === 'string') body.system = [{ type: 'text', text: body.system }];
  if (!Array.isArray(body.system) || !Array.isArray(body.messages) || !body.messages.length) return [];
  const all = [...body.system.filter(b => b.type === 'text'), ...body.messages.flatMap(textBlocks)];
  // The root directory names no project, so it is left alone. Any other directory
  // is replaced only as a whole path: /w/repo, not /w/repo-worktrees.
  const found = all.map(b => CWD_LINE.exec(b.text)).find(Boolean)?.[1];
  const cwd = found && !/^\/+$/.test(found) ? found : null;
  const slug = cwd && cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whole = cwd && [
    [new RegExp(`(?<![\\w.-])${escape(slug)}(?![\\w-]|\\.[\\w-])`, 'g'), '$CWD_SLUG'],
    [new RegExp(`(?<![\\w.~/-])${escape(cwd)}(?![\\w-]|\\.[\\w-])`, 'g'), '$CWD'],
  ];
  const moved = [];
  let replaced = 0;
  for (const block of body.system) {
    if (block.type !== 'text') continue;
    let text = block.text;
    for (const pattern of VOLATILE) text = text.replace(pattern, match => { moved.push(match); return ''; });
    for (const [pattern, name] of whole || []) {
      text = text.replace(pattern, () => { replaced++; return name; });
    }
    block.text = text.replace(/\n{3,}/g, '\n\n');
  }
  const changes = [];
  if (moved.length || replaced) {
    const lines = [...moved];
    if (replaced) lines.push(`In the system prompt $CWD is ${cwd} and $CWD_SLUG is ${slug}.`);
    const note = { type: 'text', text: `<environment>\n${lines.join('\n')}\n</environment>` };
    const home = body.messages.find(m => textBlocks(m).some(b => CWD_LINE.test(b.text))) || body.messages[0];
    home.content.unshift(note);
    changes.push(`normalize:moved ${moved.length} replaced ${replaced}`);
  }
  // Claude Code sends the git status snapshot as a reminder block ahead of the
  // prompt in the first user message; it goes after the prompt instead.
  const first = body.messages.find(m => m.role === 'user');
  if (first) {
    const blocks = textBlocks(first);
    const status = blocks.filter((b, i) => i < blocks.length - 1 && /gitStatus:/.test(b.text));
    if (status.length) {
      first.content = [...first.content.filter(b => !status.includes(b)), ...status];
      changes.push(`normalize:git_status_after_prompt ${status.length}`);
    }
  }
  return changes;
}

// Codex sends its environment (cwd, shell, date) as a user message before the
// prompt. Moving it after the first prompt that follows keeps the developer
// instructions and that prompt in the shared prefix; every turn moves it the same way.
function normalizeOpenAI(body) {
  if (!Array.isArray(body.input)) return [];
  const isEnv = item => item?.type === 'message' && item.role === 'user'
    && (item.content || []).some(c => typeof c.text === 'string' && c.text.startsWith('<environment_context>'));
  const out = [];
  let held = [];
  for (const item of body.input) {
    if (isEnv(item)) held.push(item);
    else {
      out.push(item);
      if (held.length && item?.type === 'message' && item.role === 'user') { out.push(...held); held = []; }
    }
  }
  out.push(...held);
  const moved = out.some((item, i) => item !== body.input[i]);
  body.input = out;
  return moved ? ['normalize:environment_after_prompt'] : [];
}

// Recent OpenAI models accept explicit breakpoints next to the implicit one. The
// input_text part holding the marker is split right after it and the head marked.
function insertOpenAIBreakpoint(body, marker) {
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    const j = item.content.findIndex(c => typeof c.text === 'string' && c.text.includes(marker));
    if (j === -1) continue;
    const part = item.content[j];
    const end = part.text.indexOf(marker) + marker.length;
    const head = { ...part, text: part.text.slice(0, end), prompt_cache_breakpoint: { mode: 'explicit' } };
    if (end === part.text.length) { item.content[j] = head; return ['breakpoint:marked']; }
    item.content.splice(j, 1, head, { ...part, text: part.text.slice(end) });
    return ['breakpoint:split'];
  }
  return ['breakpoint:marker_missing'];
}

// Codex opens every request with the same developer messages (skills, permissions,
// collaboration mode) after its instructions and tools. Implicit mode writes only at
// the latest user message, so a new session never reads that shared block. Marking
// the last part of the leading developer messages writes it once for every session
// that shares the prompt_cache_key.
function developerBreakpoint(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  let last = -1;
  while (input[last + 1]?.type === 'message' && input[last + 1].role === 'developer') last++;
  const parts = last === -1 ? [] : input[last].content;
  const part = Array.isArray(parts) ? parts[parts.length - 1] : null;
  if (!part || typeof part.text !== 'string' || part.prompt_cache_breakpoint) return [];
  part.prompt_cache_breakpoint = { mode: 'explicit' };
  return [`developer_breakpoint:input[${last}]`];
}

// Response parsing. Bedrock streams Anthropic events inside the AWS event-stream
// framing; Mantle streams OpenAI server-sent events; both also answer plain JSON.

function eventStreamDecoder(onEvent) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 12) {
      const total = buffer.readUInt32BE(0);
      if (buffer.length < total) return;
      const headersLength = buffer.readUInt32BE(4);
      const headers = {};
      let p = 12;
      while (p < 12 + headersLength) {
        const nameLength = buffer[p];
        const name = buffer.subarray(p + 1, p + 1 + nameLength).toString();
        p += 1 + nameLength;
        const type = buffer[p++];
        if (type === 7 || type === 6) {
          const length = buffer.readUInt16BE(p);
          headers[name] = buffer.subarray(p + 2, p + 2 + length).toString();
          p += 2 + length;
        } else break;
      }
      const payload = buffer.subarray(12 + headersLength, total - 4).toString();
      buffer = buffer.subarray(total);
      try {
        const outer = JSON.parse(payload);
        if (headers[':message-type'] === 'exception') onEvent({ type: 'error', error: outer });
        else if (outer.bytes) onEvent(JSON.parse(Buffer.from(outer.bytes, 'base64').toString()));
        else onEvent(outer);
      } catch {}
    }
  };
}

function sseDecoder(onEvent) {
  let buffer = '';
  return chunk => {
    buffer += chunk.toString();
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { onEvent(JSON.parse(data)); } catch {}
    }
  };
}

function usageCollector(kind) {
  const usage = {};
  const raw = {};
  const anthropic = u => {
    if (!u) return;
    if (u.input_tokens !== undefined) usage.input = u.input_tokens;
    if (u.cache_read_input_tokens !== undefined) usage.cache_read = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens !== undefined) usage.cache_write = u.cache_creation_input_tokens;
    if (u.cache_creation) {
      usage.cache_write_5m = u.cache_creation.ephemeral_5m_input_tokens ?? 0;
      usage.cache_write_1h = u.cache_creation.ephemeral_1h_input_tokens ?? 0;
    }
    if (u.output_tokens !== undefined) usage.output = u.output_tokens;
  };
  const openai = u => {
    if (!u) return;
    raw.usage = u;
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const written = u.input_tokens_details?.cache_write_tokens;
    usage.input = (u.input_tokens ?? 0) - cached - (written ?? 0);
    usage.cache_read = cached;
    if (written !== undefined) usage.cache_write = written;
    usage.output = u.output_tokens ?? 0;
    if (u.output_tokens_details?.reasoning_tokens !== undefined) usage.reasoning = u.output_tokens_details.reasoning_tokens;
  };
  const onEvent = event => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'error') usage.error = event.error?.message || event.error?.type || 'error';
    if (kind === 'anthropic') {
      if (event.type === 'message_start') anthropic(event.message?.usage);
      else if (event.type === 'message_delta') anthropic(event.usage);
      else if (event.usage) anthropic(event.usage);
    } else if (kind === 'openai') {
      if (event.response?.usage) openai(event.response.usage);
      else if (event.usage) openai(event.usage);
      if (event.type === 'response.failed') usage.error = event.response?.error?.message || 'failed';
    }
  };
  return { usage, raw, onEvent };
}

function price(model, prices) {
  if (prices && prices[model]) return prices[model];
  return PRICES.find(p => String(model || '').includes(p.match)) || null;
}

function cost(model, usage, prices) {
  const p = price(model, prices);
  if (!p || usage.input === undefined) return null;
  const write = usage.cache_write ?? 0;
  const write1h = usage.cache_write_1h ?? 0;
  const write5m = usage.cache_write_5m ?? write - write1h;
  return round((usage.input * p.input + write5m * (p.write_5m ?? p.input) + write1h * (p.write_1h ?? p.input)
    + (usage.cache_read ?? 0) * p.read + (usage.output ?? 0) * p.output) * 1e-6);
}

const round = n => Math.round(n * 1e7) / 1e7;

function decodeBody(raw, encoding) {
  if (!encoding || encoding === 'identity') return raw;
  if (encoding === 'gzip') return zlib.gunzipSync(raw);
  if (encoding === 'deflate') return zlib.inflateSync(raw);
  if (encoding === 'br') return zlib.brotliDecompressSync(raw);
  if (encoding === 'zstd') return zlib.zstdDecompressSync(raw);
  throw new Error(`unsupported content-encoding ${encoding}`);
}

function classify(path) {
  if (path.startsWith('/model/')) return 'anthropic';
  if (/\/responses(\?|$)/.test(path)) return 'openai';
  return 'other';
}

function modelFromPath(path) {
  const m = /^\/model\/([^/]+)\//.exec(path);
  return m ? decodeURIComponent(m[1]) : null;
}

function createProxy(opts) {
  const retained = [];
  let counter = 0;
  const logStream = opts.log ? fs.createWriteStream(opts.log, { flags: 'a' }) : null;
  const write = entry => {
    if (logStream) logStream.write(`${JSON.stringify(entry)}\n`);
    const u = entry.usage || {};
    const d = entry.divergence;
    const where = !d ? 'first' : d.relation === 'diverged' ? `diverged ${d.segment}@${d.offset} vs #${d.against}` : `${d.relation} #${d.against}`;
    process.stderr.write(`#${entry.id} ${entry.kind} ${entry.model || '-'} ${entry.status} read=${u.cache_read ?? '-'} write=${u.cache_write ?? '-'} in=${u.input ?? '-'} out=${u.output ?? '-'} $${entry.cost_usd ?? '-'} ${where}${entry.rewrites?.length ? ` [${entry.rewrites.join(', ')}]` : ''}\n`);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => handle(req, res, Buffer.concat(chunks)));
    req.on('error', () => res.destroy());
  });

  // Applies the levers, logs the prefix analysis into entry and returns the body to
  // send when a lever rewrote it.
  function analyze(req, body, entry, headers, id, kind) {
    let forward = null;
    const rewrites = [];
    if (kind === 'openai' && opts.cacheKey) rewrites.push(...pinCacheKey(body, opts.cacheKey));
    if (kind === 'anthropic' && opts.normalize) rewrites.push(...normalize(body));
    if (kind === 'openai' && opts.normalize) rewrites.push(...normalizeOpenAI(body));
    if (kind === 'anthropic' && opts.breakpoint) rewrites.push(...insertBreakpoint(body, opts.breakpoint, opts.breakpointTtl));
    if (kind === 'openai' && opts.breakpoint) rewrites.push(...insertOpenAIBreakpoint(body, opts.breakpoint));
    if (kind === 'anthropic' && opts.turnBreakpoint) rewrites.push(...turnBreakpoint(body, opts.breakpointTtl));
    if (kind === 'openai' && opts.developerBreakpoint) rewrites.push(...developerBreakpoint(body));
    const segs = segments(kind, body);
    const current = { id, kind, segs, cacheKey: body.prompt_cache_key };
    entry.divergence = closest(current, retained);
    if (kind === 'openai' && opts.inheritCacheKey) {
      const parent = inheritFrom(current, retained);
      if (parent) rewrites.push(...pinCacheKey(body, parent.cacheKey));
      current.cacheKey = body.prompt_cache_key;
    }
    retained.push(current);
    if (retained.length > RETAINED) retained.shift();
    if (rewrites.length) {
      entry.rewrites = rewrites;
      forward = Buffer.from(JSON.stringify(body));
    }
    entry.model = kind === 'anthropic' ? modelFromPath(req.url) : body.model;
    if (body.prompt_cache_key !== undefined) entry.cache_key = short(String(body.prompt_cache_key));
    entry.segments = segs.length;
    entry.chars = segs.reduce((n, s) => n + s.chars, 0);
    entry.hash = hashes(kind, segs);
    entry.params = params(body);
    if (req.headers['anthropic-beta']) entry.betas = req.headers['anthropic-beta'];
    if (opts.skeleton) {
      fs.mkdirSync(opts.skeleton, { recursive: true });
      fs.writeFileSync(`${opts.skeleton}/${id}.json`, `${JSON.stringify(skeleton(body), null, 1)}\n`);
    }
    if (forward) delete headers['content-encoding'];
    return forward;
  }

  function handle(req, res, raw) {
    const id = ++counter;
    const started = Date.now();
    const kind = classify(req.url);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
    headers['accept-encoding'] = 'identity';
    const entry = { id, ts: new Date(started).toISOString(), kind, method: req.method, path: req.url.replace(/\?.*$/, '') };

    let body = null;
    let forward = raw;
    if (kind !== 'other' && raw.length) {
      try {
        body = JSON.parse(decodeBody(raw, req.headers['content-encoding']).toString());
      } catch (error) {
        // A JSON syntax error quotes the body, so only its kind is logged.
        entry.parse_error = error instanceof SyntaxError ? 'invalid JSON' : error.message;
      }
    }
    if (body) {
      try {
        forward = analyze(req, body, entry, headers, id, kind) || raw;
      } catch (error) {
        // A body shape the levers or the segmenter do not expect is forwarded as
        // received; the proxy keeps serving every other request.
        entry.analysis_error = error.message;
        forward = raw;
      }
    }
    if (forward !== raw || headers['content-length'] !== undefined) headers['content-length'] = String(forward.length);

    const base = kind === 'anthropic' ? opts.runtime : opts.mantle;
    let target;
    try {
      target = new URL(base + req.url);
    } catch (error) {
      entry.status = 400;
      entry.error = 'invalid request path';
      write(entry);
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('cache-proxy: invalid request path\n');
      return;
    }
    const client = target.protocol === 'https:' ? https : http;
    const upstream = client.request(target, { method: req.method, headers }, up => {
      const collector = usageCollector(kind);
      const type = up.headers['content-type'] || '';
      const feed = type.includes('eventstream') ? eventStreamDecoder(collector.onEvent)
        : type.includes('event-stream') ? sseDecoder(collector.onEvent) : null;
      const json = [];
      const outHeaders = { ...up.headers };
      delete outHeaders.connection;
      delete outHeaders['transfer-encoding'];
      res.writeHead(up.statusCode, outHeaders);
      up.on('error', error => {
        entry.status = up.statusCode;
        entry.error = error.message;
        write(entry);
        res.destroy();
      });
      up.on('data', chunk => {
        res.write(chunk);
        if (feed) feed(chunk);
        else json.push(chunk);
      });
      up.on('end', () => {
        res.end();
        if (!feed && type.includes('json')) {
          try { collector.onEvent(JSON.parse(Buffer.concat(json).toString())); } catch {}
        }
        entry.status = up.statusCode;
        entry.response_headers = Object.keys(up.headers).sort();
        entry.ms = Date.now() - started;
        if (Object.keys(collector.usage).length) entry.usage = collector.usage;
        if (collector.raw.usage) entry.usage_raw = collector.raw.usage;
        if (entry.usage) entry.cost_usd = cost(entry.model, entry.usage, opts.prices);
        if (kind !== 'other' || up.statusCode >= 400) write(entry);
      });
    });
    upstream.on('error', error => {
      entry.status = 502;
      entry.error = error.message;
      write(entry);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`cache-proxy upstream error: ${error.message}\n`);
    });
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    upstream.end(forward);
  }

  return server;
}

function report(file) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const lines = ['| # | kind | model | status | input | cache read | cache write | output | cost USD | prefix |',
    '|---:|---|---|---:|---:|---:|---:|---:|---:|---|'];
  for (const r of rows) {
    const u = r.usage || {};
    const d = r.divergence;
    const where = !d ? 'first' : d.relation === 'diverged'
      ? `diverged from #${d.against} at ${d.segment} char ${d.offset} (${d.shared_chars} chars shared)`
      : `${d.relation} #${d.against}`;
    lines.push(`| ${r.id} | ${r.kind} | ${r.model || ''} | ${r.status} | ${u.input ?? ''} | ${u.cache_read ?? ''} | ${u.cache_write ?? ''} | ${u.output ?? ''} | ${r.cost_usd ?? ''} | ${where}${r.rewrites ? ` [${r.rewrites.join(', ')}]` : ''} |`);
  }
  return lines.join('\n');
}

const argv = process.argv.slice(2);
if (argv[0] === 'report') {
  process.stdout.write(`${report(argv[1])}\n`);
} else {
  const opts = parseArgs(argv);
  const server = createProxy(opts);
  server.listen(opts.port, '127.0.0.1', () => {
    process.stderr.write(`cache-proxy listening on http://127.0.0.1:${server.address().port}\n`);
  });
}

