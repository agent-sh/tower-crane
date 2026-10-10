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

function root(project, env = process.env) {
  return env.TOWER_CRANE_TMP || project?.gates?.tmp_root || os.tmpdir();
}

module.exports = { FIELDS, valid, errors, root };
