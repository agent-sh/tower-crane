'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const P = require('./processes');

const ROOT = path.resolve(__dirname, '..');

// Installs outside agent homes have their own lifetime. A snapshot's users
// live inside tool/, so rebuilding the rest of a home preserves these holds.
function snapshot(root) {
  return path.basename(root) === 'tool' && path.basename(path.dirname(path.dirname(root))) === 'homes';
}

function hold(root = ROOT, pid = process.pid) {
  if (!snapshot(root) || !pid) return () => {};
  const dir = path.join(root, '.users');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${pid}-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid, ...P.identity(pid) }), { flag: 'wx', mode: 0o600 });
  return () => fs.rmSync(file, { force: true });
}

function inUse(root) {
  // A prune can run before the caller has registered its hold.
  if (path.resolve(root) === ROOT) return true;
  const dir = path.join(root, '.users');
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  let live = false;
  for (const name of names) {
    const file = path.join(dir, name);
    let user;
    try { user = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') continue;
      // An incomplete or unreadable hold cannot prove the user has exited.
      live = true;
      continue;
    }
    if (P.processState(user) === 'exited') fs.rmSync(file, { force: true });
    else live = true;
  }
  return live;
}

function present() {
  return fs.existsSync(path.join(ROOT, 'bin', 'tower-crane.js')) && fs.existsSync(path.join(ROOT, 'lib'));
}

function inside(file) {
  const relative = path.relative(ROOT, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function missing(error) {
  if (error?.engineCodeMissing) return true;
  const text = typeof error === 'string' ? error : error?.message || '';
  if (/^gate not installed:/.test(text)) return true;
  const module = /Cannot find module ['"]([^'"]+)['"]/.exec(text)?.[1];
  if (!module) return false;
  if (path.isAbsolute(module)) return inside(module);
  const importer = error?.requireStack?.[0] || /Require stack:\s*\n-\s*([^\r\n]+)/.exec(text)?.[1];
  return module.startsWith('.') && !!importer && inside(path.resolve(path.dirname(importer), module));
}

function throwIfMissing(error) {
  if (missing(error)) throw Object.assign(new Error(typeof error === 'string' ? error : error.message),
    { engineCodeMissing: true, infrastructure_failure: true });
}

function requireFile(file) {
  if (!fs.existsSync(file)) throw Object.assign(new Error(`Cannot find module '${file}'`),
    { code: 'MODULE_NOT_FOUND', engineCodeMissing: true, infrastructure_failure: true });
}

module.exports = { hold, inUse, present, missing, throwIfMissing, requireFile };
