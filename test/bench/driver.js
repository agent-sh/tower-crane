'use strict';

// The bench's browser half: serve on a scratch state, a headless Chrome page
// from test/browser.js, and input that goes through Chrome's own input
// pipeline (Input.dispatchMouseEvent and Input.dispatchKeyEvent at the
// target's center), never page functions. Every input is recorded with its
// target size, the pointer travel and the scroll distance, so a scenario's
// path can be counted and timed.

const fs = require('node:fs');
const cp = require('node:child_process');
const { openBrowser } = require('../browser');

const SIZES = [[3840, 1080], [1920, 1080], [1280, 800], [390, 844]];
const THEMES = ['light', 'dark'];

// Card, Moran and Newell's operator times, seconds (docs/human-bench.md).
const KLM = { K: 0.28, P: 1.1, B: 0.1, H: 0.4, M: 1.35 };

function serve(s, bin, agent = 'owner') {
  const child = cp.spawn(process.execPath, [bin, 'serve', '--port', '0', '--json', '--agent', agent], { cwd: s.repo, env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  // An owner serve prints a one-time link (open) whose page hands the write
  // token to this origin's storage; a build before that link has only url.
  const links = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (!out.includes('\n')) return;
      const j = JSON.parse(out.split('\n')[0]);
      resolve({ url: j.url, open: j.open || j.url });
    });
    child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${err}`)));
  });
  return { links, stop: async () => { child.kill(); await exited; } };
}

async function browser() {
  const cleanups = [];
  const b = await openBrowser({ after: (fn) => cleanups.push(fn) });
  await b.send('Page.enable');
  await b.send('Accessibility.enable');
  b.close = async () => { for (const fn of cleanups.reverse()) await fn(); };
  return b;
}

// One recorded path through a page.
class Path {
  constructor(b) {
    this.b = b;
    this.ops = [];
    this.inputs = [];
    this.travel = 0;
    this.scrolled = 0;
    this.pointer = null;
    this.hand = 'mouse';
    this.started = Date.now();
  }

  op(code, n = 1) { for (let i = 0; i < n; i++) this.ops.push(code); }
  think() { this.op('M'); }

  async rect(selector) {
    return this.b.call((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
    }, selector);
  }

  // Scrolls with the wheel over the target's own scroll container until the
  // target is inside the viewport, as a person would, and counts the distance.
  async reveal(selector) {
    for (let i = 0; i < 60; i++) {
      const r = await this.rect(selector);
      if (!r) throw new Error(`no element ${selector}`);
      const box = await this.b.call((sel) => {
        const el = document.querySelector(sel);
        let p = el.parentElement;
        while (p && p !== document.body) {
          const s = getComputedStyle(p);
          if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1) { const q = p.getBoundingClientRect(); return { x: q.left, y: Math.max(0, q.top), w: q.width, h: Math.min(innerHeight, q.bottom) - Math.max(0, q.top) }; }
          p = p.parentElement;
        }
        return { x: 0, y: 0, w: innerWidth, h: innerHeight };
      }, selector);
      const top = Math.max(0, box.y);
      const bottom = Math.min(r.vh, box.y + box.h);
      if (r.y >= top && r.y + r.h <= bottom && r.h > 0) return r;
      const dy = r.y < top ? Math.max(-400, r.y - top - 16) : Math.min(400, r.y + r.h - bottom + 16);
      const x = Math.min(r.vw - 2, Math.max(2, box.x + box.w / 2));
      const y = Math.min(r.vh - 2, Math.max(2, top + (bottom - top) / 2));
      if (this.scrolled === 0 || this.inputs.at(-1)?.type !== 'scroll') this.think();
      await this.b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
      this.scrolled += Math.abs(dy);
      this.inputs.push({ type: 'scroll', dy });
      this.op('W');
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error(`could not scroll ${selector} into view`);
  }

  async click(selector, { think = true } = {}) {
    if (think) this.think();
    const r = await this.reveal(selector);
    const x = r.x + r.w / 2;
    const y = r.y + r.h / 2;
    if (this.hand !== 'mouse') { this.op('H'); this.hand = 'mouse'; }
    if (this.pointer) this.travel += Math.hypot(x - this.pointer[0], y - this.pointer[1]);
    this.pointer = [x, y];
    await this.b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    this.inputs.push({ type: 'click', target: selector, w: Math.round(r.w), h: Math.round(r.h) });
    this.op('P');
    this.op('B', 2);
  }

  async type(text) {
    if (this.hand !== 'keys') { this.op('H'); this.hand = 'keys'; }
    await this.b.send('Input.insertText', { text });
    this.inputs.push({ type: 'type', chars: text.length });
    // Typed characters are keystrokes; the pass bars count them apart.
    this.op('T', text.length);
  }

  async key(key, { shift = false } = {}) {
    const codes = { Tab: 9, Enter: 13, Escape: 27, Space: 32 };
    if (this.hand !== 'keys') { this.op('H'); this.hand = 'keys'; }
    const base = { key: key === 'Space' ? ' ' : key, code: key, windowsVirtualKeyCode: codes[key], modifiers: shift ? 8 : 0 };
    await this.b.send('Input.dispatchKeyEvent', { type: key === 'Space' ? 'keyDown' : 'rawKeyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : key === 'Space' ? { text: ' ' } : {}) });
    await this.b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    this.inputs.push({ type: 'key', key });
    this.op('K');
  }

  // KLM seconds; a wheel notch and a typed character count as keystrokes, a
  // reacquisition after scrolling as an M. Without typing, for bars that say
  // "plus typing".
  klm(typing = true) {
    return Math.round(this.ops.reduce((s, o) => s + (o === 'W' || o === 'T' ? (o === 'T' && !typing ? 0 : KLM.K) : KLM[o]), 0) * 100) / 100;
  }

  result() {
    const count = (type) => this.inputs.filter((i) => i.type === type).length;
    return {
      clicks: count('click'), keys: count('key'), typed: this.inputs.filter((i) => i.type === 'type').reduce((n, i) => n + i.chars, 0),
      scrolls: count('scroll'), scroll_px: Math.round(this.scrolled), travel_px: Math.round(this.travel),
      actions: count('click') + count('key'), klm_s: this.klm(), klm_without_typing_s: this.klm(false), wall_ms: Date.now() - this.started,
      smallest_target: this.inputs.filter((i) => i.type === 'click').reduce((m, i) => Math.min(m, i.w, i.h), Infinity),
      ops: this.ops.join(''),
    };
  }
}

async function setSize(b, [width, height]) {
  await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}

async function setMedia(b, { theme = 'light', reduced = false } = {}) {
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
}

async function shot(b, file) {
  const { data } = await b.send('Page.captureScreenshot', { format: 'webp', quality: 72 });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
}

async function load(b, url, live = true) {
  await b.goto('about:blank');
  await b.goto(url);
  if (live) await b.until(`(document.querySelector('[data-conn]') || {}).dataset?.conn === 'live'`, 'the live stream', 20000);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

module.exports = { SIZES, THEMES, KLM, serve, browser, Path, setSize, setMedia, shot, load };
