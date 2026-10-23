'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTaskRepo, pinRung } = require('./helpers');
const { waitUntil, childClosed } = require('./signals');

test('startup receipt consumption cannot fail its publisher', async (t) => {
  for (const [mode, role, hooks, error] of [
    ['small', 'small', {}, null],
    ['worker', 'worker', {}, null],
    ['handshake', 'worker', { HOOK_NO_SH: '1' }, null],
    ['startup-error', 'small', {}, 'planted startup failure'],
  ]) {
    await t.test(mode, async (row) => {
      const h = makeTaskRepo(row, [{
        args: ['--title', 'Receipt race', '--acceptance', 'startup finishes'],
        brief: 'Prove startup receipt publication.\n',
      }]);
      const rung = role === 'small' ? 'small' : h.json(['spawn', '--task', 'T1', '--dry-run']).rung;
      pinRung(h, rung, { harness: 'command', command: [process.execPath, '-e', 'process.exit(0)', '{prompt}'] });
      const consumed = path.join(h.base, 'consumed');
      const preload = path.join(h.base, 'receipt-reader.js');
      fs.writeFileSync(preload, `
        if (process.argv[1]?.endsWith('spawn-monitor.js')) {
          const fs = require('node:fs');
          const path = require('node:path');
          const rename = fs.renameSync;
          fs.renameSync = function(from, to) {
            const result = rename.call(this, from, to);
            if (path.basename(to) !== 'started.json' || ${Boolean(error)}) return result;
            const deadline = performance.now() + 10000; // wait-allow: the receipt barrier uses the production startup window.
            const pause = new Int32Array(new SharedArrayBuffer(4));
            const parent = process.ppid;
            while (fs.existsSync(to)) {
              if (performance.now() >= deadline) throw new Error('dispatcher did not consume its receipt');
              if (process.ppid !== parent) throw new Error('dispatcher exited before it consumed its receipt');
              Atomics.wait(pause, 0, 0, 10); // wait-allow: publish/consume barrier bounded by the startup window.
            }
            // The reader may remove this disposable directory as soon as it sees the receipt.
            fs.rmSync(path.dirname(to), { recursive: true, force: true });
            fs.writeFileSync(${JSON.stringify(consumed)}, 'consumed');
            return result;
          };
          ${error ? `require('node:child_process').spawnSync = () => { throw new Error(${JSON.stringify(error)}); };` : ''}
        }
      `);
      const child = h.spawnCli(['spawn', ...(role === 'small' ? ['--role', 'small'] : []), '--task', 'T1', '--wait', '--json'], {
        env: { NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"` }, hooks,
      });
      let stdout = '';
      let stderr = '';
      let closed = false;
      let code;
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('close', (status) => { closed = true; code = status; });
      h.teardown.push(async () => {
        if (!closed) {
          child.kill();
          await childClosed(child);
        }
      });
      await waitUntil(() => closed || /supervisor failed:.*ENOENT/.test(stderr), {
        what: () => `receipt publication did not finish: ${stderr}`,
      });
      if (!error) assert.equal(fs.existsSync(consumed), true, `the dispatcher must consume the receipt before publication returns: ${stderr}`);
      assert.doesNotMatch(stderr, /supervisor failed:.*ENOENT/);
      assert.equal(code, error ? 1 : 0, stderr);
      if (error) assert.match(stderr, /planted startup failure/);
      else assert.equal(JSON.parse(stdout).code, 0);
    });
  }
});
