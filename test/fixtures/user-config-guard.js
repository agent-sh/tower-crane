'use strict';

// Fails any test process, or CLI a test runs, that resolves the user ladder
// file (TOWER_CRANE_CONFIG, else ~/.config/tower-crane/config.json) outside
// the fixture root: such a process reads the developer's real ladder, and on
// a CI runner whatever that home holds. test/run.js preloads it into every
// test file, test/helpers.js and test/gates/helpers.js load it for a file run
// on its own, and fixtures/account-home.js brings it into every CLI baseEnv
// starts.
//
// The roots are fixed when the guard loads: TC_USER_CONFIG_ROOTS when a parent
// passed them, else the test temp and live roots of that moment. Gate tests
// move TOWER_CRANE_TMP, which tempRoot prefers, after placing their fixture
// user file; roots read at each check would shrink to that subdirectory.
// The guard puts them in process.env, so every child gets the same ones.
//
// lib/ladder.js calls its own userFile directly (readUser, resolve), so
// wrapping the export would miss those reads: the guard renames the function
// as this checkout's lib/ladder.js compiles and declares a checking userFile
// in its place, which every caller then reaches.
//
// A CLI may exit nonzero by design, or run detached, so its own exit code
// does not prove a leak was seen. Every process appends what it finds to the
// hits file of the test process that owns it (TC_USER_CONFIG_HITS): fixture
// cleanup fails the test whose fixture made the call, and the test file
// fails at exit on any hit left.

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { tempRoot, liveRoot } = require('../tmp-root');

const ROOTS_ENV = 'TC_USER_CONFIG_ROOTS';
const HITS_ENV = 'TC_USER_CONFIG_HITS';
const PATCHED = Symbol.for('tower-crane.user-config-guard');
const DECLARATION = 'function userFile(env = process.env) {';
const LADDER = path.join(path.dirname(path.dirname(__dirname)), 'lib', 'ladder.js');

const ROOTS = process.env[ROOTS_ENV]
  ? process.env[ROOTS_ENV].split(path.delimiter).filter(Boolean)
  : [tempRoot(), liveRoot()].map((root) => path.resolve(root));
process.env[ROOTS_ENV] = ROOTS.join(path.delimiter);

// A test file, or a process no test file started, owns a hits file; a CLI
// appends to the one its test process passed down.
const OWNER = !!process.env.NODE_TEST_CONTEXT || !process.env[HITS_ENV];
if (OWNER) {
  process.env[HITS_ENV] = path.join(ROOTS[0], `tower-crane-user-config-hits-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
}
const HITS = process.env[HITS_ENV];

function roots() {
  return ROOTS;
}

const inside = (root, p) => {
  if (typeof p !== 'string') return false;
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const ownHits = [];
function check(file) {
  if (ROOTS.some((root) => inside(root, file))) return file;
  const resolved = path.resolve(file);
  const message = `a test resolved the user config outside the fixture root (${ROOTS.join(', ')}): ${resolved}`;
  // Deep enough to reach the test that called lib/, past the lib frames.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  const hit = { message, cwd: process.cwd(), home: process.env.TC_ACCOUNT_HOME, pid: process.pid,
    stack: stack.split('\n').slice(2).filter((line) => !line.includes('(node:')).join('\n') };
  ownHits.push(message);
  fs.mkdirSync(path.dirname(HITS), { recursive: true });
  fs.appendFileSync(HITS, JSON.stringify(hit) + '\n');
  throw new Error(message);
}

const reported = new Set();
// Throws on hits not yet reported: with `base`, only those a process in that
// fixture made (by working directory or account home), so the test that owns
// the fixture fails; without it, every one left.
function assertNoUserConfigLeaks(base) {
  if (!OWNER) return;
  let text;
  // read-published: processes append hits; nothing replaces the file.
  try { text = fs.readFileSync(HITS, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  // A line still being written has no newline yet; the next check reads it.
  const found = text.split('\n').slice(0, -1).map((line, i) => ({ i, hit: JSON.parse(line) }))
    .filter(({ i, hit }) => !reported.has(i) && (!base || base === hit.cwd || inside(base, hit.cwd) || inside(base, hit.home)));
  for (const { i } of found) reported.add(i);
  if (found.length) throw new Error(found.map(({ hit }) => `${hit.message}\n(pid ${hit.pid}, cwd ${hit.cwd})\n${hit.stack}`).join('\n'));
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
  // Module filenames are real paths; a checkout reached through a link still matches.
  let ladder = LADDER;
  try { ladder = fs.realpathSync.native(LADDER); } catch {}
  const compile = Module.prototype._compile;
  Module.prototype._compile = function (content, filename, ...rest) {
    const source = filename === ladder || filename === LADDER ? guardLadder(content, filename) : content;
    return compile.call(this, source, filename, ...rest);
  };

  // An exit check, not a node:test after hook: under --test-force-exit a root
  // after hook in a file with no node:test tests runs the child out of memory.
  // The runner fails a file whose process exits nonzero.
  process.once('exit', () => {
    try {
      if (OWNER) assertNoUserConfigLeaks();
      else if (ownHits.length) throw new Error(ownHits.join('\n'));
    } catch (error) {
      console.error(error.message);
      process.exitCode ||= 1;
    } finally {
      if (OWNER) fs.rmSync(HITS, { force: true });
    }
  });
}

module.exports = { ROOTS_ENV, HITS_ENV, roots, check, assertNoUserConfigLeaks };
