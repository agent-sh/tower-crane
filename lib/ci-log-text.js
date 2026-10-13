'use strict';

const { stripVTControlCharacters } = require('node:util');

// Logs reach both the worker's scratch and its terminal. Keep line breaks and tabs,
// but remove stray controls that the terminal-sequence parser leaves behind.
function cleanLog(text) {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

module.exports = { cleanLog };
