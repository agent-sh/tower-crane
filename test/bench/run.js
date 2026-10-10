'use strict';

// The human bench (docs/human-bench.md). Runs every scenario and check of
// docs/human-experience.md section 6 against one tree's board:
//
//   node test/bench/run.js --build before|after --tree DIR --out DIR [--scratch DIR] [--only H1,H4]
//
// --tree is the checkout whose bin/tower-crane.js builds the fixtures and
// serves the board; --out receives results.json and the screenshots. Serve
// runs as the owner on scratch states only, so run it outside an agent task
// process (the env is cleaned of TOWER_CRANE_* either way).

const fs = require('node:fs');
const path = require('node:path');
const F = require('./fixtures');
const D = require('./driver');
const H = require('./scenarios');
const TARGETS = require('./targets');

function args() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1];
  return out;
}

const opt = args();
const build = opt.build;
const T = TARGETS[build];
if (!T || !opt.tree || !opt.out) {
  process.stderr.write('usage: node test/bench/run.js --build before|after --tree DIR --out DIR [--scratch DIR] [--only H1,H4]\n');
  process.exit(2);
}
const bin = path.resolve(opt.tree, 'bin', 'tower-crane.js');
const out = path.resolve(opt.out);
const shotsDir = path.join(out, build);
// Without --scratch the states go in a private directory made for this run
// and removed after it; --scratch keeps them for inspection.
const scratch = opt.scratch ? path.resolve(opt.scratch) : fs.mkdtempSync(path.join(process.env.TOWER_CRANE_TEST_TMP || require('node:os').tmpdir(), `tower-crane-bench-${build}-`));
const only = opt.only ? new Set(opt.only.split(',')) : null;
const want = (k) => !only || only.has(k);
fs.mkdirSync(shotsDir, { recursive: true });
fs.mkdirSync(scratch, { recursive: true });

const log = (...m) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${m.join(' ')}\n`);
const sizeName = ([w, h]) => `${w}x${h}`;

async function withServe(b, s, fn) {
  const srv = D.serve(s, bin);
  try {
    const { url, open } = await srv.links;
    if (open !== url) await D.load(b, open, false);
    return await fn(url);
  } finally { await srv.stop(); }
}

async function main() {
  const file = path.join(out, `results-${build}.json`);
  // A partial run (--only) updates the steps it ran and keeps the rest.
  const results = only && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { build, tree: path.resolve(opt.tree), sizes: D.SIZES.map(sizeName), scenarios: {}, checks: {}, rooms: {} };
  results.started_at = new Date().toISOString();
  const b = await D.browser();
  const cleanup = [];
  results.errors = [];
  // A failing step is recorded as a failure and the run goes on.
  const save = () => fs.writeFileSync(path.join(out, `results-${build}.json`), JSON.stringify(results, null, 2) + '\n');
  const step = async (name, fn) => {
    try { return await fn(); } catch (e) { results.errors.push({ step: name, error: e.message }); log('error', name, e.message); return { pass: false, error: e.message }; } finally { save(); }
  };
  const ctxFor = (s, url, size, theme, extra = {}) => ({ b, T, s, url, size, theme, cleanup, shots: (name) => path.join(shotsDir, `${name}-${sizeName(size)}-${theme}.webp`), ...extra });
  try {
    // Read-only: the busy run at every size and theme.
    log('busy fixture');
    const busy = F.busy(scratch, bin);
    await withServe(b, busy, async (url) => {
      for (const size of D.SIZES) {
        await D.setSize(b, size);
        for (const theme of D.THEMES) {
          await D.setMedia(b, { theme });
          const key = `${sizeName(size)}-${theme}`;
          if (want('H1')) {
            log('H1', key);
            results.scenarios[`H1 ${key}`] = await step(`H1 ${key}`, () => H.h1(ctxFor(busy, url, size, theme)));
          }
          if (want('checks')) {
            await D.load(b, url);
            await D.shot(b, path.join(shotsDir, `front-${key}.webp`));
            results.checks[`front ${key}`] = await step(`checks ${key}`, () => H.checks(ctxFor(busy, url, size, theme)));
            if (size[0] === 3840) results.checks[`front ${key}`].density = await b.call(require('./checks').density, T.wrappers);
          }
          if (want('H2') && size[0] > 500) {
            await D.load(b, url);
            // H2's controls must be reachable without a scroll at desktop sizes.
            results.scenarios[`H2 reach ${key}`] = { pass: await b.call((sel) => { const el = document.querySelector(sel); if (!el) return false; const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }, T.option('D1', 'postgres')) };
          }
        }
      }
      if (want('rooms')) {
        for (const room of T.rooms) {
          for (const [size, theme] of [[[1920, 1080], 'light'], [[1920, 1080], 'dark'], [[390, 844], 'light'], [[1280, 800], 'dark']]) {
            await D.setSize(b, size);
            await D.setMedia(b, { theme });
            await D.load(b, T.roomUrl(url, room));
            const key = `${room} ${sizeName(size)}-${theme}`;
            await D.shot(b, path.join(shotsDir, `${room}-${sizeName(size)}-${theme}.webp`));
            results.rooms[key] = await step(key, () => H.checks(ctxFor(busy, url, size, theme)));
          }
        }
        await D.setSize(b, [1920, 1080]);
        await D.setMedia(b, { theme: 'light' });
        await D.load(b, T.sheetUrl(url, busy.ids.retry));
        await D.shot(b, path.join(shotsDir, `sheet-${busy.ids.retry}-1920x1080-light.webp`));
        results.rooms[`sheet 1920x1080-light`] = await H.checks(ctxFor(busy, url, [1920, 1080], 'light'));
        await D.setMedia(b, { theme: 'dark' });
        await D.load(b, T.sheetUrl(url, busy.ids.retry));
        await D.shot(b, path.join(shotsDir, `sheet-${busy.ids.retry}-1920x1080-dark.webp`));
        await D.setSize(b, [390, 844]);
        await D.load(b, T.sheetUrl(url, busy.ids.retry));
        await D.shot(b, path.join(shotsDir, `sheet-${busy.ids.retry}-390x844-dark.webp`));
        await D.load(b, `${url}settings`);
        await D.shot(b, path.join(shotsDir, 'settings-390x844-dark.webp'));
        await D.setSize(b, [1920, 1080]);
        for (const theme of D.THEMES) {
          await D.setMedia(b, { theme });
          await D.load(b, `${url}settings`);
          await D.shot(b, path.join(shotsDir, `settings-1920x1080-${theme}.webp`));
          results.rooms[`settings 1920x1080-${theme}`] = await H.checks(ctxFor(busy, url, [1920, 1080], theme));
        }
      }
      await D.setSize(b, [1920, 1080]);
      await D.setMedia(b, { theme: 'light' });
      if (want('motion')) {
        await D.setMedia(b, { theme: 'light', reduced: true });
        await D.load(b, url);
        await H.wait(800);
        results.checks['motion reduced 1920x1080'] = await b.inPage(require('./checks').motion);
        await D.setMedia(b, { theme: 'light' });
      }
      if (want('keyboard')) { log('keyboard'); results.checks['keyboard 1920x1080'] = await step('keyboard', () => H.keyboard(ctxFor(busy, url, [1920, 1080], 'light'))); }
      if (want('H7')) { log('H7'); results.scenarios.H7 = await step('H7', () => H.h7(ctxFor(busy, url, [1920, 1080], 'light'))); }
      if (want('rooms1')) {
        for (const size of [[1920, 1080], [390, 844]]) {
          log('one room', sizeName(size));
          await D.setSize(b, size);
          results.checks[`one room ${sizeName(size)}`] = await step(`one room ${sizeName(size)}`, () => H.oneRoom(ctxFor(busy, url, size, 'light')));
        }
        await D.setSize(b, [1920, 1080]);
      }
      if (want('H2a')) results.scenarios.H2a = await step('H2a', () => H.h2a(ctxFor(busy, url, [1920, 1080], 'light')));
    });

    // Paths that change the state, each on its own fresh busy run.
    await D.setSize(b, [1920, 1080]);
    await D.setMedia(b, { theme: 'light' });
    for (const [name, fn] of [['H2', H.h2], ['H3', H.h3], ['H6', H.h6]]) {
      if (!want(name)) continue;
      log(name);
      results.scenarios[name] = await step(name, async () => { const s = F.busy(scratch, bin); return withServe(b, s, (url) => fn(ctxFor(s, url, [1920, 1080], 'light'))); });
    }
    if (want('H9')) {
      log('H9');
      results.scenarios.H9 = await step('H9', () => H.h9({ s: F.busy(scratch, bin) }, results.scenarios));
    }
    results.scenarios.H4p = { pass: false, skipped: true, note: 'no pause command on this base: project set --paused arrives with T91 (PR #77)' };

    if (want('H4')) {
      log('H4');
      results.scenarios.H4 = await step('H4', async () => { const s = F.runaway(scratch, bin); return withServe(b, s, (url) => H.h4(ctxFor(s, url, [1920, 1080], 'light'))); });
      for (const fn of cleanup.splice(0)) fn();
    }
    if (want('H4s')) {
      for (const variant of ['stale', 'unavailable']) {
        log('H4s', variant);
        results.scenarios[`H4s ${variant}`] = await step(`H4s ${variant}`, async () => { const s = F.runaway(scratch, bin, { variant }); return withServe(b, s, (url) => H.h4s(ctxFor(s, url, [1920, 1080], 'light', { variant }))); });
        for (const fn of cleanup.splice(0)) fn();
      }
    }
    if (want('H5')) {
      log('H5');
      await step('H5', async () => {
        const s = F.budget(scratch, bin);
        await withServe(b, s, async (url) => {
          for (const size of D.SIZES) {
            await D.setSize(b, size);
            results.scenarios[`H5 ${sizeName(size)}`] = await step(`H5 ${sizeName(size)}`, () => H.h5(ctxFor(s, url, size, 'light')));
          }
        });
      });
      for (const fn of cleanup.splice(0)) fn();
      await D.setSize(b, [1920, 1080]);
    }
    if (want('H8')) {
      log('H8');
      await step('H8', async () => {
        const s = F.calm(scratch, bin);
        await withServe(b, s, async (url) => {
          for (const theme of D.THEMES) {
            await D.setMedia(b, { theme });
            results.scenarios[`H8 ${theme}`] = await step(`H8 ${theme}`, () => H.h8(ctxFor(s, url, [1920, 1080], theme)));
          }
        });
      });
      await D.setMedia(b, { theme: 'light' });
    }
  } finally {
    for (const fn of cleanup) fn();
    await b.close();
    if (!opt.scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
  results.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(out, `results-${build}.json`), JSON.stringify(results, null, 2) + '\n');
  log('wrote', path.join(out, `results-${build}.json`));
}

main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
