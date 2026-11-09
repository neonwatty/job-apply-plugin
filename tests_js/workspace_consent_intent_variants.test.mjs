import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rankCandidates } from '../runtime/contracts/workspace/answer-match-scoring.js';
import { evaluateReuse } from '../runtime/contracts/workspace/answer-match-reuse.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const scope = fromJSON({ employer: 'Synthetic' });
const fieldClass = fromJSON('demographic_consent');
const sensitivity = fromJSON('high');
const saved = fromJSON({ key: 'demographic-consent',
  question: 'I agree to Synthetic processing my voluntary demographic data for recruiting inclusion metrics',
  aliases: [
    'I consent to Synthetic processing my voluntary demographic data for recruiting inclusion metrics',
    'Yes, I agree to Synthetic processing my voluntary demographic data for recruiting inclusion metrics',
    'Type I agree to Synthetic processing my voluntary demographic data for recruiting inclusion metrics',
  ], scope: { employer: 'Synthetic' }, fieldClass: 'demographic_consent', sensitivity: 'high',
  state: 'sensitive', valueState: 'seen', recordStatus: 'active', reviewStatus: 'accepted' });
const ranked = question => rankCandidates({ question: fromJSON(question), scope, fieldClass,
  sensitivity, candidates: [saved] })[0];
const reuse = (match, useAuthority) => JSON.parse(serialize(evaluateReuse({ match, candidate: saved, scope,
  fieldClass, sensitivity, mode: fromJSON('strict'), useAuthority: fromJSON(useAuthority) })));

test('one purpose can be proposed across checkbox, radio, dropdown and explicit text variants', () => {
  const variants = [
    ['checkbox', 'I agree to Synthetic processing my voluntary demographic data for recruiting inclusion metrics'],
    ['radio', 'I consent to Synthetic processing my voluntary demographic data for recruiting inclusion metrics'],
    ['dropdown', 'Yes, I agree to Synthetic processing my voluntary demographic data for recruiting inclusion metrics'],
    ['text', 'Type I agree to Synthetic processing my voluntary demographic data for recruiting inclusion metrics'],
  ];
  for (const [control, question] of variants) {
    const match = ranked(question);
    assert.equal(JSON.parse(serialize(match)).confidenceBand, 'exact', control);
    assert.ok(reuse(match, 'none').reasonCodes.includes('owner_confirmation_required'), control);
    assert.ok(reuse(match, 'per_use').reasonCodes.includes('reuse_eligible'), control);
  }
});

test('a high lexical match with a broader sharing purpose still needs a separate decision', () => {
  const changedPurpose = 'I agree to Synthetic processing my voluntary demographic data for recruiting inclusion metrics and sharing it with advertising partners';
  const match = ranked(changedPurpose);
  assert.equal(JSON.parse(serialize(match)).confidenceBand, 'high');
  assert.ok(reuse(match, 'none').reasonCodes.includes('owner_confirmation_required'));
  const guidance = readFileSync(new URL('../skills/job-apply/references/consent-intents.md', import.meta.url), 'utf8');
  assert.match(guidance, /Compare the purpose, data or rights involved, recipient, and consequence/);
  assert.match(guidance, /new purpose, broader use or sharing/);
  assert.match(guidance, /unclear assent requires a new owner decision/);
});
