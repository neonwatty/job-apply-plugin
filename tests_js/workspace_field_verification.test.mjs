import test from 'node:test';
import assert from 'node:assert/strict';
import { decideFieldVerification } from '../apps/companion/field-verification.mjs';

const evidence = changes => ({ source: 'readback', observation: 'match', freshness: 'current',
  attemptScope: 'same', formScope: 'same', controlScope: 'same', repairCount: 0, ...changes });

test('only current same-control/form/attempt affirmative comparisons verify', () => {
  for (const source of ['readback', 'visual']) {
    assert.deepEqual(decideFieldVerification(evidence({ source })), {
      state: 'verified', next: 'continue', verified: true, repairAllowed: false,
      finalSubmissionAllowed: false,
    });
    for (const freshness of ['stale', 'unknown']) {
      const result = decideFieldVerification(evidence({ source, freshness }));
      assert.equal(result.verified, false);
      assert.equal(result.next, 'reobserve');
    }
    for (const key of ['attemptScope', 'formScope', 'controlScope']) {
      for (const value of ['different', 'unknown']) {
        const result = decideFieldVerification(evidence({ source, [key]: value }));
        assert.equal(result.verified, false);
        assert.equal(result.next, 'reobserve');
      }
    }
  }
});

test('masked or omitted readback cannot authorize retyping or completion', () => {
  for (const observation of ['masked', 'unavailable', 'unknown']) {
    for (const repairCount of [0, 1]) {
      const result = decideFieldVerification(evidence({ observation, repairCount }));
      assert.equal(result.verified, false);
      assert.equal(result.repairAllowed, false);
      assert.equal(result.next, 'inspect_visual');
    }
  }
  for (const observation of ['unreadable', 'unknown']) {
    const result = decideFieldVerification(evidence({ source: 'visual', observation }));
    assert.equal(result.verified, false);
    assert.equal(result.repairAllowed, false);
    assert.equal(result.next, 'owner_input_required');
  }
});

test('actual current mismatch permits one repair followed by new observation', () => {
  for (const source of ['readback', 'visual']) {
    const mismatch = evidence({ source, observation: 'mismatch' });
    assert.equal(decideFieldVerification(mismatch).next, 'repair_once');
    assert.equal(decideFieldVerification(mismatch).verified, false);
    assert.equal(decideFieldVerification({ ...mismatch, repairCount: 1 }).next, 'owner_input_required');
    assert.equal(decideFieldVerification({ ...mismatch, freshness: 'stale' }).repairAllowed, false);
    assert.equal(decideFieldVerification({ ...mismatch, formScope: 'different' }).repairAllowed, false);
  }
  const written = decideFieldVerification(evidence({ source: 'write', observation: 'attempted', repairCount: 1 }));
  assert.equal(written.verified, false);
  assert.equal(written.next, 'reobserve');
  assert.equal(decideFieldVerification(evidence({ source: 'visual', repairCount: 1 })).verified, true);
});

test('closed evidence schema rejects wrong evidence and private payloads without echoing them', () => {
  const invalid = [null, [], {}, evidence({ source: 'owner_confirmation' }),
    evidence({ source: 'write', observation: 'match' }), evidence({ source: 'visual', observation: 'masked' }),
    evidence({ observation: '<redacted>' }), evidence({ observation: 'private@example.test' }),
    evidence({ freshness: true }), evidence({ attemptScope: 'attempt-2' }),
    evidence({ repairCount: -1 }), evidence({ repairCount: 2 }), evidence({ repairCount: '0' }),
    evidence({ value: 'private@example.test' }), evidence({ screenshot: '/private/screenshot.png' }),
    evidence({ filename: 'private.pdf' }), evidence({ source: '__proto__' }),
    evidence({ source: ['readback'] }), evidence({ source: { toString: () => 'readback' } })];
  for (const input of invalid) {
    assert.throws(() => decideFieldVerification(input), { message: 'invalid field verification evidence' });
  }
});
