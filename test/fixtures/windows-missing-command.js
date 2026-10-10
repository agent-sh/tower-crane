'use strict';

const cp = require('node:child_process');

if (process.env.TOWER_CRANE_TEST_MISSING_STATUS) {
  const spawn = cp.spawn;
  cp.spawn = function windowsMissingCommand(file, args, opts) {
    if (file !== 'tower-crane-missing-test-program') return spawn.call(this, file, args, opts);
    // POSIX truncates exit codes, so both exit events reproduce cmd.exe's full status.
    const diagnostic = "'tower-crane-missing-test-program' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";
    const output = process.env.TOWER_CRANE_TEST_DIAGNOSTIC_IN_TEST ? 'not ok 1 - missing dependency breaks a test\n' : '';
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
