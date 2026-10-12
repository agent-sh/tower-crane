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
// declaration. Template interpolations use the same lexer recursively.
function tokenize(text, from = 0) {
  const tokens = [];
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
        type = /^(?:return|throw|case|yield|typeof|void|delete|new)$/.test(identifier[0]) ? 'keyword' : 'identifier';
        position += identifier[0].length;
      } else position++;
    }
    return { type, value: text.slice(start, position), start, end: position };
  };
  let previous = null;
  while (position < text.length) {
    const token = read(previous);
    if (!token) break;
    tokens.push(token);
    if (token.type !== 'comment') previous = token;
  }
  return tokens;
}

function callArguments(text, start) {
  const args = [];
  const stack = [')'];
  let from = start + 1;
  for (const token of tokenize(text, start).slice(1)) {
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
    if (token.type !== 'identifier') return undefined;
    if (bindings.has(token.value)) {
      const values = bindings.get(token.value).map((bound) => seen.has(bound) ? undefined
        : foldedBudget(bound.value, bound.bindings(), new Set([...seen, bound])));
      return values.length && values.every((number) => number === values[0]) ? values[0] : undefined;
    }
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
  for (const match of text.matchAll(/\b(?:Date|performance)\.now\(\)\s*-\s*[\w$.]+\s*\)*\s*[<>]=?|[<>]=?\s*\(*\s*(?:Date|performance)\.now\(\)\s*-\s*[\w$.]+/g)) {
    report(text.slice(0, match.index).split('\n').length - 1, 'elapsed wall time is a pass condition');
  }
  for (const match of text.matchAll(/(['"])--(timeout|test-timeout)\1\s*,\s*(['"])([\d.]+)\3/g)) {
    const budget = Number(match[4]) * (match[2] === 'timeout' ? 1000 : 1);
    if (budget > 0 && budget < HUNG_TEST_MS) {
      report(text.slice(0, match.index).split('\n').length - 1, 'CLI wait has a readiness budget below the hung-test timeout');
    }
  }
  // Assignments and var declarations create the same deadline as const/let.
  for (const match of text.matchAll(/\b[\w$.]+\s*=\s*(?:Date|performance)\.now\(\)\s*\+\s*/g)) {
    const index = text.slice(0, match.index).split('\n').length - 1;
    const { value } = expressionAt(match.index + match[0].length);
    if (!/^\s*\/\//.test(lines[index]) && !hungBudget(value, bindingsAt(match.index))) {
      report(index, 'readiness deadline below the hung-test timeout');
    }
  }
  for (const match of text.matchAll(/\b(?:Date|performance)\.now\(\)\s*[<>]=?\s*\(*\s*[\w$.]+\s*\+\s*/g)) {
    const { value } = expressionAt(match.index + match[0].length);
    if (!hungBudget(value, bindingsAt(match.index))) {
      report(text.slice(0, match.index).split('\n').length - 1, 'readiness deadline below the hung-test timeout');
    }
  }
  for (const match of text.matchAll(/\b[\w$.]+\s*\+\s*/g)) {
    const { value, end } = expressionAt(match.index + match[0].length);
    if (/^\s*\)*\s*[<>]=?\s*(?:Date|performance)\.now\(\)/.test(text.slice(end))
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
  for (const elapsed of text.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(?:Date|performance)\.now\(\)\s*-\s*\w+/g)) {
    const comparisons = new RegExp(`\\b${elapsed[1]}\\s*[<>]=?|[<>]=?\\s*\\(*\\s*${elapsed[1]}\\b`, 'g');
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

function checkTestWaits(root) {
  const dir = path.join(root, 'test');
  if (!fs.existsSync(dir)) return;
  const findings = [];
  for (const name of fs.readdirSync(dir, { recursive: true })) {
    if (!name.endsWith('.js')) continue;
    const file = `test/${name.replaceAll('\\', '/')}`;
    for (const finding of waitFindings(fs.readFileSync(path.join(root, file), 'utf8'))) {
      findings.push(`${file}:${finding.line} ${finding.reason}; use test/signals.js or // wait-allow: reason`);
    }
  }
  if (findings.length) throw new Error(findings.join('\n'));
}

module.exports = { waitFindings, checkTestWaits };
