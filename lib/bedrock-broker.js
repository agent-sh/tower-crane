'use strict';

// Bedrock for a claude agent whose bearer token lives in the OS store.
// Claude Code 2.1.305 reads AWS_BEARER_TOKEN_BEDROCK only from its
// environment, and with CLAUDE_CODE_SKIP_BEDROCK_AUTH=1 it sends no
// credential at all, keeping the path prefix of ANTHROPIC_BEDROCK_BASE_URL
// for both the runtime (/model/...) and the control plane
// (/inference-profiles) (docs/research/credentials-keyring.md, B9 and B10).
// So the supervisor runs this broker for as long as it supervises the
// agent: it listens on 127.0.0.1 at an ephemeral port, answers only under a
// random path nonce, adds Authorization: Bearer with the token it reads
// through the credential helper, and forwards the request with its body,
// headers and status unchanged and streamed both ways. Claude gets the
// broker's URL and no credential; its sandboxed commands have no host
// loopback (B11) and do not get the URL (agents.js claude).
//
// Codex commands share the host network, so another agent's command can
// reach the port; the nonce, which only this claude's environment holds,
// keeps it out. Only Claude's two calls pass: POST under /model/ and GET
// under /inference-profiles.

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const cp = require('node:child_process');

const HELPER = path.join(__dirname, 'credential-helper.js');
// A token read from the store serves requests for this long, so a stream of
// requests reads the store once a minute; a 401 or 403 from Bedrock drops it
// at once, so a rotated token is read on the next request.
const TOKEN_TTL_MS = 60000;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
// What a client could send that names a credential or signs one; the broker's own bearer replaces them.
const AUTH = new Set(['authorization', 'x-api-key', 'x-amz-security-token', 'x-amz-date', 'x-amz-content-sha256']);

function upstreams(target) {
  if (target.base_url) return { runtime: target.base_url, control: target.base_url };
  return { runtime: `https://bedrock-runtime.${target.region}.amazonaws.com`, control: `https://bedrock.${target.region}.amazonaws.com` };
}

function allowed(method, rest) {
  if (method === 'POST' && rest.startsWith('/model/')) return 'runtime';
  if (method === 'GET' && /^\/inference-profiles(?:[/?]|$)/.test(rest)) return 'control';
  return null;
}

// The helper's answer, read asynchronously so a request never blocks the
// supervisor's event loop. Its stderr names the stores and the fix.
function readToken(target, env) {
  return new Promise((resolve) => {
    cp.execFile(process.execPath, [HELPER, 'value', target.name, ...(target.config ? ['--config', target.config] : [])],
      { env, encoding: 'utf8', maxBuffer: 1 << 20, timeout: 10000, windowsHide: true }, (error, stdout, stderr) => {
        if (!error && stdout) resolve({ token: stdout });
        else resolve({ error: String(stderr || '').trim().split('\n').pop() || `tower-crane credential ${target.name} cannot be read` });
      });
  });
}

function deny(res, status, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json', 'x-amzn-errortype': status === 403 ? 'AccessDeniedException' : 'NotFoundException' });
  res.end(JSON.stringify({ message }));
}

// Starts the broker. target(t) points it at the route about to launch, {
// name, region, base_url, config }, or at none; env is what the
// helper runs with. Resolves to { url, env, target, close }.
async function start({ env = process.env } = {}) {
  const nonce = crypto.randomBytes(24).toString('base64url');
  let current = null;
  let cached = null;
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const prefix = `/${nonce}/`;
    if (!req.url.startsWith(prefix)) return deny(res, 404, 'not found');
    const rest = req.url.slice(prefix.length - 1);
    const which = allowed(req.method, rest);
    if (!which) return deny(res, 404, `the Bedrock broker forwards POST /model/ and GET /inference-profiles only, not ${req.method} ${rest.split('?')[0].slice(0, 80)}`);
    const target = current;
    if (!target) return deny(res, 403, 'tower-crane credential: no route is running');
    if (!target.base_url && !target.region) return deny(res, 403, `tower-crane credential ${target.name}: the route has no AWS region`);
    let token;
    if (cached && cached.key === target.name && performance.now() - cached.at < TOKEN_TTL_MS) token = cached.token;
    else {
      const r = await readToken(target, env);
      if (r.error) return deny(res, 403, r.error);
      token = r.token;
      cached = { key: target.name, token, at: performance.now() };
    }
    const base = new URL(upstreams(target)[which]);
    const url = new URL(base.pathname.replace(/\/$/, '') + rest, base);
    const headers = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (HOP.has(k.toLowerCase()) || AUTH.has(k.toLowerCase())) continue;
      headers[k] = headers[k] === undefined ? req.rawHeaders[i + 1] : `${headers[k]}, ${req.rawHeaders[i + 1]}`;
    }
    headers.authorization = `Bearer ${token}`;
    const out = (url.protocol === 'https:' ? https : http).request(url, { method: req.method, headers }, (up) => {
      if (up.statusCode === 401 || up.statusCode === 403) cached = null;
      const back = {};
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        const k = up.rawHeaders[i];
        if (HOP.has(k.toLowerCase())) continue;
        back[k] = back[k] === undefined ? up.rawHeaders[i + 1] : [].concat(back[k], up.rawHeaders[i + 1]);
      }
      res.writeHead(up.statusCode, up.statusMessage, back);
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    out.on('error', (e) => deny(res, 502, `the Bedrock broker could not reach ${url.host}: ${e.code || e.message}`));
    req.on('aborted', () => out.destroy());
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    req.pipe(out);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  // The supervisor waits on its harness, not on this server.
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/${nonce}`;
  return {
    url,
    env: { ANTHROPIC_BEDROCK_BASE_URL: url, CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1' },
    target(t) {
      if (current?.name !== t?.name) cached = null;
      current = t || null;
    },
    close() {
      current = null;
      cached = null;
      server.close();
      for (const s of sockets) s.destroy();
    },
  };
}

module.exports = { start, TOKEN_TTL_MS };
