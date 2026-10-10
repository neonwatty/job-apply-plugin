const common = ['unattestedReplyBlocked', 'exactReplyReplayInert', 'confirmedFactsFeedActualRun',
  'outOfOrderAndUnattestedAcquireBlocked', 'unrelatedProfileAndManagedResumePreserved', 'noSubmissionOrInventedReview'];
const requirements = {
  'campaign-blocked-queue': [...common, 'pauseAndStaleResumeBlocked', 'restartSelectsNextThenBlockedQueueStops'],
  'campaign-broker-restart': [...common, 'liveClaimRequiresRecoveryWait'],
};
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) throw Error('Invalid evidence shape');
}
/** Grades controlled executable evidence only. No text heuristics stand in for model evaluation. */
export function grade(receipt) {
  exact(receipt, ['schemaVersion', 'scenario', 'evidenceKind', 'checks', 'calls', 'elapsedMs', 'modelTranscript']);
  const expected = requirements[receipt.scenario];
  if (!expected || receipt.schemaVersion !== 1 || receipt.evidenceKind !== 'deterministic_installed_commands'
    || receipt.modelTranscript !== null || !Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs < 0) throw Error('Invalid evidence identity');
  exact(receipt.checks, expected);
  if (Object.values(receipt.checks).some(value => typeof value !== 'boolean')
    || !Array.isArray(receipt.calls) || receipt.calls.length < 1 || receipt.calls.length > 1000) throw Error('Invalid evidence values');
  for (const call of receipt.calls) {
    exact(call, ['surface', 'command', 'code', 'elapsedMs']);
    if (!['workflow', 'store'].includes(call.surface) || typeof call.command !== 'string' || !call.command.length
      || call.command.length > 128 || ![0, 2].includes(call.code) || !Number.isFinite(call.elapsedMs) || call.elapsedMs < 0) throw Error('Invalid command evidence');
  }
  const commandLatencyMs = receipt.calls.reduce((sum, call) => sum + call.elapsedMs, 0);
  return {
    scenario: receipt.scenario, completion: Object.values(receipt.checks).every(Boolean),
    passedChecks: Object.values(receipt.checks).filter(Boolean).length, requiredChecks: expected.length,
    commandInvocations: receipt.calls.length, rejectedCommandInvocations: receipt.calls.filter(call => call.code === 2).length,
    commandLatencyMs, elapsedMs: receipt.elapsedMs,
    modelToolCalls: null, unnecessaryQuestions: null, modelLatencyMs: null,
    modelMetricsUnavailableReason: 'No model conversation was executed or graded.',
  };
}
