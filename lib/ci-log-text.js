'use strict';

const { stripVTControlCharacters } = require('node:util');

// Logs reach both the worker's scratch and its terminal. Keep line breaks and tabs,
// but remove stray controls that the terminal-sequence parser leaves behind.
function cleanLog(text) {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

// Check output is JSON, so its escaped controls become raw only after decoding.
function cleanOutput(value) {
  if (typeof value === 'string') return cleanLog(value);
  if (Array.isArray(value)) return value.map(cleanOutput);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanOutput(item)]));
  }
  return value;
}

module.exports = { cleanLog, cleanOutput };
