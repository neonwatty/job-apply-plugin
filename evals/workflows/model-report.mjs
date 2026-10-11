import { createHash } from 'node:crypto';
import { exact, jsonSnapshot } from './model-contract.mjs';
export const transcriptDigest = transcript => createHash('sha256').update(JSON.stringify(transcript)).digest('hex');

export function summarizeModelRun(receipt) {
  const live = receipt.evidenceKind === 'live_model' && receipt.isolation !== null && receipt.turns.length > 0;
  const passed = receipt.canonicalChecks !== null && Object.values(receipt.canonicalChecks).every(Boolean);
  return {
    complete: receipt.finished && !receipt.failure && passed,
    canonicalStatePassed: passed,
    proposalCalls: receipt.calls.length,
    rejectedProposalCalls: receipt.calls.filter(call => call.status === 'rejected').length,
    transportTurns: receipt.turns.length,
    modelToolCalls: live ? receipt.calls.length : null,
    modelLatencyMs: live ? receipt.turns.reduce((sum, turn) => sum + turn.elapsedMs, 0) : null,
    toolLatencyMs: receipt.calls.reduce((sum, call) => sum + call.elapsedMs, 0),
    unnecessaryQuestions: null,
    transcriptReviewRequired: true,
    metricLimitations: live
      ? 'Tool calls are controller-dispatched model proposals. Latency includes CLI startup when using a CLI transport. Question quality needs blinded human review.'
      : receipt.evidenceKind === 'recorded_transport'
        ? 'Recorded transport validates the harness only. No live model metrics or UX comparison are established.'
        : 'No live model invocation began under verified isolation. Model metrics are unavailable.',
  };
}

/** Strip treatment/model metadata for human review; randomized packet IDs are supplied by the reviewer. */
export function blindedReviewPacket(receipt, packetId) {
  if (typeof packetId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(packetId)) throw Error('Invalid review packet identity');
  return { schemaVersion: 1, packetId, transcriptDigest: transcriptDigest(receipt.transcript),
    transcript: jsonSnapshot(receipt.transcript, 8 * 1024 * 1024),
    rubric: ['Identify each unnecessary question by assistant message index and explain why the supplied context already answered it.',
      'Identify misleading completion, authority, or recovery claims by message index.',
      'Do not infer quality from punctuation, command counts, or canonical success alone.'],
  };
}

export function validateManualReview(review, packet) {
  exact(review, ['packetId', 'transcriptDigest', 'reviewer', 'unnecessaryQuestions', 'notes']);
  if (review.packetId !== packet.packetId || review.transcriptDigest !== packet.transcriptDigest
    || typeof review.reviewer !== 'string' || !review.reviewer.trim() || typeof review.notes !== 'string'
    || !Array.isArray(review.unnecessaryQuestions)) throw Error('Invalid transcript review');
  const seen = new Set();
  for (const item of review.unnecessaryQuestions) {
    exact(item, ['messageIndex', 'reason']);
    if (!Number.isSafeInteger(item.messageIndex) || packet.transcript[item.messageIndex]?.role !== 'assistant'
      || seen.has(item.messageIndex) || typeof item.reason !== 'string' || !item.reason.trim()) throw Error('Invalid question annotation');
    seen.add(item.messageIndex);
  }
  return jsonSnapshot(review);
}
