'use strict';

// Parsers take captured text only. Exit handling owns file access and recording.
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const value = (n) => count(n) ? n : null;
const sum = (...ns) => ns.every(count) && count(ns.reduce((a, b) => a + b, 0)) ? ns.reduce((a, b) => a + b, 0) : null;

function records(text) {
  try {
    const doc = JSON.parse(text);
    return (Array.isArray(doc) ? doc : [doc]).filter((r) => r && typeof r === 'object');
  } catch {
    return String(text || '').split(/\r?\n/).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter((r) => r && typeof r === 'object');
  }
}

function usage(tokens, input, cached, output, model = null, models) {
  if (!count(tokens)) return null;
  if (input !== null && cached !== null && cached > input) return null;
  if (input !== null && output !== null && input + output > tokens) return null;
  return { tokens, input, cached, output, model, ...(models ? { models } : {}) };
}

// A run on several models keeps each model's own counts. The primary model,
// the one with the most tokens, names the entry, so no joined ID is recorded.
// Usage that names no model counts toward the primary model, as it did before.
function split(items) {
  const groups = new Map();
  for (const u of items) groups.set(u.model || null, [...groups.get(u.model || null) || [], u]);
  const rows = [...groups].map(([model, list]) => ({
    model, tokens: sum(...list.map((u) => u.tokens)), input: sum(...list.map((u) => u.input)),
    cached: sum(...list.map((u) => u.cached)), output: sum(...list.map((u) => u.output)),
  }));
  const named = rows.filter((r) => r.model !== null);
  if (!named.length) return { model: null, models: undefined };
  const primary = named.reduce((a, b) => ((b.tokens ?? -1) > (a.tokens ?? -1) ? b : a));
  const unnamed = rows.find((r) => r.model === null);
  const counted = named.map((r) => (unnamed && r === primary ? {
    ...r, tokens: sum(r.tokens, unnamed.tokens), input: sum(r.input, unnamed.input),
    cached: sum(r.cached, unnamed.cached), output: sum(r.output, unnamed.output),
  } : r));
  return { model: primary.model, models: counted.length > 1 ? counted : undefined };
}

function add(items) {
  const known = items.filter(Boolean);
  if (!known.length) return null;
  const { model, models } = split(known);
  return usage(
    sum(...known.map((u) => u.tokens)), sum(...known.map((u) => u.input)),
    sum(...known.map((u) => u.cached)), sum(...known.map((u) => u.output)), model, models,
  );
}

function codex(log, session = '') {
  // total_token_usage is cumulative and often repeated; never sum it.
  let total;
  let model = /^model:\s*(\S+)/m.exec(log)?.[1] || null;
  const sessionRecords = records(session);
  for (const r of sessionRecords) if (r.type === 'turn_context' && r.payload) model = r.payload.model || model;
  for (const r of [...records(log), ...sessionRecords]) {
    if (r.type === 'turn_context' && r.payload) model = r.payload.model || model;
    if (r.type === 'event_msg' && r.payload?.type === 'token_count') {
      const u = r.payload.info?.total_token_usage;
      if (u) {
        const candidate = usage(value(u.total_tokens), value(u.input_tokens), value(u.cached_input_tokens), value(u.output_tokens), model);
        if (candidate && (!total || candidate.tokens >= total.tokens)) total = candidate;
      }
    }
    if (r.type === 'turn.completed' && r.usage) {
      const u = r.usage;
      const candidate = usage(sum(u.input_tokens, u.output_tokens), value(u.input_tokens), value(u.cached_input_tokens), value(u.output_tokens), model);
      if (candidate && (!total || candidate.tokens >= total.tokens)) total = candidate;
    }
  }
  if (total) return total;
  // The text footer is non-cached input + output, not inclusive usage.
  // Without structured usage or the exact rollout, the total is unknown.
  return null;
}

function anthropic(u, model, models) {
  if (!u) return null;
  const input = sum(u.input_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0);
  return usage(sum(input, u.output_tokens), input, value(u.cache_read_input_tokens), value(u.output_tokens), model, models);
}

// The result's modelUsage counts each model in camelCase; a model without
// counts stays unknown rather than zero.
function resultModel(name, u) {
  const input = sum(u?.inputTokens, u?.cacheReadInputTokens ?? 0, u?.cacheCreationInputTokens ?? 0);
  return { model: name, tokens: sum(input, u?.outputTokens), input, cached: value(u?.cacheReadInputTokens), output: value(u?.outputTokens) };
}

function claude(log) {
  const rs = records(log);
  const result = rs.findLast((r) => r.type === 'result' && r.usage);
  if (result) {
    const { model, models } = split(Object.entries(result.modelUsage || {}).map(([name, u]) => resultModel(name, u)));
    return anthropic(result.usage, model, models);
  }
  // Streaming/session messages can repeat the same assistant message id.
  const messages = new Map();
  for (const r of rs) if (r.type === 'assistant' && r.message?.usage) {
    messages.set(r.message.id || messages.size, anthropic(r.message.usage, r.message.model || null));
  }
  return add([...messages.values()]);
}

function opencode(log) {
  const steps = new Map();
  for (const r of records(log)) {
    if (r.type !== 'step_finish' || !r.part?.tokens) continue;
    const u = r.part.tokens;
    const input = sum(u.input, u.cache?.read ?? 0, u.cache?.write ?? 0);
    const output = sum(u.output, u.reasoning ?? 0);
    steps.set(r.part.id || steps.size, usage(value(u.total) ?? sum(input, output), input, value(u.cache?.read), output));
  }
  return add([...steps.values()]);
}

function agy(log) {
  const r = records(log).findLast((r) => r.usage);
  if (!r) return null;
  const u = r.usage;
  // agy includes cache reads in input and reports thinking separately.
  const output = sum(u.output_tokens, u.thinking_tokens ?? 0);
  return usage(value(u.total_tokens) ?? sum(u.input_tokens, output), value(u.input_tokens), value(u.cache_read_tokens), output, r.model || null);
}

function pi(log) {
  const items = [];
  for (const r of records(log)) {
    if (!['message_end', 'message'].includes(r.type) || r.message?.role !== 'assistant') continue;
    const u = r.message.usage;
    if (!u) continue;
    const input = sum(u.input, u.cacheRead ?? 0, u.cacheWrite ?? 0);
    items.push(usage(value(u.totalTokens) ?? sum(input, u.output), input, value(u.cacheRead), value(u.output), r.message.model || null));
  }
  return add(items);
}

function parseUsage(harness, log, session = '') {
  const parsers = { codex, claude, opencode, agy, pi };
  return Object.hasOwn(parsers, harness) ? parsers[harness](log, session) : null;
}

module.exports = { parseUsage, records };
