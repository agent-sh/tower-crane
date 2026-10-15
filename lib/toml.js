'use strict';

// The TOML that codex config files use, parsed into plain objects and written
// back, so an agent home keeps only the settings it should whatever layout
// the user wrote them in (tables, dotted keys or inline tables). Dates and
// times are kept as their source text.

const { refuse } = require('./util');

// Tables have no prototype and are read through own properties only, so a
// key such as __proto__ or constructor is just a key.
const table = () => Object.create(null);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

class Raw {
  constructor(text) {
    this.text = text;
  }
}

function parse(text, file = 'config.toml') {
  let i = 0;
  const s = text.replace(/\r\n/g, '\n');
  const fail = (why) => {
    const line = s.slice(0, i).split('\n').length;
    throw refuse(`${file}:${line}: cannot read TOML (${why})`);
  };
  const ws = () => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  };
  // Whitespace, newlines and comments, as allowed inside arrays.
  const gap = () => {
    for (;;) {
      ws();
      if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++;
      else if (s[i] === '\n') i++;
      else return;
    }
  };
  const endOfLine = () => {
    ws();
    if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++;
    if (i < s.length && s[i] !== '\n') fail('expected the end of the line');
  };
  const escape = () => {
    const c = s[i++];
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
    if (c in simple) return simple[c];
    if (c === 'u' || c === 'U') {
      const n = c === 'u' ? 4 : 8;
      const hex = s.slice(i, i + n);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) fail('bad unicode escape');
      i += n;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (c === 'x') {
      const hex = s.slice(i, i + 2);
      i += 2;
      return String.fromCharCode(parseInt(hex, 16));
    }
    return fail(`bad escape \\${c}`);
  };
  const string = () => {
    if (s.startsWith('"""', i)) {
      i += 3;
      if (s[i] === '\n') i++;
      let out = '';
      for (;;) {
        if (i >= s.length) fail('unterminated string');
        if (s.startsWith('"""', i)) {
          // Up to two quotes right before the closing ones belong to the string.
          let q = 0;
          while (s[i + q] === '"') q++;
          out += '"'.repeat(Math.min(q - 3, 2));
          i += q;
          return out;
        }
        if (s[i] === '\\') {
          i++;
          if (/[ \t\n]/.test(s[i]) && /^[ \t]*\n/.test(s.slice(i))) {
            while (/[ \t\n]/.test(s[i])) i++;
            continue;
          }
          out += escape();
        } else out += s[i++];
      }
    }
    if (s.startsWith("'''", i)) {
      i += 3;
      if (s[i] === '\n') i++;
      const end = s.indexOf("'''", i);
      if (end < 0) fail('unterminated string');
      let q = end;
      while (s[q + 3] === "'") q++;
      const out = s.slice(i, q);
      i = q + 3;
      return out;
    }
    if (s[i] === '"') {
      i++;
      let out = '';
      while (s[i] !== '"') {
        if (i >= s.length || s[i] === '\n') fail('unterminated string');
        if (s[i] === '\\') {
          i++;
          out += escape();
        } else out += s[i++];
      }
      i++;
      return out;
    }
    if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0 || s.slice(i + 1, end).includes('\n')) fail('unterminated string');
      const out = s.slice(i + 1, end);
      i = end + 1;
      return out;
    }
    return null;
  };
  const key = () => {
    const parts = [];
    for (;;) {
      ws();
      const q = s[i] === '"' || s[i] === "'" ? string() : null;
      if (q !== null) parts.push(q);
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
        if (!m) fail('expected a key');
        parts.push(m[0]);
        i += m[0].length;
      }
      ws();
      if (s[i] !== '.') return parts;
      i++;
    }
  };
  const value = () => {
    const str = string();
    if (str !== null) return str;
    if (s[i] === '[') {
      i++;
      const arr = [];
      for (;;) {
        gap();
        if (s[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value());
        gap();
        if (s[i] === ',') i++;
        else if (s[i] !== ']') fail('expected , or ] in an array');
      }
    }
    if (s[i] === '{') {
      i++;
      const obj = table();
      ws();
      if (s[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        const k = key();
        if (s[i] !== '=') fail('expected =');
        i++;
        ws();
        put(obj, k, value());
        ws();
        if (s[i] === '}') {
          i++;
          return obj;
        }
        if (s[i] !== ',') fail('expected , or } in an inline table');
        i++;
      }
    }
    // A date and time may be written with a space between them.
    const m = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:[0-9:.+\-Z]+|^[^\s,\]}#]+/.exec(s.slice(i));
    if (!m) fail('expected a value');
    const tok = m[0];
    i += tok.length;
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(tok)) return Number(tok.replace(/inf/, 'Infinity').replace(/nan/, 'NaN'));
    const num = tok.replace(/_/g, '');
    if (/^[+-]?(0|[1-9]\d*)$/.test(num)) return Number(num);
    if (/^0x[0-9a-fA-F]+$|^0o[0-7]+$|^0b[01]+$/.test(num)) return Number(num);
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(num)) return Number(num);
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(tok)) return new Raw(tok);
    return fail(`unknown value ${tok}`);
  };
  const put = (obj, parts, v) => {
    let o = obj;
    for (const p of parts.slice(0, -1)) {
      if (!has(o, p)) o[p] = table();
      if (!isTable(o[p])) fail(`${parts.join('.')} redefines a value`);
      o = o[p];
    }
    const last = parts[parts.length - 1];
    if (has(o, last)) fail(`${parts.join('.')} is defined twice`);
    o[last] = v;
  };
  const root = table();
  let cur = root;
  for (;;) {
    gap();
    if (i >= s.length) return root;
    if (s[i] === '[') {
      const arrayTable = s[i + 1] === '[';
      i += arrayTable ? 2 : 1;
      const parts = key();
      if (s[i] !== ']' || (arrayTable && s[i + 1] !== ']')) fail('expected ] after a table name');
      i += arrayTable ? 2 : 1;
      endOfLine();
      let o = root;
      for (const p of parts.slice(0, -1)) {
        if (!has(o, p)) o[p] = table();
        o = Array.isArray(o[p]) ? o[p][o[p].length - 1] : o[p];
        if (!isTable(o)) fail(`${parts.join('.')} is not a table`);
      }
      const last = parts[parts.length - 1];
      if (arrayTable) {
        if (!has(o, last)) o[last] = [];
        if (!Array.isArray(o[last])) fail(`${parts.join('.')} is not an array of tables`);
        o[last].push(table());
        cur = o[last][o[last].length - 1];
      } else {
        if (!has(o, last)) o[last] = table();
        if (!isTable(o[last])) fail(`${parts.join('.')} is not a table`);
        cur = o[last];
      }
      continue;
    }
    const k = key();
    if (s[i] !== '=') fail('expected =');
    i++;
    ws();
    put(cur, k, value());
    endOfLine();
  }
}

const isTable = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Raw);

const keyText = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

function valueText(v) {
  if (v instanceof Raw) return v.text;
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isNaN(v) ? 'nan' : v === Infinity ? 'inf' : v === -Infinity ? '-inf' : String(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(valueText).join(', ')}]`;
  return `{ ${Object.entries(v).map(([k, x]) => `${keyText(k)} = ${valueText(x)}`).join(', ')} }`;
}

// Plain values first, then each table under its own header, so the output
// reads like a hand-written config file.
function stringify(obj) {
  return lines(obj, []).join('\n').replace(/^\n+/, '');
}

function lines(obj, prefix) {
  const out = [];
  const tables = [];
  for (const [k, v] of Object.entries(obj)) {
    if (isTable(v)) tables.push([k, v]);
    else out.push(`${keyText(k)} = ${valueText(v)}`);
  }
  for (const [k, v] of tables) {
    const name = [...prefix, k];
    if (!Object.keys(v).length || Object.values(v).some((x) => !isTable(x))) out.push('', `[${name.map(keyText).join('.')}]`);
    out.push(...lines(v, name));
  }
  return out;
}

module.exports = { parse, stringify, isTable, has, Raw };
