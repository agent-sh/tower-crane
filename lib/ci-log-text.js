'use strict';

// One cleanup for every text that reaches a terminal, a prompt or the redaction patterns: CI logs,
// check output and gate output. It removes terminal escapes and then stray controls, keeping tabs
// and newlines. An escape or control inside a token hides it from the redaction patterns, so gates
// clean their output before redacting it.
//
// Escapes, in 7-bit and 8-bit (C1) forms: OSC strings (ESC ] or 0x9d, ended by BEL, ESC \ or 0x9c),
// DCS, SOS, PM and APC strings (ESC P, X, ^, _ or 0x90, 0x98, 0x9e, 0x9f, ended by ESC \ or 0x9c),
// CSI sequences (ESC [ or 0x9b) and two-character escapes such as a charset selection (ESC ( B).
// A string body stops at a newline or the next ESC, so an unterminated one cannot swallow later
// lines, and every scan ends within its line, which keeps the cleanup linear. An escape goes
// without a trace, as on a terminal, so a color change inside a token joins it back together.
const TERMINAL_ESCAPE = new RegExp([
  '(?:\\x1b\\]|\\x9d)[^\\x07\\x1b\\x9c\\n]*(?:\\x07|\\x1b\\\\|\\x9c)?',
  '(?:\\x1b[PX^_]|[\\x90\\x98\\x9e\\x9f])[^\\x1b\\x9c\\n]*(?:\\x1b\\\\|\\x9c)?',
  '(?:\\x1b\\[|\\x9b)[0-?]*[ -/]*[@-~]',
  '\\x1b[ -/]*[0-~]',
].join('|'), 'g');
// What is left: carriage returns, and every other C0 control except tab and newline, DEL and every
// C1 control, such as a lone ESC or an 8-bit introducer without a body.
const STRAY_CONTROL = /\r+\n?|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]+/g;
const WORD = /[A-Za-z0-9_]/;

// The redaction patterns find a token shape by its word boundaries, which a removed control must
// not take away: `Downloading\rghp_...` joined into one word would hide the token. A carriage
// return ends a line, as a progress bar's redraw does, and CRLF becomes LF. A run of other
// controls between two word characters becomes a space, and elsewhere it goes.
function stripEscapes(text) {
  return String(text ?? '').replace(TERMINAL_ESCAPE, '').replace(STRAY_CONTROL, (run, at, all) => {
    if (run[0] === '\r') return '\n';
    return WORD.test(all[at - 1] ?? '') && WORD.test(all[at + run.length] ?? '') ? ' ' : '';
  });
}

// Check output is JSON, so its escaped controls become raw only after decoding.
function cleanOutput(value) {
  if (typeof value === 'string') return stripEscapes(value);
  if (Array.isArray(value)) return value.map(cleanOutput);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanOutput(item)]));
  }
  return value;
}

module.exports = { stripEscapes, cleanOutput };
