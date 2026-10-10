'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { refuse } = require('./util');

// Four KiB keeps small receipts readable without copying large output or policies on every write.
const INLINE_BYTES = 4096;
const FIELDS = new Set(['summary', 'commands', 'receipt', 'gate_policy', 'ci_policy', 'test_failure', 'capped_review']);
const TYPES = new Set(['tests', 'clean', 'sources', 'review', 'ci', 'merge', 'note']);
const loaded = new WeakMap();
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
const relative = (task, hash) => `evidence/${task}/${hash}.json`;
const fallback = (key, task, hash) => key === 'summary' ? `[Stored in ${relative(task, hash)}]`
  : key === 'commands' || key === 'capped_review' ? [] : null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function hydrate(record, dir, task) {
  if (!record || !TYPES.has(record.type) || !record.evidence_refs || !/^T\d+$/.test(task)) return record;
  const fields = new Map();
  for (const [key, ref] of Object.entries(record.evidence_refs)) {
    if (!FIELDS.has(key)) continue;
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
      throw refuse(`invalid evidence reference for ${task}.${key}`);
    }
    // A pinned older writer can replace an inline fallback with a new value.
    if (!same(record[key], fallback(key, task, ref.sha256))) continue;
    const field = { ref, inline: record[key], read: false };
    fields.set(key, field);
    Object.defineProperty(record, key, {
      enumerable: true, configurable: true,
      get() {
        if (!field.read) {
          const file = relative(task, ref.sha256);
          let text;
          try { text = fs.readFileSync(path.join(dir, file)); }
          catch (error) { throw refuse(`cannot read ${file}: ${error.code}; restore the evidence file`); }
          if (text.length !== ref.bytes || digest(text) !== ref.sha256) throw refuse(`evidence file ${file} failed its content check`);
          try { field.value = JSON.parse(text); }
          catch { throw refuse(`evidence file ${file} is not valid JSON`); }
          field.read = true;
        }
        return field.value;
      },
      set(value) { field.value = value; field.read = true; },
    });
  }
  loaded.set(record, fields);
  return record;
}

function stored(record, dir, task, write) {
  if (!record || !TYPES.has(record.type)) return record;
  const fields = loaded.get(record);
  const out = {};
  const refs = { ...record.evidence_refs };
  for (const key of Object.keys(record)) {
    if (key === 'evidence_refs') continue;
    const field = fields?.get(key);
    if (field && !field.read) {
      out[key] = field.inline;
      continue;
    }
    const value = record[key];
    out[key] = value;
    if (!FIELDS.has(key)) continue;
    if (!write) {
      if (field) out[key] = field.inline;
      continue;
    }
    delete refs[key];
    const text = JSON.stringify(value);
    if (text === undefined || Buffer.byteLength(text) <= INLINE_BYTES) continue;
    const hash = digest(text);
    const file = path.join(dir, relative(task, hash));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Content-addressed files are immutable; identical policy snapshots share one file per task.
    if (!fs.existsSync(file)) require('./state').writeAtomic(file, text);
    refs[key] = { sha256: hash, bytes: Buffer.byteLength(text) };
    out[key] = fallback(key, task, hash);
  }
  if (Object.keys(refs).length) out.evidence_refs = refs;
  return out;
}

function tasksJson(tasks, dir, write = false, migrated) {
  return JSON.stringify({ ...tasks, tasks: tasks.tasks.map((task) => ({
    ...task, evidence: task.evidence.map((entry) => {
      const compact = stored(entry, dir, task.id, write);
      if (write && !same(compact.evidence_refs, entry.evidence_refs)) migrated?.(task, entry);
      return compact;
    }),
  })) }, null, 2) + '\n';
}

module.exports = { INLINE_BYTES, hydrate, stored, tasksJson };
