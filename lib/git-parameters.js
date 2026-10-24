'use strict';

// Command-scope git config in GIT_CONFIG_PARAMETERS, the variable `git -c`
// fills. Tower Crane sets its entries there, not in GIT_CONFIG_COUNT with
// GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n>: a sandboxed agent's commands
// get no name holding KEY (lib/agents.js CODEX_ENV_EXCLUDE), and git stops
// when a count lacks its keys. git reads the count entries first, then these
// (git 2.53.0), so an entry appended here wins over both.

const NAME = 'GIT_CONFIG_PARAMETERS';

// The name env holds it under: Windows keeps any case.
const key = (env) => Object.keys(env).find((name) => name.toUpperCase() === NAME) || NAME;

// git's sq_quote: inside single quotes only a quote needs escaping.
const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

// One entry in the form git 2.31 and later reads, which keeps an = in the key
// (url.<base>.insteadOf) apart from the value.
const entry = (name, value) => `${quote(name)}=${quote(value)}`;

// text with entries appended, space-separated as git writes them.
function append(text, pairs) {
  const added = pairs.map(([name, value]) => entry(name, value)).join(' ');
  if (!added) return text || '';
  return text ? `${text} ${added}` : added;
}

// Splits GIT_CONFIG_PARAMETERS the way git does: whitespace between entries
// ends one outside quotes, and the first unquoted `=` ends a name. An entry
// with no unquoted `=` is the older `'name=value'` form, so its name ends at
// the first `=` inside the quotes. Each entry keeps its original text, so its
// quoting reaches git unchanged. null when the text is malformed.
function split(text) {
  const entries = [];
  let start = -1;
  let name = '';
  let named = null;
  let open = null;
  let escaped = false;
  const begin = (index) => {
    if (start < 0) start = index;
  };
  const add = (char) => {
    if (named === null) name += char;
  };
  const end = (index) => {
    if (start < 0) return;
    entries.push({ raw: text.slice(start, index), name: named ?? name.split('=')[0] });
    start = -1;
    name = '';
    named = null;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      add(char);
    } else if (!open && char === '\\') {
      begin(index);
      escaped = true;
    } else if (open && char === open) {
      open = null;
    } else if (!open && (char === '\'' || char === '"')) {
      begin(index);
      open = char;
    } else if (!open && /\s/.test(char)) {
      end(index);
    } else if (!open && char === '=' && named === null) {
      begin(index);
      named = name;
    } else {
      begin(index);
      add(char);
    }
  }
  if (open || escaped) return null;
  end(text.length);
  return entries;
}

// Moves env's GIT_CONFIG_COUNT entries into GIT_CONFIG_PARAMETERS, ahead of
// what it holds, so they keep their place before it, and deletes the count,
// key and value names. git stops at a key the count names but env lacks, so
// the move stops there too.
function fromCount(env) {
  const names = Object.keys(env).filter((name) => /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i.test(name));
  const get = (wanted) => names.find((name) => name.toUpperCase() === wanted);
  const count = Number.parseInt(env[get('GIT_CONFIG_COUNT')], 10) || 0;
  const pairs = [];
  for (let i = 0; i < count; i++) {
    const k = get(`GIT_CONFIG_KEY_${i}`);
    if (k === undefined) break;
    pairs.push([env[k], env[get(`GIT_CONFIG_VALUE_${i}`)] ?? '']);
  }
  const out = { ...env };
  for (const name of names) delete out[name];
  if (!pairs.length) return out;
  const at = key(out);
  const added = append('', pairs);
  out[at] = out[at] ? `${added} ${out[at]}` : added;
  return out;
}

module.exports = { NAME, key, entry, append, split, fromCount };
