import assert from 'node:assert/strict';
import test from 'node:test';
import { grade } from '../evals/workflows/grade.mjs';
const receipt = () => ({ schemaVersion: 1, scenario: 'campaign-broker-restart', evidenceKind: 'deterministic_installed_commands',
  checks: { unattestedReplyBlocked: true, exactReplyReplayInert: true, confirmedFactsFeedActualRun: true,
    outOfOrderAndUnattestedAcquireBlocked: true, unrelatedProfileAndManagedResumePreserved: true,
    noSubmissionOrInventedReview: true, liveClaimRequiresRecoveryWait: true },
  calls: [{ surface: 'workflow', command: 'campaign context', code: 0, elapsedMs: 15 }], elapsedMs: 20, modelTranscript: null });
test('closed evidence grader distinguishes executable completion from unavailable model metrics', () => {
  const result = grade(receipt());
  assert.equal(result.completion, true);
  assert.equal(result.commandInvocations, 1);
  assert.equal(result.commandLatencyMs, 15);
  assert.equal(result.unnecessaryQuestions, null);
  assert.equal(result.modelToolCalls, null);
  const failed = receipt(); failed.checks.liveClaimRequiresRecoveryWait = false;
  assert.equal(grade(failed).completion, false);
});
test('closed evidence rejects incomplete, fabricated model, and malformed metric inputs', () => {
  for (const change of [
    value => { delete value.checks.liveClaimRequiresRecoveryWait; },
    value => { value.checks.extra = true; },
    value => { value.calls[0].elapsedMs = -1; },
    value => { value.calls = []; },
    value => { value.modelTranscript = 'Pretend model success'; },
    value => { value.evidenceKind = 'live_browser'; },
  ]) {
    const value = receipt(); change(value); assert.throws(() => grade(value), /Invalid evidence|Invalid command/);
  }
});
