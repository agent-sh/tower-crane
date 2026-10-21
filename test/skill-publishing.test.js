'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers');

test('worker instructions keep base merges conditional and publication at submit', () => {
  const work = fs.readFileSync(path.join(ROOT, 'skills/tower-crane-work/SKILL.md'), 'utf8');
  const prepare = work.slice(work.indexOf('6. '), work.indexOf('7. '));
  const checklist = work.slice(work.indexOf('7. '), work.indexOf('8. '));
  const publish = work.slice(work.indexOf('8. '), work.indexOf('## Rework'));
  const rework = work.slice(work.indexOf('## Rework'));
  assert.match(prepare, /Merge the base only at first publish.*conflicting.*orchestrator or a rework note requests/);
  assert.match(prepare, /Otherwise do not fetch or merge the base on a revision/);
  assert.match(prepare, /CONFLICTING.*DIRTY.*unknown mergeability does not/);
  assert.doesNotMatch(prepare, /Push with|Create or update the PR/);
  assert.match(checklist, /against the local diff.*before publishing/);
  assert.doesNotMatch(checklist, /Do it after the PR exists|so CI.*run at that head|fix.*push,|gh pr edit/);
  assert.match(checklist, /Fix the blocking ones locally/);
  assert.match(publish, /Publish once, right before submit/);
  assert.match(publish, /Run submit immediately after publication/);
  assert.match(publish, /No push between submits/);
  assert.match(rework, /Keep every rework fix local until resubmit/);
  assert.match(rework, /push and update the PR once, immediately before resubmitting/);
  assert.doesNotMatch(work, /Fix the blocking ones, push|fix them, push,|Do it after the PR exists/);
  const review = fs.readFileSync(path.join(ROOT, 'skills/tower-crane-review/SKILL.md'), 'utf8');
  assert.match(review, /Workers check the local diff before publishing once at submit/);
});
