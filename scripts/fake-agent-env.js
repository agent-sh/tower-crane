'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tokenize, callArguments } = require('./test-waits');
const MISSING_ENV = 'a CLI-running fake agent must build its env with fakeAgentEnv (test/helpers.js or test/agent-env.js)';

function callsHelper(text) {
  const tokens = tokenize(text).filter((token) => token.type !== 'comment');
  return tokens.some((token, i) => token.type === 'identifier' && token.value === 'fakeAgentEnv' && tokens[i + 1]?.value === '(');
}

function helperEnvArgument(script, options) {
  if (callsHelper(options)) return true;
  const code = tokenize(script).filter((token) => !['comment', 'string', 'template'].includes(token.type)).map((token) => token.value).join(' ');
  for (const match of code.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*([^;]+)/g)) {
    if (!callsHelper(match[2])) continue;
    const name = match[1];
    if (new RegExp(`\\benv\\s*:\\s*${name}\\b`).test(options)
      || name === 'env' && /\{\s*env\s*[,}]/.test(options)) return true;
  }
  return false;
}

// Generated workers live in literals; ordinary CLI probes in test code already
// get the account preload from helpers.run or the fixture's base environment.
function fakeAgentEnvFindings(text, fixture = false) {
  if (fixture && /STUB_RUN/.test(text) && /spawnSync\s*\(\s*argv\s*\[\s*0\s*\]/.test(text) && !callsHelper(text)) {
    return [MISSING_ENV];
  }
  const scripts = fixture ? [text] : tokenize(text)
    .filter((token) => ['string', 'template'].includes(token.type))
    .filter((token) => /(?:execFile|spawn).*(?:process\.execPath|command)/s.test(token.value))
    .map((token) => token.type === 'string' ? vm.runInNewContext(token.value) : token.value.slice(1, -1));
  const missing = scripts.flatMap((script) => [...script.matchAll(/\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*(?:process\.execPath|command)\s*,/g)]
    .filter((match) => {
      const args = callArguments(script, match.index + match[0].indexOf('('));
      return /\b(?:BIN|bin|cli)\b|tower-crane\.js|process\.argv\[\d+\]/.test(args[1] || '')
        && !/^\[\s*['"]-e['"]/.test(args[1] || '')
        && !helperEnvArgument(script, args[2] || '');
    }));
  if (!missing.length) return [];
  // A fixture may instead give the preload to the agent through its configured
  // rung or project env, or through a harness adapter's spawn options.
  const code = tokenize(text).filter((token) => !['comment', 'string', 'template'].includes(token.type)).map((token) => token.value).join(' ');
  const launchEnv = /JSON\s*\.\s*stringify\s*\(\s*fakeAgentEnv\s*\(/.test(code)
    || /options\s*=\s*\{[^;]*\benv\s*:[^;]*\bfakeAgentEnv\s*\(/.test(code);
  return launchEnv ? [] : [MISSING_ENV];
}

function checkFakeAgentEnvs(root) {
  const dir = path.join(root, 'test');
  if (!fs.existsSync(dir)) return;
  const findings = [];
  for (const name of fs.readdirSync(dir, { recursive: true })) {
    if (!name.endsWith('.js') || name === 'helpers.js') continue;
    const file = `test/${name.replaceAll('\\', '/')}`;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const finding of fakeAgentEnvFindings(text, file.startsWith('test/fixtures/'))) {
      findings.push(`${file}: ${finding}`);
    }
  }
  if (findings.length) throw new Error(findings.join('\n'));
}

module.exports = { fakeAgentEnvFindings, checkFakeAgentEnvs };
