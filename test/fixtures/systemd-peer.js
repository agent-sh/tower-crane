'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');

// A private manager is a peer, so it answers Manager calls but rejects bus Hello.
function reply(type, serial, error, variant = false) {
  const chunks = [];
  let size = 16;
  const append = b => { chunks.push(b); size += b.length; };
  const align = n => append(Buffer.alloc((n - size % n) % n));
  const uint = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); append(b); };
  const string = s => { const b = Buffer.from(s); uint(b.length); append(b); append(Buffer.from([0])); };
  const signature = s => append(Buffer.concat([Buffer.from([s.length]), Buffer.from(s), Buffer.from([0])]));
  const field = (code, sig, value) => {
    align(8);
    append(Buffer.from([code]));
    signature(sig);
    if (sig === 'u') { align(4); uint(value); }
    else if (sig === 's') { align(4); string(value); }
    else signature(value);
  };
  field(5, 'u', serial);
  field(7, 's', 'org.freedesktop.systemd1');
  if (error) field(4, 's', 'org.freedesktop.DBus.Error.UnknownObject');
  field(8, 'g', error ? 's' : variant ? 'v' : 'as');
  const headers = Buffer.concat(chunks);
  const body = error ? Buffer.concat([Buffer.from([Buffer.byteLength(error), 0, 0, 0]), Buffer.from(error), Buffer.from([0])])
    : variant ? Buffer.concat([Buffer.from([2, 97, 115, 0]), Buffer.alloc(4)]) : Buffer.alloc(4);
  const fixed = Buffer.alloc(16);
  fixed[0] = 108;
  fixed[1] = type;
  fixed[3] = 1;
  fixed.writeUInt32LE(body.length, 4);
  fixed.writeUInt32LE(1, 8);
  fixed.writeUInt32LE(headers.length, 12);
  return Buffer.concat([fixed, headers, Buffer.alloc((8 - headers.length % 8) % 8), body]);
}

function fields(message) {
  const read = at => message[0] === 108 ? message.readUInt32LE(at) : message.readUInt32BE(at);
  const end = 16 + read(12);
  const found = new Map();
  let at = 16;
  while (at < end) {
    at = Math.ceil(at / 8) * 8;
    if (at >= end) break;
    const code = message[at++];
    const len = message[at++];
    const sig = message.toString('utf8', at, at + len);
    at += len + 1;
    if (sig === 's' || sig === 'o') {
      at = Math.ceil(at / 4) * 4;
      const length = read(at);
      at += 4;
      found.set(code, message.toString('utf8', at, at + length));
      at += length + 1;
    } else if (sig === 'u') {
      at = Math.ceil(at / 4) * 4;
      found.set(code, read(at));
      at += 4;
    } else if (sig === 'g') {
      const length = message[at++];
      found.set(code, message.toString('utf8', at, at + length));
      at += length + 1;
    } else throw new Error(`unexpected header type ${sig}`);
  }
  return { path: found.get(1), interface: found.get(2), member: found.get(3), destination: found.get(6), serial: read(8) };
}

async function start(t) {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 't423-peer-'));
  const dir = path.join(root, 'systemd');
  fs.mkdirSync(dir);
  const calls = [];
  const auth = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let binary = false;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!binary) {
        let end;
        while ((end = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.subarray(0, end).toString().replace(/^\0/, '');
          auth.push(line);
          buffer = buffer.subarray(end + 2);
          if (line === 'AUTH EXTERNAL') socket.write('DATA\r\n');
          else if (line.startsWith('AUTH') || line.startsWith('DATA')) socket.write('OK 0123456789abcdef0123456789abcdef\r\n');
          else if (line.startsWith('NEGOTIATE_UNIX_FD')) socket.write('ERROR "No file descriptors"\r\n');
          else if (line === 'BEGIN') { binary = true; break; }
        }
      }
      while (binary && buffer.length >= 16) {
        const read = at => buffer[0] === 108 ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);
        const length = Math.ceil((16 + read(12)) / 8) * 8 + read(4);
        if (buffer.length < length) break;
        const message = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        const f = fields(message);
        if (message[1] !== 1) continue;
        calls.push(f);
        const variant = f.interface === 'org.freedesktop.DBus.Properties' && f.member === 'Get';
        const accepted = f.path === '/org/freedesktop/systemd1' && (variant || f.member === 'GetEnvironment');
        socket.write(reply(accepted ? 2 : 3, f.serial, accepted ? null : `Unknown object '${f.path}'`, variant));
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path.join(dir, 'private'), resolve);
  });
  return { root, calls, auth };
}

module.exports = { start, fields };
