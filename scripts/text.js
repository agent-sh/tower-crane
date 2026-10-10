'use strict';

const fs = require('node:fs');

const normalizeText = (text) => text.replace(/\r\n?/g, '\n');
const readText = (file) => normalizeText(fs.readFileSync(file, 'utf8'));
const escapeTableCell = (text) => text.replace(/[\\|]/g, '\\$&');

module.exports = { normalizeText, readText, escapeTableCell };
