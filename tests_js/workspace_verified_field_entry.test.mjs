import test from 'node:test';
import assert from 'node:assert/strict';
import { performVerifiedFieldEntry } from '../apps/companion/verified-field-entry.mjs';
const evidence = observation => ({ source: 'readback', observation, freshness: 'current',
  attemptScope: 'same', formScope: 'same', controlScope: 'same', repairCount: 0 });

test('readback API failure never causes another write or leaks private errors', async () => {
  let repairs = 0;
  const result = await performVerifiedFieldEntry({ write: async () => {},
    observe: async () => { throw Error('private value inputValue is not a function'); },
    repair: async () => { repairs++; }, repairCount: 0 });
  assert.equal(repairs, 0);
  assert.equal(result.state, 'observation_failed');
  assert.equal(result.verified, false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('a write exception requires observation and can still have succeeded', async () => {
  const result = await performVerifiedFieldEntry({ write: async () => { throw Error('focus moved'); },
    observe: async () => evidence('match'), repairCount: 0 });
  assert.equal(result.writeState, 'uncertain');
  assert.equal(result.verified, true);
});
test('one observed mismatch permits one alternate and fresh readback', async () => {
  let observations = 0;
  const result = await performVerifiedFieldEntry({ write: async () => {},
    observe: async () => evidence(++observations === 1 ? 'mismatch' : 'match'),
    repair: async () => {}, repairCount: 0 });
  assert.equal(observations, 2);
  assert.equal(result.repairCount, 1);
  assert.equal(result.verified, true);
});
test('consumed retries, masking and stale observations cannot trigger repair', async () => {
  for (const state of ['consumed', 'masked', 'stale']) {
    const result = await performVerifiedFieldEntry({ write: async () => {},
      observe: async () => ({ ...evidence(state === 'masked' ? 'masked' : 'mismatch'),
        freshness: state === 'stale' ? 'stale' : 'current' }),
      repair: async () => { assert.fail('unexpected repair'); }, repairCount: state === 'consumed' ? 1 : 0 });
    assert.equal(result.verified, false);
    assert.equal(result.repairState, 'not_attempted');
  }
});
test('failed alternate stays consumed and cannot verify a mismatch', async () => {
  const result = await performVerifiedFieldEntry({ write: async () => {},
    observe: async () => evidence('mismatch'), repair: async () => { throw Error('private'); }, repairCount: 0 });
  assert.equal(result.repairState, 'uncertain');
  assert.equal(result.repairCount, 1);
  assert.equal(result.next, 'owner_input_required');
});

test('date verification requires all segments and clear associated validation', async () => {
  const { verifyDateGroup } = await import('../apps/companion/verified-field-entry.mjs');
  assert.equal(verifyDateGroup({ segments: [evidence('match'), evidence('match')], validation: 'clear' }).verified, true);
  for (const validation of ['invalid', 'unknown']) {
    assert.equal(verifyDateGroup({ segments: [evidence('match')], validation }).verified, false);
  }
  for (const other of [evidence('mismatch'), evidence('masked'), { ...evidence('match'), freshness: 'stale' }]) {
    assert.equal(verifyDateGroup({ segments: [evidence('match'), other], validation: 'clear' }).verified, false);
  }
  for (const input of [{}, { segments: [], validation: 'clear' }, { segments: [evidence('match')], validation: 'guessed' }]) {
    assert.throws(() => verifyDateGroup(input), /invalid date group evidence/);
  }
});
