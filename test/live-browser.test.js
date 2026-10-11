'use strict';

// Real harness calls cost tokens and need host sandbox access and a login.
// Run this opt-in probe from an unsandboxed session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { makeRepo, ROOT } = require('./helpers');
const { CHROME } = require('./browser');
const { shellQuote } = require('../lib/gates/common');
const BrowserKit = require('../lib/browser-kit');
const A = require('../lib/agents');

for (const harness of ['claude', 'codex']) {
  test(`a real sandboxed ${harness} browser worker opens the board with MCP, takes a screenshot and runs a board test`, {
    skip: process.env.TOWER_CRANE_LIVE_BROWSER !== '1' ? 'set TOWER_CRANE_LIVE_BROWSER=1 to run real sandboxed workers'
      : process.env.TOWER_CRANE_LIVE_BROWSER_HARNESS && process.env.TOWER_CRANE_LIVE_BROWSER_HARNESS !== harness ? 'another harness selected'
        : process.platform !== 'linux' && 'probe requires the Linux command sandbox',
    timeout: 300000,
  }, async (t) => {
    assert.ok(CHROME, 'install Chrome or set TOWER_CRANE_TEST_CHROME; the live probe must not skip the browser test');
    const h = makeRepo(t);
    for (const dir of ['bin', 'lib', 'agents', 'skills', 'standards', 'test']) fs.cpSync(path.join(ROOT, dir), path.join(h.repo, dir), { recursive: true });
    fs.writeFileSync(path.join(h.repo, 'browser-probe.js'), `
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
assert.equal(process.env.TOWER_CRANE_SANDBOX, '1', 'the worker must use the outer sandbox');
const screenshot = path.join(__dirname, 'board-screenshot.png');
assert.ok(process.argv[2], 'pass the screenshot file path returned by MCP');
if (path.resolve(process.argv[2]) !== screenshot) fs.copyFileSync(process.argv[2], screenshot);
assert.deepEqual([...fs.readFileSync(screenshot).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
const result = cp.spawnSync(process.execPath, [
  '--test', '--test-reporter=tap',
  '--test-name-pattern=^shared restoration reveals nested disclosures',
  path.join(__dirname, 'test', 'board.test.js'),
], { encoding: 'utf8', timeout: 300000 });
const receipt = {
  code: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
};
fs.writeFileSync(path.join(__dirname, 'browser-probe.json'), JSON.stringify(receipt));
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
const diagnostic = JSON.stringify(receipt);
assert.equal(receipt.error, undefined, 'board browser test could not run: ' + diagnostic);
assert.equal(receipt.code, 0, 'board browser test failed: ' + diagnostic);
assert.equal(receipt.stderr, '', 'board browser test emitted stderr: ' + diagnostic);
assert.match(receipt.stdout || '', /# pass 1\\b/, 'board browser test ran no passing test: ' + diagnostic);
assert.match(receipt.stdout || '', /# fail 0\\b/, 'board browser test did not report success: ' + diagnostic);
`);
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'board browser probe']);
    h.init();
    const kit = BrowserKit.servers(process.env, A.origin(process.env).home);
    assert.ok(kit.length, 'configure a browser kit server before running the live probe');
    h.ok(['browser-kit', 'set', '--servers', JSON.stringify(kit)]);
    h.ok(['task', 'add', '--title', 'Headless Chrome probe', '--kind', 'design', '--acceptance', 'MCP screenshot and one board browser test pass']);
    const model = harness === 'claude' ? ['--model', process.env.TOWER_CRANE_LIVE_MODEL || 'opus', '--clear', 'profile']
      : ['--profile', process.env.TOWER_CRANE_LIVE_PROFILE || 'sol', '--clear', 'model'];
    h.ok(['ladder', 'set', 'medium', '--harness', harness, ...model, '--clear', 'effort', '--clear', 'args', '--supervision', '{"retries":0}']);
    const wt = h.json(['worktree', 'T1']).path;
    const command = [process.execPath, path.join(wt, 'browser-probe.js')].map(shellQuote).join(' ');
    const screenshot = path.join(wt, 'board-screenshot.png');
    let browserRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/board' && /Chrome|Chromium/.test(req.headers['user-agent'] || '')) browserRequests++;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(path.join(h.state, 'sketch.html')));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/board`;
      h.ok(['brief', 'set', 'T1', '-'], {
        input: `This is a live browser kit verification fixture. First use the attached browser MCP tools (${kit.join(', ')}) to navigate to ${url} and take a PNG screenshot with filename board-screenshot.png. Use MCP for both navigation and screenshot. Then run this command with your command tool, appending the absolute screenshot file path returned by MCP as one quoted argument. The script copies that PNG into the worktree and runs one board test. Report its exit code and stop. Do not edit source files, use tower-crane, open a PR, or delegate work.\n\n${command} <screenshot-file-from-MCP>\n`,
      });
      const dry = h.json(['spawn', '--task', 'T1', '--dry-run']);
      assert.deepEqual(dry.home.mcp, kit, 'the real worker route must receive the configured kit');
      const result = await h.runAsync(['spawn', '--task', 'T1', '--wait'], {
        env: { TOWER_CRANE_TEST_CHROME: CHROME },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.ok(browserRequests > 0, 'a Chrome browser must request the board');
      assert.ok(fs.existsSync(screenshot), `the MCP screenshot must exist\n${result.stdout}\n${result.stderr}`);
      assert.deepEqual([...fs.readFileSync(screenshot).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'the screenshot is a PNG');
      const output = path.join(wt, 'browser-probe.json');
      assert.ok(fs.existsSync(output), `the worker must run the command\n${result.stdout}\n${result.stderr}`);
      const seen = JSON.parse(fs.readFileSync(output, 'utf8'));
      const diagnostic = JSON.stringify(seen);
      assert.equal(seen.error, undefined, `board browser test could not run: ${diagnostic}`);
      assert.equal(seen.code, 0, `board browser test failed: ${diagnostic}`);
      assert.equal(seen.stderr, '', `board browser test emitted stderr: ${diagnostic}`);
      assert.match(seen.stdout || '', /# pass 1\b/, `board browser test ran no passing test: ${diagnostic}`);
      assert.match(seen.stdout || '', /# fail 0\b/, `board browser test did not report success: ${diagnostic}`);
    } catch (error) {
      const logs = path.join(h.state, 'logs');
      const tail = fs.existsSync(logs) ? fs.readdirSync(logs).filter((name) => name.endsWith('.log')).map((name) =>
        `${name}:\n${fs.readFileSync(path.join(logs, name), 'utf8').slice(-16384)}`).join('\n') : '';
      t.diagnostic(`Agent log tails:\n${tail || '(no agent log)'}`);
      throw error;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
