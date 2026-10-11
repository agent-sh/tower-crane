'use strict';

// Where gates build their detached worktrees and scratch. TOWER_CRANE_TMP overrides the
// project's gates.tmp_root, and the OS temporary directory is the default.
const os = require('node:os');
const path = require('node:path');

const FIELDS = ['tmp_root'];

function valid(value) {
  return typeof value === 'string' && value.trim() !== '' && !value.includes('\0') && path.isAbsolute(value.trim());
}

function errors(gates) {
  return gates?.tmp_root != null && !valid(gates.tmp_root)
    ? ['project.json gates.tmp_root must be an absolute directory path or null'] : [];
}

// The root and the setting that chose it: TOWER_CRANE_TMP, then gates.tmp_root, then the system directory.
function resolve(project, env = process.env) {
  if (env.TOWER_CRANE_TMP) return { root: env.TOWER_CRANE_TMP, source: 'TOWER_CRANE_TMP' };
  if (project?.gates?.tmp_root) return { root: project.gates.tmp_root, source: 'gates.tmp_root' };
  return { root: os.tmpdir(), source: 'system' };
}

function root(project, env = process.env) {
  return resolve(project, env).root;
}

module.exports = { FIELDS, valid, errors, resolve, root };
