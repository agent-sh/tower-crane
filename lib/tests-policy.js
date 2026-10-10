'use strict';

const { KINDS } = require('./state');
const MODES = ['prove', 'run-only', 'none'];

function settingError(key, value) {
  if (value == null) return null;
  if (key === 'map') return require('./tests-map').settingError(value);
  if (key === 'mode' && !MODES.includes(value)) return `must be ${MODES.join(', ')} or null`;
  if (key === 'expensive' && typeof value !== 'boolean') return 'must be true, false or null';
  if (key === 'by_kind') {
    if (typeof value !== 'object' || Array.isArray(value)
        || !Object.entries(value).every(([kind, mode]) => KINDS.includes(kind) && MODES.includes(mode))) {
      return `must be an object mapping task kinds (${KINDS.join(', ')}) to ${MODES.join(', ')}, or null`;
    }
  }
  return null;
}

function resolve(project, kind) {
  const tests = project.tests || {};
  for (const key of ['mode', 'by_kind', 'expensive', 'map']) {
    const error = settingError(key, Object.hasOwn(tests, key) ? tests[key] : null);
    if (error) return { error: `project.json tests.${key} ${error}` };
  }
  const override = tests.by_kind && Object.hasOwn(tests.by_kind, kind);
  const requested = override ? tests.by_kind[kind] : tests.mode ?? 'prove';
  const source = override ? `project.json tests.by_kind.${kind}` : tests.mode != null ? 'project.json tests.mode' : 'default policy';
  return { mode: requested, source, expensive: tests.expensive === true };
}

module.exports = { settingError, resolve };
