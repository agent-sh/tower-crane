'use strict';
// Whether a GitHub Actions job skips for an event by its own `if:` condition. A merged hotfix is
// judged by base runs, where a pull-request-only job skips; a job skipped by a path filter or by
// another job's output must not count the same way. Only a condition that is false for the event
// whatever its other terms are proves an event skip. Anything this reader cannot follow is unknown.

const UNKNOWN = { kind: 'unknown' };
const TOKEN = /\s*(?:(\|\||&&|==|!=|!|\(|\)|,)|'((?:[^']|'')*)'|([A-Za-z_][\w.\-*]*(?:\[[^\]]*\])*)|(-?\d+(?:\.\d+)?))/y;

function tokens(text) {
  const out = [];
  TOKEN.lastIndex = 0;
  let at = 0;
  while (at < text.length) {
    if (!text.slice(at).trim()) break;
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(text);
    if (!m) return null;
    at = TOKEN.lastIndex;
    if (m[1]) out.push({ op: m[1] });
    else if (m[2] !== undefined) out.push({ value: { kind: 'str', v: m[2].replace(/''/g, "'") } });
    else if (m[3]) out.push({ ident: m[3] });
    else out.push({ value: { kind: 'num', v: Number(m[4]) } });
  }
  return out;
}

// Three-valued truth: true, false or null for unknown.
function truth(value) {
  if (value.kind === 'bool') return value.v;
  if (value.kind === 'str') return value.v !== '';
  if (value.kind === 'num') return value.v !== 0;
  return null;
}
const bool = (t) => (t === null ? UNKNOWN : { kind: 'bool', v: t });

function evaluate(expression, event) {
  const list = tokens(expression);
  if (!list) return null;
  let i = 0;
  const peek = (op) => list[i]?.op === op;
  const take = (op) => {
    if (!peek(op)) throw new Error(`expected ${op}`);
    i += 1;
  };
  function primary() {
    const t = list[i++];
    if (!t) throw new Error('unexpected end');
    if (t.op === '(') {
      const v = or();
      take(')');
      return v;
    }
    if (t.value) return t.value;
    if (!t.ident) throw new Error(`unexpected ${t.op}`);
    if (peek('(')) {
      // A function call (always(), contains(...), success()): its value is unknown here.
      take('(');
      if (!peek(')')) {
        or();
        while (peek(',')) { take(','); or(); }
      }
      take(')');
      return UNKNOWN;
    }
    const name = t.ident.toLowerCase();
    if (name === 'github.event_name') return { kind: 'str', v: event };
    if (name === 'true' || name === 'false') return { kind: 'bool', v: name === 'true' };
    return UNKNOWN;
  }
  function compare() {
    const left = primary();
    if (!peek('==') && !peek('!=')) return left;
    const op = list[i++].op;
    const right = primary();
    if (left.kind !== 'str' || right.kind !== 'str') return UNKNOWN;
    // Actions compares strings without regard to case.
    const same = left.v.toLowerCase() === right.v.toLowerCase();
    return { kind: 'bool', v: op === '==' ? same : !same };
  }
  function not() {
    if (!peek('!')) return compare();
    take('!');
    const t = truth(not());
    return bool(t === null ? null : !t);
  }
  function and() {
    let t = truth(not());
    while (peek('&&')) {
      take('&&');
      const r = truth(not());
      t = t === false || r === false ? false : t === true && r === true ? true : null;
    }
    return bool(t);
  }
  function or() {
    let t = truth(and());
    while (peek('||')) {
      take('||');
      const r = truth(and());
      t = t === true || r === true ? true : t === false && r === false ? false : null;
    }
    return bool(t);
  }
  try {
    const v = or();
    if (i !== list.length) return null;
    return truth(v);
  } catch {
    return null;
  }
}

// True only when the condition is false for `event` whatever its other terms are.
function falseForEvent(condition, event) {
  if (typeof condition !== 'string' || !condition.trim()) return false;
  let text = condition.trim();
  const wrapped = text.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (wrapped) text = wrapped[1];
  if (text.includes('${{')) return false;
  return evaluate(text, event) === false;
}

const indent = (line) => line.match(/^ */)[0].length;
const unquote = (v) => {
  const t = v.trim();
  if (/^'.*'$/s.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/s.test(t)) return t.slice(1, -1);
  return t;
};

// The value of `key:` in a block, joining a folded or literal block scalar onto one line.
function blockValue(lines, at, keyIndent) {
  const value = lines[at].slice(lines[at].indexOf(':') + 1).replace(/\s+#.*$/, '').trim();
  if (!/^[>|][-+]?$/.test(value)) return unquote(value);
  const parts = [];
  for (let j = at + 1; j < lines.length && (!lines[j].trim() || indent(lines[j]) > keyIndent); j++) parts.push(lines[j].trim());
  return parts.join(' ').trim();
}

// The `if:` conditions of the jobs whose check run is named `checkName`, from a workflow file's
// text: a job's `name:` with `${{ }}` parts matching anything, else its id with an optional
// matrix suffix. null when no job matches or a matching job has no condition.
function jobConditions(text, checkName) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*#/.test(l));
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  const jobs = [];
  let jobIndent = null;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j];
    if (!line.trim()) continue;
    const n = indent(line);
    if (n === 0) break;
    jobIndent ??= n;
    if (n === jobIndent) {
      const id = line.trim().match(/^([A-Za-z_][\w-]*):\s*$/)?.[1];
      jobs.push({ id, at: j, name: null, condition: null });
      continue;
    }
    const job = jobs.at(-1);
    if (!job) continue;
    job.keyIndent ??= n;
    if (n !== job.keyIndent) continue;
    if (/^name:/.test(line.trim())) job.name = blockValue(lines, j, n);
    if (/^if:/.test(line.trim())) job.condition = blockValue(lines, j, n);
  }
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = jobs.filter((job) => {
    if (job.name) {
      const pattern = job.name.split(/\$\{\{[\s\S]*?\}\}/).map(escape).join('.*');
      return new RegExp(`^${pattern}$`).test(checkName);
    }
    return job.id && (checkName === job.id || checkName.startsWith(`${job.id} (`));
  });
  if (!matches.length || matches.some((job) => !job.condition)) return null;
  return matches.map((job) => job.condition);
}

module.exports = { falseForEvent, jobConditions };
