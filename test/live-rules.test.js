'use strict';

// Runs the real claude and codex CLIs, so each costs a model call and needs a
// login: set TOWER_CRANE_LIVE_CLAUDE=1 or TOWER_CRANE_LIVE_CODEX=1
// (TOWER_CRANE_LIVE_MODEL and TOWER_CRANE_LIVE_PROFILE pick the model and
// profile). It proves what the stubs cannot: a real agent receives every rule
// file in the chain and restates its target. Each rule file holds a random
// house token only that file gives. The user's global rules live in a
// CLAUDE_CONFIG_DIR or CODEX_HOME of the test's own, which links the user's
// login and config but never writes to the user's own directories.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pinLiveRung, makeRepo } = require('./helpers');
const A = require('../lib/agents');

const LINKS = {
  claude: (dir) => ['.credentials.json', 'settings.json'].map((f) => path.join(dir, f)),
  codex: (dir) => {
    let profiles = [];
    try {
      profiles = fs.readdirSync(dir).filter((f) => /^[\w.-]+\.config\.toml$/.test(f));
    } catch {
      // No codex home.
    }
    return ['auth.json', '.env', 'config.toml', ...profiles].map((f) => path.join(dir, f));
  },
};

const word = () => crypto.randomBytes(4).toString('hex').toUpperCase();

// The agent's messages in order: claude's --output-format json writes one
// result object, codex --json one item per message.
function messages(log, harness) {
  const out = [];
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (harness === 'claude' && e?.type === 'result' && typeof e.result === 'string') out.push(e.result);
    if (harness === 'codex' && e?.type === 'item.completed' && e.item?.type === 'agent_message') out.push(e.item.text);
  }
  return out;
}

for (const harness of ['claude', 'codex']) {
  const flag = `TOWER_CRANE_LIVE_${harness.toUpperCase()}`;
  test(`a real ${harness} worker answers with every house token in the rules chain and restates its target`, {
    skip: process.env[flag] !== '1' ? `set ${flag}=1 to run against the real ${harness} CLI`
      : process.platform === 'win32' && 'the probe links the user\'s login, which needs symlinks',
    timeout: 300000,
  }, async (t) => {
    const h = makeRepo(t);
    const user = A.origin(process.env)[harness];
    const userDir = harness === 'claude' ? user.dir : user;
    const global = path.join(h.base, `user-${harness}`);
    fs.mkdirSync(global);
    for (const f of LINKS[harness](userDir)) if (fs.existsSync(f)) fs.symlinkSync(f, path.join(global, path.basename(f)));
    const tokens = { global: word(), shared: word(), parent: word(), repo: word() };
    const rule = (label) => `When asked for the ${label} house token, answer ${label}: HT-${tokens[label]}.\n`;
    const globalFile = path.join(global, harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
    fs.writeFileSync(globalFile, `${rule('global')}\n@shared.md\n`);
    fs.writeFileSync(path.join(global, 'shared.md'), rule('shared'));
    fs.writeFileSync(path.join(h.base, 'AGENTS.md'), rule('parent'));
    fs.writeFileSync(path.join(h.repo, 'AGENTS.md'), rule('repo'));
    h.git(['add', '.']);
    h.git(['commit', '-q', '-m', 'rules']);
    const goal = `keep the ${word()} ledger honest`;
    const title = `Rules check ${word()}`;
    h.init();
    h.ok(['project', 'set', '--goal', goal]);
    h.ok(['task', 'add', '--title', title, '--acceptance', 'every house token is named']);
    // The brief does not ask for the target, so a restatement proves the
    // prompt's own ## Goal instruction works.
    h.ok(['brief', 'set', 'T1', '-'], {
      input: 'Rules check set up by the owner. Name every house token your rules give (global, shared, parent and repo), one per line as label: token. Change no file, do not use tower-crane, and stop after that one answer.\n',
    });
    pinLiveRung(h, harness);
    const env = { ...h.env, [harness === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: global };
    const r = await h.runAsync(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json'], { env });
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const spawned = events.find((e) => e.cmd === 'spawn');
    assert.ok(spawned, `spawned\n${r.stderr}`);
    const log = fs.readFileSync(spawned.detail.log, 'utf8');
    assert.equal(r.code, 0, `${r.stderr}\n${log.slice(-4000)}`);

    const startup = events.find((e) => e.cmd === 'startup');
    const listed = startup.detail.rules.map((f) => f.path);
    for (const f of [globalFile, path.join(global, 'shared.md'), path.join(h.base, 'AGENTS.md'), path.join(spawned.detail.cwd, 'AGENTS.md')]) {
      assert.ok(listed.includes(f), `the startup receipt lists ${f}: ${listed.join(', ')}`);
    }
    assert.equal(startup.detail.goal, goal);
    assert.equal(startup.detail.target.title, title);

    const said = messages(spawned.detail.log, harness);
    assert.ok(said.length, `the agent replied\n${log.slice(-4000)}`);
    const all = said.join('\n');
    for (const [label, token] of Object.entries(tokens)) assert.ok(all.includes(`HT-${token}`), `the reply names the ${label} house token HT-${token}:\n${all}`);
    assert.ok(said[0].includes(title.split(' ').pop()), `the first message restates the target "${title}":\n${said[0]}`);
    assert.ok(said[0].includes(goal.split(' ')[2]), `the first message restates the goal "${goal}":\n${said[0]}`);

    const spend = h.readState('tasks.json').tasks[0].spend.entries?.find((e) => e.agent === spawned.detail.agent);
    t.diagnostic(`startup: rules ${startup.detail.rules_bytes} B (~${startup.detail.rules_tokens} tok, ${startup.detail.rules.length} files), prompt ${startup.detail.prompt_bytes} B (~${startup.detail.prompt_tokens} tok); measured input ${spend?.input ?? 'unknown'} tokens, cached ${spend?.cached ?? 'unknown'}`);
  });
}
