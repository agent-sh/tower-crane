'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const mode = process.env.TOWER_CRANE_TEST_UPSTREAM_PROBE_CASE;

if (path.resolve(process.argv[1] || '') !== __filename) {
  const execFile = cp.execFile;
  cp.execFile = function probeHarness(file, args, options, callback) {
    if (file === 'tc-test-fake-probe-claude') {
      return execFile.call(this, process.execPath, [__filename, ...args],
        { ...options, env: require('../agent-env').fakeAgentEnv(options.env) }, callback);
    }
    return execFile.call(this, file, args, options, callback);
  };
  if (path.basename(process.argv[1] || '') === 'probe-anthropic-upstream.js') {
    // A broken local-only selection must never read an owner's credential.
    const credentials = require('../../lib/credentials');
    const check = credentials.check;
    credentials.check = (name, options) => {
      assert.ok(name.startsWith('tc-test-fake-'), 'the fixture permits only fake credentials');
      return check(name, options);
    };
    if (mode === 'broker-start-failure') {
      require('../../lib/bedrock-broker').start = async () => { throw new Error('tc-test-fake broker startup failure'); };
    }
    if (mode === 'setup-write-failure') {
      const write = fs.writeFileSync;
      fs.writeFileSync = function probeSetup(file, ...args) {
        if (path.basename(file) === 'settings.json') throw new Error('tc-test-fake setup failure');
        return write.call(this, file, ...args);
      };
    }
  }
} else {
  async function reply() {
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'tower-crane-placeholder');
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']) {
      assert.equal(process.env[name], undefined, `${name} must stay out of the client`);
    }
    assert.match(process.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/[\w-]+$/);
    const args = process.argv.slice(2);
    assert.equal(args[args.indexOf('--max-turns') + 1], '1');
    assert.equal(args[args.indexOf('--tools') + 1], '');
    const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', {
      method: 'POST',
      headers: { authorization: 'Bearer tower-crane-placeholder', 'x-api-key': 'tc-test-fake-client', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL, messages: [{ role: 'user', content: 'Reply OK.' }], stream: true }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes('"text":"OK"'), 'the probe must return its local text block');
    assert.ok(body.includes('event: message_stop'), 'the local stream must finish');
    if (mode === 'malformed-json') return process.stdout.write('tc-test-fake malformed result\n');
    process.stdout.write(JSON.stringify({ subtype: 'success', is_error: mode === 'provider-error',
      result: mode === 'wrong-reply' || mode === 'provider-error' ? 'NO' : 'OK' }) + '\n');
    if (mode === 'process-failure') process.exitCode = 1;
  }
  reply().catch(() => { console.error('tc-test-fake probe harness failed'); process.exitCode = 1; });
}
