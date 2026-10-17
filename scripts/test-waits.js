'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HUNG_TEST_MS = 300000;
function allowed(line) {
  if (tokenize(line).some((token) => token.type === 'comment'
    && /^\/\/\s*wait-allow:\s*\S.*$/.test(token.value))) return true;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      // Generated fixture scripts can begin a line inside a template literal.
      else if (quote === '`' && /^\/\/\s*wait-allow:\s*\S.*$/.test(line.slice(i))
        && !line.slice(i).includes('`')) return true;
    } else if (['"', "'", '`'].includes(char)) quote = char;
  }
  return false;
}

// Keep literal bodies opaque so their delimiters cannot split a call or a
// declaration. Template interpolations use the same lexer recursively. A
// caller that needs only the tokens up to a bracket stops the scan there.
function* scan(text, from = 0) {
  let position = from;
  const quotedEnd = (quote) => {
    position++;
    while (position < text.length) {
      if (text[position++] === '\\') position++;
      else if (text[position - 1] === quote) break;
    }
  };
  const read = (previous) => {
    while (/\s/.test(text[position] || '') && position < text.length) position++;
    if (position >= text.length) return null;
    const start = position;
    const char = text[position];
    let type = 'punctuation';
    if (text.startsWith('//', position)) {
      type = 'comment';
      position = text.indexOf('\n', position);
      if (position < 0) position = text.length;
    } else if (text.startsWith('/*', position)) {
      type = 'comment';
      const end = text.indexOf('*/', position + 2);
      position = end < 0 ? text.length : end + 2;
    } else if (char === '"' || char === "'") {
      type = 'string';
      quotedEnd(char);
    } else if (char === '`') {
      type = 'template';
      position++;
      while (position < text.length) {
        if (text[position] === '\\') position += 2;
        else if (text[position++] === '`') break;
        else if (text.slice(position - 1, position + 1) === '${') {
          position++;
          let depth = 1;
          let last = null;
          while (depth && position < text.length) {
            const token = read(last);
            if (!token) break;
            if (token.type === 'comment') continue;
            if (token.value === '{') depth++;
            else if (token.value === '}') depth--;
            last = token;
          }
        }
      }
    } else if (char === '/' && !(previous && (['identifier', 'number', 'string', 'template', 'regex'].includes(previous.type)
      || [')', ']'].includes(previous.value)))) {
      type = 'regex';
      position++;
      let inClass = false;
      while (position < text.length && !/[\r\n]/.test(text[position])) {
        const current = text[position++];
        if (current === '\\') position++;
        else if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) {
          while (/[a-z]/i.test(text[position] || '')) position++;
          break;
        }
      }
    } else {
      const number = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)/.exec(text.slice(position));
      const identifier = /^[$A-Z_a-z][$\w]*/.exec(text.slice(position));
      if (number) { type = 'number'; position += number[0].length; }
      else if (identifier) {
        // Reserved words can also be member names. Members finish an operand;
        // operator and statement keywords begin the next expression instead.
        type = !['.', '#'].includes(previous?.value)
          && /^(?:await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|return|switch|throw|try|typeof|var|void|while|with|yield)$/.test(identifier[0])
          ? 'keyword' : 'identifier';
        position += identifier[0].length;
      } else position++;
    }
    return { type, value: text.slice(start, position), start, end: position };
  };
  let previous = null;
  while (position < text.length) {
    const token = read(previous);
    if (!token) break;
    yield token;
    if (token.type !== 'comment') previous = token;
  }
}

const tokenize = (text, from = 0) => [...scan(text, from)];

function callArguments(text, start) {
  const args = [];
  const stack = [')'];
  let from = start + 1;
  let first = true;
  for (const token of scan(text, start)) {
    if (first) { first = false; continue; }
    if (token.type !== 'punctuation') continue;
    const char = token.value;
    if ('([{'.includes(char)) stack.push({ '(': ')', '[': ']', '{': '}' }[char]);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) { args.push(text.slice(from, token.start).trim()); return args; }
    } else if (char === ',' && stack.length === 1) {
      args.push(text.slice(from, token.start).trim());
      from = token.end;
    }
  }
  return [];
}

function normalizedBudget(value) {
  let tokens = tokenize(value).filter((token) => token.type !== 'comment');
  // Identity wrappers can surround an identifier, but a literal label stays
  // a string. Joining significant tokens also removes inline comments.
  for (;;) {
    if (tokens[0]?.value === '+' && tokens[1]?.value !== '+') { tokens = tokens.slice(1); continue; }
    if (tokens[0]?.value !== '(' || tokens.at(-1)?.value !== ')') break;
    let depth = 0;
    let whole = true;
    for (const [index, token] of tokens.entries()) {
      if (token.value === '(') depth++;
      else if (token.value === ')' && --depth === 0 && index !== tokens.length - 1) { whole = false; break; }
    }
    if (!whole || depth !== 0) break;
    tokens = tokens.slice(1, -1);
  }
  return tokens.map((token) => token.value).join('');
}

function foldedBudget(value, bindings, seen = new Set()) {
  const tokens = tokenize(value).filter((token) => token.type !== 'comment');
  let position = 0;
  const primary = () => {
    const token = tokens[position++];
    if (!token) return undefined;
    if (token.value === '+' || token.value === '-') {
      const number = primary();
      return number === undefined ? undefined : token.value === '-' ? -number : number;
    }
    if (token.value === '(') {
      const number = sum();
      return tokens[position++]?.value === ')' ? number : undefined;
    }
    if (token.type === 'number') return Number(token.value.replaceAll('_', ''));
    if (bindings.has(token.value)) {
      const values = bindings.get(token.value).map((bound) => seen.has(bound) ? undefined
        : foldedBudget(bound.value, bound.bindings(), new Set([...seen, bound])));
      return values.length && values.every((number) => number === values[0]) ? values[0] : undefined;
    }
    if (token.type !== 'identifier') return undefined;
    return token.value === 'HUNG_TEST_MS' ? HUNG_TEST_MS : undefined;
  };
  const product = () => {
    let result = primary();
    while (['*', '/'].includes(tokens[position]?.value)) {
      const operator = tokens[position++].value;
      const right = primary();
      result = result === undefined || right === undefined ? undefined
        : operator === '*' ? result * right : result / right;
    }
    return result;
  };
  const sum = () => {
    let result = product();
    while (['+', '-'].includes(tokens[position]?.value)) {
      const operator = tokens[position++].value;
      const right = product();
      result = result === undefined || right === undefined ? undefined
        : operator === '+' ? result + right : result - right;
    }
    return result;
  };
  const result = sum();
  return position === tokens.length ? result : undefined;
}

function hungBudget(value, bindings = new Map(), seen = new Set(), sign = 1) {
  const folded = foldedBudget(value, bindings, seen);
  if (folded !== undefined) return sign * folded >= HUNG_TEST_MS;
  value = normalizedBudget(value);
  if (/^-(?!-)/.test(value)) return hungBudget(value.slice(1), bindings, seen, -sign);
  if (bindings.has(value)) {
    return bindings.get(value).every((bound) => !seen.has(bound)
      && hungBudget(bound.value, bound.bindings(), new Set([...seen, bound]), sign));
  }
  if (value === 'HUNG_TEST_MS') return sign > 0;
  if (/^Math\.max\(/.test(value)) {
    return sign > 0 && callArguments(value, value.indexOf('(')).some((arg) => hungBudget(arg, bindings, seen));
  }
  return sign * Number(value.replaceAll('_', '')) >= HUNG_TEST_MS;
}

function budgetExpression(value, bindings, seen = new Set()) {
  if (foldedBudget(value, bindings, seen) !== undefined) return true;
  value = normalizedBudget(value);
  if (/^-(?!-)/.test(value)) return budgetExpression(value.slice(1), bindings, seen);
  const defaultValue = /^(\w+)\s*=\s*([\s\S]+)$/.exec(value);
  if (defaultValue) {
    return budgetExpression(defaultValue[2], bindings, seen)
      || (/^(?:ms|timeout(?:Ms)?|budget|duration)$/i.test(defaultValue[1])
        && !/^['"`{[]/.test(defaultValue[2].trim()));
  }
  if (bindings.has(value)) {
    return bindings.get(value).some((bound) => !seen.has(bound)
      && (budgetExpression(bound.value, bound.bindings(), new Set([...seen, bound]))
        || (/^(?:ms|timeout(?:Ms)?|budget|duration)$/i.test(value)
          && !/^['"`{[]|\bfunction\b|=>/.test(bound.value))));
  }
  if (/^['"`{[]/.test(value) || /\bfunction\b|=>/.test(value)) return false;
  // Computed numbers are budgets too. Unknown expressions need an explicit
  // hung-guard minimum or a reason rather than being treated as nonnumeric.
  let expression = value.replace(/(['"`])(?:\\[\s\S]|(?!\1)[\s\S])*?\1/g, '');
  if (/^[\w$.]+\s*\(/.test(expression)
    && !/^(?:Math\.\w+|Number|parseInt|parseFloat)\s*\(/.test(expression)) {
    // Arguments of an unknown call do not describe its return type. Keep
    // arithmetic outside that call, which can turn its result into a budget.
    let depth = 0;
    for (let i = expression.indexOf('('); i < expression.length; i++) {
      if (expression[i] === '(') depth++;
      if (expression[i] === ')' && --depth === 0) {
        expression = `result${expression.slice(i + 1)}`;
        break;
      }
    }
  }
  return /^[\s(]*[+-]?\s*\d/.test(expression)
    || /\b\d[\d_]*(?:e[+-]?\d+)?\b/i.test(expression)
    || /^(?:Math\.\w+|Number|parseInt|parseFloat)\s*\(/.test(expression)
    || /[\w$.()]+\s*[-+*/%]\s*[\w$.()]+/.test(expression)
    || /^(?:HUNG_TEST_MS|ms|timeout(?:Ms)?|budget|duration)$/i.test(expression)
    || /\b[\w$.]+_(?:MS|TIMEOUT|BUDGET|DURATION)\b/.test(expression);
}

function expressionEnd(text, tokens, start, comparison = false) {
  const nested = [];
  let end = start;
  for (; end < tokens.length; end++) {
    const token = tokens[end];
    if (!nested.length) {
      if ([',', ';', '}', ')', ']'].includes(token.value)) break;
      if (comparison && (['<', '>', '='].includes(token.value)
        || ['&', '|', '?'].includes(token.value) && tokens[end + 1]?.value === token.value)) break;
      if (end > start && /[\r\n]/.test(text.slice(tokens[end - 1].end, token.start))) {
        const previous = tokens[end - 1].value;
        // A newline ends a completed initializer, but not a continued sum,
        // member access or call. The declaration need not have a semicolon.
        if (!/^(?:[=+\-*/%&|^?:.!~<>]|in|instanceof)$/.test(previous)
          && !/^(?:[+\-*/%&|^?:.<>[(]|in|instanceof)$/.test(token.value)) break;
      }
    }
    if (['(', '[', '{'].includes(token.value)) nested.push(token.value);
    else if ([')', ']', '}'].includes(token.value)) nested.pop();
  }
  return end;
}

function bindingScopes(text) {
  const root = { start: 0, end: text.length, parent: null, values: new Map() };
  const scopes = [root];
  const stack = [root];
  const tokens = tokenize(text).filter((token) => token.type !== 'comment');
  for (const token of tokens) {
    token.scope = stack.at(-1);
    if (token.type !== 'punctuation') continue;
    if (token.value === '{') {
      const scope = { start: token.end, end: text.length, parent: stack.at(-1), values: new Map() };
      scopes.push(scope);
      stack.push(scope);
    } else if (token.value === '}' && stack.length > 1) {
      stack.pop().end = token.start;
    }
  }
  const parentheses = new Map();
  const opened = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value === '(') opened.push(i);
    else if (tokens[i].value === ')' && opened.length) parentheses.set(opened.pop(), i);
  }
  for (const [open, close] of parentheses) {
    const arrow = tokens[close + 1]?.value === '=' && tokens[close + 2]?.value === '>';
    const body = tokens[close + (arrow ? 3 : 1)];
    if (!body || (!arrow && (body.value !== '{'
      || /^(?:if|for|while|switch|catch|with)$/.test(tokens[open - 1]?.value)))) continue;
    const args = callArguments(text, tokens[open].start).map(normalizedBudget);
    if (!args.some((arg) => /^[$\w]+\s*=/.test(arg))) continue;
    const block = body.value === '{' && scopes.find((scope) => scope.start === body.end);
    const end = block ? block.end : (tokens[expressionEnd(text, tokens, close + 3)]?.start ?? text.length);
    const parameters = { start: tokens[open].end, end, parent: tokens[open].scope, values: new Map() };
    // Defaults belong to the callable's parameter environment, not a body
    // local with the same name or a default on another callable.
    for (const scope of scopes) {
      if (scope.parent === parameters.parent && scope.start >= parameters.start && scope.end <= end) {
        scope.parent = parameters;
      }
    }
    scopes.push(parameters);
    for (const arg of args) {
      const parameter = /^([$\w]+)(?:\s*=\s*([\s\S]+))?$/.exec(arg);
      if (parameter) parameters.values.set(parameter[1], [{
        value: parameter[2] || 'undefined', scope: parameters,
      }]);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const declaration = tokens[i];
    if (!['const', 'let', 'var'].includes(declaration.value)) continue;
    // var can escape a block. Collect possible values conservatively when
    // its function boundary is ambiguous, retaining each initializer's scope.
    const storage = declaration.value === 'var' ? root : declaration.scope;
    let j = i + 1;
    while (j < tokens.length) {
      let name = null;
      if (/^[$A-Z_a-z][$\w]*$/.test(tokens[j]?.value || '')) name = tokens[j++].value;
      else if (['[', '{'].includes(tokens[j]?.value)) {
        // Imported/destructured values have no scalar initializer here, but
        // later scalar declarators still belong to this declaration.
        let depth = 0;
        do {
          if (['[', '{'].includes(tokens[j]?.value)) depth++;
          else if ([']', '}'].includes(tokens[j]?.value)) depth--;
          j++;
        } while (j < tokens.length && depth);
      } else break;
      let from = tokens[j - 1].end;
      if (tokens[j]?.value === '=') from = tokens[j++].end;
      j = expressionEnd(text, tokens, j);
      const end = tokens[j - 1]?.end ?? from;
      if (name) {
        const values = storage.values.get(name) || [];
        values.push({ value: text.slice(from, end).trim(), scope: declaration.scope });
        storage.values.set(name, values);
      }
      if (tokens[j]?.value !== ',') break;
      j++;
    }
  }
  // Initializers resolve where declared, so a caller's shadowing cannot
  // change an outer alias. Cache maps to preserve identity when detecting cycles.
  const cache = new Map();
  const scopedBindings = (initial) => {
    if (cache.has(initial)) return cache.get(initial);
    const values = new Map();
    cache.set(initial, values);
    for (let scope = initial; scope; scope = scope.parent) {
      for (const [name, initializers] of scope.values) {
        if (!values.has(name)) values.set(name, initializers.map((initializer) => ({
          value: initializer.value, bindings: () => scopedBindings(initializer.scope),
        })));
      }
    }
    return values;
  };
  const bindingsAt = (position) => {
    let scope = root;
    for (const candidate of scopes) {
      if (candidate.start <= position && position <= candidate.end && candidate.start >= scope.start) scope = candidate;
    }
    return scopedBindings(scope);
  };
  return bindingsAt;
}

// Wall clocks a deadline or an elapsed check can read.
const CLOCK = String.raw`(?:(?:Date|performance)\.now\(\)|Number\(process\.hrtime\.bigint\(\)\)|process\.hrtime\.bigint\(\)|\+?new Date\(\)(?:\.getTime\(\)|\.valueOf\(\))?)`;
const SHELL = String.raw`(['"\`])(?:[\w./-]*\/)?(?:ba|da|k|z)?sh\1\s*,\s*\[\s*(['"\`])-c\2\s*,\s*`;
const SLEEP_CALL = new RegExp(String.raw`\b(?:Atomics\.wait|setTimeout|sleep|delay|pause|scheduler\.wait)\s*\(|\b(?:spawnSync|execSync|execFileSync)\s*\(\s*['"\`]sleep\b`
  + String.raw`|\b(?:spawnSync|execFileSync)\s*\(\s*${SHELL}['"\`][^'"\`]*\bsleep\s`);
// A shell command at a command position: the start, after a separator, or
// after a keyword that begins a command list.
const SHELL_COMMAND = String.raw`(?<=(?:^|[\n;&|({])[ \t]*|\b(?:then|do|else)[ \t]+)`;
// Loop words at a command position, which also follows a case pattern's ),
// an interpolation's }, ! and time. A loop word in a comment, an echo or a
// grep argument is text.
const SHELL_LOOP_WORD = new RegExp(String.raw`(?<=(?:^|[\n;&|(){}!])[ \t]*|\b(?:then|do|else|time)[ \t]+)(?:while|until|for|do|done)\b`, 'g');
// Any sleep word in a loop body counts, also /bin/sleep or command sleep,
// but not an option such as --sleep, an echo's text or a comment.
const SHELL_SLEEP = /(?<![\w-])sleep[ \t]+[^\s;&|]/;
const SHELL_TEXT = /(?<!\w)(?:echo|printf)\b[^;&|\n]*|(?<![^\s;&|(])#[^\n]*/g;
// An echo's command substitutions still run.
const shellCode = (body) => body.replace(SHELL_TEXT, (text) => (text.startsWith('#') ? ''
  : (text.match(/\$\([^()]*\)?|`[^`]*`?/g) || []).join(' ')));

// A script with its escapes resolved, of the same length so positions still
// point into the test file: a newline escape ends a line, a tab separates.
const shellText = (value) => value.replace(/\\([\s\S])/g, (all, char) => (char === 'n' || char === 'r' ? ' \n' : char === 't' ? '  ' : ` ${char}`));

// Shell loops a test writes that a counter bounds around a sleep: a for loop
// over seq, a brace range, a fixed list of numbers or a C-style header, or a
// while or until loop comparing a variable its body counts, in its condition
// or in a test before a break in the body.
function shellCounted(script) {
  const found = [];
  const open = [];
  const check = (loop, body) => {
    if (!SHELL_SLEEP.test(shellCode(body))) return;
    let counted;
    if (loop.keyword === 'for') {
      counted = /^\s*\(\([^;]*;[^;]*[<>][^;]*;/.test(loop.header)
        || /^\s+[A-Z_a-z]\w*\s+in\s+(?:\$\(\s*seq\b|`\s*seq\b|\{-?\d+\.\.-?\d+(?:\.\.-?\d+)?\}|-?\d+(?:\s+-?\d+)+\s*;?\s*$)/.test(loop.header);
    } else {
      const compared = (text) => [...text.matchAll(/\$\{?(\w+)\}?"?\s+-(?:lt|le|gt|ge|eq)\b|-(?:lt|le|gt|ge|eq)\s+"?\$\{?(\w+)|\(\(\s*(\w+)\s*(?:[<>]|==)/g)]
        .map((m) => m[1] || m[2] || m[3]);
      const names = [...compared(loop.header), ...(/\b(?:break|exit|return)\b/.test(body) ? compared(body) : [])];
      counted = names.some((name) => new RegExp(String.raw`\b${name}=\s*(?:\$\(\(|\$\(\s*expr\b|\`\s*expr\b)|\(\(\s*(?:\+\+|--)?\s*${name}\s*(?:\+\+|--|[-+]=)|\(\(\s*(?:\+\+|--)\s*${name}\b|\blet\s+["']?${name}\b`).test(body));
    }
    if (counted) found.push(loop.at);
  };
  for (const word of script.matchAll(SHELL_LOOP_WORD)) {
    const [keyword] = word;
    if (keyword === 'do') {
      const loop = open.findLast((candidate) => candidate.body === undefined);
      if (loop) { loop.header = script.slice(loop.at + loop.keyword.length, word.index); loop.body = word.index + 2; }
    } else if (keyword === 'done') {
      const index = open.findLastIndex((candidate) => candidate.body !== undefined);
      if (index < 0) continue;
      const [loop] = open.splice(index, 1);
      check(loop, script.slice(loop.body, word.index));
    } else open.push({ keyword, at: word.index });
  }
  // A loop whose done is in code the check cannot read runs to the end.
  for (const loop of open) if (loop.body !== undefined) check(loop, script.slice(loop.body));
  return found;
}

// Whether a script sleeps outside any loop, where nothing polls a signal.
function shellBareSleep(script) {
  const wrapped = /^\s*(?:[\w./-]*\/)?(?:ba|da|k|z)?sh\s+-c\s+(['"])([\s\S]*)\1\s*$/.exec(script);
  let depth = 0;
  for (const word of (wrapped ? wrapped[2] : script).matchAll(new RegExp(String.raw`${SHELL_COMMAND}(?:(?:do|done)\b|sleep[ \t]+[^\s;&|])`, 'g'))) {
    if (word[0] === 'do') depth++;
    else if (word[0] === 'done') depth = Math.max(0, depth - 1);
    else if (!depth) return true;
  }
  return false;
}

// A synchronous sleep a helper function can hide: Atomics.wait with a
// timeout, a sleep command, or a promise that only a timer resolves.
// A sh -c helper sleeps only when its command literal holds a bare sleep.
const HELPER_SLEEP = new RegExp(String.raw`\bAtomics\.wait\s*\(|\b(?:spawnSync|execSync|execFileSync)\s*\(\s*(?:['"\`]sleep\b|${SHELL}(['"\`])((?:\\[\s\S]|(?!\3)[^\\])*)\3)`
  + String.raw`|\bnew\s+Promise\s*\(\s*(?:async\s*)?\(?\s*([$\w]+)[^)=]*\)?\s*=>\s*\{?\s*setTimeout\s*\(\s*\5\s*,`, 'g');

// Loop bodies, with whether a counter bounds the loop. Generated fixture
// scripts live in string and template literals, so those are read as code too.
function loops(text, offset = 0, found = Object.assign([], { shell: [], helpers: new Set() })) {
  const tokens = tokenize(text).filter((token) => token.type !== 'comment');
  const literal = (token) => ['string', 'template'].includes(token?.type);
  for (const token of tokens) {
    if (literal(token) && /\b(?:while|for|do)\b/.test(token.value)) {
      // Same-length unescaping keeps positions; escaped newlines stay whitespace.
      const inner = token.value.slice(1, -1).replace(/\\([\s\S])/g, (all, char) => ('nrt'.includes(char) ? '  ' : ` ${char}`));
      loops(inner, offset + token.start + 1, found);
    }
  }
  const match = new Map();
  const open = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type !== 'punctuation') continue;
    if ('([{'.includes(token.value)) open.push(index);
    else if (')]}'.includes(token.value) && open.length) match.set(open.pop(), index);
  }
  // A shell script can be one literal, a + chain whose other operands the
  // check cannot read, or an array of lines that a join puts together.
  const operandEnd = (j) => {
    while (j < tokens.length) {
      const { type, value } = tokens[j];
      if (type === 'punctuation' && match.has(j) && '([{'.includes(value)) j = match.get(j) + 1;
      else if (type === 'punctuation' && [',', ';', ')', ']', '}', '+', '?', ':'].includes(value)) break;
      else j++;
    }
    return j;
  };
  const chain = (i) => {
    const parts = [i];
    let j = i + 1;
    while (tokens[j]?.value === '+') {
      if (literal(tokens[j + 1])) { parts.push(j + 1); j += 2; continue; }
      const k = operandEnd(j + 1);
      if (tokens[k]?.value !== '+') break;
      parts.push(' ');
      j = k;
    }
    return { parts, end: j };
  };
  const used = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (!literal(tokens[i]) || used.has(i)) continue;
    const close = tokens[i - 1]?.value === '[' ? match.get(i - 1) : undefined;
    let parts;
    if (close !== undefined && tokens[close + 1]?.value === '.' && tokens[close + 2]?.value === 'join' && tokens[close + 3]?.value === '(') {
      parts = [];
      for (let j = i; j < close;) {
        if (literal(tokens[j])) {
          const next = chain(j);
          parts.push(...next.parts);
          j = next.end;
        }
        j = operandEnd(j);
        if (tokens[j]?.value === ',') { parts.push('\n'); j++; } else break;
      }
    } else parts = chain(i).parts;
    for (const part of parts) if (typeof part === 'number') used.add(part);
    // A newline escape can run into the keyword, so no word boundary before it.
    if (!parts.some((part) => typeof part === 'number' && /do\b/.test(tokens[part].value))) continue;
    let script = '';
    const starts = [];
    for (const part of parts) {
      if (typeof part === 'string') { script += part; continue; }
      starts.push([script.length, offset + tokens[part].start + 1]);
      script += shellText(tokens[part].value.slice(1, -1));
    }
    for (const at of shellCounted(script)) {
      const [from, start] = starts.findLast(([position]) => position <= at);
      found.shell.push(start + at - from);
    }
  }
  const counted = (range) => {
    const ids = new Set();
    for (let i = 0; i < range.length; i++) {
      const [a, b, c] = [range[i], range[i + 1], range[i + 2]];
      if (a.type === 'identifier' && ['+', '-'].includes(b?.value) && [b.value, '='].includes(c?.value)) ids.add(a.value);
      if (['+', '-'].includes(a.value) && b?.value === a.value && c?.type === 'identifier') ids.add(c.value);
    }
    return ids;
  };
  const body = (at) => {
    if (tokens[at]?.value === '{' && match.has(at)) return { from: tokens[at].start, to: tokens[match.get(at)].end };
    const end = expressionEnd(text, tokens, at);
    return { from: tokens[at]?.start ?? text.length, to: tokens[end]?.start ?? text.length };
  };
  // A loop with no bound in its header can still end on a count: an if in
  // its body that tests a counter and breaks, returns or throws.
  const exits = (range, inBody) => {
    for (let i = 0; i < range.length; i++) {
      if (range[i].value !== 'if' || range[i + 1]?.value !== '(') continue;
      let j = i + 1;
      for (let depth = 0; j < range.length; j++) {
        if ('([{'.includes(range[j].value)) depth++;
        else if (')]}'.includes(range[j].value) && --depth === 0) break;
      }
      const condition = range.slice(i + 2, j);
      const ids = new Set([...inBody, ...counted(condition)]);
      if (!condition.some((token) => token.type === 'identifier' && ids.has(token.value))) continue;
      let k = j + 1;
      if (range[k]?.value === '{') {
        // A return in a function the block defines leaves that function only.
        let inner = 0;
        const functions = [];
        for (let depth = 0; k < range.length; k++) {
          const { value } = range[k];
          if (value === 'function' || (value === '>' && range[k - 1]?.value === '=' && range[k + 1]?.value === '{')) inner = 1;
          if (!functions.length && ['break', 'return', 'throw'].includes(value)) return true;
          if (value === '{') {
            depth++;
            if (inner) functions.push(depth);
            inner = 0;
          } else if (value === '}') {
            if (functions.at(-1) === depth) functions.pop();
            if (--depth === 0) break;
          }
        }
      } else if (['break', 'return', 'throw'].includes(range[k]?.value)) return true;
    }
    return false;
  };
  const add = (keyword, header, range, kind) => {
    const bodyTokens = tokenize(text.slice(range.from, range.to)).filter((token) => token.type !== 'comment');
    const inBody = counted(bodyTokens);
    let condition = header;
    let counters = counted(header);
    if (kind === 'for') {
      const parts = [[]];
      let depth = 0;
      for (const token of header) {
        if ('([{'.includes(token.value)) depth++;
        else if (')]}'.includes(token.value)) depth--;
        if (token.value === ';' && !depth) parts.push([]);
        else parts.at(-1).push(token);
      }
      if (parts.length < 3) return;
      condition = parts[1];
      counters = new Set([...counted(parts[1]), ...counted(parts[2])]);
    }
    const bounded = condition.some((token) => token.type === 'identifier' && (counters.has(token.value) || inBody.has(token.value)))
      || exits(bodyTokens, new Set([...inBody, ...counters]));
    found.push({ start: offset + keyword.start, from: offset + range.from, to: offset + range.to, bounded });
  };
  for (const [index, token] of tokens.entries()) {
    if (token.type !== 'keyword') continue;
    if (token.value === 'do' && tokens[index + 1]?.value === '{' && match.has(index + 1)) {
      const close = match.get(index + 1);
      if (tokens[close + 1]?.value === 'while' && match.has(close + 2)) {
        add(token, tokens.slice(close + 3, match.get(close + 2)), body(index + 1), 'while');
      }
    } else if (['for', 'while'].includes(token.value) && tokens[index + 1]?.value === '(' && match.has(index + 1)) {
      // The tail of a do-while has no body of its own.
      const before = tokens[index - 1];
      if (before?.value === '}' && [...match].some(([from, to]) => to === index - 1 && tokens[from - 1]?.value === 'do')) continue;
      const close = match.get(index + 1);
      add(token, tokens.slice(index + 2, close), body(close + 1), token.value);
    }
  }
  // A named function whose sleep no loop of its own polls is a sleep
  // wherever it is called.
  const sleeps = [...text.matchAll(HELPER_SLEEP)].filter((m) => (m[4] === undefined || shellBareSleep(shellText(m[4])))
    && (!m[0].startsWith('Atomics') || callArguments(text, m.index + m[0].length - 1).length >= 4));
  if (sleeps.length) {
    for (const [index, token] of tokens.entries()) {
      let name;
      let at;
      if (token.value === 'function' && tokens[index + 1]?.type === 'identifier' && tokens[index + 2]?.value === '(') {
        name = tokens[index + 1].value;
        at = index + 2;
      } else if (['const', 'let', 'var'].includes(token.value) && tokens[index + 1]?.type === 'identifier' && tokens[index + 2]?.value === '=') {
        name = tokens[index + 1].value;
        at = index + 3;
        if (tokens[at]?.value === 'async') at++;
        if (tokens[at]?.value === 'function') at += tokens[at + 1]?.type === 'identifier' ? 2 : 1;
        else if (tokens[at]?.type === 'identifier' && tokens[at + 1]?.value === '=' && tokens[at + 2]?.value === '>') {
          at += 1;
        } else if (tokens[at]?.value !== '(') continue;
      } else continue;
      let start;
      if (tokens[at]?.value === '(' && match.has(at)) {
        const close = match.get(at);
        start = tokens[close + 1]?.value === '{' ? close + 1
          : tokens[close + 1]?.value === '=' && tokens[close + 2]?.value === '>' ? close + 3 : -1;
      } else if (tokens[at]?.value === '=' && tokens[at + 1]?.value === '>') start = at + 2;
      if (!(start >= 0) || !tokens[start]) continue;
      const range = body(start);
      const inside = (position) => found.some((loop) => offset + range.from <= loop.from && loop.to <= offset + range.to
        && loop.from <= offset + position && offset + position < loop.to);
      if (sleeps.some((m) => range.from <= m.index && m.index < range.to && !inside(m.index))) found.helpers.add(name);
    }
  }
  return found;
}

function waitFindings(text) {
  const findings = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const bindingsAt = bindingScopes(text);
  const expressionAt = (position) => {
    // A clock expression may be inside a quoted generated script. Tokenize
    // from that expression so an outer quote cannot absorb its delimiter.
    const fragment = text.slice(position);
    const tokens = tokenize(fragment).filter((token) => token.type !== 'comment');
    const end = expressionEnd(fragment, tokens, 0, true);
    const to = tokens[end - 1]?.end ?? 0;
    return { value: fragment.slice(0, to).trim(), end: position + to };
  };
  const report = (index, reason) => {
    if (!/^\s*\/\//.test(lines[index]) && !allowed(lines[index])) findings.push({ line: index + 1, reason });
  };
  for (const [index, line] of lines.entries()) {
    if (/^\s*\/\//.test(line)) continue;
    const guard = /\b(?:const|let)\s+HUNG_TEST_MS\s*=\s*([^;]+)/.exec(line);
    if (guard && !hungBudget(guard[1].trim())) report(index, 'hung-test backstop was shortened');
    for (const match of line.matchAll(/(['"])--(timeout|test-timeout)=([\d.]+)\1/g)) {
      const budget = Number(match[3]) * (match[2] === 'timeout' ? 1000 : 1);
      if (budget > 0 && budget < HUNG_TEST_MS) report(index, 'CLI wait has a readiness budget below the hung-test timeout');
    }
  }
  for (const match of text.matchAll(new RegExp(String.raw`${CLOCK}\s*-\s*[\w$.]+\s*\)*\s*(?:[*/]\s*[\w$.]+\s*\)*\s*)?[<>]=?|[<>]=?\s*\(*\s*${CLOCK}\s*-\s*[\w$.]+|\bprocess\.hrtime\(\s*[\w$.]+\s*\)(?:\[\d\])?\s*[<>]=?|[<>]=?\s*process\.hrtime\(\s*[\w$.]+\s*\)`, 'g'))) {
    report(text.slice(0, match.index).split('\n').length - 1, 'elapsed wall time is a pass condition');
  }
  for (const match of text.matchAll(/(['"])--(timeout|test-timeout)\1\s*,\s*(['"])([\d.]+)\3/g)) {
    const budget = Number(match[4]) * (match[2] === 'timeout' ? 1000 : 1);
    if (budget > 0 && budget < HUNG_TEST_MS) {
      report(text.slice(0, match.index).split('\n').length - 1, 'CLI wait has a readiness budget below the hung-test timeout');
    }
  }
  // Assignments and var declarations create the same deadline as const/let.
  for (const match of text.matchAll(new RegExp(String.raw`\b[\w$.]+\s*=\s*${CLOCK}\s*\+\s*`, 'g'))) {
    const index = text.slice(0, match.index).split('\n').length - 1;
    const { value } = expressionAt(match.index + match[0].length);
    if (!/^\s*\/\//.test(lines[index]) && !hungBudget(value, bindingsAt(match.index))) {
      report(index, 'readiness deadline below the hung-test timeout');
    }
  }
  for (const match of text.matchAll(new RegExp(String.raw`${CLOCK}\s*[<>]=?\s*\(*\s*[\w$.]+\s*\+\s*`, 'g'))) {
    const { value } = expressionAt(match.index + match[0].length);
    if (!hungBudget(value, bindingsAt(match.index))) {
      report(text.slice(0, match.index).split('\n').length - 1, 'readiness deadline below the hung-test timeout');
    }
  }
  for (const match of text.matchAll(/\b[\w$.]+\s*\+\s*/g)) {
    const { value, end } = expressionAt(match.index + match[0].length);
    if (new RegExp(String.raw`^\s*\)*\s*[<>]=?\s*${CLOCK}`).test(text.slice(end))
      && !hungBudget(value, bindingsAt(match.index))) {
      report(text.slice(0, match.index).split('\n').length - 1, 'readiness deadline below the hung-test timeout');
    }
  }
  for (const match of text.matchAll(/\bmonitorGraceMs\s*:\s*([^,}]+)/g)) {
    if (!hungBudget(match[1].trim())) {
      report(text.slice(0, match.index).split('\n').length - 1, 'teardown has a fixed observation budget');
    }
  }
  for (const match of text.matchAll(/\bAbortSignal\.timeout\s*\(/g)) {
    const args = callArguments(text, match.index + match[0].lastIndexOf('('));
    if (!hungBudget(args[0] || '')) {
      report(text.slice(0, match.index).split('\n').length - 1, 'abort signal has a fixed readiness budget');
    }
  }
  for (const elapsed of text.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(?:(\w+)|\[\s*(\w+)[^\]]*\])\s*=\s*(?:${CLOCK}\s*-\s*[\w$.]+|process\.hrtime\(\s*[\w$.]+\s*\))`, 'g'))) {
    const name = elapsed[1] || elapsed[2];
    const comparisons = new RegExp(`\\b${name}\\s*(?:[*/]\\s*[\\w$.]+\\s*)?[<>]=?|[<>]=?\\s*\\(*\\s*${name}\\b`, 'g');
    for (const match of text.matchAll(comparisons)) {
      report(text.slice(0, match.index).split('\n').length - 1, 'elapsed wall time is a pass condition');
    }
  }
  const promiseTimers = new Set();
  for (const match of text.matchAll(/\b(?:const|let|var)\s+(?:\{([^}]+)\}|([$\w]+))\s*=\s*require\(\s*(['"])(?:node:)?timers\/promises\3\s*\)/g)) {
    if (match[2]) promiseTimers.add(`${match[2]}.setTimeout`);
    else {
      const timer = /(?:^|,)\s*setTimeout(?:\s*:\s*([$\w]+))?\s*(?:,|$)/.exec(match[1]);
      if (timer) promiseTimers.add(timer[1] || 'setTimeout');
    }
  }
  for (const match of text.matchAll(/\b(?:const|let|var)\s+([$\w]+)\s*=\s*(?:[$\w]+\.)?promisify\(\s*setTimeout\s*\)/g)) {
    promiseTimers.add(match[1]);
  }
  for (const match of text.matchAll(/\bpromisify\(\s*setTimeout\s*\)\s*\(|\bscheduler\.wait\s*\(/g)) {
    const args = callArguments(text, match.index + match[0].lastIndexOf('('));
    if (!hungBudget(args[0] || '', bindingsAt(match.index))) {
      report(text.slice(0, match.index).split('\n').length - 1, 'timer wait needs a signal or a wait-allow reason');
    }
  }
  // A synchronous sleep that polls inside a loop is a probe cadence: the loop
  // condition is the signal, and its bounds are checked below. A sleep on its
  // own lets time stand in for the signal.
  const loopBodies = loops(text);
  const polled = (position) => loopBodies.some((loop) => loop.from <= position && position < loop.to);
  for (const match of text.matchAll(/\bAtomics\.wait\s*\(/g)) {
    const args = callArguments(text, match.index + match[0].lastIndexOf('('));
    // Without a timeout the call waits for a notification, which is a signal.
    if (args.length < 4 || hungBudget(args[3], bindingsAt(match.index)) || polled(match.index)) continue;
    report(text.slice(0, match.index).split('\n').length - 1, 'sleep needs a signal or a wait-allow reason');
  }
  for (const match of text.matchAll(/\b(?:spawnSync|execSync|execFileSync|spawn|exec|execFile)\s*\(\s*(['"`])sleep\b/g)) {
    if (!polled(match.index)) report(text.slice(0, match.index).split('\n').length - 1, 'sleep needs a signal or a wait-allow reason');
  }
  // A sleep the shell runs: a command string, or a script after sh -c.
  const scripts = new RegExp(String.raw`\b(?:(?:spawnSync|execFileSync|spawn|execFile)\s*\(\s*${SHELL}|(?:execSync|exec)\s*\(\s*)(['"\`])((?:\\[\s\S]|(?!\3)[^\\])*)\3`, 'g');
  for (const match of text.matchAll(scripts)) {
    if (!(match[1] === undefined && /^sleep\b/.test(match[4])) && shellBareSleep(shellText(match[4])) && !polled(match.index)) {
      report(text.slice(0, match.index).split('\n').length - 1, 'sleep needs a signal or a wait-allow reason');
    }
  }
  // A counted loop that sleeps is a deadline in disguise, unless each sleep
  // carries its own reason (paced work, a staggered race).
  const lineOf = (position) => text.slice(0, position).split('\n').length - 1;
  const helpers = [...loopBodies.helpers].map(escaped);
  const sleepCall = new RegExp(SLEEP_CALL.source + (helpers.length ? String.raw`|(?<![\w$.])(?:${helpers.join('|')})\s*\(` : ''), 'g');
  for (const loop of loopBodies) {
    if (!loop.bounded) continue;
    const sleeps = [...text.slice(loop.from, loop.to).matchAll(sleepCall)];
    if (sleeps.some((sleep) => !allowed(lines[lineOf(loop.from + sleep.index)]))) {
      report(lineOf(loop.start), 'an iteration count bounds a sleep loop');
    }
  }
  // The same in a shell script a test writes.
  for (const at of new Set(loopBodies.shell)) report(lineOf(at), 'an iteration count bounds a sleep loop');
  const promisePositions = new Set();
  for (const timer of promiseTimers) {
    const escaped = timer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of text.matchAll(new RegExp(`(?<![\\w$])${escaped}\\s*\\(`, 'g'))) {
      const args = callArguments(text, match.index + match[0].lastIndexOf('('));
      promisePositions.add(match.index + timer.lastIndexOf('.') + 1);
      if (!hungBudget(args[0] || '', bindingsAt(match.index))) {
        report(text.slice(0, match.index).split('\n').length - 1, 'timer wait needs a signal or a wait-allow reason');
      }
    }
  }
  for (const match of text.matchAll(/\b(setTimeout|until|waitFor\w*|waitUntil|waitOnRepo|fileWritten|eventAppended|childExit|childClosed|portListening)\s*\(/g)) {
    if (promisePositions.has(match.index)) continue;
    const bindings = bindingsAt(match.index);
    const index = text.slice(0, match.index).split('\n').length - 1;
    if (/^\s*\/\//.test(lines[index])) continue;
    const args = callArguments(text, match.index + match[0].lastIndexOf('('));
    if (match[1] === 'setTimeout') {
      if (!hungBudget(args[1] || '', bindings)) report(index, 'timer wait needs a signal or a wait-allow reason');
    } else {
      for (const arg of args.slice(1)) {
        const normalized = normalizedBudget(arg);
        const value = /^\w+\s*=\s*([\s\S]+)$/.exec(normalized)?.[1] || normalized;
        if (budgetExpression(arg, bindings) && !hungBudget(value, bindings)) {
          report(index, 'wait supplies a fixed readiness budget');
        }
        for (const option of arg.matchAll(/\b(?:ms|timeout|timeoutMs)\s*:\s*([^,}]+)/g)) {
          if (!hungBudget(option[1].trim())) report(index, 'wait options supply a fixed readiness budget');
        }
      }
    }
  }
  for (const match of text.matchAll(/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|test|describe|before|after|beforeEach|afterEach)\s*\(/g)) {
    const start = match.index + match[0].lastIndexOf('(');
    const args = callArguments(text, start);
    const options = ['test', 'describe'].includes(match[1]) ? args.slice(1, 2) : args;
    for (const arg of options.filter((value) => value.startsWith('{'))) {
      const from = text.indexOf(arg, start);
      for (const budget of arg.matchAll(/\btimeout\s*:\s*(Math\.max\([^)]*\)|[^,}]+)/g)) {
        if (!hungBudget(budget[1].trim())) {
          const index = text.slice(0, from + budget.index).split('\n').length - 1;
          report(index, 'subprocess or test watchdog below the hung-test timeout');
        }
      }
    }
  }
  return findings;
}

// A test that signals a pid it read from a file or an event signals its own
// process group when the read finds the file not yet written: Number('') is
// 0. Only a process signalling itself may call process.kill directly; every
// other pid goes through killPid or killGroup in test/signals.js, which
// refuse anything that is not a process id. An alias of process.kill
// (`const kill = process.kill`, `process['kill']`, `process.kill.call`) or of
// process itself reaches the same call with a pid this check cannot see, so it
// counts too. Generated fixture scripts in strings and templates are checked too.
//
// `child.process` is another object's member, not this process, while
// `global.process`, `globalThis?.process` and a spread `...process` are. A `\n`
// escape in a generated script ends a line.
const GLOBAL = String.raw`(?:global(?:This)?\s*\??\.\s*)?`;
const PROCESS = String.raw`(?<!(?<!\\)[\w$]|(?<!(?:(?<!(?<!\\)[\w$])global(?:This)?\s*\??|\.\.))\.\s*)process`;
// Optional chaining reaches the same call: `process?.kill(0)`, `process.kill?.(0)`.
const KILL_CALL = new RegExp(String.raw`${PROCESS}\s*\??\.\s*kill\s*(?:\?\.\s*)?\(`, 'g');
// A computed member that spells out 'kill', or whose key the check cannot read.
const COMPUTED = String.raw`\s*(?:\?\.\s*)?\[\s*(?:(?<quote>['"\`])kill\k<quote>\s*\]|(?!['"]))`;
const KILL_ALIASES = [
  // A value assigned, passed or returned, as opposed to a call, a member, a
  // comparison, the interposer's own assignment or prose that names it.
  new RegExp(String.raw`(?<=(?:(?<![=!<>])=|[(,:?[]|=>|&&|\|\||\breturn)\s*${GLOBAL})${PROCESS}\s*\??\.\s*kill\b(?!\s*(?:\(|\?\.|\.|=|!=))`, 'g'),
  new RegExp(String.raw`${PROCESS}\s*\??\.\s*kill\s*\??\.\s*(?:call|apply|bind)\b`, 'g'),
  new RegExp(PROCESS + COMPUTED, 'g'),
  new RegExp(String.raw`\{[^{}]*\bkill\b[^{}]*\}\s*=\s*${GLOBAL}process\b(?!\s*[.[?])`, 'g'),
];
// `const p = process;` makes p.kill the same call.
const PROCESS_ALIAS = new RegExp(String.raw`\b(?:const|let|var)\s+([$A-Z_a-z][$\w]*)\s*=\s*${GLOBAL}process\s*(?=[;,)\n]|$)`, 'g');
// An argument of a comparing assertion or Object.is is compared, not called.
const COMPARED = /(?:\bassert(?:\s*\.\s*strict)?\s*\.\s*(?:equal|strictEqual|notEqual|notStrictEqual|deepEqual|deepStrictEqual|notDeepEqual|notDeepStrictEqual)|\bObject\s*\.\s*is)\s*\(\s*(?:[^(),;]*,\s*)?$/;
// Inside a string, a sentence has a word before the name; generated code has
// an operator, a delimiter or a keyword there.
const PROSE_WORD = /(?:^|[^$\w.\\])([$A-Z_a-z][$\w]*)\s*$/;
const KEYWORDS = new Set(['async', 'await', 'case', 'catch', 'class', 'const', 'default', 'delete', 'do', 'else', 'export',
  'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'switch',
  'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield']);
// A fixture that fakes a pid probe holds the original to forward every other
// call: `const kill = process.kill;` and, as the next statement, the
// replacement. Only that line may alias process.kill, and the alias may only
// forward the replacement's own, unchanged pid and signal from inside it.
const INTERPOSER = /\b(?:const|let|var)\s+([$A-Z_a-z][$\w]*)\s*=\s*(process\s*\.\s*kill)\s*;\s*process\s*\.\s*kill\s*=\s*function\b[^(]*\(\s*([$A-Z_a-z][$\w]*)\s*,\s*([$A-Z_a-z][$\w]*)\s*\)\s*\{/dg;

const escaped = (name) => name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

// The index of the bracket that closes the one at `from`, or from any other
// position, of the first bracket that closes an enclosing one. Literals and
// comments are tokens, so their braces do not count.
function closing(text, from, limit = text.length) {
  const opener = '{(['.includes(text[from]);
  let depth = 0;
  for (const token of scan(text.slice(0, limit), from)) {
    if (token.type !== 'punctuation') continue;
    if ('{(['.includes(token.value)) depth++;
    else if ('})]'.includes(token.value) && (opener ? --depth === 0 : --depth < 0)) return token.start;
  }
  return limit;
}

// Where an arrow function starting its body at `from` ends: its block, or the
// expression up to the first delimiter outside brackets.
function arrowEnd(text, from) {
  const body = text.slice(from).search(/\S/) + from;
  if (text[body] === '{') return closing(text, body);
  let depth = 0;
  for (const token of scan(text, body)) {
    if (token.type !== 'punctuation') continue;
    if ('{(['.includes(token.value)) depth++;
    else if ('})]'.includes(token.value) && --depth < 0) return token.start;
    else if (depth === 0 && [',', ';'].includes(token.value)) return token.start;
  }
  return text.length;
}

// The `${...}` span of a template that holds a position, as [start, end).
function interpolation(text, token, position) {
  let i = token.start + 1;
  while (i < Math.min(position, token.end)) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text.startsWith('${', i)) {
      const end = closing(text, i + 1, token.end);
      if (position < end) return [i + 2, end];
      i = end + 1;
      continue;
    }
    i++;
  }
  return null;
}

// The innermost token holding a position. An interpolation is code the test
// runs, so the search goes on inside it.
function tokenAt(text, tokens, position) {
  let token = tokens.find((t) => t.start <= position && position < t.end);
  while (token?.type === 'template') {
    const span = interpolation(text, token, position);
    if (!span) return token;
    token = tokenize(text.slice(0, span[1]), span[0]).find((t) => t.start <= position && position < t.end);
  }
  return token;
}

// The parameters of a list, split at its top-level commas.
function parameters(list) {
  const params = [''];
  let depth = 0;
  for (const char of list) {
    if ('{[('.includes(char)) depth++;
    else if ('}])'.includes(char)) depth--;
    if (char === ',' && depth === 0) params.push('');
    else params[params.length - 1] += char;
  }
  return params;
}

// Ranges where a function parameter or a nested declaration rebinds `name`
// between `from` and `to`, so a use there is another value. A match inside a
// comment or a literal (`literal`) rebinds nothing.
function rebound(text, name, from, to, own, literal = () => false) {
  const id = escaped(name);
  // A default value after `=` is a use, and a destructuring key before `:` names no binding.
  const binds = (list) => parameters(list).some((param) => new RegExp(String.raw`(?<![\w$.])${id}(?![\w$])(?!\s*:)`)
    .test(param.split(/=(?![=>])/)[0]));
  const ranges = [];
  const scope = text.slice(0, to);
  const code = (m) => !literal(from + m.index);
  for (const m of [...scope.slice(from).matchAll(/\b(function\b[^(]*|catch\s*|(?<![\w$.])(?!(?:if|for|while|switch|with|catch|function)\b)[$A-Z_a-z][$\w]*\s*)\(([^()]*)\)\s*\{/g)].filter(code)) {
    if (binds(m[2])) ranges.push([from + m.index, closing(text, from + m.index + m[0].length - 1)]);
  }
  for (const m of [...scope.slice(from).matchAll(new RegExp(String.raw`(?:\(([^()]*)\)|(?<![\w$.])(${id}))\s*=>`, 'g'))].filter(code)) {
    if (m[2] || binds(m[1])) ranges.push([from + m.index, arrowEnd(text, from + m.index + m[0].length)]);
  }
  for (const m of [...scope.slice(from).matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+${id}(?![\w$])`, 'g'))].filter(code)) {
    const at = from + m.index;
    if (!own.includes(at + m[0].length - name.length)) ranges.push([at, closing(text, at, to)]);
  }
  return ranges;
}

function killFindings(text, { interposer = false } = {}) {
  const findings = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const tokens = tokenize(text);
  const lineOf = (position) => text.slice(0, position).split('\n').length - 1;
  // A comment in the code, a `//` before the name on the same line of a
  // generated script, or a quoted sentence holds prose about process.kill.
  const prose = (position) => {
    if (/^\s*(?:\/\/|\*)/.test(lines[lineOf(position)])) return true;
    const token = tokenAt(text, tokens, position);
    if (!token) return false;
    if (token.type === 'comment') return true;
    if (token.type !== 'string' && token.type !== 'template') return false;
    const from = Math.max(token.start + 1, text.lastIndexOf('\n', position - 1) + 1);
    const fragment = text.slice(from, position);
    if (tokenize(fragment).some((t) => t.type === 'comment' && t.end === fragment.length)) return true;
    const word = PROSE_WORD.exec(fragment);
    return !!word && !KEYWORDS.has(word[1]);
  };
  const report = (position, what) => {
    const index = lineOf(position);
    findings.push({ line: index + 1, reason: `\`${lines[index].trim().slice(0, 80)}\` ${what}, so the pids it receives are not checked` });
  };
  const ownPid = (open, names) => names.includes(normalizedBudget(callArguments(text, open)[0] || ''));
  for (const match of text.matchAll(KILL_CALL)) {
    if (prose(match.index)) continue;
    const open = match.index + match[0].length - 1;
    if (!ownPid(open, ['process.pid'])) {
      const pid = normalizedBudget(callArguments(text, open)[0] || '');
      findings.push({ line: lineOf(match.index) + 1, reason: `process.kill(${pid}) signals a pid that is not checked` });
    }
  }
  const interposers = interposer ? [...text.matchAll(INTERPOSER)].map((match) => {
    const open = match.index + match[0].length - 1;
    const body = [open, closing(text, open)];
    const assign = String.raw`(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?![=>])`;
    const changed = (param) => {
      const p = escaped(param);
      return new RegExp([
        String.raw`(?<![\w$.])${p}\s*${assign}`, String.raw`(?:\+\+|--)\s*${p}(?![\w$])`, String.raw`(?<![\w$.])${p}\s*(?:\+\+|--)`,
        String.raw`\b(?:const|let|var)\s+${p}(?![\w$])`, String.raw`\bfor\s*\(\s*${p}\s+(?:of|in)\b`,
        // A destructuring assignment such as `[pid] = [0]` or `({ pid } = o)`.
        // A computed member such as `calls[pid] = signal` writes another object.
        String.raw`(?<![\w$\]]\s*)[[{][^;[\]{}]*?(?<![\w$.])${p}(?![\w$])[^;[\]{}]*?[\]}][\s\]}]*=(?![=>])`,
      ].join('|')).test(text.slice(body[0], body[1]));
    };
    // A sloppy-mode script changes a parameter through `arguments` too: by
    // an element write, an increment, or a call that writes its elements.
    const reassigned = [match[3], match[4]].some(changed)
      || new RegExp([String.raw`\barguments\s*\[[^\]]*\]\s*(?:${assign}|\+\+|--)`, String.raw`(?:\+\+|--)\s*arguments\s*\[`,
        String.raw`\b(?:Object\s*\.\s*(?:assign|defineProperty|defineProperties)|Reflect\s*\.\s*(?:set|defineProperty))\s*\(\s*arguments\b`,
        String.raw`\.\s*(?:splice|fill|copyWithin|reverse|sort|shift|unshift|pop|push)\s*\.\s*(?:call|apply)\s*\(\s*arguments\b`].join('|'))
        .test(text.slice(body[0], body[1]));
    // The alias is the same value in its whole block, above the declaration
    // too. A generated script holds its own blocks and ends at its closing backtick.
    const script = tokens.find((t) => t.type === 'template' && t.start < match.index && match.index < t.end);
    const base = script ? script.start + 1 : 0;
    const openers = [];
    for (const token of tokenize(text.slice(0, match.index), base)) {
      if (token.type !== 'punctuation') continue;
      if ('{(['.includes(token.value)) openers.push(token.start);
      else if ('})]'.includes(token.value)) openers.pop();
    }
    const literals = (script ? tokenize(text.slice(0, script.end - 1), base) : tokens)
      .filter((t) => ['comment', 'string', 'template', 'regex'].includes(t.type));
    return { alias: match[1], declared: match.indices[1][0], original: match.indices[2][0], params: [match[3], match[4]],
      body, reassigned, literals, scope: [openers.at(-1) ?? base, closing(text, match.index, script ? script.end - 1 : text.length)] };
  }) : [];
  const exempt = new Set(interposers.map((i) => i.original));
  for (const pattern of KILL_ALIASES) {
    for (const match of text.matchAll(pattern)) {
      if (exempt.has(match.index) || prose(match.index)) continue;
      // A global prefix belongs to the compared value, as in assert.equal(global.process.kill, k).
      const before = text.slice(Math.max(0, match.index - 200), match.index).replace(/\bglobal(?:This)?\s*\??\.\s*$/, '');
      if (COMPARED.test(before) && /^\s*[,)]/.test(text.slice(match.index + match[0].length))) continue;
      report(match.index, 'aliases process.kill');
    }
  }
  for (const alias of new Set([...text.matchAll(PROCESS_ALIAS)].map((m) => m[1]).filter((name) => name !== 'process'))) {
    const id = escaped(alias);
    for (const use of text.matchAll(new RegExp(String.raw`(?<![\w$.])${id}(?:\s*\??\.\s*kill\b(\s*(?:\?\.\s*)?\()?|${COMPUTED})`, 'g'))) {
      if (prose(use.index)) continue;
      if (use[1] && ownPid(use.index + use[0].length - 1, ['process.pid', `${alias}.pid`])) continue;
      report(use.index, `uses ${alias}, an alias of process, to reach process.kill`);
    }
  }
  // The held original is process.kill under another name: any use in its
  // scope but the interposer forwarding its own arguments signals a pid
  // nothing checked.
  for (const alias of new Set(interposers.map((i) => i.alias))) {
    const own = interposers.filter((i) => i.alias === alias);
    const id = escaped(alias);
    const shadows = own.flatMap((i) => rebound(text, alias, i.scope[0], i.scope[1], own.map((o) => o.declared),
      (position) => i.literals.some((t) => t.start <= position && position < t.end)));
    const inside = (ranges, position) => ranges.some(([from, to]) => from <= position && position < to);
    // A name that ends a string, as in 'kill', is text; one that begins a
    // generated script, as in `kill(0);`, is a use.
    for (const use of text.matchAll(new RegExp(String.raw`(?<![\w$.])${id}(?![\w$'"\`])`, 'g'))) {
      const owners = own.filter((i) => i.scope[0] <= use.index && use.index < i.scope[1]);
      if (!owners.length || owners.some((i) => i.declared === use.index)) continue;
      // An object key (`{ kill: x }`) names no binding; a ternary branch or a case label does.
      if (/[{,]\s*$/.test(text.slice(Math.max(0, use.index - 80), use.index)) && /^\s*:(?!:)/.test(text.slice(use.index + alias.length))) continue;
      if (inside(shadows, use.index) || prose(use.index)) continue;
      // An inner function with its own pid or signal forwards another value.
      const forwards = owners.some((i) => !i.reassigned && i.body[0] < use.index && use.index < i.body[1]
        && !inside(i.params.flatMap((param) => rebound(text, param, i.body[0] + 1, i.body[1], [])), use.index)
        && new RegExp(String.raw`^${id}\s*\.\s*call\s*\(\s*(?:this|process)\s*,\s*${escaped(i.params[0])}\s*,\s*${escaped(i.params[1])}\s*\)`).test(text.slice(use.index)));
      if (!forwards) report(use.index, `uses ${alias}, the held process.kill, other than to forward the interposer's own pid and signal`);
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

// These replace process.kill to fake what a pid probe observes or when a signal
// lands, and forward every other call to the original. Only their interposer
// declarations may alias it; see INTERPOSER.
const KILL_INTERPOSERS = new Set(['test/fixtures/hooks.js', 'test/fixtures/monitor-clock.js', 'test/fixtures/slow-group-kill.js', 'test/spawn-resume.test.js']);

function checkTestWaits(root) {
  const dir = path.join(root, 'test');
  if (!fs.existsSync(dir)) return;
  const findings = [];
  for (const name of fs.readdirSync(dir, { recursive: true })) {
    if (!name.endsWith('.js')) continue;
    const file = `test/${name.replaceAll('\\', '/')}`;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const finding of waitFindings(text)) {
      findings.push(`${file}:${finding.line} ${finding.reason}; use test/signals.js or // wait-allow: reason`);
    }
    // The checked helpers themselves are the one place a bare call belongs.
    if (file === 'test/signals.js') continue;
    for (const finding of killFindings(text, { interposer: KILL_INTERPOSERS.has(file) })) {
      findings.push(`${file}:${finding.line} ${finding.reason}; use killPid or killGroup from test/signals.js`);
    }
  }
  if (findings.length) throw new Error(findings.join('\n'));
}

module.exports = { waitFindings, killFindings, checkTestWaits };
