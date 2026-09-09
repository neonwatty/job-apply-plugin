import { get, int, integer, keys, object, parse, serialize, set, string } from '../../../src/contracts/workspace/values';
import type { Document } from '../../../src/contracts/workspace/values';

export interface CleanupPair {
  winnerKey: string;
  duplicateKey: string;
  confidenceBand: 'exact' | 'high';
  reasonCodes: string[];
  winnerRevision: bigint;
  duplicateRevision: bigint;
  winnerQuestion: string;
  duplicateQuestion: string;
}

function closed(record: Document, fields: string[]): void {
  const actual = keys(record);
  if (actual.length !== fields.length || actual.some(key => !fields.includes(key))) throw Error('Invalid cleanup preview');
}

function requiredString(record: Document, field: string): string {
  const value = string(get(record, field));
  if (value === null) throw Error('Invalid cleanup preview');
  return value;
}

function revision(record: Document, field: string): bigint {
  const value = int(get(record, field));
  if (value === null || value < 1n) throw Error('Invalid cleanup preview');
  return value;
}

export interface CleanupPreview {
  previewToken: string;
  pairs: CleanupPair[];
}

// The token is retained only for the approval request, never rendered.
export function cleanupPreview(raw: string): CleanupPreview {
  const response = object(parse(raw), 'cleanup preview');
  closed(response, ['proposals', 'previewToken', 'mutated']);
  const token = requiredString(response, 'previewToken');
  if (get(response, 'mutated') !== false || token.length !== 'answer-cleanup-v1.'.length + 64 || !/^answer-cleanup-v1\.[a-f0-9]{64}$/.test(token)) {
    throw Error('Invalid cleanup preview');
  }
  const proposals = get(response, 'proposals');
  if (!Array.isArray(proposals)) throw Error('Invalid cleanup preview');
  const pairs = proposals.map(value => {
    const record = object(value, 'cleanup proposal');
    closed(record, ['winnerKey', 'duplicateKey', 'confidenceBand', 'reasonCodes', 'winnerRevision', 'duplicateRevision', 'winnerQuestion', 'duplicateQuestion']);
    const confidenceBand = requiredString(record, 'confidenceBand');
    const reasons = get(record, 'reasonCodes');
    if ((confidenceBand !== 'exact' && confidenceBand !== 'high') || !Array.isArray(reasons)) throw Error('Invalid cleanup preview');
    const reasonCodes = reasons.map(reason => {
      const code = string(reason);
      if (code === null) throw Error('Invalid cleanup preview');
      return code;
    });
    return {
      winnerKey: requiredString(record, 'winnerKey'),
      duplicateKey: requiredString(record, 'duplicateKey'),
      winnerQuestion: requiredString(record, 'winnerQuestion'),
      duplicateQuestion: requiredString(record, 'duplicateQuestion'),
      winnerRevision: revision(record, 'winnerRevision'),
      duplicateRevision: revision(record, 'duplicateRevision'),
      confidenceBand: confidenceBand as CleanupPair['confidenceBand'],
      reasonCodes,
    };
  });
  return { previewToken: token, pairs };
}

export function cleanupApproval(preview: CleanupPreview, pair: CleanupPair): string {
  if (!preview.pairs.includes(pair)) throw Error('Invalid cleanup approval');
  const body = object(parse(JSON.stringify({
    approval: {
      previewToken: preview.previewToken, winnerKey: pair.winnerKey, duplicateKey: pair.duplicateKey,
    },
    ownerConfirmed: true,
  })), 'cleanup approval');
  const approval = object(get(body, 'approval'), 'approval');
  set(approval, 'winnerRevision', integer(pair.winnerRevision));
  set(approval, 'duplicateRevision', integer(pair.duplicateRevision));
  return serialize(body);
}

export function cleanupApproved(raw: string): void {
  const result = object(parse(raw), 'cleanup approval result');
  closed(result, ['approved', 'result']);
  if (get(result, 'approved') !== true) throw Error('Invalid cleanup approval result');
  revision(object(get(result, 'result'), 'answer'), 'revision');
}

export function cleanupExplanation(pair: CleanupPair): string {
  return pair.confidenceBand === 'exact'
    ? 'The question or an alternate wording matches exactly.'
    : 'The questions have a strong similarity in meaning.';
}
