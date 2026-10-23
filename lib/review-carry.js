'use strict';

const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const cp = require('./commands');
const { nowIso, refuse, shaMatch } = require('./util');

const DEFAULT_DOCS_PATHS = ['docs/**', '**/*.md', 'changelog.d/**'];
const SOURCE = 'review carry';
const GATE_SOURCE = 'gate carry';
const INSTRUCTIONS = /^(skills|agents|prompts)\//;

function docsPaths(project) {
  return project.review?.docs_paths ?? DEFAULT_DOCS_PATHS;
}

function docsOnly(files, paths, exclude = []) {
  const patterns = paths.map(require('./gates/tests').globToRegExp);
  const exclusions = exclude.map(require('./gates/tests').globToRegExp);
  return files.length > 0 && files.every((file) => !INSTRUCTIONS.test(file)
    && patterns.some((pattern) => pattern.test(file)) && !exclusions.some((pattern) => pattern.test(file)));
}

function identity(review) {
  return { type: review.type, sha: review.sha, revision: review.revision, agent: review.agent, at: review.at };
}

function original(task, entry) {
  return task.evidence.find((review) => isDeepStrictEqual(identity(review), entry.carried_from));
}

function eligible(task, entry, events, seen = new Set()) {
  if (![SOURCE, GATE_SOURCE].includes(entry.source) || !entry.ok || entry.waived || seen.has(entry)) return false;
  seen.add(entry);
  const audit = events.find((event) => event.task === task.id && event.cmd === entry.source
    && isDeepStrictEqual(event.detail, entry));
  if (!audit) return false;
  const review = original(task, entry);
  if (!review || review.waived || task.evidence.indexOf(review) >= task.evidence.indexOf(entry)) return false;
  const independent = [SOURCE, GATE_SOURCE].includes(review.source)
    ? eligible(task, review, events, seen) : require('./tasks').eligibleGateEvidence(task, review, events);
  if (!independent) return false;
  if (entry.type !== 'review') return review.ok === true;
  if (review.ok || review.followups_only) return true;
  if (entry.receipt?.reason === 'attestation') {
    return audit.agent === 'owner' || require('./authority').isOrchestrator(audit.agent, events);
  }
  return ['fix round', 'title or body only'].includes(entry.receipt?.reason)
    && Array.isArray(review.findings) && review.findings.length > 0;
}

function snapshot(st, task) {
  const T = require('./tasks');
  const retired = new Set(T.retiredRevisions(st.events, task.id));
  const candidates = task.evidence.filter((review) => review.type === 'review'
    && review.revision <= task.revision && !retired.has(review.revision)
    && T.eligibleGateEvidence(task, review, st.events));
  const submitted = st.events.findLast((event) => event.task === task.id && event.cmd === 'submit'
    && candidates.some((review) => shaMatch(review.sha, event.detail.sha)));
  if (!submitted) return null;
  const atHead = candidates.filter((review) => shaMatch(review.sha, submitted.detail.sha));
  const revision = Math.max(...atHead.map((review) => review.revision));
  // A late verdict for an older submission cannot replace a newer head's important findings.
  const latest = atHead.findLast((review) => review.revision === revision);
  if (!latest || latest.waived) return null;
  let review = latest;
  while (review.source === SOURCE) review = original(task, review);
  if (!review || retired.has(review.revision)) return null;
  const recorded = st.events.findLastIndex((event) => event.task === task.id && event.cmd === 'evidence'
    && event.agent === review.agent && event.detail.type === 'review' && event.detail.ok === review.ok
    && event.detail.revision === review.revision && shaMatch(event.detail.sha, review.sha));
  if (recorded < 0 || st.events.slice(recorded + 1).some((event) => event.task === task.id
    && (event.cmd === 'brief set' || event.cmd === 'task update'
      && ['acceptance', 'depends_on', 'needs', 'kind'].some((key) => Object.hasOwn(event.detail, key))))) return null;
  return { review: latest, reviewed_head: review.sha, docs_paths: docsPaths(st.project),
    docs_exclude: st.project.review?.docs_exclude ?? [] };
}

function parseDisputes(value) {
  if (value === undefined) return [];
  let disputes;
  try { disputes = JSON.parse(value); } catch { throw refuse('--disputes must be a JSON array of {finding, reason}'); }
  if (!Array.isArray(disputes) || disputes.some((d) => !d || !Number.isSafeInteger(d.finding) || d.finding < 1
    || typeof d.reason !== 'string' || !d.reason.trim() || Object.keys(d).some((k) => !['finding', 'reason'].includes(k)))
    || new Set(disputes.map((d) => d.finding)).size !== disputes.length) {
    throw refuse('--disputes must be a JSON array of unique {finding, reason}, with one-based finding numbers');
  }
  return disputes.map((d) => ({ finding: d.finding, reason: d.reason.trim() }));
}

function softwarePolicy(st, task) {
  return { gates: st.project.gates ?? null, tests: st.project.tests ?? null, ci: st.project.ci ?? null,
    ci_local: task.ci_local ?? null, host_probes: task.host_probes ?? [] };
}

function prepareSoftware(st, task, prepared) {
  const T = require('./tasks');
  const previous = { ...task, sha: prepared.inputs.review.sha, revision: prepared.inputs.review.revision };
  const report = T.gateReport(previous, st.events, st);
  const software = ['tests', 'ci'].map((type) => T.latestGateEvidence(previous, type, st.events))
    .filter((entry) => entry?.ok && !entry.waived && report.gates.find((g) => g.type === entry.type)?.ok);
  return { ...prepared, software, software_policy: softwarePolicy(st, task) };
}

// Zero-context hunks let a named line range bound a nit without guessing from its prose.
function namedFixes(files, patch, findings, rules, disputes = [], attest = false, metadata = false) {
  if (!Array.isArray(findings) || !findings.length || disputes.some((d) => d.finding > findings.length)) return false;
  const disputed = new Set(disputes.map((d) => d.finding - 1));
  const permitted = [];
  for (const [index, finding] of findings.entries()) {
    if (disputed.has(index)) {
      if (files.includes(finding.path)) return false;
      continue;
    }
    if (!attest && !['nit', 'doc-fix', 'title-body-fix', 'false-claim'].includes(finding.kind)) return false;
    if (['PR body', 'PR title'].includes(finding.path)) {
      if (!metadata) return false;
      continue;
    }
    if (docsOnly([finding.path], rules.docs_paths, rules.docs_exclude)) {
      if (!['nit', 'doc-fix', 'false-claim'].includes(finding.kind)) return false;
      if (!files.includes(finding.path)) return false;
      continue;
    }
    if (!Number.isSafeInteger(finding.line) || finding.line < 1) return false;
    permitted.push(finding);
  }
  const code = files.filter((file) => !docsOnly([file], rules.docs_paths, rules.docs_exclude));
  if (code.some((file) => INSTRUCTIONS.test(file) || !permitted.some((f) => f.path === file))) return false;
  let current = null;
  let before = null;
  let modeChanged = false;
  const checked = new Set();
  const fixed = new Set();
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) modeChanged = false;
    if (/^(old mode |new mode )/.test(line)) modeChanged = true;
    if (line.startsWith('--- ')) before = require('./gates/clean').diffPath(line.slice(4)).replace(/^a\//, '');
    if (line.startsWith('+++ ')) current = line === '+++ /dev/null' ? before
      : require('./gates/clean').diffPath(line.slice(4)).replace(/^b\//, '');
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !code.includes(current)) continue;
    if (modeChanged) return false;
    const start = Number(hunk[1]);
    const removed = Number(hunk[2] ?? 1);
    const added = Number(hunk[4] ?? 1);
    const matches = permitted.filter((f) => f.path === current && start >= f.line
      && start + Math.max(removed, 1) - 1 <= (f.end_line ?? f.line)
      && added <= (f.end_line ?? f.line) - f.line + 1);
    if (!matches.length) return false;
    for (const finding of matches) fixed.add(finding);
    checked.add(current);
  }
  return code.every((file) => checked.has(file)) && permitted.every((finding) => fixed.has(finding));
}

// Git runs before the state lock. The snapshot is checked again in the submit mutation.
function prepare(st, task, repo, options = {}) {
  const inputs = snapshot(st, task);
  if (!inputs) return null;
  const disputes = options.disputes ?? [];
  if (inputs.review.ok && inputs.review.revision === task.revision && shaMatch(inputs.review.sha, task.sha)
    && !options.metadata && !options.attestation && !disputes.length) return null;
  let delta;
  try {
    const git = (args) => cp.execFileSync('git', ['-C', repo.root, ...args],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const from = git(['rev-parse', '--verify', `${inputs.review.sha}^{commit}`]).trim();
    git(['merge-base', '--is-ancestor', from, task.sha]);
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', from, task.sha];
    const files = git([...args, '--name-only', '-z']).split('\0').filter(Boolean);
    if (files.some((file) => INSTRUCTIONS.test(file))) return null;
    const patch = git([...args, '--unified=0']);
    delta = { inputs, files, sha: task.sha, diff_sha256: createHash('sha256').update(patch).digest('hex'), disputes };
    const passing = inputs.review.ok || inputs.review.followups_only;
    if (options.attestation) {
      if (!shaMatch(options.attestation.from, inputs.review.sha)
        || !files.some((file) => !docsOnly([file], inputs.docs_paths, inputs.docs_exclude))
        || !namedFixes(files, patch, inputs.review.findings, inputs, [], true, !!options.metadata)) return null;
      return prepareSoftware(st, task, { ...delta, reason: 'attestation', attestation: options.attestation });
    }
    if (passing && docsOnly(files, inputs.docs_paths, inputs.docs_exclude)) {
      return prepareSoftware(st, task, { ...delta, reason: 'docs only' });
    }
    if (passing && !files.length && options.metadata && shaMatch(task.sha, inputs.review.sha)) {
      return prepareSoftware(st, task, { ...delta, reason: 'title or body only' });
    }
    if (!passing && namedFixes(files, patch, inputs.review.findings, inputs, disputes, false, !!options.metadata)) {
      if (!files.length && !disputes.length && !options.metadata) return null;
      if (!files.length && !disputes.length && !inputs.review.findings.every((f) =>
        ['PR title', 'PR body'].includes(f.path))) return null;
      return prepareSoftware(st, task, { ...delta, reason: files.length || disputes.length ? 'fix round' : 'title or body only' });
    }
    return null;
  } catch {
    // Missing commits and rewritten history need the ordinary review.
    return null;
  }
}

function record(st, task, prepared, emit) {
  if (!prepared) return;
  if (task.sha !== prepared.sha || !isDeepStrictEqual(snapshot(st, task), prepared.inputs)) {
    throw refuse(`${task.id}: review or docs policy changed while preparing carryover; retry submit`);
  }
  const T = require('./tasks');
  if (T.latestGateEvidence(task, 'review', st.events)?.ok) return;
  const review = prepared.inputs.review;
  const receipt = { reason: prepared.reason, docs_paths: prepared.inputs.docs_paths,
    docs_exclude: prepared.inputs.docs_exclude, files: prepared.files, diff_sha256: prepared.diff_sha256,
    ...(prepared.disputes.length ? { disputes: prepared.disputes } : {}),
    ...(prepared.attestation ? { attestation: prepared.attestation } : {}) };
  const entry = { type: 'review', source: SOURCE, ok: true, sha: task.sha, revision: task.revision,
    agent: review.agent, at: nowIso(), ref: review.ref,
    summary: `Review carried from ${prepared.inputs.reviewed_head}: ${prepared.reason}`,
    carried_from: identity(review), reviewed_head: prepared.inputs.reviewed_head, receipt };
  // A named small fix keeps the software proof the independent review used.
  for (const previous of isDeepStrictEqual(softwarePolicy(st, task), prepared.software_policy) ? prepared.software : []) {
    const type = previous.type;
    const latest = T.latestGateEvidence({ ...task, sha: review.sha, revision: review.revision }, type, st.events);
    if (!isDeepStrictEqual(latest, previous) || T.latestGateEvidence(task, type, st.events)) continue;
    const carried = { ...previous, source: GATE_SOURCE, sha: task.sha, revision: task.revision, at: nowIso(),
      carried_from: identity(previous), reviewed_head: prepared.inputs.reviewed_head, carry_reason: prepared.reason,
      summary: `${type} carried from ${previous.sha}: ${prepared.reason}` };
    task.evidence.push(carried);
    emit(task.id, carried, GATE_SOURCE);
  }
  task.evidence.push(entry);
  emit(task.id, entry, SOURCE);
}

module.exports = { docsPaths, docsOnly, eligible, prepare, record, parseDisputes, namedFixes, identity };
