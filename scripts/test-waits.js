'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HUNG_TEST_MS = 300000;
function allowed(line) {
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
    else if (line.slice(i, i + 2) === '//') {
      return /^\/\/\s*wait-allow:\s*\S.*$/.test(line.slice(i));
    }
  }
  return false;
}

// Read call arguments without splitting on commas in callbacks, strings or
// nested calls. This keeps multiline waits subject to the same rule.
function callArguments(text, start) {
  const args = [];
  const stack = [')'];
  let from = start + 1;
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (['"', "'", '`'].includes(char)) { quote = char; continue; }
    if ('([{'.includes(char)) stack.push({ '(': ')', '[': ']', '{': '}' }[char]);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) { args.push(text.slice(from, i).trim()); return args; }
    } else if (char === ',' && stack.length === 1) {
      args.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  return [];
}

function hungBudget(value, bindings = new Map(), seen = new Set()) {
  value = value.trim();
  if (value === 'HUNG_TEST_MS') return true;
  if (bindings.has(value) && !seen.has(value)) {
    return hungBudget(bindings.get(value), bindings, new Set([...seen, value]));
  }
  if (/^Math\.max\(/.test(value)) {
    return callArguments(value, value.indexOf('(')).some((arg) => hungBudget(arg, bindings, seen));
  }
  return Number(value.replaceAll('_', '')) >= HUNG_TEST_MS;
}

function budgetExpression(value, bindings, seen = new Set()) {
  value = value.trim();
  const defaultValue = /^(\w+)\s*=\s*([\s\S]+)$/.exec(value);
  if (defaultValue) {
    return budgetExpression(defaultValue[2], bindings, seen)
      || (/^(?:ms|timeout(?:Ms)?|budget|duration)$/i.test(defaultValue[1])
        && !/^['"`{[]/.test(defaultValue[2].trim()));
  }
  if (bindings.has(value) && !seen.has(value)) {
    const bound = bindings.get(value);
    return budgetExpression(bound, bindings, new Set([...seen, value]))
      || (/^(?:ms|timeout(?:Ms)?|budget|duration)$/i.test(value)
        && !/^['"`{[]|\bfunction\b|=>/.test(bound));
  }
  if (/^['"`{[]/.test(value) || /\bfunction\b|=>/.test(value)) return false;
  // Computed numbers are budgets too. Unknown expressions need an explicit
  // hung-guard minimum or a reason rather than being treated as nonnumeric.
  const expression = value.replace(/(['"`])(?:\\[\s\S]|(?!\1)[\s\S])*?\1/g, '');
  if (/^[\w$.]+\s*\(/.test(expression)
    && !/^(?:Math\.\w+|Number|parseInt|parseFloat)\s*\(/.test(expression)) return false;
  return /^[\s(]*[+-]?\s*\d/.test(expression)
    || /\b\d[\d_]*(?:e[+-]?\d+)?\b/i.test(expression)
    || /^(?:Math\.\w+|Number|parseInt|parseFloat)\s*\(/.test(expression)
    || /[\w$.()]+\s*[-+*/%]\s*[\w$.()]+/.test(expression)
    || /^(?:HUNG_TEST_MS|ms|timeout(?:Ms)?|budget|duration)$/i.test(expression)
    || /\b[\w$.]+_(?:MS|TIMEOUT|BUDGET|DURATION)\b/.test(expression);
}

function waitFindings(text) {
  const findings = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const bindings = new Map([...text.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*([^;]+)/g)]
    .map((match) => [match[1], match[2].trim()]));
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
  // Deadline arithmetic also appears inside generated child scripts.
  for (const match of text.matchAll(/\b(?:const|let)\s+\w+\s*=\s*(?:Date|performance)\.now\(\)\s*\+\s*([^;\n]+)/g)) {
    const index = text.slice(0, match.index).split('\n').length - 1;
    if (!/^\s*\/\//.test(lines[index]) && !hungBudget(match[1].trim())) {
      report(index, 'readiness deadline below the hung-test timeout');
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
  for (const match of text.matchAll(/\b(setTimeout|until|waitFor\w*|waitUntil)\s*\(/g)) {
    const index = text.slice(0, match.index).split('\n').length - 1;
    if (/^\s*\/\//.test(lines[index])) continue;
    const args = callArguments(text, match.index + match[0].lastIndexOf('('));
    if (match[1] === 'setTimeout') {
      if (!hungBudget(args[1] || '')) report(index, 'timer wait needs a signal or a wait-allow reason');
    } else {
      for (const arg of args.slice(1)) {
        const value = /^\w+\s*=\s*([\s\S]+)$/.exec(arg)?.[1] || arg;
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
