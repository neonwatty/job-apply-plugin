import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {validateReviewRestartEvidence} from '../runtime/contracts/workspace/review-restart.js';
import {fromJSON,serialize} from '../runtime/contracts/workspace/values.js';
import {cases,job,legacy,modern,reviewed} from './workspace_review_restart_contracts_support.mjs';

test('review restart distinguishes a full current attempt from the one-time legacy review', () => {
  assert.equal(validateReviewRestartEvidence(fromJSON(job),fromJSON(modern),[fromJSON(reviewed)]),'job-restarted');
  assert.equal(validateReviewRestartEvidence(fromJSON(job),fromJSON(legacy),[fromJSON(reviewed)]),'legacy-review-rebuild');
});
test('review evidence gates match original Python restart including validation and history ordering', () => {
  const inputs = cases();
  const oracle = JSON.parse(execFileSync('python3',['tools/contracts/review-restart/reference.py'], {
    input:JSON.stringify(inputs),encoding:'utf8',maxBuffer:1024*1024,
  }));
  for (const [index,item] of inputs.entries()) {
    const record = fromJSON(item.job), session = fromJSON(item.session), history = item.history.map(fromJSON);
    const before = [record,session,...history].map(serialize);
    let actual;
    try { actual = {value:validateReviewRestartEvidence(record,session,history)}; }
    catch (error) { actual = {error:error.message}; }
    assert.deepEqual(actual,oracle[index],item.name);
    assert.deepEqual([record,session,...history].map(serialize),before,`${item.name}: inputs remain unchanged`);
  }
});
