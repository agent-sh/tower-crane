'use strict';

// What local CI saves and how it chooses: redaction of GitHub CI logs, binary
// artifacts, escape and line-break splits, environment values, headers and
// token shapes; receipts and their copies; run retention; kind variants and task
// overrides; and the merged tree it runs on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeRepo } = require('./helpers');
const { changeKind } = require('./gate-helpers');
const { fixture, mergeFixture } = require('./local-ci-helpers');
const StateFiles = require('./state-files');

test('captured GitHub CI logs keep the redaction output from before the text budget', () => {
  const { createRedactor, redactJoined } = require('../lib/gates/common');
  // Captured logs pin the cleaned text, so the budget cannot silently drop normal output.
  const cases = [
    ['gate-scratch-etimedout.log', 'b674f8053b2eb0cd567805836a984d8a719224ae00a94fb5f92e84db3c760983'],
    ['gate-scratch-leak.log', '0334cf4e39e42c7c8c9d4f637d71de2d6228394c3d37153e7c6daf6cd696f3fb'],
    ['model-swap-timeout.log', '4ae01c709d2eab64279c403a90369d284f5dd8f0f5d2c5880fbe802ed49b42b2'],
  ];
  for (const [file, expected] of cases) {
    const output = fs.readFileSync(path.join(__dirname, 'fixtures', 'proof-logs', file), 'utf8');
    const clean = redactJoined({ output }, createRedactor([]));
    assert.equal(crypto.createHash('sha256').update(clean).digest('hex'), expected, file);
  }
});

test('local CI saves only a notice for unscannable logs and text artifacts', (t) => {
  // Each start of the value explores hundreds of escape readings, past the work its length allows.
  const h = fixture(t, `
const fs = require('node:fs');
const text = ('a\\x1b[' + '1'.repeat(1024) + 'm ').repeat(1024);
fs.writeFileSync('dense.txt', text);
process.stdout.write(text);
process.exitCode = 1;
`);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: h.command, timeout: 30, artifacts: ['dense.txt'] })]);
  const result = h.run(['check', 'ci', 'T1'], { env: { FIXTURE_TOKEN: 'a123456789bcdefghijk0' } });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const kept = h.readState('tasks.json').tasks[0].evidence.at(-1).local_ci;
  assert.ok(kept, result.stdout + result.stderr);
  const notice = /^\[unscannable text: .+; content omitted\]$/;
  assert.match(fs.readFileSync(path.join(h.state, kept.log), 'utf8'), notice);
  assert.match(kept.output_tail, notice);
  assert.equal(kept.artifacts.length, 1);
  assert.match(fs.readFileSync(path.join(h.state, kept.artifacts[0].path), 'utf8'), notice);
});

test('a removed control keeps the word boundary token shapes are found by', () => {
  const { stripEscapes, createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  const github = `ghp_${'d4'.repeat(18)}`;
  const aws = `AKIA${'E5'.repeat(8)}`;
  for (const [input, expected] of [
    // Joined, the controls inside a token would hide it; split at them, a boundary would.
    [`${github.slice(0, 8)}\x1b\x7f${github.slice(8)}`, '[redacted:GITHUB_TOKEN]'],
    [`Downloading\r${github}`, 'Downloading\n[redacted:GITHUB_TOKEN]'],
    [`${aws}\rDONE`, '[redacted:AWS_ACCESS_KEY_ID]\nDONE'],
    [`x\b${github}`, 'x [redacted:GITHUB_TOKEN]'],
    [`${aws}\x00DONE`, '[redacted:AWS_ACCESS_KEY_ID] DONE'],
  ]) assert.equal(redact(stripEscapes(input)), expected, JSON.stringify(input));
  // The token stays whole for the redactor, which labels an environment value by its variable.
  const env = createRedactor([['FIXTURE_TOKEN', github], ['PLAIN_SECRET', 'abcdefghij0123456789xyz']]);
  assert.equal(env(stripEscapes(`a ${github.slice(0, 8)}\x00${github.slice(8)}`)), 'a [redacted:FIXTURE_TOKEN]');
  // A value with no token shape stays whole when the redactor cleans the text: its controls go,
  // a carriage return included.
  assert.equal(env(env.strip('pre abcdefghij\x00012345\r6789xyz post')), 'pre [redacted:PLAIN_SECRET] post');
});

test('a token that escapes take part of and split, or that a line break splits, is redacted whole', () => {
  const { createRedactor } = require('../lib/gates/common');
  const github = 'ghp_Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2';
  const aws = `AKIA${'E5'.repeat(8)}`;
  const env = createRedactor([['FIXTURE_TOKEN', github]]);
  const plain = createRedactor([]);
  const head = github.slice(0, 8);
  const tail = github.slice(8);
  for (const [name, input, expected] of [
    // A terminal reads ESC g as one escape, so the cleanup loses the token's first character.
    ['a stray ESC takes the first character', `a \x1b${head}\x1b[1m${tail} b`, 'a [redacted:X] b'],
    ['a word before the stray ESC', `a\x1b${head}\x1b[1m${tail}`, 'a [redacted:X]'],
    ['ESC ( takes the first character', `\x1b(${head}\x1b[1m${tail}`, '[redacted:X]'],
    ['a charset escape splits it too', `\x1b${head}\x1b(B${tail}`, '[redacted:X]'],
    ['an unterminated OSC takes the head', `\x1b]0;title ${head}\x1b[1m${tail}\nnext`, '[redacted:X]\nnext'],
    ['a newline splits the token', `key ${github.slice(0, 10)}\n${github.slice(10)} done`, 'key [redacted:X] done'],
    ['CRLF splits the token', `key ${github.slice(0, 10)}\r\n${github.slice(10)} done`, 'key [redacted:X] done'],
    // A removed line break is a word boundary: the lines around the token do not glue onto it.
    ['a word line before a token split across lines', `token is\n${github.slice(0, 14)}\n${github.slice(14)} ok`, 'token is\n[redacted:X] ok'],
    ['a split token whose tail ends its line', `key ${github.slice(0, 10)}\n${github.slice(10)}\nnext`, 'key [redacted:X]\nnext'],
    // ESC [ right before a token reads as a CSI whose final byte is the token's first letter.
    ['ESC [ takes the first character', `x \x1b[${github} y`, 'x [redacted:X] y'],
    ['ESC [ takes the first character of a split token', `x \x1b[${head}\x1b[1m${tail} y`, 'x [redacted:X] y'],
    // Kept as they were: a token that ends its line keeps the next line's first word, a header
    // value ends at its line, and an escape's final byte after a token does not change its label.
    ['a token ends its line', `token ${github}\nnext line`, 'token [redacted:X]\nnext line'],
    ['a charset reset after the token', `\x1b[31m${github}\x1b(B\x1b[m`, '[redacted:X]'],
    ['a header value ends at its line', 'Authorization: Bearer abc\nAccept: */*', 'Authorization: Bearer [redacted:AUTHORIZATION]\nAccept: */*'],
    // A line break inside a token prefix joins with two of its characters before the break or
    // three after it: `s` then a line `K-...` is no API key.
    ['a one-letter word before a line `K-`', 'run 0.3 s\nK-long_async rc 1', 'run 0.3 s\nK-long_async rc 1'],
    ['a line break after a token\'s first letter', `xx ${github[0]}\n${github.slice(1)} y`, 'xx [redacted:X] y'],
    ['a line break inside a token prefix', `xx ${github.slice(0, 2)}\r\n${github.slice(2)}\nnext`, 'xx [redacted:X]\nnext'],
  ]) {
    assert.equal(env(env.strip(input)), expected.replaceAll('[redacted:X]', '[redacted:FIXTURE_TOKEN]'), name);
    assert.equal(plain(plain.strip(input)), expected.replaceAll('[redacted:X]', '[redacted:GITHUB_TOKEN]'), name);
  }
  // A fixed-length shape keeps its word boundary when it is joined back, with a line after it too.
  assert.equal(plain(plain.strip(`token is\n${aws[0]}\n${aws.slice(1)}\nnext`)), 'token is\n[redacted:AWS_ACCESS_KEY_ID]\nnext');
  // A token whose prefix a line break splits is not put back over another secret: its joined text
  // would cut an environment value an escape splits, or a token the cleaned text shows.
  const overlap = createRedactor([['MY_SECRET', 'Wx2Zq9Xw8Vu7Ts6']]);
  assert.equal(overlap(overlap.strip(`xx g\n${github.slice(1)}Zq9\x1b=Xw8Vu7Ts6 y`)), `xx g\n${github.slice(1, -3)}[redacted:MY_SECRET] y`);
  assert.equal(plain(plain.strip('id=xox\nb-l2SorrmC\n0FhbP-gho_3uN9vAEJTHvInLGgsXGIqgB5 y')), 'id=xox\nb-l2SorrmC\n0FhbP-[redacted:GITHUB_TOKEN] y');
  // Nor over a token or header a view recovers after an escape takes its first character.
  for (const [input, secret] of [
    [`x g\n${github.slice(1, 26)}\x1bsk-proj-abcdefghijklmnop ok`, 'abcdefghijklmnop'],
    [`x g\n${github.slice(1, 26)}\x1bxoxb-1234567890-abcdef ok`, '1234567890-abcdef'],
    [`log g\n${github.slice(1, 26)}\x1bAuthorization: Bearer s3cr3tvalue123 ok`, 's3cr3tvalue123'],
    ['AS\nIAPACIFIC\x1bAUTHORIZATION: Bearer test-value', 'test-value'],
  ]) assert.ok(!plain(plain.strip(input)).includes(secret), JSON.stringify(input));
  // Nor over a token the redactor finds once the environment value glued before it is redacted.
  const glued = createRedactor([['MY_SECRET', 'AGVCLyB0UqFWaWBjHoW2KwhAm1']]);
  assert.equal(glued(glued.strip('x AGVCLyB0UqFWaWBjHoW2KwhAm1ghs_QEXOi2e7ePqMbY\x1bAx0JI5\x1bghs\n_Dgm6eT6p3sOC76q8NN6NDZi2pLzL4XLEvA27RHpV\n')), 'x [redacted:MY_SECRET][redacted:GITHUB_TOKEN]\n_Dgm6eT6p3sOC76q8NN6NDZi2pLzL4XLEvA27RHpV\n');
  // The same with the value split by a line break or an escape, which the cleaned text does not show whole.
  for (const split of ['\n', '\x1b(']) {
    assert.equal(glued(glued.strip(`x AGVCLyB0Uq${split}FWaWBjHoW2KwhAm1ghs_QEXOi2e7ePqMbY\x1bAx0JI5\x1bghs\n_Dgm6eT6p3sOC76q8NN6NDZi2pLzL4XLEvA27RHpV\n`)), 'x [redacted:MY_SECRET] [redacted:GITHUB_TOKEN]\n_Dgm6eT6p3sOC76q8NN6NDZi2pLzL4XLEvA27RHpV\n', JSON.stringify(split));
  }
  // Two secrets put back next to each other keep one space between them.
  assert.equal(plain(plain.strip(`x g\n${github.slice(1, 26)}\x1bsk-proj-abcdefghijklmnop ok`)), 'x [redacted:GITHUB_TOKEN] [redacted:API_KEY] ok');
  // Split tokens next to each other go back apart, each from the view it was found in, so a
  // fixed-length shape does not take the next one's first character.
  assert.equal(plain(plain.strip('\n\nAK\nIA658PUUFDAL0P\n\x1b[31mR4\x1bXO\nAK\x1b[m\nIAKDXEI\rU3ZNV9O\x1bI3EQ=x')), '\n\n[redacted:AWS_ACCESS_KEY_ID] [redacted:AWS_ACCESS_KEY_ID]=x');
  // Two line breaks inside a prefix, or a blank line, join nothing.
  for (const input of [`x g\nh\np_${github.slice(4)}`, `x g\n\nhp_${github.slice(4)}`, 'run s\nk-means_clustering']) assert.equal(plain(plain.strip(input)), input);
  assert.equal(plain(plain.strip(`k=${aws.slice(0, 9)}\n${aws.slice(9)}\n`)), 'k=[redacted:AWS_ACCESS_KEY_ID]\n');
  assert.equal(plain(plain.strip(`id=${aws.slice(0, 9)}\n${aws.slice(9)}\nnext line`)), 'id=[redacted:AWS_ACCESS_KEY_ID]\nnext line');
  // An environment value is redacted however escapes and line breaks split it: here a stray ESC
  // takes one of its characters, a real two-character escape sits in it and a line break splits it.
  const value = 'Zq9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0';
  const values = createRedactor([['MY_SECRET', value]]);
  for (const input of [
    `v=${value[0]}\x1b${value.slice(1, 4)}\n${value.slice(4)} end`,
    `v=${value[0]}\x1bM${value.slice(1, 5)}\x1b(${value.slice(5)} end`,
    `v=${value.slice(0, 3)}\x1b7${value.slice(3, 9)}\r\n\x1b[1m${value.slice(9)} end`,
  ]) assert.equal(values(values.strip(input)), 'v=[redacted:MY_SECRET] end', JSON.stringify(input));
  // A join takes a bounded run: a short prefix before many lines of token characters takes a few
  // of them, not the rest of the text.
  const lines = `sk-ab\n${'cd\n'.repeat(20000)}`;
  const joined = plain(plain.strip(lines));
  assert.ok(joined.startsWith('[redacted:API_KEY]\ncd\n'), joined.slice(0, 40));
  assert.ok(joined.split('\n').length > 19990);
});

test('a binary artifact is redacted at its exact bytes, or missed when a secret shows only in another view', () => {
  const { createRedactor } = require('../lib/gates/common');
  const github = `ghp_${'d4'.repeat(18)}`;
  const aws = `AKIA${'E5'.repeat(8)}`;
  const value = 'p\u00e4ss-\u20ac-0123456789abcdefgh';
  const redact = createRedactor([['FIXTURE_PASSWORD', value]]);
  const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'))));
  const junk = Buffer.from([0xff, 0x00, 0xe9, 0x80, 0x1b]);
  const nul = Buffer.from([0xff, 0x00]);
  const every = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  for (const [input, expected] of [
    [bytes(junk, value, junk), bytes(junk, '[redacted:FIXTURE_PASSWORD]', junk)],
    [bytes(junk, github, junk), bytes(junk, '[redacted:GITHUB_TOKEN]', junk)],
    [bytes(junk, '"', github, '", "', aws, '"'), bytes(junk, '"[redacted:GITHUB_TOKEN]", "[redacted:AWS_ACCESS_KEY_ID]"')],
    [bytes('Authorization: Bearer ', junk, 'x y'), bytes('Authorization: Bearer [redacted:AUTHORIZATION] y')],
    [bytes(junk, '[redacted:GITHUB_TOKEN]', junk), bytes(junk, '[redacted:GITHUB_TOKEN]', junk)],
    // A token that ends its line, and a charset reset after a token, are redacted in place.
    [bytes(nul, github, '\nnext\n'), bytes(nul, '[redacted:GITHUB_TOKEN]\nnext\n')],
    [bytes(nul, `"${github}\x1b(B\x1b[m"`), bytes(nul, '"[redacted:GITHUB_TOKEN]\x1b(B\x1b[m"')],
    [bytes(nul, 'run 0.3 s\nK-long_async rc 1'), bytes(nul, 'run 0.3 s\nK-long_async rc 1')],
    [every, every],
  ]) {
    const out = redact.bytes(input);
    assert.equal(out.missed, undefined, input.toString('hex'));
    assert.deepEqual(out.body, expected, input.toString('hex'));
  }
  const utf16 = (text, big) => {
    const b = Buffer.from(text, 'utf16le');
    return big ? b.swap16() : b;
  };
  // Most of these show in the bytes once NULs and escapes go; a non-ASCII value needs a UTF-16 view.
  const ANY = /^a secret as /;
  for (const [name, input, view] of [
    // 0x90 and 0x98 bytes here are halves of characters, not 8-bit string introducers.
    ['an arrow before a UTF-16 token', utf16(`{"t": "\u2190 ${github}"}`), ANY],
    ['a CJK character before a UTF-16 token', utf16(`\u9019 ${github}`), ANY],
    ['a UTF-16BE token', utf16(`x ${github}`, true), ANY],
    ['a UTF-16 token at an odd offset', bytes(Buffer.from([0xff]), utf16(` ${github}`)), ANY],
    ['a color escape inside a UTF-16 token', utf16(`${github.slice(0, 8)}\x1b[32m${github.slice(8)}`), ANY],
    ['a non-ASCII environment value in UTF-16', utf16(`v=${value}`), /as UTF-16LE/],
    ['AWS key split by an escape', bytes(Buffer.from([0xff]), ` ${aws.slice(0, 8)}\x1b[1m${aws.slice(8)}\x00DONE`), ANY],
    ['a token tail after a carriage return', bytes(junk, `${github.slice(0, 26)}\r${github.slice(26)}`), ANY],
    ['a UTF-8 character with a 0x98 byte before a split token', bytes(junk, `\u662f ${github.slice(0, 8)}\x1b[1m${github.slice(8)}`), ANY],
    ['a split environment value', bytes(junk, `${value.slice(0, 5)}\r${value.slice(5)}`), ANY],
    // Escape removal takes a character from these tokens, so only a gentle view shows them whole.
    ['a stray ESC takes a split token\'s first character', bytes(nul, `\x1b${github.slice(0, 8)}\x1b[1m${github.slice(8)}`), /gently/],
    ['ESC ( takes a split token\'s first character', bytes(nul, `\x1b(${github.slice(0, 8)}\x1b[1m${github.slice(8)}`), /gently/],
    ['a stray ESC takes the first character of a token a charset escape splits', bytes(nul, `\x1b${github.slice(0, 8)}\x1b(B${github.slice(8)}`), /gently and joined/],
    ['a word before a stray ESC that takes a split token\'s first character', bytes(nul, `x\x1b${github.slice(0, 8)}\x1b[1m${github.slice(8)}`), /gently/],
    ['an unterminated OSC takes a split token\'s head', bytes(nul, `\x1b]0;t ${github.slice(0, 8)}\x1b[1m${github.slice(8)}\n`), /gently/],
    ['a token split across lines', bytes(nul, `${github.slice(0, 10)}\n${github.slice(10)}`), /line breaks removed/],
    ['a token split by CRLF', bytes(nul, `${github.slice(0, 10)}\r\n${github.slice(10)}`), /line breaks removed/],
    ['an environment value split across lines', bytes(nul, `${value.slice(0, 5)}\n${value.slice(5)}`), /inside an environment value/],
    ['an environment value split by a stray and a real escape', bytes(nul, `${value.slice(0, 1)}\x1bM${value.slice(1, 5)}\x1b(${value.slice(5)}`), /inside an environment value/],
    ['an AWS key split across lines before a word line', bytes(nul, `id=${aws.slice(0, 9)}\n${aws.slice(9)}\nnext line`), /line breaks removed/],
    ['a word line before a token split across lines', bytes(nul, `token is\n${github.slice(0, 14)}\n${github.slice(14)} ok`), /line breaks removed/],
    ['a line break inside a token prefix', bytes(nul, `xx ${github[0]}\n${github.slice(1)} y`), /line breaks removed/],
    ['ESC [ takes a split token\'s first character', bytes(nul, `x \x1b[${github.slice(0, 8)}\x1b[1m${github.slice(8)}`), /gently/],
  ]) assert.match(redact.bytes(input).missed || '', view, name);
});

test('a binary artifact is scanned without a map per byte, and as UTF-16 only when it could hold it', () => {
  const { createRedactor } = require('../lib/gates/common');
  const github = `ghp_${'d4'.repeat(18)}`;
  const redact = createRedactor([['FIXTURE_PASSWORD', 'hunter2-secret-value']]);
  const text = Buffer.from(`${'build ok\n'.repeat(1 << 16)}${github} \x1b[1mdone\n`);
  // A 64 MiB file peaked at 1.4 GiB: two 4-byte source maps per byte once a secret showed, and four
  // UTF-16 copies of a file that had no NUL byte. Arrays over a shared buffer allocate nothing.
  const big = [];
  const saved = { Int32Array, Uint16Array };
  for (const [name, Base] of Object.entries(saved)) {
    globalThis[name] = class extends Base {
      constructor(...args) {
        super(...args);
        if (!(args[0] instanceof ArrayBuffer) && this.length >= text.length / 8) big.push(`${name}(${this.length})`);
      }
    };
  }
  try {
    for (const head of [0xff, 0x00]) {
      const out = redact.bytes(Buffer.concat([Buffer.from([head]), text]));
      assert.equal(out.missed, undefined);
      assert.match(out.body.toString('latin1'), /\n\[redacted:GITHUB_TOKEN\] \x1b\[1mdone\n$/);
    }
  } finally {
    Object.assign(globalThis, saved);
  }
  assert.deepEqual(big, []);
  // A value with no ASCII character has no NUL byte in UTF-16, so a non-ASCII value keeps those views.
  const value = '中文密码中文';
  const wide = Buffer.from(value, 'utf16le');
  assert.equal(wide.includes(0), false);
  assert.match(createRedactor([['FIXTURE_PASSWORD', value]]).bytes(Buffer.concat([Buffer.from([0xff]), wide])).missed || '', /as UTF-16LE from its second byte/);
  // An empty buffer has no unit from its second byte; that view threw on a negative length.
  assert.deepEqual(createRedactor([['FIXTURE_PASSWORD', value]]).bytes(Buffer.alloc(0)), { body: Buffer.alloc(0) });
});

test('dense overlapping environment values in a binary artifact merge as they are found', () => {
  const { createRedactor } = require('../lib/gates/common');
  // Both values occur at every other byte of a run of `a1`. 64 MiB of it made 67M spans, one per
  // occurrence, and ran out of memory at 7 GB. Arrays over a shared buffer allocate nothing.
  const redact = createRedactor([['SECRET_A', 'a1'.repeat(10)], ['SECRET_B', 'a1'.repeat(11)]]);
  const run = 'a1'.repeat(1 << 19);
  const big = [];
  const saved = { Int32Array, Uint32Array };
  for (const [name, Base] of Object.entries(saved)) {
    globalThis[name] = class extends Base {
      constructor(...args) {
        super(...args);
        if (!(args[0] instanceof ArrayBuffer) && this.length >= run.length / 8) big.push(`${name}(${this.length})`);
      }
    };
  }
  try {
    // The charset escape keeps its final byte in the gentle views, which then run too.
    for (const [input, expected] of [
      [`\x00${run}`, '\x00[redacted:SECRET_B]'],
      [`\x00\x1b(B${run}`, '\x00\x1b(B[redacted:SECRET_B]'],
      [`\x00${run} \x1b(B ${run}\n`, '\x00[redacted:SECRET_B] \x1b(B [redacted:SECRET_B]\n'],
    ]) {
      const out = redact.bytes(Buffer.from(input, 'latin1'));
      assert.equal(out.missed, undefined);
      assert.equal(out.body.toString('latin1'), expected);
    }
  } finally {
    Object.assign(globalThis, saved);
  }
  assert.deepEqual(big, []);
});

test('an environment value is redacted however an escape splits it, and a header an escape glues on keeps its value hidden', () => {
  const { createRedactor } = require('../lib/gates/common');
  const shows = (out, secret) => Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((w) => out.replace(/[\x00-\x1f\x7f-\x9f]/g, '').includes(w));
  const value = 'm.SQhCuRiP7Puvr5-jZYLEMzpy';
  const env = createRedactor([['MY_SECRET', value]]);
  // A line-split token whose tail is the head of a value that a real two-character escape splits.
  const tail = createRedactor([['MY_SECRET', 'jXNogNs9XVM82r2']]);
  assert.equal(tail(tail.strip('ghp_5j63\nJyejyrqtFRVIndoXPk4KhSudBJNTpPdjXNog\x1b=Ns9XVM82r2 key')), '[redacted:GITHUB_TOKEN] [redacted:MY_SECRET] key');
  for (const input of [
    // `ESC [` reads the value's next character, or its digits and the character after, as a CSI.
    `v ${value.slice(0, 6)}\x1b[${value.slice(6)} end`,
    `v ${value.slice(0, 6)}\x1b[1;${value.slice(6)} end`,
    `v ${value.slice(0, 10)}\x1b[${value.slice(10)} end`,
    // An escape's intermediate byte is the value's own `.`, and the value goes on in an OSC body.
    `v ${value.slice(0, 1)}\x1b(${value.slice(1)} end`,
    `v ${value.slice(0, 1)}\x1b]0;t ${value.slice(1)} end`,
  ]) {
    assert.ok(!shows(env(env.strip(input)), value), JSON.stringify(input));
    assert.ok(env.bytes(Buffer.from(`\x00${input}`, 'latin1')).missed, JSON.stringify(input));
  }
  // A token that a real two-character escape and a line break both split is not copied.
  assert.match(createRedactor([]).bytes(Buffer.from('ghp_Ab3dEf\x1b(B6hIj9kLm2nO\np5qRs8tUv1wXy4zAb7d\0', 'latin1')).missed || '', /line breaks removed/);
  // A token glued to a header by an escape the cleanup removes takes the header word no more.
  const plain = createRedactor([]);
  const github = 'ghp_Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2';
  for (const input of [
    'z xoxa-ab\ncdefghij\x1b(B\x1b[1mAuthorization: Bearer sekrit-value',
    `z ${github}\x1b[0mAuthorization: Bearer sekrit-value`,
    `z ${github.slice(0, 9)}\r\n${github.slice(9)}\x1b7authorization: token sekrit-value`,
    // A token whole before its line break keeps its tail, glued by the escape to the header.
    `z ${github.slice(0, -1)}\n${github.slice(-1)}\x1b(BAUTHORIZATION: Basic sekrit-value`,
  ]) {
    assert.ok(!plain(plain.strip(input)).includes('sekrit'), JSON.stringify(input));
    const binary = plain.bytes(Buffer.from(`\x00${input}`, 'latin1'));
    assert.ok(binary.missed || !binary.body.toString('latin1').includes('sekrit'), JSON.stringify(input));
  }
});

test('a value found by reading its own characters as escape bytes yields to the secret next to it', () => {
  const { createRedactor } = require('../lib/gates/common');
  // The longest run of each value's characters the redacted text shows: a reading that completes
  // one value through an escape's final or a string's body once took the next value's first
  // character, or a token's, and that secret then went unredacted.
  const longest = (out, value) => {
    const flat = out.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    for (let w = value.length; w > 0; w--) for (let i = 0; i + w <= value.length; i++) if (flat.includes(value.slice(i, i + w))) return w;
    return 0;
  };
  for (const [input, values, shown] of [
    ["MXqy66Mp)n4ON[RpY;U[blM\u001b];9oS[tUd6\u001bMXqy66Mp)n4ON[RpY;U[blM9oS[tUd6", ["MXqy66Mp)n4ON[RpY;U[blM9oS[tUd6"], [22]],
    ["NUaymyOGww31eUrQ1ew9DN\u001b]NRq3j5\u001bNUaymyOGww31eUrQ1ew9DNRq3j5", ["NUaymyOGww31eUrQ1ew9DNRq3j5"], [21]],
    ["z.-5944266\u001b[1485051.5-2-..;\u001b_1\u001b;cqBv9kHeu4SduMI3)v1P9", ["z.-59442661485051.5-2-..;1",";cqBv9kHeu4SduMI3)v1P9"], [24,1]],
    ["t\u009b(1RFDj3fjaueLt\u001bPnRLsRjwB5\u001bt1RFDj3fjaueLtnRLsRjwB5", ["t1RFDj3fjaueLtnRLsRjwB5"], [12]],
    ["d.9i_2.AwBMs\u001bAPs3A5A\u001b_2d.9i_\u009c2.AwBMsAPs3A5A2", ["d.9i_2.AwBMsAPs3A5A2"], [1]],
    ["Zi\\KtUcLu9Dt!Z\u009d;y39VSNzoOvdB8\u001bZi\\KtUcLu9Dt!Zy39VSNzoOvdB8", ["Zi\\KtUcLu9Dt!Zy39VSNzoOvdB8"], [13]],
    [";TROJ-;P\u009b;\u009dlyevZK5\u001b;TROJ-;PlyevZK5", [";TROJ-;PlyevZK5"], [8]],
    ["ghs_Ts11bZC0Zq7aHV\u001bw\u001bP\u001by1WKo\n\u001b1", ["1bZC0Zq7aHVwy1WKo1"], [1]],
    ["jPvnOM.aFSqiQ\u009d;3\u001bQLXKA72OYA8@#rY3hX7B4Suwpcn9", ["jPvnOM.aFSqiQ3","QLXKA72OYA8@#rY3hX7B4Suwpcn9"], [12,1]],
    ["fVf\u009d;Kfi89wxZZwvvF7oA5\u001bfVfKfi89wxZZwv\u009bmvF7oA5", ["fVfKfi89wxZZwvvF7oA5"], [2]],
    ["byfLZlhUtC2ZZDTVFSF6GWb\u009d;47K1\u001bbyfLZlhUtC2ZZDTVFSF6GWb47K1", ["byfLZlhUtC2ZZDTVFSF6GWb47K1"], [22]],
    ["E6M0@v\u001b[onU5kWEd\u001bXLClsTi!d0\u001bdpF!GANsVQ6d92lmWHU@ec1NM#V8", ["dpF!GANsVQ6d92lmWHU@ec1NM#V8","E6M0@vonU5kWEdLClsTi!d0"], [1,6]],
    ["ASIAAXGDD9ECDI6JTPS\n7\u001b];\u001b\\AuThOrIzAtIoN:HLyexBO69t\u009b;GX73hs3OSW3github_p", ["HLyexBO69tGX73hs3OSW3"], [1]],
  ]) {
    const redact = createRedactor(values.map((v, i) => [`SECRET_${i}`, v]));
    const out = redact(redact.strip(input));
    values.forEach((v, i) => assert.ok(longest(out, v) <= shown[i], `${JSON.stringify(input)} shows ${longest(out, v)} of ${v}`));
  }
});

test('the text redactor redacts what reading escapes only as a terminal does redacts', () => {
  const { createRedactor } = require('../lib/gates/common');
  const flat = (out) => out.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  const longest = (out, value) => {
    for (let w = value.length; w > 0; w--) for (let i = 0; i + w <= value.length; i++) if (flat(out).includes(value.slice(i, i + w))) return w;
    return 0;
  };
  // A value whose characters an escape takes in one reading joins up across a line break in the
  // other: the terminal reading shows 16 of its characters, and no more may show.
  const value = 'CG8f9JH2DMB1rIfUBY8UioDg8';
  const env = createRedactor([['SECRET_0', value]]);
  const joined = env(env.strip(`github_pat_\n${value}C\n\x1bG8f9JH2DMB1rIfUBY\x1b[8UioDg8`));
  assert.ok(longest(joined, value) <= 16, joined);
  // A header value the terminal reading redacts whole keeps its tail hidden after a value found in it.
  const header = createRedactor([['SECRET_0', 'HLyexBO69tGX73hs3OSW3']]);
  const out = header(header.strip('ASIAAXGDD9ECDI6JTPS\n7\x1b];\x1b\\AuThOrIzAtIoN:HLyexBO69t\x9b;GX73hs3OSW3github_p'));
  assert.ok(!flat(out).includes('github_p'), out);
  // Mapped, as the joined output of two streams reads it, the same characters stay redacted.
  const view = header.stripMapped('ASIAAXGDD9ECDI6JTPS\n7\x1b];\x1b\\AuThOrIzAtIoN:HLyexBO69t\x9b;GX73hs3OSW3github_p');
  assert.equal(header(view.text), out);
  for (let i = 0; i < view.text.length; i++) {
    const [a, b] = view.at(i);
    assert.ok(a <= b && (i === 0 || view.at(i - 1)[0] <= a), `at(${i})`);
  }
});

test('mapped escape readings keep both span endpoints in order when a value is put beside a token', () => {
  const { stripEscapesViews, stripEscapesMapped } = require('../lib/ci-log-text');
  const { createRedactor } = require('../lib/gates/common');
  for (const [input, value] of [
    ['ghs_Ts11bZC0Zq7aHV\x1bw\x1bP\x1by1WKo\n\x1b1', '1bZC0Zq7aHVwy1WKo1'],
    ['ASIAAXGDD9ECDI6JTPS\n7\x1b];\x1b\\AuThOrIzAtIoN:HLyexBO69t\x9b;GX73hs3OSW3github_p', 'HLyexBO69tGX73hs3OSW3'],
    ['MXqy66Mp)n4ON[RpY;U[blM\x1b];9oS[tUd6\x1bMXqy66Mp)n4ON[RpY;U[blM9oS[tUd6', 'MXqy66Mp)n4ON[RpY;U[blM9oS[tUd6'],
    ['github_pat_defghij\x1bAuthorization:e\x9b;HLyexBO69tGX73hs3OSW3', 'HLyexBO69tGX73hs3OSW3'],
    ['xoxa-aghijrd\x1bghp_8x2\x9b1bZC0Zq7aHVwy1WKo1\x1b]0', '1bZC0Zq7aHVwy1WKo1'],
    ['\x1b]xoxa-k\x1bAuthorization:Bearer\x9b1bZC0Zq7aHVwy1WKo1', '1bZC0Zq7aHVwy1WKo1'],
  ]) {
    const redact = createRedactor([['FIXTURE_SECRET', value]]);
    const views = [...stripEscapesViews(input, [value]), stripEscapesMapped(input, [value]), redact.stripMapped(input)];
    for (const view of views) {
      let previous = [0, 0];
      for (let i = 0; i < view.text.length; i++) {
        const [a, b] = view.at(i);
        assert.ok(a >= previous[0] && b >= previous[1] && a <= b && b <= input.length,
          `${JSON.stringify(input)} at(${i}): ${previous} -> ${a},${b}`);
        previous = [a, b];
      }
      // Random access must give the same spans as ordered access.
      for (let i = view.text.length - 1; i >= 0; i--) {
        if (i > 0) assert.ok(view.at(i - 1)[1] <= view.at(i)[1]);
      }
    }
    assert.ok(!redact(redact.strip(input)).includes(value));
  }
});

test('a header value recovered across a hidden escape keeps the following lorem125 line', () => {
  const { createRedactor, redactJoined } = require('../lib/gates/common');
  const value = ';l4mPuuBezabcdefghijk';
  const redact = createRedactor([['FIXTURE_SECRET', value]]);
  for (const lineEnd of ['\n', '\r\n']) {
    const input = `AuThOrIzAtIoN: ;l4m\r\x1bPuuBezabcdefghijk${lineEnd}lorem125`;
    const expected = 'AuThOrIzAtIoN: [redacted:AUTHORIZATION]\nlorem125';
    assert.equal(redact(redact.strip(input)), expected, JSON.stringify(lineEnd));
    const at = input.indexOf('lorem125');
    assert.equal(redactJoined({ output: input, runs: [
      { stream: 'out', text: input.slice(0, at) }, { stream: 'err', text: input.slice(at) },
    ] }, redact), expected, JSON.stringify(lineEnd));
  }
});

test('common leading digits of a secret do not exhaust the work budget on a 1 MiB plain joined log', () => {
  const { createRedactor, redactJoined } = require('../lib/gates/common');
  const { valueSpans } = require('../lib/escape-views');
  const value = '012345678901234567890123456789';
  const redact = createRedactor([['THIRD_SECRET', value]]);
  const unit = 'ok 0123456789\n';
  const plain = unit.repeat(Math.ceil((1 << 20) / unit.length)).slice(0, 1 << 20);
  const result = (text) => redactJoined({ output: text, runs: [
    { stream: 'out', text: text.slice(0, text.length / 2) },
    { stream: 'err', text: text.slice(text.length / 2) },
  ] }, redact);
  assert.equal(result(plain), plain);
  for (const more of [false, true]) assert.deepEqual(valueSpans(plain, value, null, more), []);
  // Real candidates still include an exact value and one interrupted in its leading digits.
  const input = `${plain}\n${value} end\n01\x1b[0m${value.slice(2)} end\n`;
  assert.equal(result(input), `${plain}\n[redacted:THIRD_SECRET] end\n[redacted:THIRD_SECRET] end\n`);
});

test('glued headers on one long line are read once each, and a long glued header value stays redacted', () => {
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  // The value runs on past what a fixed window read, and its tail showed.
  const long = redact(redact.strip(`x\x1b[0mAuthorization: Bearer ${'a'.repeat(5000)} end`));
  assert.ok(!long.includes('aaaaaaaaa'), long.slice(0, 200));
  // Read to the line's end once per header, a line of them took minutes: the characters read for
  // the headers stay a small multiple of the line. Joined once per header, a line of headers with
  // no space between them overflowed a string.
  const { gluedHeaders } = require('../lib/escape-views');
  const { shapeMatches } = require('../lib/ci-log-text');
  const size = 4 << 20;
  for (const unit of ['w\x1b[mAuthorization: Bearer abc ', 'w\x1b(Bauthorization:', 'word\x1b[1mAuthorization:']) {
    const line = unit.repeat(Math.ceil((1 << 20) / unit.length));
    let read = 0;
    const found = gluedHeaders(line, (t) => { read += t.length; return shapeMatches(t); });
    assert.ok(found.length > 0 && read < 4 * line.length, `${JSON.stringify(unit)} read ${read} characters for ${line.length}`);
    const text = unit.repeat(Math.ceil(size / unit.length));
    assert.ok(!redact(redact.strip(text)).includes('abc'), JSON.stringify(unit));
    assert.ok(redact.bytes(Buffer.from(`\0${text}`, 'latin1')).missed, JSON.stringify(unit));
  }
});

test('a binary artifact is read across lines a window at a time', () => {
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  // A copy without line breaks and a map of every line peaked at 1.4 GiB for 64 MiB of short lines
  // after a token prefix; a window holds a few thousand of them.
  const text = Buffer.from(`\x00sk-ab\n${'cd\n'.repeat(1 << 19)}`, 'latin1');
  const big = [];
  const Saved = Int32Array;
  globalThis.Int32Array = class extends Saved {
    constructor(...args) {
      super(...args);
      if (!(args[0] instanceof ArrayBuffer) && this.length >= text.length / 8) big.push(this.length);
    }
  };
  let out;
  try {
    out = redact.bytes(text);
  } finally {
    globalThis.Int32Array = Saved;
  }
  assert.match(out.missed || '', /line breaks removed/);
  assert.deepEqual(big, []);
});

test('restoring redaction markers is linear in their count', () => {
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([['FIXTURE_TOKEN', `ghp_${'d4'.repeat(18)}`]]);
  const text = '[redacted:A] '.repeat(Math.ceil((1 << 20) / 13));
  // A split and join of the whole text per marker took minutes for these 1 MiB. Counting splits of
  // the text, at least the size it has with markers in place, shows the passes without timing them.
  const split = String.prototype.split;
  let passes = 0;
  String.prototype.split = function (...args) {
    if (this.length >= text.length / 4) passes++;
    return split.apply(this, args);
  };
  try {
    assert.equal(redact(`${text}ghp_${'d4'.repeat(18)}`), `${text}[redacted:FIXTURE_TOKEN]`);
  } finally {
    String.prototype.split = split;
  }
  assert.ok(passes <= 1, `${passes} passes`);
  const binary = Buffer.from(`\x00${text}`, 'latin1');
  assert.equal(redact.bytes(binary).body, binary);
});

test('a token prefix before 16 MiB of token characters is redacted whole in linear work', () => {
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([['FIXTURE_TOKEN', `ghp_${'d4'.repeat(18)}`]]);
  const size = 16 << 20;
  // The token shapes ran as backtracking regular expressions, which threw a RangeError (maximum
  // call stack size exceeded) from about 8 MiB of run: the gate crashed instead of redacting. The
  // NUL byte sends the text through the control cleanup's token search too.
  const cases = [
    [`ghp_${'aB3'.repeat(size / 3)}`, '[redacted:GITHUB_TOKEN]'],
    [`sk-${'ab-'.repeat(size / 3)}z`, '[redacted:API_KEY]'],
    [`Authorization: Bearer ${'Zy9'.repeat(size / 3)}`, 'Authorization: Bearer [redacted:AUTHORIZATION]'],
    [`ghp_${'aB3'.repeat(size / 3)}_tail`, '[redacted:GITHUB_TOKEN]_tail'],
  ];
  // Counting character reads shows the scans read each character a bounded number of times,
  // without timing them.
  const charCodeAt = String.prototype.charCodeAt;
  let reads = 0;
  String.prototype.charCodeAt = function (i) {
    reads++;
    return charCodeAt.call(this, i);
  };
  try {
    for (const [token, expected] of cases) {
      const input = `\x00pre ${token} post`;
      reads = 0;
      assert.equal(redact(redact.strip(input)), `pre ${expected} post`, token.slice(0, 24));
      const out = redact.bytes(Buffer.from(input, 'latin1'));
      assert.equal(out.missed, undefined, token.slice(0, 24));
      assert.equal(out.body.toString('latin1'), `\x00pre ${expected} post`, token.slice(0, 24));
      assert.ok(reads <= 16 * input.length, `${reads} character reads for ${input.length} characters`);
    }
  } finally {
    String.prototype.charCodeAt = charCodeAt;
  }
});

test('a token run glued to more word characters is redacted whole, and the word after it stays', () => {
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  const github = `ghp_${'d4'.repeat(18)}`;
  const aws = `AKIA${'E5'.repeat(8)}`;
  const slack = `xoxb-1234567890-1234567890-${'AbCd'.repeat(6)}`;
  // Without a word boundary after the run, the shapes skipped these and left the whole secret, or,
  // for the Slack token, stopped at its last dash and left the secret part.
  for (const [input, expected] of [
    [`${github}_suffix`, '[redacted:GITHUB_TOKEN]_suffix'],
    [`${github}_${github}`, '[redacted:GITHUB_TOKEN]_ghp_d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4'],
    [`${aws}abc`, '[redacted:AWS_ACCESS_KEY_ID]abc'],
    // An AWS key id is 20 characters, so a longer run keeps its tail.
    [`${aws}XYZ`, '[redacted:AWS_ACCESS_KEY_ID]XYZ'],
    [`${aws}_2`, '[redacted:AWS_ACCESS_KEY_ID]_2'],
    [`${slack}_x`, '[redacted:SLACK_TOKEN]_x'],
    [`xoxb-${'ab'.repeat(5)}_x`, '[redacted:SLACK_TOKEN]_x'],
    // Shorter than the shape's minimum, a glued run is not a token.
    [`ghp_${'a'.repeat(19)}_x`, `ghp_${'a'.repeat(19)}_x`],
  ]) {
    assert.equal(redact(`key=${input} end`), `key=${expected} end`, input);
    const out = redact.bytes(Buffer.from(`\x00key=${input} end`, 'latin1'));
    assert.equal(out.missed, undefined, input);
    assert.equal(out.body.toString('latin1'), `\x00key=${expected} end`, input);
  }
  // A control inside a glued run goes, so the token is redacted whole; one at the token's end stays
  // a boundary. Without that, `ghp_ABCD\rEFGH..._x` became two lines that no shape matches. The
  // bytes cannot be redacted in place there, so the binary file is missed.
  // binary is the redacted file, or null when it is missed.
  for (const [input, expected, binary] of [
    [`ghp_${'a'.repeat(10)}\r${'b'.repeat(26)}_suffix`, '[redacted:GITHUB_TOKEN]_suffix', null],
    [`ghp_ABCD\rEFGH${'c'.repeat(32)}_x`, '[redacted:GITHUB_TOKEN]_x', null],
    [`ghp_ABCD\x00EFGH${'c'.repeat(32)}_x`, '[redacted:GITHUB_TOKEN]_x', null],
    [`${slack.slice(0, 20)}\r${slack.slice(20)}_x`, '[redacted:SLACK_TOKEN]_x', null],
    [`${aws.slice(0, 8)}\r${aws.slice(8)}XYZ`, '[redacted:AWS_ACCESS_KEY_ID]XYZ', null],
    [`${github}\x00_x`, '[redacted:GITHUB_TOKEN] _x', '[redacted:GITHUB_TOKEN]\x00_x'],
    [`${aws}\rDONE`, '[redacted:AWS_ACCESS_KEY_ID]\nDONE', '[redacted:AWS_ACCESS_KEY_ID]\rDONE'],
    [`${aws}\x00DONE`, '[redacted:AWS_ACCESS_KEY_ID] DONE', '[redacted:AWS_ACCESS_KEY_ID]\x00DONE'],
  ]) {
    assert.equal(redact(redact.strip(`key=${input} end`)), `key=${expected} end`, JSON.stringify(input));
    const out = redact.bytes(Buffer.from(`\x00key=${input} end`, 'latin1'));
    if (binary === null) assert.match(out.missed || '', /^a secret as /, JSON.stringify(input));
    else assert.equal(out.body?.toString('latin1'), `\x00key=${binary} end`, JSON.stringify(input));
  }
});

// The old token expressions, safe on short inputs, as the reference for the scans.
const OLD_SHAPES = [
  ['\\bgh[pousr]_', 'A-Za-z0-9', 20, Infinity, ''],
  ['\\bgithub_pat_', 'A-Za-z0-9_', 20, Infinity, ''],
  ['\\bsk-', 'A-Za-z0-9_-', 8, Infinity, 'i'],
  ['\\b(?:AKIA|ASIA)', '0-9A-Z', 16, 16, ''],
  ['\\bxox[a-z]-', 'A-Za-z0-9-', 10, Infinity, 'i'],
].map(([lead, body, min, max, flags]) => ({
  old: new RegExp(`${lead}[${body}]{${min},${max === Infinity ? '' : max}}\\b`, `g${flags}`),
  run: new RegExp(`^${lead}[${body}]{${min},}$`, flags),
}));
const OLD_HEADER = /(\bauthorization:\s*(?:(?:bearer|basic|token)\s+)?)\S+/gi;
// A seeded generator (mulberry32), so a failure names an input that reproduces.
const seeded = (seed) => (n) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const wide = [0xe9, 0x17f, 0xa0, 0x2003, 0x3000, 0xfeff, 0x2028, 0x85].map((c) => String.fromCharCode(c));
const TOKEN_PIECES = ['ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_', 'ghx_', 'GHP_', 'github_pat_', 'github_pat_11ABC_',
  'sk-', 'SK-', 'Sk-', 'sk-proj-', 'sk-ant-api03-', 'AKIA', 'ASIA', 'akia', 'ASIAPACIFIC', 'xoxb-', 'xoxa-', 'xoxp-',
  'xoxr-', 'XoXs-', 'XOXP-', 'xox-', 'authorization:', 'Authorization: ', 'AUTHORIZATION:', 'Authorization:\t',
  'Bearer ', 'BEARER\t', 'bearer', 'Basic ', 'Token ', 'token\t', 'a', 'B', '7', 'Z', '_', '-', ' ', '\n', '.', ':',
  '=', '"', '/', 'IOSFODNN', 'EXAMPLE7', 'AKIAIOSFODNN7EXAMPLE', 'ASIAQWERTYUIOP123456', 'aaaaaaaa',
  'A1B2C3D4E5F6G7H8', 'xyz0123456789', 'a-a-a-a-', 'Q_q_Q_', ...wide];

test('token shapes find every token the old regular expressions found', () => {
  // Strict scans find exactly the old matches. The default scans find each of them again, ending
  // where it ended unless the run is glued to a word character, and find more only for a glued run.
  const { TOKEN_SHAPES } = require('../lib/ci-log-text');
  const next = seeded(1);
  let glued = 0;
  for (let k = 0; k < 20000; k++) {
    let text = '';
    for (let i = 1 + next(14); i > 0; i--) text += TOKEN_PIECES[next(TOKEN_PIECES.length)];
    OLD_SHAPES.forEach(({ old, run }, i) => {
      const found = TOKEN_SHAPES[i].find(text);
      const isGlued = ([at, , end]) => run.test(text.slice(at, end)) && /\w/.test(text[end] ?? '');
      const before = [...text.matchAll(old)].map((m) => [m.index, m.index, m.index + m[0].length]);
      assert.deepEqual(TOKEN_SHAPES[i].find(text, 'strict'), before, `${JSON.stringify(text)} shape ${i}`);
      for (const [at, , end] of before) {
        const now = found.find(([a]) => a === at);
        assert.ok(now && (now[2] === end || (now[2] > end && isGlued(now))), `${JSON.stringify(text)} shape ${i}`);
      }
      for (const match of found) {
        if (before.some(([a, , b]) => a === match[0] && b === match[2])) continue;
        assert.ok(isGlued(match), `${JSON.stringify(text)} shape ${i} ${match}`);
        glued++;
      }
    });
    const auth = [...text.matchAll(OLD_HEADER)].map((m) => [m.index, m.index + m[1].length, m.index + m[0].length]);
    assert.deepEqual(TOKEN_SHAPES[5].find(text, 'strict'), auth, JSON.stringify(text));
  }
  assert.ok(glued > 0, 'no glued run was generated');
});

test('every shape is found in the same text, and a control before a token keeps it apart', () => {
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  const key = 'AKIAIOSFODNN7EXAMPLE';
  // binary is the redacted file, or null when it is missed.
  for (const [input, expected, binary] of [
    // Replaced one shape at a time, the API key's replacement took the header word, and the header's
    // value stayed.
    ['sk-authorization: s3cr3tvalue', '[redacted:API_KEY]: [redacted:AUTHORIZATION]', '[redacted:API_KEY]: [redacted:AUTHORIZATION]'],
    [`AUTHORIZATION:${key}xoxp-AUTHORIZATION:xoxp-Token`, 'AUTHORIZATION:[redacted:AUTHORIZATION]', 'AUTHORIZATION:[redacted:AUTHORIZATION]'],
    // A header right after a glued AWS key, and a header as another header's value.
    [`${key}AUTHORIZATION: Bearer s3cr3tvalue`, '[redacted:AWS_ACCESS_KEY_ID]AUTHORIZATION: Bearer [redacted:AUTHORIZATION]', '[redacted:AWS_ACCESS_KEY_ID]AUTHORIZATION: Bearer [redacted:AUTHORIZATION]'],
    ['Authorization: Authorization: s3cr3tvalue', 'Authorization: [redacted:AUTHORIZATION] [redacted:AUTHORIZATION]', 'Authorization: [redacted:AUTHORIZATION] [redacted:AUTHORIZATION]'],
    // Joined across the carriage return, the AWS shape took the header, or a Slack run hid the key
    // after it.
    ['Region ASIAPACIFIC\rAUTHORIZATION: Bearer s3cr3tvalue', 'Region ASIAPACIFIC\nAUTHORIZATION: Bearer [redacted:AUTHORIZATION]', null],
    [`xoxb-ASIAQWERTYUIOP123456a\r${key}_x`, '[redacted:SLACK_TOKEN]\n[redacted:AWS_ACCESS_KEY_ID]_x', null],
  ]) {
    assert.equal(redact(redact.strip(`key=${input} end`)), `key=${expected} end`, JSON.stringify(input));
    const out = redact.bytes(Buffer.from(`\x00key=${input} end`, 'latin1'));
    if (binary === null) assert.match(out.missed || '', /^a secret as /, JSON.stringify(input));
    else assert.equal(out.body?.toString('latin1'), `\x00key=${binary} end`, JSON.stringify(input));
  }
});

test('no token the old expressions find in any reading of the input survives redaction', () => {
  // Random lines of token prefixes, headers, word pieces, escapes and controls. Every token or
  // header value of 8 or more characters that the old expressions find in the text with its
  // escapes removed and its controls removed, made newlines or made spaces, or in the cleaned text,
  // must be gone from the redacted text: it may show there only as often as some reading has it
  // outside the tokens found, since the same characters can be a token in one reading and plain
  // text in another. A header word given as another header's value is a header, also when an escape
  // took its first letter (`\x1bAUTHORIZATION:`).
  // A binary copy must hold none found in its bytes.
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  const pieces = [...TOKEN_PIECES, '\r', '\v', '\f', '\x00', '\x7f', '\x08', '\x1b', '\x1b[31m', '\x1b[0m', '\x9b'];
  const escapes = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g;
  const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
  // Each secret found once per position, as `position:secret`.
  const secrets = (view) => {
    const out = OLD_SHAPES.flatMap(({ old }) => [...view.matchAll(old)].map((m) => `${m.index}:${m[0]}`));
    for (const m of view.matchAll(OLD_HEADER)) {
      const value = m[0].slice(m[1].length);
      if (!'authorization:'.endsWith(value.toLowerCase())) out.push(`${m.index + m[1].length}:${value}`);
    }
    return [...new Set(out)].map((s) => s.slice(s.indexOf(':') + 1)).filter((s) => s.length >= 8);
  };
  const count = (text, part) => text.split(part).length - 1;
  const gone = (views, out, what) => {
    const found = views.map(secrets);
    for (const secret of new Set(found.flat())) {
      const kept = Math.max(...views.map((view, i) => count(view, secret) - found[i].filter((s) => s === secret).length));
      assert.ok(count(out, secret) <= kept, `${what} ${JSON.stringify(secret)}`);
    }
  };
  const next = seeded(7);
  for (let k = 0; k < 20000; k++) {
    let text = '';
    for (let i = 1 + next(20); i > 0; i--) text += pieces[next(pieces.length)];
    const cleaned = redact.strip(text);
    const out = redact(cleaned);
    const bare = text.replace(escapes, '');
    gone([cleaned, bare.replace(controls, ''), bare.replace(controls, '\n'), bare.replace(controls, ' ')], out, `${JSON.stringify(text)} kept`);
    const bytes = Buffer.from(text, 'latin1');
    const copy = redact.bytes(bytes);
    if (copy.missed) continue;
    const raw = bytes.toString('latin1');
    gone([raw], copy.body.toString('latin1'), `${JSON.stringify(text)} copied`);
  }
});

test('a passing local CI keeps its log without a tail or artifacts', (t) => {
  const h = fixture(t);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: h.command, timeout: 5, artifacts: ['*.js'] })]);
  const e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.ok, true);
  assert.equal(e.local_ci.output_tail, undefined);
  assert.deepEqual(e.local_ci.artifacts, []);
  assert.ok(fs.existsSync(path.join(h.state, e.local_ci.log)));
  assert.ok(!fs.existsSync(path.join(h.state, 'ci-artifacts')));
});

test('local CI keeps private receipts on failure and success before removing its worktree', (t) => {
  const h = fixture(t, `
const fs = require('node:fs');
const failed = process.argv.includes('--fail');
fs.writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd() }));
fs.mkdirSync('.local/checks', { recursive: true });
fs.writeFileSync('.local/checks/receipt.json', JSON.stringify({
  failure_reasons: failed ? ['step unit-tests failed'] : [],
  steps: [{ argv: ['node', 'unit-tests.js'], check: 0, outcome: failed ? 'failed' : 'passed' }],
  checks: [{ exit_code: failed ? 1 : 0, output: 'all printed steps OK' }]
}));
console.log('All printed steps OK');
process.exit(failed ? 1 : 0);
`);
  for (const failed of [true, false]) {
    h.ok(['project', 'set', '--ci-local', JSON.stringify({
      command: [...h.command, ...(failed ? ['--fail'] : [])], timeout: 5,
      receipts: ['.local/checks/*.json', '.local/checks/receipt.json'],
    })]);
    const r = h.run(['check', 'ci', 'T1']);
    assert.equal(r.code, failed ? 1 : 0, r.stdout + r.stderr);
    const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
    const kept = e.local_ci;
    assert.equal(kept.receipts.length, 1, 'overlapping globs copy a receipt once');
    const receipt = kept.receipts[0];
    const run = path.posix.basename(path.posix.dirname(kept.log));
    assert.equal(receipt.path, `ci-artifacts/${run}/receipts/.local/checks/receipt.json`);
    assert.ok(!fs.existsSync(path.join(h.state, path.posix.dirname(kept.log), 'receipts')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.state, receipt.path), 'utf8')), {
      failure_reasons: failed ? ['step unit-tests failed'] : [],
      steps: [{ argv: ['node', 'unit-tests.js'], check: 0, outcome: failed ? 'failed' : 'passed' }],
      checks: [{ exit_code: failed ? 1 : 0, output: 'all printed steps OK' }],
    });
    assert.equal(receipt.bytes, fs.statSync(path.join(h.state, receipt.path)).size);
    const cwd = JSON.parse(fs.readFileSync(h.log, 'utf8')).cwd;
    assert.ok(!fs.existsSync(cwd), 'gate worktree removed after saving the receipt');
    assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
    if (failed) {
      assert.match(e.summary, /node unit-tests\.js \(outcome: failed, exit 1\)/);
      assert.match(e.summary, /step unit-tests failed/);
    }
    const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.findLast((v) => v.cmd === 'check ci').detail.local_ci, kept);
  }
});

test('receipt summary variants omit credentials formed by adjacent selected fields', () => {
  const { receiptFailures } = require('../lib/gates/local-ci');
  const { createRedactor } = require('../lib/gates/common');
  const token = 'ghp_T448JsonTableCredential01234567890123456';
  const opaque = 'OpaqueT448SlashBoundary01234567890123456789';
  const redact = createRedactor([['TOKEN', token], ['OPAQUE', opaque]]);
  const omitted = ['[receipt summary omitted: a credential spans fields]'];
  for (const secret of [token, opaque]) {
    const halves = [secret.slice(0, 20), secret.slice(20)];
    for (const receipt of [
      { failure_reasons: halves },
      { steps: [{ argv: ['node', ...halves], outcome: 'failed' }] },
      { steps: [{ name: halves[0], outcome: halves[1] }] },
      { steps: halves.map(name => ({ name, outcome: 'failed' })) },
      { steps: [{ argv: [halves[0]], outcome: 'failed' }], failure_reasons: [halves[1]] },
    ]) {
      assert.deepEqual(receiptFailures(JSON.stringify(receipt), redact), omitted);
    }
    for (const payload of [
      { output_lines: halves }, { output_lines: [halves] }, { [halves[0]]: halves[1] },
    ]) {
      const receipt = { ...payload, steps: [{ argv: ['node', 'unit-tests.js'], outcome: 'failed' }] };
      assert.deepEqual(receiptFailures(JSON.stringify(receipt), redact), ['node unit-tests.js (outcome: failed)']);
    }
  }
});

test('split-credential receipt tables stay private and expose only safe summaries on fail and pass', (t) => {
  const h = fixture(t, `
const fs = require('node:fs');
const token = process.env.CI_FIXTURE_TOKEN;
const opaque = process.env.CI_FIXTURE_SECRET;
fs.mkdirSync('.local/checks', { recursive: true });
if (process.argv.includes('--across-files')) {
  for (const [index, part] of [token.slice(0, 20), token.slice(20)].entries()) {
    fs.writeFileSync('.local/checks/cross-' + index + '.json', JSON.stringify({ failure_reasons: [part] }));
  }
}
for (const [kind, secret] of [['token', token], ['opaque', opaque]]) {
  const halves = [secret.slice(0, 20), secret.slice(20)];
  const step = { argv: ['node', 'unit-tests.js'], check: 0, outcome: 'failed' };
  for (const [name, payload] of [
    ['lines', { output_lines: halves }], ['nested', { output_lines: [halves] }],
    ['key', { [halves[0]]: halves[1] }], ['reasons', { failure_reasons: halves }],
    ['argv', { steps: [{ ...step, argv: ['node', ...halves] }] }],
    ['name-outcome', { steps: [{ name: halves[0], outcome: halves[1] }] }]
  ]) {
    fs.writeFileSync('.local/checks/' + kind + '-' + name + '.json', JSON.stringify({
      steps: [step], checks: [{ exit_code: 1 }], ...payload
    }));
  }
  console.log(halves.join('\\n'));
}
fs.writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd() }));
process.exit(process.argv.includes('--fail') ? 1 : 0);
`);
  const token = 'ghp_T448JsonTableCredential01234567890123456';
  const opaque = 'OpaqueT448SlashBoundary01234567890123456789';
  h.env.CI_FIXTURE_TOKEN = token;
  h.env.CI_FIXTURE_SECRET = opaque;
  for (const [failed, across] of [[true, false], [false, false], [true, true], [false, true]]) {
    h.ok(['project', 'set', '--ci-local', JSON.stringify({
      command: [...h.command, ...(failed ? ['--fail'] : []), ...(across ? ['--across-files'] : [])], timeout: 5,
      receipts: [across ? '.local/checks/cross-*.json' : '.local/checks/*.json'],
    })]);
    const r = h.run(['check', 'ci', 'T1']);
    assert.equal(r.code, failed ? 1 : 0, r.stdout + r.stderr);
    const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
    assert.equal(e.local_ci.receipts.length, across ? 2 : 12);
    const run = path.posix.basename(path.posix.dirname(e.local_ci.log));
    const logDir = path.join(h.state, path.posix.dirname(e.local_ci.log));
    assert.deepEqual(fs.readdirSync(logDir), ['output.log']);
    for (const copy of e.local_ci.receipts) {
      assert.ok(copy.path.startsWith(`ci-artifacts/${run}/receipts/`), copy.path);
      const target = path.join(h.state, copy.path);
      assert.ok(fs.existsSync(target));
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(target).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700);
      }
    }
    if (!across) assert.ok(e.local_ci.receipt_failures.includes('node unit-tests.js (outcome: failed, exit 1)'));
    assert.ok(e.local_ci.receipt_failures.includes('[receipt summary omitted: a credential spans fields]'));
    if (failed && !across) assert.match(e.summary, /node unit-tests\.js/);
    const publicText = [
      fs.readFileSync(path.join(h.state, e.local_ci.log), 'utf8'), JSON.stringify(e),
      StateFiles.docText(h.state, 'tasks.json'),
      StateFiles.logText(h.state), r.stdout, r.stderr,
    ].join('\n');
    for (const secret of [token, opaque]) {
      for (const part of [secret, secret.slice(0, 20), secret.slice(20)]) assert.ok(!publicText.includes(part), part);
    }
    assert.ok(!fs.existsSync(JSON.parse(fs.readFileSync(h.log, 'utf8')).cwd));
  }
});

test('receipt globs validate like artifact globs', () => {
  const Local = require('../lib/ci-local');
  for (const [receipts, valid] of [
    [[], true], [['.local/checks/*.json', 'reports/**/*.json'], true],
    ['*.json', false], [null, false], [[1], false], [[''], false],
    [['../up/*.json'], false], [['/absolute/*.json'], false],
    [['C:\\checks\\*.json'], false], [['a\\..\\b'], false], [['a\0b'], false],
  ]) {
    assert.equal(Local.valid({ command: ['node'], timeout: 5, receipts }), valid, JSON.stringify(receipts));
    for (const override of [{ command: ['node'], receipts }, { args: [], receipts }]) {
      assert.equal(Local.validOverride(override, { allowReceipts: true }), valid, JSON.stringify(override));
      assert.equal(Local.valid({ command: ['node'], timeout: 5, by_kind: { docs: override } }), false);
    }
  }
  const local = { command: ['node'], timeout: 5, receipts: ['.local/checks/*.json'] };
  assert.deepEqual(Local.resolve(local, { id: 'T1', kind: 'code' }).receipts, local.receipts);
  for (const override of [{ args: [] }, { args: [], receipts: [] }, { args: [], receipts: ['other/*.json'] }]) {
    const expected = override.receipts ?? local.receipts;
    assert.deepEqual(Local.resolve(local, { id: 'T1', kind: 'docs', ci_local: override }).receipts, expected);
  }
  const policy = require('../lib/gate-commands').resolve({ tests: { map: {} }, ci: { local } }, 'tests').policy;
  assert.deepEqual(policy.ci_local, { command: ['node'], timeout: 5 });
});

test('task local CI overrides replace, inherit or disable receipt copies on pass and fail', (t) => {
  const h = fixture(t, `
const fs = require('node:fs');
fs.mkdirSync('.local/checks', { recursive: true });
for (const name of ['project', 'task']) {
  fs.writeFileSync('.local/checks/' + name + '.json', JSON.stringify({ name }));
}
process.exit(process.argv.includes('--fail') ? 1 : 0);
`);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({
    command: h.command, timeout: 5, receipts: ['.local/checks/project.json'],
    by_kind: { docs: { args: ['--kind'] } },
  })]);
  for (const mode of ['command', 'args']) {
    for (const row of [
      { label: 'replace', receipts: ['.local/checks/task.json'], expected: ['task'] },
      { label: 'inherit', expected: ['project'] },
      { label: 'disable', receipts: [], expected: [] },
    ]) {
      for (const failed of [false, true]) {
        const label = `${mode} ${row.label} ${failed ? 'fail' : 'pass'}`;
        const extra = failed ? ['--fail'] : [];
        const override = mode === 'command' ? { command: [...h.command, ...extra] } : { args: extra };
        if (Object.hasOwn(row, 'receipts')) override.receipts = row.receipts;
        const updated = h.json(['task', 'update', 'T1', '--ci-local', JSON.stringify(override)]);
        assert.deepEqual(updated.ci_local, override, label);
        const r = h.run(['check', 'ci', 'T1']);
        assert.equal(r.code, failed ? 1 : 0, `${label}: ${r.stdout}${r.stderr}`);
        const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
        assert.equal(e.receipt.variant, 'task:T1', label);
        assert.deepEqual(e.receipt.command, [...h.command, ...extra], label);
        const copied = e.local_ci.receipts || [];
        assert.deepEqual(copied.map((file) => path.basename(file.from, '.json')), row.expected, label);
        for (const file of copied) {
          assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.state, file.path), 'utf8')),
            { name: path.basename(file.from, '.json') }, label);
        }
        const run = path.posix.basename(path.posix.dirname(e.local_ci.log));
        assert.equal(fs.existsSync(path.join(h.state, 'ci-artifacts', run, 'receipts')),
          row.expected.length > 0, label);
      }
    }
  }
});

test('task receipt globs use the project validation error without changing state', (t) => {
  const h = fixture(t);
  const project = h.readState('project.json');
  const tasks = h.readState('tasks.json');
  const audit = StateFiles.logText(h.state);
  for (const receipts of ['*.json', null, [1], [''], ['../up/*.json'], ['/absolute/*.json'],
    ['C:\\checks\\*.json'], ['a\\..\\b'], ['a\0b']]) {
    const setting = h.run(['project', 'set', '--name', 'changed', '--ci-local',
      JSON.stringify({ command: h.command, timeout: 5, receipts })]);
    assert.equal(setting.code, 2, JSON.stringify(receipts));
    assert.match(setting.stderr, /receipts.*relative globs without \.\./);
    for (const override of [{ command: h.command, receipts }, { args: [], receipts }]) {
      const update = h.run(['task', 'update', 'T1', '--title', 'changed', '--ci-local', JSON.stringify(override)]);
      assert.equal(update.code, 2, JSON.stringify(override));
      assert.equal(update.stderr, setting.stderr, JSON.stringify(override));
    }
  }
  assert.deepEqual(h.readState('project.json'), project);
  assert.deepEqual(h.readState('tasks.json'), tasks);
  assert.equal(StateFiles.logText(h.state), audit);
});

test('receipt copies redact decoded JSON keys and values on failure and success', (t) => {
  const h = fixture(t, `
const fs = require('node:fs');
const failed = process.argv.includes('--fail');
const token = process.env.CI_FIXTURE_TOKEN;
const opaque = process.env.CI_FIXTURE_SECRET;
fs.mkdirSync('.local/checks', { recursive: true });
const body = JSON.stringify({
  checks: [{ output: { nested: [
    token, opaque, token.slice(0, 4) + '\\x1b[31m' + token.slice(4),
    token.slice(0, 4) + '\\n' + token.slice(4)
  ] } }],
  [token]: 'key marker',
  failure_reasons: failed ? ['failed unit-tests: ' + token] : [],
  passed: !failed
});
const encoded = Array.from(token, (char) => '\\\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
const serialized = body.replaceAll(token, encoded).replaceAll('/', '\\\\/');
fs.writeFileSync('.local/checks/escaped.json', serialized);
fs.writeFileSync('.local/checks/bom.json', '\\uFEFF' + serialized);
fs.writeFileSync('.local/checks/utf16le.json', Buffer.from(serialized, 'utf16le'));
fs.writeFileSync('.local/checks/utf16be.json', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(serialized, 'utf16le').swap16()]));
fs.writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd() }));
process.exit(failed ? 1 : 0);
`);
  const token = 'ghp_T448JsonEncodedCredential0123456789012345';
  const opaque = 'OpaqueT448/SlashBoundary01234567890123456789';
  h.env.CI_FIXTURE_TOKEN = token;
  h.env.CI_FIXTURE_SECRET = opaque;
  for (const failed of [true, false]) {
    h.ok(['project', 'set', '--ci-local', JSON.stringify({
      command: [...h.command, ...(failed ? ['--fail'] : [])], timeout: 5, receipts: ['.local/checks/*.json'],
    })]);
    const r = h.run(['check', 'ci', 'T1']);
    assert.equal(r.code, failed ? 1 : 0, r.stdout + r.stderr);
    const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
    assert.equal(e.local_ci.receipts.length, 4);
    for (const copy of e.local_ci.receipts) {
      const decoded = JSON.parse(fs.readFileSync(path.join(h.state, copy.path), 'utf8'));
      for (const output of decoded.checks[0].output.nested.slice(2)) {
        const recovered = output.replace(/\u001b\[[0-9;]*m/g, '').replace(/[\r\n]/g, '');
        assert.ok(!recovered.includes(token), 'serialized ANSI/newline split exposes the credential after decoding');
      }
      const stored = JSON.stringify(decoded);
      assert.ok(!stored.includes(token), 'Unicode-escaped credential survived JSON decoding');
      assert.ok(!stored.includes(opaque), 'slash-escaped credential survived JSON decoding');
      assert.deepEqual(decoded.checks[0].output.nested, [
        '[redacted:CI_FIXTURE_TOKEN]', '[redacted:CI_FIXTURE_SECRET]',
        '[redacted:CI_FIXTURE_TOKEN]', '[redacted:CI_FIXTURE_TOKEN]',
      ]);
      assert.equal(decoded['[redacted:CI_FIXTURE_TOKEN]'], 'key marker');
      assert.equal(copy.redacted, true);
    }
    if (failed) assert.match(e.summary, /failed unit-tests: \[redacted:CI_FIXTURE_TOKEN\]/);
    assert.ok(!JSON.stringify(e).includes(token));
    assert.ok(!fs.existsSync(JSON.parse(fs.readFileSync(h.log, 'utf8')).cwd));
  }
});

test('receipt JSON redaction covers escaped strings, nesting, keys and processing failures', () => {
  const { receiptText } = require('../lib/gates/local-ci');
  const { createRedactor } = require('../lib/gates/common');
  const token = 'ghp_T448JsonTableCredential01234567890123456';
  const opaque = 'opaque "quoted" \\slash\ncredential';
  const redact = createRedactor([['TOKEN', token], ['OPAQUE', opaque]]);
  const escaped = Array.from(token, (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  for (const [input, expected] of [
    [`{"output":"${escaped}"}`, { output: '[redacted:TOKEN]' }],
    [`\uFEFF{"output":"${escaped}"}`, { output: '[redacted:TOKEN]' }],
    [JSON.stringify({ nested: [{ output: opaque }] }), { nested: [{ output: '[redacted:OPAQUE]' }] }],
    [JSON.stringify([token, opaque]), ['[redacted:TOKEN]', '[redacted:OPAQUE]']],
    [JSON.stringify(opaque), '[redacted:OPAQUE]'],
    [JSON.stringify({ [opaque]: token }), { '[redacted:OPAQUE]': '[redacted:TOKEN]' }],
    [JSON.stringify({ output: `\u001b[31m${token}\u001b[0m` }), { output: '[redacted:TOKEN]' }],
    ...['\u001b[31m', '\u001b]0;title\u0007', '\n', '\r\n', '\0'].map((split) => [
      JSON.stringify({ output: token.slice(0, 4) + split + token.slice(4) }), { output: '[redacted:TOKEN]' },
    ]),
    ['{"__proto__":{"safe":true},"constructor":"data"}', JSON.parse('{"__proto__":{"safe":true},"constructor":"data"}')],
    ['{"passed":true,"count":1,"signal":null}', { passed: true, count: 1, signal: null }],
    [JSON.stringify({ [token]: 'first', '[redacted:TOKEN]': 'second' }), {
      '[redacted:TOKEN]': 'first', '[redacted:TOKEN] (2)': 'second',
    }],
  ]) {
    const result = receiptText(input, redact);
    assert.deepEqual(JSON.parse(result.body), expected);
    assert.ok(!result.body.includes(token));
    assert.ok(!result.body.includes(JSON.stringify(opaque).slice(1, -1)));
  }
  const deep = '['.repeat(20000) + JSON.stringify(opaque) + ']'.repeat(20000);
  assert.match(receiptText(deep, redact).body, /^\[unscannable .*content omitted\]$/);
  assert.equal(receiptText(`plain ${token}`, redact).body, 'plain [redacted:TOKEN]');
  const numbers = '{"bytes":9007199254740993,"limit":1e999,"decimal":0.12345678901234567890}';
  assert.equal(receiptText(numbers, redact).body, numbers, 'receipt numbers retain their source precision');
});

test('malformed JSON and JSONL receipt tables keep only omission notices on failure and success', (t) => {
  const h = fixture(t, `
const fs = require('node:fs');
const token = process.env.CI_FIXTURE_TOKEN;
const encoded = Array.from(token, char => '\\\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
const body = JSON.stringify({ output: token }).replaceAll(token, encoded);
fs.mkdirSync('.local/checks', { recursive: true });
for (const [name, content] of [
  ['01-missing-brace', body.slice(0, -1)], ['02-jsonl', body + '\\n' + body],
  ['03-open-string', body.slice(0, -2)], ['04-array', '[' + body],
  ['05-string', '"' + encoded], ['06-prefixed', 'Receipt: ' + body.slice(0, -1)],
  ['07-bom', '\\uFEFF' + body.slice(0, -1)]
]) fs.writeFileSync('.local/checks/' + name + '.json', content);
fs.writeFileSync('.local/checks/08-utf16le.json', Buffer.from(body.slice(0, -1), 'utf16le'));
fs.writeFileSync('.local/checks/09-utf16be.json', Buffer.from(body + '\\n' + body, 'utf16le').swap16());
fs.writeFileSync('.local/checks/10-cut-utf16le.json', Buffer.from(body, 'utf16le').subarray(0, -1));
fs.writeFileSync('.local/checks/11-cut-utf16be.json', Buffer.from(body, 'utf16le').swap16().subarray(0, -1));
fs.writeFileSync('.local/checks/12-invalid-utf8.json', Buffer.concat([Buffer.from(body), Buffer.from([0xff])]));
fs.writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd() }));
process.exit(process.argv.includes('--fail') ? 1 : 0);
`);
  const token = 'ghp_T448MalformedCredential01234567890123456789';
  h.env.CI_FIXTURE_TOKEN = token;
  for (const failed of [true, false]) {
    h.ok(['project', 'set', '--ci-local', JSON.stringify({
      command: [...h.command, ...(failed ? ['--fail'] : [])], timeout: 5, receipts: ['.local/checks/*.json'],
    })]);
    const r = h.run(['check', 'ci', 'T1']);
    assert.equal(r.code, failed ? 1 : 0, r.stdout + r.stderr);
    const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
    assert.equal(e.local_ci.receipts.length, 12);
    for (const copy of e.local_ci.receipts) {
      const text = fs.readFileSync(path.join(h.state, copy.path), 'utf8');
      assert.match(text, /^\[unscannable JSON receipt: .*content omitted\]$/, copy.from);
      assert.ok(!text.includes('\\u'), copy.from);
      assert.equal(copy.redacted, true);
      if (failed) assert.ok(e.summary.includes(copy.path), e.summary);
    }
    assert.ok(!JSON.stringify(e).includes(token));
    assert.ok(!fs.existsSync(JSON.parse(fs.readFileSync(h.log, 'utf8')).cwd));
  }
});

test('malformed JSON-like receipt variants fail closed while ordinary text keeps its redaction', () => {
  const { receiptText } = require('../lib/gates/local-ci');
  const { createRedactor } = require('../lib/gates/common');
  const token = 'ghp_T448MalformedTableCredential01234567890123456';
  const redact = createRedactor([['TOKEN', token]]);
  const body = JSON.stringify({ output: token.slice(0, 4) + '\u001b[31m' + token.slice(4) });
  for (const text of [
    body.slice(0, -1), body + '\n' + body, body.slice(0, -2), '[' + body,
    '\uFEFF' + body.slice(0, -1), '"\\u0067hp_', 'Receipt: ' + body.slice(0, -1),
  ]) {
    const result = receiptText(text, redact);
    assert.match(result.body, /^\[unscannable JSON receipt: .*content omitted\]$/);
    assert.equal(result.redacted, true);
  }
  assert.equal(receiptText('bad JSON', redact).body, 'bad JSON');
  assert.equal(receiptText('plain "words"', redact).body, 'plain "words"');
  assert.equal(receiptText(`plain ${token}`, redact).body, 'plain [redacted:TOKEN]');
});

test('local CI receipt diagnosis reads failed steps and run-state reasons and tolerates other formats', () => {
  const { receiptFailures } = require('../lib/gates/local-ci');
  for (const [body, names] of [
    [{
      steps: [{ argv: ['node', 'unit-tests.js'], check: 0, outcome: 'failed' }, { argv: ['lint'], check: 1, outcome: 'passed' }],
      checks: [{ exit_code: 1, output: 'unbounded output stays out of evidence' }, { exit_code: 0 }],
    }, ['node unit-tests.js (outcome: failed, exit 1)']],
    [{
      steps: [{ argv: ['tests'], check: 0, outcome: 'interrupted' }],
      checks: [{ exit_code: null, timed_out: true }],
    }, ['tests (outcome: interrupted, timed out)']],
    [{ steps: [{ name: 'tests', outcome: 'failed', check: 99 }] }, ['tests (outcome: failed)']],
    [{ failure_reasons: ['run state incomplete', '', null, 1] }, ['run state incomplete']],
    [{
      head_unchanged: false, source_unchanged: false, working_tree_clean_after: false,
    }, ['head changed during local CI', 'sources changed during local CI', 'working tree is dirty after local CI']],
    [{ head_unchanged: true, source_unchanged: true, working_tree_clean_after: true }, []],
    [{
      steps: [{ argv: ['tests'], outcome: 'failed' }, { argv: ['tests'], outcome: 'failed' }],
      failure_reasons: ['tests (outcome: failed)'],
    }, ['tests (outcome: failed)']],
    [{ steps: [null, {}, { argv: [1], outcome: 'failed' }, { argv: [], outcome: 'failed' }], failure_reasons: 'unexpected' }, []],
    [{ results: { unknown: 'failed' } }, []], [null, []], [[], []], ['bad JSON', []],
  ]) {
    assert.deepEqual(receiptFailures(body === 'bad JSON' ? body : JSON.stringify(body)), names, JSON.stringify(body));
  }
});

test('receipt copies redact before truncating and list paths for unreadable receipt formats', (t) => {
  const { RECEIPT_BYTES } = require('../lib/gates/local-ci');
  const h = fixture(t, `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd() }));
fs.mkdirSync('.local/checks', { recursive: true });
const limit = Number(process.argv.at(-1));
const start = '{"output":"';
const token = process.env.CI_FIXTURE_TOKEN;
fs.writeFileSync('.local/checks/large.json',
  start + 'x'.repeat(limit - start.length - 4) + token + '","failure_reasons":["large-step failed"]}');
fs.writeFileSync('.local/checks/unknown.json', '{"other":"diagnosis"}');
fs.writeFileSync('.local/checks/bad.json', 'bad JSON');
fs.writeFileSync('.local/checks/link.json', '{"safe":true}');
if (process.platform !== 'win32') {
  fs.unlinkSync('.local/checks/link.json');
  fs.symlinkSync(process.argv[2], '.local/checks/link.json');
}
console.log('All printed steps OK');
process.exit(1);
`);
  const token = 'ghp_T448ReceiptBoundary01234567890123456789';
  h.env.CI_FIXTURE_TOKEN = token;
  h.ok(['project', 'set', '--ci-local', JSON.stringify({
    command: [...h.command, String(RECEIPT_BYTES)], timeout: 30, receipts: ['.local/checks/*.json'],
  })]);
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
  const copied = Object.fromEntries(e.local_ci.receipts.map((file) => [path.basename(file.from), file]));
  assert.equal(copied['large.json'].truncated, true);
  const large = fs.readFileSync(path.join(h.state, copied['large.json'].path), 'utf8');
  assert.ok(Buffer.byteLength(large) <= RECEIPT_BYTES);
  assert.equal(copied['large.json'].bytes, Buffer.byteLength(large));
  assert.ok(!large.includes('ghp_'));
  assert.ok(!large.includes('T448ReceiptBoundary'));
  assert.match(large, /\[receipt truncated at 8 MiB\]/);
  assert.match(e.summary, /large-step failed/);
  assert.match(e.summary, /large\.json \(truncated at 8 MiB\)/);
  for (const name of ['unknown.json', 'bad.json']) {
    assert.ok(fs.existsSync(path.join(h.state, copied[name].path)));
    assert.ok(e.summary.includes(copied[name].path), e.summary);
  }
  if (process.platform !== 'win32') {
    assert.equal(copied['link.json'], undefined);
    assert.match(e.local_ci.receipts_skipped[0].reason, /outside the gate worktree/);
  }
  assert.ok(!fs.existsSync(JSON.parse(fs.readFileSync(h.log, 'utf8')).cwd));
});

test('local CI joins stdout and stderr by whole lines, so a stderr line cannot split a secret', (t) => {
  // Like a Python or cargo step writing to pipes: stdout flushes a block that ends inside a token,
  // stderr reports the failure before the rest of that line arrives, and both end without a newline.
  const h = fixture(t, `
const fs = require('node:fs');
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // wait-allow: the gate must read each write before the other stream writes, the condition under test
const token = process.env.CI_FIXTURE_TOKEN;
fs.writeSync(1, 'line 1\\nline 2\\ntoken ' + token.slice(0, 12));
pause();
fs.writeSync(2, '! FAILING STEP: unit tests\\n');
pause();
fs.writeSync(1, token.slice(12) + ' end\\nline 3\\n');
fs.writeSync(1, 'unfinished out');
fs.writeSync(2, 'unfinished err');
process.exit(1);
`);
  const token = 'ghp_T361Head' + 'T361TailBody01234567';
  h.env.CI_FIXTURE_TOKEN = token;
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
  const log = fs.readFileSync(path.join(h.state, e.local_ci.log), 'utf8');
  for (const text of [log, e.local_ci.output_tail]) {
    assert.match(text, /^token \[redacted:CI_FIXTURE_TOKEN\] end$/m, text);
    assert.match(text, /^! FAILING STEP: unit tests$/m, text);
    assert.match(text, /^unfinished out$/m, text);
    assert.match(text, /^unfinished err$/m, text);
    // Each line of one stream keeps its place; the stderr line comes where its newline arrived.
    const at = ['line 2', '! FAILING STEP', 'token [redacted', 'line 3'].map((s) => text.indexOf(s));
    assert.deepEqual([...at].sort((a, b) => a - b), at, text);
  }
  const stored = [log, r.stdout, r.stderr, JSON.stringify(e), StateFiles.logText(h.state)].join('\n');
  assert.ok(!stored.includes('T361Head'), 'the first half of the token leaked');
  assert.ok(!stored.includes('T361TailBody'), 'the second half of the token leaked');
});

test('local CI keeps the newest five runs of a task and leaves other tasks\' runs', (t) => {
  const h = fixture(t);
  const logs = path.join(h.state, 'logs');
  const store = path.join(h.state, 'ci-artifacts');
  const old = Date.now() / 1000 - 3600;
  for (const name of [...Array.from({ length: 6 }, (_, i) => `ci-T1-0123456789-old${i}`), 'ci-T12-0123456789-other']) {
    for (const dir of [logs, store]) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'output.log'), name);
    }
    // old0 is the oldest; each later one is a minute newer.
    const at = old + Number(/old(\d)$/.exec(name)?.[1] ?? 0) * 60;
    fs.utimesSync(path.join(logs, name), at, at);
  }
  const e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.ok, true);
  const run = path.basename(path.dirname(e.local_ci.log));
  const left = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('ci-T1-')).sort();
  assert.deepEqual(left(logs), [run, 'ci-T1-0123456789-old2', 'ci-T1-0123456789-old3', 'ci-T1-0123456789-old4', 'ci-T1-0123456789-old5'].sort());
  assert.deepEqual(left(store), ['ci-T1-0123456789-old2', 'ci-T1-0123456789-old3', 'ci-T1-0123456789-old4', 'ci-T1-0123456789-old5']);
  for (const dir of [logs, store]) assert.ok(fs.existsSync(path.join(dir, 'ci-T12-0123456789-other')));
});

test('conflicting merged trees fail before running the local command', (t) => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.repo, 'head.txt'), 'conflict\n');
  h.git(['commit', '-qam', 'base conflicts']);
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /merge|conflict/);
  assert.ok(!fs.existsSync(h.log));
});

test('changed local CI policy invalidates its earlier receipt', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: h.command, timeout: 10 })]);
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /configured command or timeout/);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [...h.command, 'extra'], timeout: 10 })]);
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /configured command or timeout/);
  h.ok(['project', 'set', '--ci-local', 'null']);
  assert.equal(h.run(['accept', 'T1']).code, 1);
});

test('local CI selects kind args, replacement commands and the default with audited variants', (t) => {
  const h = fixture(t, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n");
  const local = {
    command: h.command, timeout: 5,
    by_kind: {
      docs: { args: ['--native-extended', '', 'literal; $(exit 1)'] },
      ops: { command: [process.execPath, 'ci.js', h.log, '--lab'], timeout: 10 },
    },
  };
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  for (const [kind, variant, command, timeout] of [
    ['docs', 'kind:docs', [...h.command, ...local.by_kind.docs.args], 5],
    ['ops', 'kind:ops', local.by_kind.ops.command, 10],
    ['research', 'default', h.command, 5],
  ]) {
    const before = h.json(['task', 'show', 'T1']);
    changeKind(h, kind);
    const reworked = h.json(['task', 'show', 'T1']);
    assert.equal(reworked.revision, before.revision + 1);
    assert.equal(reworked.gates.gates.find(g => g.type === 'review').ok, false);
    assert.deepEqual(reworked.evidence, before.evidence);
    h.reviewer('T1', 'reviewer', h.sha);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', h.sha, '--revision', h.revision('T1'), '--agent', 'reviewer']);
    const e = h.json(['check', 'ci', 'T1']);
    assert.equal(e.revision, reworked.revision);
    assert.equal(e.receipt.variant, variant);
    assert.deepEqual(e.receipt.command, command);
    assert.equal(e.receipt.timeout, timeout);
    assert.deepEqual(JSON.parse(fs.readFileSync(h.log, 'utf8')), command.slice(3));
    const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.findLast((v) => v.cmd === 'check ci').detail.receipt, e.receipt);
    const gates = h.json(['task', 'show', 'T1']).gates;
    assert.equal(gates.gates.find(g => g.type === 'ci').ok, true);
    assert.equal(gates.ok, kind !== 'research');
    if (kind === 'research') assert.equal(gates.gates.find(g => g.type === 'sources').ok, false);
  }
});

test('changing kind, which can select a different local CI variant, is the orchestrator\'s or the owner\'s', (t) => {
  const h = fixture(t);
  const local = {
    command: h.command, timeout: 5,
    by_kind: { docs: { args: ['--lab'] }, ops: { args: ['--s3'] } },
  };
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  // A submitted task refuses any kind change, so the kind moves while it waits for rework.
  h.ok(['rework', 'T1', '--reason', 'retier the local check', '--agent', 'owner']);
  const tasks = h.readState('tasks.json');
  const events = StateFiles.logText(h.state);
  const denied = h.run(['task', 'update', 'T1', '--kind', 'ops', '--agent', 'worker']);
  assert.equal(denied.code, 1, denied.stderr);
  assert.match(denied.stderr, /only the orchestrator or the owner/);
  assert.deepEqual(h.readState('tasks.json'), tasks);
  assert.equal(StateFiles.logText(h.state), events);

  const override = { args: ['--custom'] };
  h.ok(['task', 'update', 'T1', '--ci-local', JSON.stringify(override)]);
  const allowed = h.run(['task', 'update', 'T1', '--kind', 'ops', '--agent', 'orchestrator']);
  assert.equal(allowed.code, 0, allowed.stderr);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.sha]);
  const e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.receipt.variant, 'task:T1');
  assert.deepEqual(e.receipt.command, [...h.command, ...override.args]);
});

test('owner task override takes precedence and clearing restores the kind variant', (t) => {
  const h = fixture(t);
  const local = { command: h.command, timeout: 5, by_kind: { docs: { args: ['--lab'] } } };
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  h.ok(['check', 'ci', 'T1']);
  const override = { args: ['--s3'] };
  const updated = h.json(['task', 'update', 'T1', '--ci-local', JSON.stringify(override)]);
  assert.deepEqual(updated.ci_local, override);
  assert.match(h.ok(['task', 'show', 'T1']), /ci\.local override:/);
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /receipt.*variant/);
  let e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.receipt.variant, 'task:T1');
  assert.deepEqual(e.receipt.command, [...h.command, '--s3']);
  assert.equal(e.receipt.timeout, 5);

  local.by_kind.docs = { args: ['--native-extended'] };
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true, 'unselected kind policy does not invalidate the override');
  const replacement = { command: [...h.command, '--lab'], timeout: 10 };
  h.ok(['task', 'update', 'T1', '--ci-local', JSON.stringify(replacement)]);
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /configured command or timeout/);
  e = h.json(['check', 'ci', 'T1']);
  assert.deepEqual(e.receipt.command, replacement.command);
  assert.equal(e.receipt.timeout, 10);

  const cleared = h.json(['task', 'update', 'T1', '--ci-local', 'null']);
  assert.ok(!Object.hasOwn(cleared, 'ci_local'));
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /receipt.*variant/);
  e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.receipt.variant, 'kind:docs');
  assert.deepEqual(e.receipt.command, [...h.command, '--native-extended']);
  h.ok(['accept', 'T1']);
  const refused = h.run(['task', 'update', 'T1', '--ci-local', JSON.stringify(override)]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /accepted.*local CI override/);
});

test('kind variants with identical argv cannot reuse receipts or merge under a different variant', (t) => {
  const h = mergeFixture(t);
  const local = { command: h.command, timeout: 5, by_kind: { docs: { args: [] }, ops: { args: [] } } };
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  const previousCI = h.json(['check', 'ci', 'T1']);
  changeKind(h, 'ops');
  const reworked = h.json(['task', 'show', 'T1']);
  assert.equal(reworked.revision, previousCI.revision + 1);
  assert.equal(reworked.gates.gates.find(g => g.type === 'ci').ok, false);
  assert.deepEqual({ task: reworked.id, ...reworked.evidence.find(e => e.type === 'ci') }, previousCI);
  h.reviewer('T1', 'reviewer', h.sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', h.sha, '--revision', h.revision('T1'), '--agent', 'reviewer']);
  h.ok(['check', 'ci', 'T1']);
  delete local.by_kind.ops;
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /receipt.*variant/);
  local.by_kind.ops = { args: [] };
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  h.ok(['accept', 'T1']);
  delete local.by_kind.ops;
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  const refused = h.run(['merge', 'T1']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /receipt.*variant/);
  assert.ok(!fs.existsSync(h.merged), 'GitHub merge never ran');
  h.ok(['check', 'ci', 'T1']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
});

test('local CI variant settings validate atomically and task overrides require explicit owner identity', (t) => {
  const h = fixture(t);
  const project = h.readState('project.json');
  const tasks = h.readState('tasks.json');
  const audit = StateFiles.logText(h.state);
  const invalid = [null, [], {}, { args: 'x' }, { args: [2] }, { args: ['\0'] },
    { command: [] }, { command: [' '] }, { command: ['node', '\0'] },
    { command: ['node'], args: [] }, { args: [], timeout: 0 },
    { args: [], timeout: 2147483648 }, { args: [], typo: true }];
  for (const by_kind of [null, [], { tooling: { args: [] } }, ...invalid.map((v) => ({ docs: v }))]) {
    const r = h.run(['project', 'set', '--name', 'changed', '--ci-local', JSON.stringify({ command: h.command, timeout: 5, by_kind })]);
    assert.equal(r.code, 2, JSON.stringify(by_kind));
    assert.match(r.stderr, /--ci-local/);
    assert.deepEqual(h.readState('project.json'), project);
  }
  for (const override of ['{', ...invalid.filter((v) => v !== null).map((v) => JSON.stringify(v))]) {
    const r = h.run(['task', 'update', 'T1', '--title', 'changed', '--ci-local', override]);
    assert.equal(r.code, 2, override);
    assert.match(r.stderr, /--ci-local/);
    assert.deepEqual(h.readState('tasks.json'), tasks);
  }
  for (const value of ['{"args":["--s3"]}', 'null']) {
    for (const identity of [
      { flags: ['--agent', 'worker'], env: {}, code: 1, pattern: /only the orchestrator or the owner/ },
      { flags: [], env: { TOWER_CRANE_AGENT: '' }, code: 2, pattern: /no agent/ },
    ]) {
      const r = h.run(['task', 'update', 'T1', '--ci-local', value, ...identity.flags], { env: identity.env });
      assert.equal(r.code, identity.code);
      assert.match(r.stderr, identity.pattern);
      assert.deepEqual(h.readState('tasks.json'), tasks);
    }
  }
  assert.equal(StateFiles.logText(h.state), audit);
  assert.match(h.ok(['task', 'update', '--help']), /--ci-local JSON/);
});

test('malformed task override fails local CI closed before command execution', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  fs.rmSync(h.log);
  const tasks = h.readState('tasks.json');
  tasks.tasks[0].ci_local = { args: 'invalid' };
  h.writeState('tasks.json', tasks);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false);
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /invalid.*override/);
  assert.ok(!fs.existsSync(h.log));
});

test('local CI runs on a clean checkout of the merge, so a clean-tree check passes', (t) => {
  // Shaped like ginza's tools/check.py working_tree_clean.
  const h = fixture(t, `
const cp = require('node:child_process');
cp.execFileSync('git', ['diff', '--quiet', 'HEAD']);
cp.execFileSync('git', ['diff', '--cached', '--quiet']);
if (cp.execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}) !== '') process.exit(3);
`);
  const e = h.json(['check', 'ci', 'T1', '--agent', 'checker']);
  assert.equal(e.ok, true, e.summary);
  assert.equal(e.receipt.exit, 0);
  assert.equal(e.receipt.head_sha, h.sha);
  // The same base and head give the same merge commit.
  assert.equal(h.json(['check', 'ci', 'T1', '--agent', 'checker']).receipt.merge_sha, e.receipt.merge_sha);
});

test('a signed base under log.showSignature still gives the merge commit its time', (t) => {
  const h = fixture(t);
  h.git(['config', 'log.showSignature', 'true']);
  // A signature header is enough: git reports its verification before the commit's own fields.
  const body = `tree ${h.git(['rev-parse', 'main^{tree}'])}\nparent ${h.baseSha}\n`
    + 'author a <a@example.com> 1700000000 +0000\ncommitter a <a@example.com> 1700000000 +0000\n'
    + 'gpgsig -----BEGIN SSH SIGNATURE-----\n U1NIU0lH\n -----END SSH SIGNATURE-----\n\nsigned base\n';
  const signed = require('node:child_process').execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'],
    { cwd: h.repo, env: h.env, input: body, encoding: 'utf8' }).trim();
  h.git(['update-ref', 'refs/heads/main', signed]);
  assert.match(h.git(['show', '-s', '--format=%ct', signed]), /signature/i, 'the fixture shows a signature line');
  const e = h.json(['check', 'ci', 'T1', '--agent', 'checker']);
  assert.equal(e.ok, true, e.summary);
  assert.equal(e.receipt.base_sha, signed);
});

test('the merge reads .gitattributes from the head, so its merge drivers apply', (t) => {
  const h = fixture(t);
  h.git(['switch', '-q', 'local-change']);
  fs.writeFileSync(path.join(h.repo, '.gitattributes'), 'notes.txt merge=union\n');
  fs.writeFileSync(path.join(h.repo, 'notes.txt'), 'head\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'head notes']);
  const head = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  fs.writeFileSync(path.join(h.repo, 'notes.txt'), 'base\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base notes']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', head]);
  const e = h.json(['check', 'ci', 'T1', '--agent', 'checker']);
  assert.equal(e.ok, true, e.summary);
  assert.deepEqual(h.git(['show', `${e.receipt.tree_hash}:notes.txt`]).split('\n').sort(), ['base', 'head']);
});

test('tracked changes made by a successful local check cannot pass', (t) => {
  const h = fixture(t, "require('node:fs').writeFileSync('head.txt', 'changed\\n');\n");
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /changed tracked sources/);
  const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(e.receipt.exit, 0);
  assert.equal(e.ok, false);
});

test('a newer fetched base invalidates a local receipt while preserving the local branch', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  fs.writeFileSync(path.join(h.repo, 'remote.txt'), 'remote\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'remote base advances']);
  const remote = h.git(['rev-parse', 'HEAD']);
  h.git(['update-ref', 'refs/remotes/origin/main', remote]);
  h.git(['reset', '--hard', h.baseSha]);
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /current merged tree/);
  h.ok(['accept', 'T1']);
  const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(e.receipt.base_sha, remote);
  assert.equal(h.git(['rev-parse', 'main']), h.baseSha);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

test('project settings validate local argv and timeout, preserve CI siblings and allow clearing', (t) => {
  const h = makeRepo(t);
  h.init(['--ci-ignore-apps', '["claude"]']);
  const original = h.readState('project.json');
  for (const local of ['{', '[]', '{}', '{"command":[],"timeout":1}', '{"command":[""],"timeout":1}',
    '{"command":["node",2],"timeout":1}', '{"command":["node"]}', '{"command":["node"],"timeout":0}',
    '{"command":["node"],"timeout":"1"}', '{"command":["node"],"timeout":1,"artifacts":["/abs/*.json"]}',
    '{"command":["node"],"timeout":1,"artifacts":["../up/*.json"]}', '{"command":["node"],"timeout":1,"artifacts":".local"}',
    '{"command":["node"],"timeout":1,"artifact_pattern":"("}', '{"command":["node"],"timeout":1,"artifact_pattern":""}',
    '{"command":["node"],"timeout":1,"receipts":["../up/*.json"]}']) {
    const r = h.run(['project', 'set', '--ci-local', local]);
    assert.equal(r.code, 2, JSON.stringify({ local, ...r }));
    assert.match(r.stderr, /--ci-local/);
    assert.deepEqual(h.readState('project.json'), original);
  }
  const local = { command: ['python3', 'tools/check.py', ''], timeout: 120 };
  const set = h.json(['project', 'set', '--ci-local', JSON.stringify(local)]);
  assert.deepEqual(set.ci, { ignore_apps: ['claude'], local });
  assert.match(h.ok(['project', 'show']), /ci\.local:/);
  const cleared = h.json(['project', 'set', '--ci-local', 'null']);
  assert.deepEqual(cleared, original);
  assert.match(h.ok(['project', 'set', '--help']), /--ci-local JSON/);
});
