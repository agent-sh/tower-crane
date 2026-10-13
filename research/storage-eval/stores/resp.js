'use strict';
// Minimal RESP2 client for the Valkey prototype. The repository takes no npm
// dependencies, so this speaks the protocol over node:net directly.
const net = require('node:net');

class Resp {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.chunks = [];
    this.waiting = [];
    // A whole reply always ends in LF, so a large reply is parsed once when
    // a chunk ends that way, not again on every chunk.
    sock.on('data', (d) => {
      this.chunks.push(d);
      if (d[d.length - 1] !== 10) return;
      this.buf = Buffer.concat([this.buf, ...this.chunks]);
      this.chunks = [];
      this.drain();
    });
    sock.on('error', (e) => this.fail(e));
    sock.on('close', () => this.fail(new Error('connection closed')));
  }

  static connect({ port, host = '127.0.0.1' }) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ port, host }, () => resolve(new Resp(sock)));
      sock.once('error', reject);
    });
  }

  fail(e) {
    for (const w of this.waiting.splice(0)) w.reject(e);
  }

  // Returns [value, nextOffset] or null when the buffer holds no whole reply.
  parse(off) {
    const b = this.buf;
    const eol = b.indexOf('\r\n', off);
    if (eol === -1) return null;
    const type = b[off];
    const line = b.toString('utf8', off + 1, eol);
    const next = eol + 2;
    if (type === 43) return [line, next];
    if (type === 45) { const e = new Error(line); e.resp = true; return [e, next]; }
    if (type === 58) return [Number(line), next];
    if (type === 36) {
      const n = Number(line);
      if (n === -1) return [null, next];
      if (b.length < next + n + 2) return null;
      return [b.toString('utf8', next, next + n), next + n + 2];
    }
    if (type === 42) {
      const n = Number(line);
      if (n === -1) return [null, next];
      const out = [];
      let at = next;
      for (let i = 0; i < n; i++) {
        const r = this.parse(at);
        if (!r) return null;
        out.push(r[0]);
        at = r[1];
      }
      return [out, at];
    }
    throw new Error(`bad RESP type ${type}`);
  }

  drain() {
    let off = 0;
    while (this.waiting.length && off < this.buf.length) {
      const r = this.parse(off);
      if (!r) break;
      off = r[1];
      const w = this.waiting.shift();
      if (r[0] instanceof Error) w.reject(r[0]); else w.resolve(r[0]);
    }
    this.buf = off ? this.buf.subarray(off) : this.buf;
  }

  static encode(args) {
    const parts = [`*${args.length}\r\n`];
    for (const a of args) {
      const s = String(a);
      parts.push(`$${Buffer.byteLength(s)}\r\n${s}\r\n`);
    }
    return parts.join('');
  }

  // Sends every command in one write; replies come back in order.
  pipeline(cmds) {
    const promises = cmds.map(() => new Promise((resolve, reject) => this.waiting.push({ resolve, reject })));
    this.sock.write(cmds.map(Resp.encode).join(''));
    return Promise.all(promises);
  }

  async call(...args) {
    return (await this.pipeline([args]))[0];
  }

  close() {
    this.sock.end();
  }
}

module.exports = { Resp };
