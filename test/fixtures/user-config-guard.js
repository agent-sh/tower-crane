'use strict';

// Fails any test process, or CLI a test runs, that resolves the user ladder
// file (TOWER_CRANE_CONFIG, else ~/.config/tower-crane/config.json) outside
// the fixture root: such a process reads the developer's real ladder, and on
// a CI runner whatever that home holds. test/run.js preloads it into every
// test file, test/helpers.js and test/gates/helpers.js load it for a file run
// on its own, and fixtures/account-home.js brings it into every CLI baseEnv
// starts.
//
// The roots are TC_USER_CONFIG_ROOTS (baseEnv passes the test process's roots
// to its children) or the test temp and live roots. lib/ladder.js calls its
// own userFile directly (readUser, resolve), so wrapping the export would miss
// those reads: the guard renames the function as the module compiles and
// declares a checking userFile in its place, which every caller then reaches.

const Module = require('node:module');
const path = require('node:path');
const { tempRoot, liveRoot } = require('../tmp-root');

const LADDER = path.join('lib', 'ladder.js');
const ROOTS_ENV = 'TC_USER_CONFIG_ROOTS';
const PATCHED = Symbol.for('tower-crane.user-config-guard');
const DECLARATION = 'function userFile(env = process.env) {';

function roots(env = process.env) {
  const given = env[ROOTS_ENV];
  return given ? given.split(path.delimiter).filter(Boolean) : [tempRoot(env), liveRoot(env)];
}

const found = [];
let reported = 0;

function check(file) {
  const resolved = path.resolve(file);
  const inside = roots().some((root) => {
    const rel = path.relative(path.resolve(root), resolved);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (inside) return file;
  const message = `a test resolved the user config outside the fixture root (${roots().join(', ')}): ${resolved}`;
  // Deep enough to reach the test that called lib/, past the lib frames.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  found.push(`${message}\n${stack.split('\n').slice(2).filter((line) => !line.includes('(node:')).join('\n')}`);
  throw new Error(message);
}

// Throws on violations not yet reported, so a process whose code caught the
// first throw (the board draws a broken ladder as an error) still fails.
function assertNoUserConfigLeaks() {
  const fresh = found.slice(reported);
  reported = found.length;
  if (fresh.length) throw new Error(fresh.join('\n'));
}

// The source keeps its line numbers, so stack traces still point at
// lib/ladder.js; the checking declaration goes after the last line.
function guardLadder(source, filename) {
  if (source.split(DECLARATION).length !== 2) {
    throw new Error(`${filename} must declare \`${DECLARATION}\` once for test/fixtures/user-config-guard.js; update the guard with it`);
  }
  return source.replace(DECLARATION, DECLARATION.replace('userFile', 'unguardedUserFile'))
    + `\n;function userFile(env = process.env) { return require(${JSON.stringify(__filename)}).check(unguardedUserFile(env)); }\n`;
}

if (!Module[PATCHED]) {
  Module[PATCHED] = true;
  const compile = Module.prototype._compile;
  Module.prototype._compile = function (content, filename, ...rest) {
    const source = typeof filename === 'string' && filename.endsWith(path.sep + LADDER) ? guardLadder(content, filename) : content;
    return compile.call(this, source, filename, ...rest);
  };

  // An exit check, not a node:test after hook: under --test-force-exit a root
  // after hook in a file with no node:test tests runs the child out of memory.
  // The runner fails a file whose process exits nonzero.
  process.once('exit', () => {
    try {
      assertNoUserConfigLeaks();
    } catch (error) {
      console.error(error.message);
      process.exitCode ||= 1;
    }
  });
}

module.exports = { ROOTS_ENV, roots, check, assertNoUserConfigLeaks };
