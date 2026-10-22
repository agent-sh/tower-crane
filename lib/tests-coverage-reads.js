'use strict';

// V8 cannot measure data. Record successful reads and read-capable opens beside
// its profiles, using the same inherited per-test directory for child processes.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const Coverage = require('./tests-coverage');

function install(dir, root) {
  const bases = Coverage.roots(root);
  const reads = new Set();
  const write = fs.writeFileSync;
  const realpath = fs.realpathSync;
  const inside = (file) => bases.some((base) => {
    const rel = path.relative(base, file);
    return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
      && !rel.split(path.sep).some((part) => part === '.git' || part === 'node_modules');
  });
  const record = (value) => {
    if (typeof value === 'number') return;
    let file;
    try {
      file = value instanceof URL ? fileURLToPath(value) : path.resolve(Buffer.isBuffer(value) ? value.toString() : value);
      if (Coverage.MEASURED.test(file) || !inside(file)) return;
      // Resolve symlinks before checking the boundary: an external target is not
      // repository data, even if the link lives in the checkout.
      file = realpath(file);
      if (!inside(file) || Coverage.MEASURED.test(file) || !fs.statSync(file).isFile()) return;
    } catch { return; }
    reads.add(pathToFileURL(file).href);
  };
  const readable = (flags) => typeof flags === 'number'
    ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== fs.constants.O_WRONLY
    : typeof flags === 'string' && (flags.startsWith('r') || flags.includes('+'));
  for (const name of ['readFileSync', 'openSync']) {
    const original = fs[name];
    fs[name] = function (...args) {
      const result = Reflect.apply(original, this, args);
      if (name === 'readFileSync' || readable(args[1] ?? 'r')) record(args[0]);
      return result;
    };
  }
  for (const name of ['readFile', 'open']) {
    const original = fs[name];
    fs[name] = function (...args) {
      const callback = args.at(-1);
      // Preserve Node's own argument validation for calls without a callback.
      if (typeof callback !== 'function') return Reflect.apply(original, this, args);
      const shouldRecord = name === 'readFile' || readable(typeof args[1] === 'function' ? 'r' : args[1] ?? 'r');
      const source = args[0];
      args[args.length - 1] = function (error, ...values) {
        if (!error && shouldRecord) record(source);
        return Reflect.apply(callback, this, [error, ...values]);
      };
      return Reflect.apply(original, this, args);
    };
  }
  for (const name of ['readFile', 'open']) {
    const original = fs.promises[name];
    fs.promises[name] = async function (...args) {
      const result = await Reflect.apply(original, this, args);
      if (name === 'readFile' || readable(args[1] ?? 'r')) record(args[0]);
      return result;
    };
  }
  // Named ESM imports of fs must see the same hooks as CommonJS callers.
  require('node:module').syncBuiltinESMExports();
  process.on('exit', () => {
    if (!reads.size) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      write(path.join(dir, `reads-${process.pid}-${require('node:crypto').randomUUID()}.json`),
        JSON.stringify({ reads: [...reads].sort() }));
    } catch (e) {
      process.stderr.write(`tower-crane: coverage reads: ${e.message}\n`);
    }
  });
}

module.exports = { install };
