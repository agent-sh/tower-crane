'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.env.TOWER_CRANE_TEST_MISSING_STATUS) {
  const spawn = cp.spawn;
  cp.spawn = function windowsMissingCommand(file, args, opts) {
    // cmd.exe runs the command without the core limit a POSIX gate puts in front of it.
    const { CORE_LIMIT } = require('../../lib/gates/common');
    const command = typeof file === 'string' && file.startsWith(CORE_LIMIT) ? file.slice(CORE_LIMIT.length) : file;
    if (command !== 'tower-crane-missing-test-program') return spawn.call(this, file, args, opts);
    // POSIX truncates exit codes, so both exit events reproduce cmd.exe's full status.
    const diagnostic = "'tower-crane-missing-test-program' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";
    // Only the submitted head holds the change's test; the base checkout runs the same command without that failure.
    const atHead = !!opts?.cwd && fs.existsSync(path.join(opts.cwd, 'test', 'value.test.js'));
    const output = process.env.TOWER_CRANE_TEST_DIAGNOSTIC_IN_TEST && atHead ? 'not ok 1 - missing dependency breaks a test\n' : '';
    const child = spawn.call(this, process.execPath, ['-e',
      `process.stdout.write(${JSON.stringify(output)}); process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(1);`], { ...opts, shell: false });
    const emit = child.emit;
    child.emit = function windowsExit(event, ...values) {
      if (['exit', 'close'].includes(event) && values[0] === 1 && !values[1]) values[0] = Number(process.env.TOWER_CRANE_TEST_MISSING_STATUS);
      return emit.call(this, event, ...values);
    };
    return child;
  };
}
