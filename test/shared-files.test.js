'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');
const { readText, escapeTableCell } = require('../scripts/text');

function fixture(t, { crlfProtected = false, windowsCheckout = false } = {}) {
  const h = makeRepo(t);
  if (windowsCheckout) h.git(['config', 'core.autocrlf', 'true']);
  for (const name of ['bin', 'lib', 'scripts', 'docs', 'changelog.d']) {
    fs.cpSync(path.join(ROOT, name), path.join(h.repo, name), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(h.repo, 'CHANGELOG.md'));
  fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(h.repo, '.gitattributes'));
  if (windowsCheckout) {
    for (const name of ['bin/tower-crane.js', 'docs/cli.md']) {
      const file = path.join(h.repo, name);
      fs.writeFileSync(file, readText(file).replace(/\n/g, '\r\n'));
    }
  }
  if (crlfProtected) {
    for (const name of ['CHANGELOG.md', 'changelog.d/T86.md']) {
      const file = path.join(h.repo, name);
      fs.writeFileSync(file, readText(file).replace(/\n/g, '\r\n'));
    }
  }
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'shared file fixture']);
  if (windowsCheckout) {
    for (const name of ['bin/tower-crane.js', 'docs/cli.md']) fs.rmSync(path.join(h.repo, name));
    h.git(['checkout', '--', 'bin/tower-crane.js', 'docs/cli.md']);
  }
  const base = h.git(['rev-parse', 'HEAD']);
  const script = (name, args = []) => cp.spawnSync(process.execPath,
    [path.join(h.repo, 'scripts', name), ...args],
    { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 30000 });
  const check = () => script('check-shared-files.js', ['--base', base]);
  const write = (name, text) => fs.writeFileSync(path.join(h.repo, name), text);
  const read = (name) => readText(path.join(h.repo, name));
  const change = () => {
    write('changelog.d/T999.md', '- A separate task change.\n');
  };
  return { h, script, check, write, read, change };
}

test('generated command rows match real CLI help, preserve details and reject drift', (t) => {
  const f = fixture(t);
  assert.equal(f.check().status, 0);
  const bin = path.join(f.h.repo, 'bin', 'tower-crane.js');
  const { COMMANDS } = require(bin);
  const docs = f.read('docs/cli.md');
  for (const command of COMMANDS) {
    const help = cp.spawnSync(process.execPath, [bin, ...command.name.split(' '), '--help'],
      { cwd: f.h.repo, env: f.h.env, encoding: 'utf8', timeout: 30000 });
    assert.equal(help.status, 0, help.stderr);
    const usage = command.name + (command.usage ? ` ${command.usage}` : '');
    assert.ok(help.stdout.startsWith(`usage: tower-crane ${usage}\n`));
    assert.ok(docs.includes(`| \`${escapeTableCell(usage)}\` | ${escapeTableCell(command.description || command.summary)} |`));
  }
  f.write('docs/cli.md', docs.replace('| append a note |', '| stale summary |'));
  const drift = f.check();
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /command rows drifted/);
  assert.equal(f.script('cli-docs.js').status, 0);
  assert.equal(f.read('docs/cli.md'), docs);

  f.change();
  f.write('bin/tower-crane.js', f.read('bin/tower-crane.js').replace('append a note', 'append a task note'));
  assert.equal(f.check().status, 1, 'a metadata change requires regeneration');
  assert.equal(f.script('cli-docs.js').status, 0);
  assert.equal(f.check().status, 0);
  assert.ok(f.read('docs/cli.md').includes('| append a task note |'));
  const prose = (text) => text.replace(/<!-- commands:[^\n]+:start -->[\s\S]*?<!-- commands:[^\n]+:end -->/g, '');
  assert.equal(prose(f.read('docs/cli.md')), prose(docs), 'all contract descriptions and authority rules survive regeneration');
  assert.ok(f.read('docs/cli.md').includes('create the state directory and `project.json` with the default harness and ladder'), 'long descriptions are preserved in generated rows');

  for (const file of ['bin/tower-crane.js', 'docs/cli.md', 'changelog.d/T999.md']) {
    f.write(file, f.read(file).replace(/\r?\n/g, '\r\n'));
  }
  assert.equal(f.check().status, 0, 'Windows line endings do not cause drift');
});

test('long command descriptions are generated from metadata while CLI help keeps the summary', (t) => {
  const f = fixture(t);
  const description = 'append a note with the supplied identity';
  f.write('bin/tower-crane.js', f.read('bin/tower-crane.js').replace("summary: 'append a note',", `summary: 'append a note', description: ${JSON.stringify(description)},`));
  const stale = f.check();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /command rows drifted/);
  assert.equal(f.script('cli-docs.js').status, 0);
  assert.ok(f.read('docs/cli.md').includes(`| ${description} |`));
  const bin = path.join(f.h.repo, 'bin', 'tower-crane.js');
  const help = cp.spawnSync(process.execPath, [bin, 'task', 'note', '--help'],
    { cwd: f.h.repo, env: f.h.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\nappend a note\n/);
  assert.ok(!help.stdout.includes(description));
  f.write('bin/tower-crane.js', f.read('bin/tower-crane.js').replace(JSON.stringify(description), JSON.stringify(description + ' and text')));
  assert.equal(f.script('cli-docs.js', ['--check']).status, 1, 'a description change makes docs stale');
  assert.equal(f.script('cli-docs.js').status, 0);
  assert.ok(f.read('docs/cli.md').includes(`| ${description} and text |`));
});

for (const windowsCheckout of [false, true]) {
  test(`independent task list and task note flag additions merge without generated-doc conflicts (${windowsCheckout ? 'Windows checkout' : 'LF checkout'})`, (t) => {
    const f = fixture(t, { windowsCheckout });
    for (const name of ['bin/tower-crane.js', 'docs/cli.md']) {
      assert.ok(!fs.readFileSync(path.join(f.h.repo, name), 'utf8').includes('\r'), `${name} checks out as LF`);
    }
    const base = f.h.git(['rev-parse', 'HEAD']);
    const addFlag = (command, flag, fragment) => {
      let found = false;
      const source = f.read('bin/tower-crane.js').split('\n').map((line) => {
        if (!line.includes(`name: '${command}'`)) return line;
        found = true;
        line = line.replace(/usage: '([^']*)'/, (_, usage) => `usage: '${usage} [--${flag} LABEL]'`);
        const spec = `'${flag}': str('LABEL', 'label for ${command}')`;
        return line.includes('flags: {') ? line.replace('flags: {', `flags: { ${spec},`)
          : line.replace(', run:', `, flags: { ${spec} }, run:`);
      }).join('\n');
      assert.ok(found, command);
      f.write('bin/tower-crane.js', source);
      f.write(`changelog.d/${fragment}.md`, `- Add --${flag} to ${command}.\n`);
      assert.equal(f.script('cli-docs.js').status, 0);
      const check = f.check();
      assert.equal(check.status, 0, check.stderr);
      f.h.git(['add', '.']);
      f.h.git(['commit', '-qm', `add ${command} flag`]);
    };

    f.h.git(['checkout', '-qb', 'task-list-flag', base]);
    addFlag('task list', 'list-label', 'T901');
    f.h.git(['checkout', '-qb', 'task-note-flag', base]);
    addFlag('task note', 'note-label', 'T902');
    const merge = cp.spawnSync('git', ['merge', '--no-ff', '-m', 'combine independent command flags', 'task-list-flag'],
      { cwd: f.h.repo, env: f.h.env, encoding: 'utf8', timeout: 30000 });
    assert.equal(merge.status, 0, merge.stdout + merge.stderr);
    assert.equal(f.h.git(['diff', '--name-only', '--diff-filter=U']), '', 'no file has a merge conflict');
    const check = f.check();
    assert.equal(check.status, 0, check.stderr);
    const merged = f.read('docs/cli.md');
    assert.ok(merged.includes('task list [--status S] [--list-label LABEL]'));
    assert.ok(merged.includes('task note ID TEXT [--note-label LABEL]'));
    assert.ok(fs.existsSync(path.join(f.h.repo, 'changelog.d/T901.md')));
    assert.ok(fs.existsSync(path.join(f.h.repo, 'changelog.d/T902.md')));
    assert.equal(f.script('cli-docs.js').status, 0);
    assert.equal(f.read('docs/cli.md'), merged, 'the automatic merge is already canonical');
  });
}

test('the shared file check enforces sorted single-line command entries with space between them', (t) => {
  const f = fixture(t);
  const source = f.read('bin/tower-crane.js');
  const first = source.match(/const COMMANDS = \[\n(  \{[^\n]+\n)\n(  \{[^\n]+\n)/);
  assert.ok(first);
  f.write('bin/tower-crane.js', source.replace(first[0], 'const COMMANDS = [\n' + first[2] + '\n' + first[1]));
  const unsorted = f.check();
  assert.equal(unsorted.status, 1);
  assert.match(unsorted.stderr, /sorted by name/);
  f.write('bin/tower-crane.js', source.replace(first[1], first[1].replace('summary:', '\n    summary:')));
  const multiline = f.check();
  assert.equal(multiline.status, 1);
  assert.match(multiline.stderr, /one entry per line/);
  f.write('bin/tower-crane.js', source.replace(first[0], 'const COMMANDS = [\n' + first[1] + first[2]));
  const adjacent = f.check();
  assert.equal(adjacent.status, 1);
  assert.match(adjacent.stderr, /blank line/);
});

test('the shared file check rejects bare stdin reads in lib and bin, and points to readStdin', (t) => {
  const f = fixture(t);
  f.change();
  assert.equal(f.check().status, 0);
  f.write('lib/probe.js', "module.exports = require('node:fs').readFileSync(0, 'utf8');\n");
  const bare = f.check();
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /lib\/probe\.js:1 reads stdin with readFileSync\(0\); use readStdin\(\) from lib\/util\.js/);
  f.write('lib/probe.js', "module.exports = require('./util').readStdin();\n");
  assert.equal(f.check().status, 0);
  f.write('bin/probe.js', "require('node:fs').readFileSync('/dev/stdin');\n");
  const device = f.check();
  assert.equal(device.status, 1);
  assert.match(device.stderr, /bin\/probe\.js:1 reads stdin/);
  f.write('bin/probe.js', "require('../lib/util').readStdin();\n");
  assert.equal(f.check().status, 0);
  f.write('lib/probe.js', "const fs = require('node:fs');\nmodule.exports = fs.readFileSync(\n  0,\n  'utf8'\n);\n");
  const wrapped = f.check();
  assert.equal(wrapped.status, 1, 'a call split across lines is still a bare read');
  assert.match(wrapped.stderr, /lib\/probe\.js:2 reads stdin with readFileSync\(0\); use readStdin\(\) from lib\/util\.js/);
  f.write('lib/probe.js', "require('./util').readStdin();\n");
  f.write('bin/probe.js', "require('node:fs').readFileSync(\n  '/dev/stdin',\n  'utf8'\n);\n");
  const wrappedDevice = f.check();
  assert.equal(wrappedDevice.status, 1, 'a /dev/stdin call split across lines is still a bare read');
  assert.match(wrappedDevice.stderr, /bin\/probe\.js:1 reads stdin/);
  f.write('bin/probe.js', "require('../lib/util').readStdin();\n");
  assert.equal(f.check().status, 0);
  f.write('lib/util.js', f.read('lib/util.js') + "\nconst raw = require('node:fs').readFileSync(0, 'utf8');\n");
  assert.equal(f.check().status, 0, 'lib/util.js is where readStdin reads fd 0');
});

test('tasks add fragments instead of editing the archive or an existing change', (t) => {
  const f = fixture(t, { crlfProtected: true });
  f.write('README.md', '# changed\n');
  const missing = f.check();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /every change needs a new/);
  f.change();
  assert.equal(f.check().status, 0, 'unstaged fragments count during local checks');
  f.h.git(['add', 'changelog.d/T999.md']);
  assert.equal(f.check().status, 0, 'tracked fragments count in CI');
  const archive = fs.readFileSync(path.join(f.h.repo, 'CHANGELOG.md'));
  assert.ok(archive.includes(Buffer.from('\r\n')), 'the baseline uses raw CRLF on every platform');
  f.write('CHANGELOG.md', Buffer.concat([archive, Buffer.from('- Direct edit.\n')]));
  const direct = f.check();
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /do not edit CHANGELOG.md/);
  f.write('CHANGELOG.md', archive);
  assert.equal(f.check().status, 0, 'the archive snapshot restores its original bytes');
  f.write('CHANGELOG.md', f.read('CHANGELOG.md'));
  const lineEndings = f.check();
  assert.equal(lineEndings.status, 1);
  assert.match(lineEndings.stderr, /do not edit CHANGELOG.md/, 'line-ending edits remain archive edits');
  f.write('CHANGELOG.md', archive);
  assert.equal(f.check().status, 0, 'restoring raw CRLF removes the line-ending edit');
  const original = fs.readFileSync(path.join(f.h.repo, 'changelog.d/T86.md'));
  f.write('changelog.d/T86.md', '- Edited another change.\n');
  const edited = f.check();
  assert.equal(edited.status, 1);
  assert.match(edited.stderr, /belongs to its original change/);
  f.write('changelog.d/T86.md', original);
  assert.equal(f.check().status, 0, 'the fragment snapshot restores its original bytes');
  fs.rmSync(path.join(f.h.repo, 'changelog.d/T86.md'));
  assert.equal(f.check().status, 1, 'existing fragments cannot be deleted');
  f.write('changelog.d/T86.md', original);
  assert.equal(f.check().status, 0, 'recreating the fragment preserves its original bytes');
  f.write('changelog.d/T999.md', '\n');
  const empty = f.check();
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /nonempty Markdown bullet/);
});

test('release assembly is deterministic and leaves the archive and fragments unchanged', (t) => {
  const f = fixture(t);
  f.change();
  const archive = f.read('CHANGELOG.md');
  const release = f.script('changelog.js');
  assert.equal(release.status, 0, release.stderr);
  const entries = ['T999.md', ...fs.readdirSync(path.join(f.h.repo, 'changelog.d')).filter((name) => !['README.md', 'T999.md'].includes(name)).sort()];
  const expected = '# Changelog\n\n' + [
    ...entries.map((name) => f.read(`changelog.d/${name}`).trim()),
    archive.slice('# Changelog\n'.length).trim(),
  ].join('\n\n') + '\n';
  assert.equal(release.stdout, expected);
  assert.equal(f.script('changelog.js').stdout, expected);
  assert.equal(f.read('CHANGELOG.md'), archive);
  assert.deepEqual(fs.readdirSync(path.join(f.h.repo, 'changelog.d')).filter((name) => name !== 'README.md').sort(), [...entries].sort());
  assert.equal(f.check().status, 0);
});

test('this repository keeps generated rows and its fragment instructions local', () => {
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-shared-files.js')],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TOWER_CRANE_CHANGE_BASE: '' }, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'tower-crane-work', 'SKILL.md'), 'utf8');
  assert.match(skill, /update the changelog the repository's way/);
  assert.doesNotMatch(skill, /changelog\.d|COMMANDS|check:shared|docs:generate/);
  const rules = readText(path.join(ROOT, 'AGENTS.md'));
  assert.match(rules, /Add `changelog\.d\/<task-or-pr>\.md`/);
  assert.match(rules, /leave `CHANGELOG\.md` and existing fragments unchanged/);
  assert.match(rules, /npm run check:shared -- --base origin\/BASE/);
});

test('CRLF source, docs, fragments and archive use the same canonical text in real commands', (t) => {
  const f = fixture(t);
  f.change();
  const docs = f.read('docs/cli.md');
  const archive = f.read('CHANGELOG.md');
  const files = ['bin/tower-crane.js', 'docs/cli.md', 'changelog.d/T999.md', 'CHANGELOG.md'];
  for (const file of files) f.write(file, f.read(file).replace(/\n/g, '\r\n'));
  f.write('changelog.d/T999.md', '- A separate task change.\r\nContinuation\ron its own line.\r\n');
  const before = files.map((file) => fs.readFileSync(path.join(f.h.repo, file)));
  assert.equal(f.script('cli-docs.js', ['--check']).status, 0);
  assert.equal(f.script('check-shared-files.js').status, 0);
  const release = f.script('changelog.js');
  assert.equal(release.status, 0, release.stderr);
  assert.ok(!release.stdout.includes('\r'));
  assert.ok(release.stdout.includes(archive.slice('# Changelog\n'.length).trim()));
  assert.ok(release.stdout.includes('- A separate task change.'));
  for (let i = 0; i < files.length; i++) {
    assert.deepEqual(fs.readFileSync(path.join(f.h.repo, files[i])), before[i], 'checks and assembly leave raw CRLF files unchanged');
  }
  assert.equal(f.script('cli-docs.js').status, 0);
  assert.equal(fs.readFileSync(path.join(f.h.repo, 'docs/cli.md'), 'utf8'), docs, 'generation writes canonical LF output');
});

test('generated table cells escape every backslash and pipe in one pass', (t) => {
  const f = fixture(t);
  const summary = String.raw`paths C:\one\|two|three`;
  f.write('bin/tower-crane.js', f.read('bin/tower-crane.js').replace("'append a note'", JSON.stringify(summary)));
  assert.equal(f.script('cli-docs.js').status, 0);
  assert.ok(f.read('docs/cli.md').includes(String.raw`| paths C:\\one\\\|two\|three |`));
  assert.equal(f.script('cli-docs.js', ['--check']).status, 0);
});

test('release fragments follow landing history rather than task or PR filename order', (t) => {
  const f = fixture(t);
  f.h.git(['rm', 'changelog.d/T86.md', 'changelog.d/T100.md']);
  f.h.git(['commit', '-qm', 'prepare release history']);
  const oldest = ['T9.md', 'T86.md', 'T100.md', '123.md'];
  for (const name of oldest) {
    f.write(`changelog.d/${name}`, `- Landed ${name}.\n`);
    f.h.git(['add', `changelog.d/${name}`]);
    f.h.git(['commit', '-qm', `land ${name}`]);
  }
  f.h.git(['checkout', '-qb', 'earlier-fragment']);
  f.write('changelog.d/T7.md', '- Landed T7.md.\n');
  f.h.git(['add', 'changelog.d/T7.md']);
  f.h.git(['commit', '-qm', 'author T7 before T2']);
  f.h.git(['checkout', 'main']);
  f.write('changelog.d/T2.md', '- Landed T2.md.\n');
  f.h.git(['add', 'changelog.d/T2.md']);
  f.h.git(['commit', '-qm', 'land T2 before T7']);
  f.h.git(['merge', '--no-ff', '-m', 'land T7 after T2', 'earlier-fragment']);
  const release = f.script('changelog.js');
  assert.equal(release.status, 0, release.stderr);
  const bullets = release.stdout.split('\n').filter((line) => line.startsWith('- Landed '));
  assert.deepEqual(bullets, ['T7.md', 'T2.md', ...oldest.reverse()].map((name) => `- Landed ${name}.`));
});
