'use strict';

// Fails any test process, or CLI a test runs, that resolves the user ladder
// file (TOWER_CRANE_CONFIG, else ~/.config/tower-crane/config.json) outside
// the fixture root: such a process reads the developer's real ladder, and on
// a CI runner whatever that home holds. test/run.js preloads it into every
// test file, test/helpers.js loads it too for a file run on its own, and
// fixtures/account-home.js brings it into every CLI baseEnv starts.
//
// The roots are TC_USER_CONFIG_ROOTS (baseEnv passes the test process's roots
// to its children) or the test temp and live roots. lib/ladder.js resolves the
// default path from os.homedir() alone, so its os module reports each default
// it resolves here, and its exported userFile and readUser report the path
// every other module and every explicit TOWER_CRANE_CONFIG resolves to.

const Module = require('node:module');
const path = require('node:path');
const { tempRoot, liveRoot } = require('../tmp-root');

const LADDER = path.join('lib', 'ladder.js');
const ROOTS_ENV = 'TC_USER_CONFIG_ROOTS';
const PATCHED = Symbol.for('tower-crane.user-config-guard');

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
  if (inside) return;
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

if (!Module[PATCHED]) {
  Module[PATCHED] = true;
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    const mod = load.call(this, request, parent, ...rest);
    if ((request === 'node:os' || request === 'os') && parent?.filename?.endsWith(path.sep + LADDER)) {
      return {
        ...mod,
        homedir() {
          const home = mod.homedir();
          check(path.join(home, '.config', 'tower-crane', 'config.json'));
          return home;
        },
      };
    }
    if (mod && typeof mod.userFile === 'function' && typeof mod.readUser === 'function' && !mod[PATCHED]) {
      let file;
      try { file = Module._resolveFilename(request, parent); } catch { return mod; }
      if (!file.endsWith(path.sep + LADDER)) return mod;
      const { userFile, readUser } = mod;
      mod.userFile = (env = process.env) => {
        const resolved = userFile(env);
        check(resolved);
        return resolved;
      };
      mod.readUser = (env = process.env) => {
        mod.userFile(env);
        return readUser(env);
      };
      mod[PATCHED] = true;
    }
    return mod;
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

module.exports = { ROOTS_ENV, roots, assertNoUserConfigLeaks };
