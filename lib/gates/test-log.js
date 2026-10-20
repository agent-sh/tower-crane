'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { redactJoined, short } = require('./common');

// Keep the existing one-MiB command budget; five runs match local CI retention.
const LOG_BYTES = 1 << 20;
const RUNS_KEPT = 5;
const BLOCK_LINES = 30;
const BLOCK_BYTES = 2048;

function name(line) {
  const spec = /^\s*✖\s+(.+?)\s*$/.exec(line);
  let found = spec?.[1].replace(/\s+\([\d.]+m?s\)$/, '');
  if (found && /^(?:failing tests\b|test at\b)/i.test(found)) found = null;
  return found || /^\s*not ok(?:\s+\d+)?(?:\s+-\s*|\s+)(.+?)\s*$/.exec(line)?.[1] || null;
}

function blocks(text) {
  const lines = text.split(/\r?\n/);
  const found = new Map();
  const detailed = new Set();
  for (let i = 0; i < lines.length; i++) {
    const test = name(lines[i]);
    if (!test) continue;
    let end = i + 1;
    while (end < lines.length) {
      if (name(lines[end]) || /^\s*(?:[✔ℹ✖]|(?:ok|not ok)\s+\d+\b|test at\b|# Subtest:)/.test(lines[end])) break;
      end++;
      if (/^\s*\.\.\.\s*$/.test(lines[end - 1])) break;
    }
    const block = lines.slice(i, end).join('\n').trimEnd();
    // Spec lists each name before printing its diagnostic occurrence.
    const diagnostic = /^\s*test at\b/.test(lines[i - 1] || '') || /\b(?:\w*Error\b|error:|stack:)/.test(block);
    if (!found.has(test) || !found.get(test).block.includes('\n') || diagnostic && !detailed.has(test)) {
      found.set(test, { name: test, block });
      if (diagnostic) detailed.add(test);
    }
  }
  return [...found.values()];
}

function bytePrefix(text, bytes) {
  const data = Buffer.from(text);
  let end = Math.min(data.length, bytes);
  while (end > 0 && end < data.length && (data[end] & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString('utf8');
}

function cap(block, log) {
  const limited = bytePrefix(block.split('\n').slice(0, BLOCK_LINES).join('\n'), BLOCK_BYTES);
  const truncated = limited !== block;
  if (!truncated) return { block, truncated };
  const marker = `\n[error block truncated; see ${log || 'the gate log'}]`;
  const content = bytePrefix(block.split('\n').slice(0, BLOCK_LINES - 1).join('\n'), BLOCK_BYTES - Buffer.byteLength(marker));
  return { block: content + marker, truncated };
}

function prune(stateDir, task) {
  const logs = path.join(stateDir, 'logs');
  const runs = fs.readdirSync(logs).filter((n) => n.startsWith(`tests-${task}-`))
    .map((n) => ({ n, at: fs.statSync(path.join(logs, n)).mtimeMs }))
    .sort((a, b) => b.at - a.at || b.n.localeCompare(a.n));
  for (const { n } of runs.slice(RUNS_KEPT)) fs.rmSync(path.join(logs, n), { recursive: true, force: true });
}

function store(ctx, redact) {
  let dir;
  const refs = [];
  return {
    refs,
    keep(phase, result, extra = {}) {
      if (!ctx.stateDir) return null;
      try {
        if (!dir) {
          const logs = path.join(ctx.stateDir, 'logs');
          fs.mkdirSync(logs, { recursive: true });
          dir = fs.mkdtempSync(path.join(logs, `tests-${ctx.task.id}-${short(ctx.task.sha)}-`));
        }
        // Redact the joined and individual stream views before imposing the disk cap.
        let plain = redactJoined(result, redact);
        const truncated = !!result.outputTruncated || Buffer.byteLength(plain) > LOG_BYTES;
        if (truncated) {
          const marker = '[log truncated at 1 MiB; earlier output omitted]\n';
          const data = Buffer.from(plain);
          let from = Math.max(0, data.length - (LOG_BYTES - Buffer.byteLength(marker)));
          while (from < data.length && (data[from] & 0xc0) === 0x80) from++;
          if (from > 0) {
            const newline = data.indexOf(10, from);
            from = newline < 0 ? data.length : newline + 1;
          }
          plain = marker + data.subarray(from).toString('utf8');
        }
        const file = path.join(dir, `${refs.length + 1}-${phase}.log`);
        fs.writeFileSync(file, plain, { flag: 'wx', mode: 0o600 });
        const ref = { phase, log: path.relative(ctx.stateDir, file).split(path.sep).join('/'), truncated, ...extra };
        refs.push(ref);
        try { prune(ctx.stateDir, ctx.task.id); }
        catch (e) { ctx.log?.(`could not prune old tests logs: ${e.message}`); }
        return ref;
      } catch (e) {
        const ref = { phase, log: null, log_error: e.message, ...extra };
        refs.push(ref);
        ctx.log?.(`could not save the tests log: ${e.message}`);
        return ref;
      }
    },
  };
}

module.exports = { blocks, cap, store, LOG_BYTES, RUNS_KEPT, BLOCK_LINES, BLOCK_BYTES };
