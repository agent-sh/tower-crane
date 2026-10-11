'use strict';

// Settled evidence keeps its large fields in content-addressed per-task files,
// so tasks.json grows with open work rather than with every gate run ever
// recorded. Readers get the full value back on first use of the field.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { refuse, shaMatch } = require('./util');

// A reference and its fallback take about 120 bytes. Measured on this
// project's state, moving settled fields over 1 KiB cut inline history from
// 5.5 MB to 2.3 MB; lower limits saved little more for many more files.
const INLINE_BYTES = 1024;
const FIELDS = new Set(['summary', 'commands', 'receipt', 'gate_policy', 'ci_policy', 'test_failure', 'capped_review']);
const TYPES = new Set(['tests', 'clean', 'sources', 'review', 'ci', 'merge', 'note']);
const loaded = new WeakMap();
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
const relative = (task, hash) => `evidence/${task}/${hash}.json`;
// What an older tool reads in place of a stored field: the right type, and
// never enough to count as a passing receipt.
const fallback = (key, task, hash) => key === 'summary' ? `[stored in ${relative(task, hash)}]`
  : key === 'commands' || key === 'capped_review' ? [] : null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Gate decisions read only the evidence at a task's current head and
// revision, and merged() reads only the merge entry. Everything else is
// history, and only history moves out, so a pinned older tool that cannot
// follow a reference still sees every value it acts on.
function settled(task, entry, merged) {
  if (!shaMatch(entry.sha, task.sha) || entry.revision !== task.revision) return true;
  return task.status === 'cancelled' || merged && entry.type !== 'merge';
}

const isMerged = (task) => task.status === 'accepted' && task.evidence.some((e) => e.type === 'merge'
  && e.ok === true && !e.waived && shaMatch(e.sha, task.sha) && e.revision === task.revision);

function hydrate(record, dir, task) {
  if (!record || !TYPES.has(record.type) || !record.evidence_refs || !/^T\d+$/.test(task)) return record;
  const fields = new Map();
  for (const [key, ref] of Object.entries(record.evidence_refs)) {
    if (!FIELDS.has(key)) continue;
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
      throw refuse(`invalid evidence reference for ${task}.${key}`);
    }
    // An older writer that set the field itself left a value that is not the
    // fallback; its value wins and the reference is dropped on the next write.
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
  // Readers see the entry as it was recorded; only the writer uses the references.
  Object.defineProperty(record, 'evidence_refs', { enumerable: false });
  return record;
}

// The record as tasks.json holds it. Mode `keep` leaves a field never read on
// its reference without loading the file; `store` also moves other large
// fields out; `inline` brings stored fields back into an entry that is
// current again, such as a reopened task's.
function stored(record, dir, task, mode) {
  if (!record || !TYPES.has(record.type)) return record;
  const fields = loaded.get(record);
  const out = {};
  const refs = { ...record.evidence_refs };
  const store = mode === 'store';
  for (const key of Object.keys(record)) {
    if (key === 'evidence_refs') continue;
    const field = fields?.get(key);
    if (field && !field.read && mode !== 'inline') {
      out[key] = field.inline;
      continue;
    }
    out[key] = record[key];
    if (!FIELDS.has(key)) continue;
    delete refs[key];
    const text = JSON.stringify(out[key]);
    if (!store || text === undefined || Buffer.byteLength(text) <= INLINE_BYTES) continue;
    const hash = digest(text);
    const file = path.join(dir, relative(task, hash));
    // Content-addressed files never change, so an existing one is already right.
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      require('./state').writeAtomic(file, text);
    }
    refs[key] = { sha256: hash, bytes: Buffer.byteLength(text) };
    out[key] = fallback(key, task, hash);
  }
  if (Object.keys(refs).length) out.evidence_refs = refs;
  return out;
}

// `write` lays out settled and current entries; without it the text is the
// layout as loaded, for comparison.
function tasksJson(tasks, dir, write = false) {
  return JSON.stringify({ ...tasks, tasks: tasks.tasks.map((task) => {
    const merged = isMerged(task);
    return { ...task, evidence: task.evidence.map((entry) => stored(entry, dir, task.id,
      !write ? 'keep' : settled(task, entry, merged) ? 'store' : 'inline')) };
  }) }, null, 2) + '\n';
}

module.exports = { INLINE_BYTES, hydrate, tasksJson };
