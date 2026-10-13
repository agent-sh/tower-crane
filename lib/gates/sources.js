'use strict';

const crypto = require('node:crypto');
const { git, resolveCommit, fail, errText } = require('./common');
const Research = require('../research');
const { fetchPublic, closeBody } = require('../public-http');

// Bound slow or unbounded responses so a source cannot hold a gate indefinitely.
const PAGE_TIMEOUT_MS = 10000;
const GATE_TIMEOUT_MS = 120000;
const PAGE_BYTES = 5 * 1024 * 1024;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const normalize = text => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function pageUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('source must be an HTTP(S) URL without credentials');
  url.hash = '';
  return url.href;
}

const BLOCK_TAGS = new Set('address article aside blockquote br caption dd div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td tfoot th thead tr ul'.split(' '));

function htmlText(body) {
  const parts = [];
  let i = 0, start = 0, templates = 0, raw = null;
  while (i < body.length) {
    if (body[i] !== '<') { i++; continue; }
    if (raw) {
      const end = i + raw.length + 2;
      if (body.slice(i, end).toLowerCase() !== `</${raw}` || !/[\s/>]/.test(body[end] || '')) {
        i++;
        continue;
      }
    } else if (!templates) parts.push(body.slice(start, i));
    if (body.startsWith('<!--', i)) {
      let comments = 1;
      i += 4;
      while (i < body.length && comments) {
        if (body.startsWith('<!--', i)) { comments++; i += 4; }
        else if (body.startsWith('-->', i)) { comments--; i += 3; }
        else i++;
      }
      start = i;
      continue;
    }
    const tagStart = ++i;
    let quote = null;
    while (i < body.length) {
      const char = body[i];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      // Ambiguous or unfinished markup cannot supply evidence for a quote.
      else if (char === '<') return parts.join('');
      i++;
    }
    if (i === body.length) return parts.join('');
    const tag = body.slice(tagStart, i++);
    const match = /^\/?([a-z][a-z0-9:-]*)(?=[\s/]|$)/i.exec(tag);
    if (match) {
      const name = match[1].toLowerCase();
      const closing = tag[0] === '/';
      if (raw) {
        raw = null;
        if (!templates) parts.push(' ');
      } else if (name === 'script' || name === 'style') {
        if (!templates) parts.push(' ');
        if (!closing) raw = name;
      } else if (name === 'template') {
        if (closing) templates = Math.max(0, templates - 1);
        else templates++;
        if (!templates || !closing && templates === 1) parts.push(' ');
      } else if (!templates && BLOCK_TAGS.has(name)) parts.push(' ');
    }
    start = i;
  }
  if (!raw && !templates) parts.push(body.slice(start));
  return parts.join('');
}

function pageText(body, html) {
  const text = html ? htmlText(body) : body;
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return normalize(html ? text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, key) => {
    if (!key.startsWith('#')) return entities[key.toLowerCase()];
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }) : text);
}

async function fetchPage(url, remaining, ctx) {
  const { response, finalUrl } = await fetchPublic(url, {
    signal: AbortSignal.timeout(Math.min(PAGE_TIMEOUT_MS, remaining)),
    headers: { Accept: 'text/html, text/plain', 'User-Agent': 'tower-crane-sources/0.1' },
  }, ctx);
  try {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type && !['text/html', 'application/xhtml+xml', 'text/plain'].includes(type)) {
      throw new Error(`unsupported content type ${type}; use an HTML or plain text page`);
    }
    let bytes = 0;
    const parts = [];
    for await (const part of response.body || []) {
      bytes += part.length;
      if (bytes > PAGE_BYTES) throw new Error(`page exceeds ${PAGE_BYTES} bytes`);
      parts.push(Buffer.from(part));
    }
    const text = pageText(Buffer.concat(parts).toString('utf8'), type !== 'text/plain');
    if (!text) throw new Error('page has no text');
    return { text, final_url: finalUrl, status: response.status, sha256: hash(text), fetched_at: new Date().toISOString() };
  } finally {
    await closeBody(response.body);
  }
}

async function run(ctx) {
  const { root, task, project } = ctx;
  const min = Research.minimum(project);
  const file = Research.deliverable(task);
  const receipt = { min_sources: min, deliverable: file, sources: [] };
  const result = (ok, summary) => ({ ok, summary, sha: task.sha, receipt });
  if (!task.sha) return fail(`task ${task.id} has no submitted sha; submit it first`);
  if (!root) return result(false, 'sources gate needs the git repository');
  const sha = await resolveCommit(ctx, root, task.sha);
  if (!sha) return result(false, `submitted commit ${task.sha} is not in the repository`);
  const read = await git(ctx, root, ['show', `${sha}:${file}`]);
  if (!read.ok) return result(false, `cannot read ${file} at the submitted commit: ${errText(read)}`);
  let doc;
  try { doc = JSON.parse(read.stdout); } catch { return result(false, `${file} must be valid JSON`); }
  if (!doc || !Array.isArray(doc.sources) || !Array.isArray(doc.claims) || !doc.claims.length) {
    return result(false, `${file} needs sources and a non-empty claims array`);
  }
  const byId = new Map();
  const urls = new Set();
  for (const source of doc.sources) {
    if (!source || !nonempty(source.id) || !nonempty(source.url)) return result(false, 'each source needs an id and URL');
    if (byId.has(source.id)) return result(false, `duplicate source id ${source.id}`);
    let url;
    try { url = pageUrl(source.url); } catch (e) { return result(false, `invalid source ${source.id}: ${e.message}`); }
    if (urls.has(url)) return result(false, `duplicate URL for source ${source.id}`);
    urls.add(url);
    byId.set(source.id, { ...source, url, claims: [] });
  }
  for (const claim of doc.claims) {
    if (!claim || !nonempty(claim.claim) || !nonempty(claim.quote) || !nonempty(claim.source)) {
      return result(false, 'each claim needs claim, quote and source strings');
    }
    const source = byId.get(claim.source);
    if (!source) return result(false, `claim names unknown source ${claim.source}`);
    source.claims.push(claim);
  }
  for (const source of byId.values()) {
    if (!source.claims.length) return result(false, `uncited source ${source.id}`);
  }
  if (byId.size < min) return result(false, `need at least ${min} distinct cited sources; found ${byId.size}`);
  const pages = new Set();
  const contents = new Set();
  const deadline = Date.now() + GATE_TIMEOUT_MS;
  for (const source of byId.values()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return result(false, 'sources gate exceeded its two minute deadline');
    let page;
    try { page = await fetchPage(source.url, remaining, ctx); }
    catch (e) { return result(false, `source ${source.id} fetch failed: ${e.message}`); }
    const { text, ...fetched } = page;
    receipt.sources.push({ id: source.id, url: source.url, ...fetched, claims: source.claims });
    if (pages.has(page.final_url) || contents.has(page.sha256)) return result(false, `duplicate page for source ${source.id}`);
    pages.add(page.final_url);
    contents.add(page.sha256);
    for (const claim of source.claims) {
      if (!text.includes(normalize(claim.quote))) return result(false, `source ${source.id}: quote not found on its page`);
    }
  }
  return result(true, `${byId.size} distinct cited pages fetched; ${doc.claims.length} quoted claims verified`);
}

module.exports = { run, pageText };
