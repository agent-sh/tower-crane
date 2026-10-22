'use strict';

// Reads a credential from the OS store for a harness that runs this as its
// own command, outside its command sandbox: codex's provider auth command,
// claude's apiKeyHelper, and the Bedrock broker (lib/bedrock-broker.js).
//
// usage: node credential-helper.js value NAME [--config FILE]
//        node credential-helper.js check NAME [--config FILE]
//
// value prints the value on stdout and nothing else. check prints nothing
// on stdout and answers with its exit status: 0 when the value can be read.
// Both exit 1 with a message on stderr that names the stores and the fix,
// never the value: codex and claude copy the helper's stderr into their own
// error output. --config names the user file, since the harness runs this
// with the agent's HOME.

const Credentials = require('./credentials');

function main(argv) {
  const [op, name, ...rest] = argv;
  let file;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--config' && rest[i + 1] !== undefined) file = rest[++i];
    else return fail(`unknown argument ${JSON.stringify(rest[i]).slice(0, 40)}`);
  }
  if (!['value', 'check'].includes(op) || !name) return fail('usage: credential-helper.js value|check NAME [--config FILE]');
  let found;
  try {
    found = Credentials.read(name, { env: process.env, ...(file ? { file } : {}) });
  } catch (e) {
    return fail(e.message);
  }
  if (op === 'value') process.stdout.write(found.value);
  return 0;
}

function fail(message) {
  process.stderr.write(`${message.startsWith('tower-crane') ? '' : 'tower-crane credential helper: '}${message}\n`);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
