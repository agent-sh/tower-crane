'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readText } = require('./text');

function withoutFences(text) {
  let fence;
  return text.split('\n').map((line) => {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
      return '';
    }
    return fence ? '' : line;
  }).join('\n');
}

function slug(text) {
  return text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '').replace(/\s/g, '-');
}

function anchors(text) {
  const clean = withoutFences(text);
  const result = new Set();
  const counts = new Map();
  for (const match of clean.matchAll(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const name = slug(match[1]);
    const count = counts.get(name) || 0;
    counts.set(name, count + 1);
    result.add(count ? `${name}-${count}` : name);
  }
  for (const match of clean.matchAll(/<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["'][^>]*>/gi)) result.add(match[1]);
  return result;
}

function links(text) {
  const clean = withoutFences(text).replace(/`+[^`\n]*`+/g, '');
  return [...clean.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^)]*)?\s*\)|^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)]
    .map((match) => ({ target: (match[1] || match[2]).replace(/^<|>$/g, '').replace(/\\([\\|()])/g, '$1'),
      line: clean.slice(0, match.index).split('\n').length }));
}

function check(root = path.join(__dirname, '..')) {
  const docs = path.join(root, 'docs');
  const files = fs.readdirSync(docs, { recursive: true }).filter((name) => name.endsWith('.md')).map((name) => path.join(docs, name));
  const cache = new Map();
  const findings = [];
  for (const file of files) {
    for (const { target, line } of links(readText(file))) {
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)) continue;
      const [name, fragment] = target.split('#');
      let dest;
      let anchor;
      try {
        dest = name ? path.resolve(path.dirname(file), decodeURIComponent(name)) : file;
        anchor = fragment === undefined ? undefined : decodeURIComponent(fragment);
      } catch {
        findings.push(`${path.relative(root, file)}:${line}: invalid link ${target}`);
        continue;
      }
      if (!fs.existsSync(dest)) findings.push(`${path.relative(root, file)}:${line}: missing file ${target}`);
      else if (anchor && /\.md$/i.test(dest)) {
        if (!cache.has(dest)) cache.set(dest, anchors(readText(dest)));
        if (!cache.get(dest).has(anchor)) findings.push(`${path.relative(root, file)}:${line}: missing anchor ${target}`);
      }
    }
  }
  if (findings.length) throw new Error(findings.join('\n'));
}

if (require.main === module) {
  try { check(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { anchors, links, check };
