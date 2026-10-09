import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';

export const pendingScenarioIds = ['pending-cancel', 'pending-stale-handoff', 'pending-stale-recovery'];
export const pendingCheckpoint = { status: 'active', step: 'questions', handoffChecklist: ['resume_upload'],
  pendingFields: [{ question: 'Synthetic preferred start date?', state: 'missing' },
    { question: 'Synthetic voluntary sensitive response?', state: 'sensitive', sensitive: true }],
  blockers: [{ type: 'browser_handoff', code: 'login-required' }],
  browserHandoff: { state: 'required', reasonCode: 'login-required', revision: 7 } };
const hash = value => createHash('sha256').update(value).digest('hex');
export function pendingCheckpointSaved(saved) {
  if (!saved || saved.status !== 'active' || !Array.isArray(saved.pendingFields) || saved.pendingFields.length !== 2) return false;
  const references = saved.pendingFields.map(field => field.reference);
  if (new Set(references).size !== 2 || !references.every(value => /^pending_[a-f0-9]{32}$/.test(value))) return false;
  const expected = pendingCheckpoint.pendingFields.map(({ question, ...field }, index) => ({ ...field,
    questionFingerprint: hash(question.toLowerCase()), reference: references[index],
    ...(saved.ats ? { scopeFingerprint: hash(JSON.stringify({ ats: saved.ats })) } : {}) }));
  const blockers = references.map((reference, index) => ({ type: 'information',
    code: index ? 'sensitive-answer-required' : 'answer-required', sensitivity: index ? 'high' : 'none', reference }));
  return same(saved.pendingFields, expected) && same(saved.browserHandoff, pendingCheckpoint.browserHandoff)
    && same(saved.blockers, [...blockers, ...pendingCheckpoint.blockers])
    && same(saved.answerKeys, []) && same(saved.approvals, []) && saved.readiness === null;
}
export function pendingStateChecks(first, last, beforeSecond, original, terminal) {
  const stable = value => {
    if (!value) return null;
    const copy = structuredClone(value); delete copy.updatedAt; return copy;
  };
  return { pendingCheckpointSaved: pendingCheckpointSaved(first),
    completeCheckpointPreserved: Boolean(first && last && beforeSecond)
      && same(stable(first), stable(beforeSecond)) && same(stable(beforeSecond), stable(last)),
    inputScopePreserved: typeof original?.subject.inputRevision === 'string'
      && terminal?.subject.inputRevision === original.subject.inputRevision };
}
export function pendingTurns(scenario, jobId) {
  const first = `I choose the exact Ready job ${jobId}. Acquire its application attempt using the existing confirmed inputs. `
    + `Record this supplied synthetic observation packet, bound to the acquired attempt revision: ${JSON.stringify(pendingCheckpoint)}. `
    + 'These are fictional observed unanswered fields and unfinished work. Do not answer them, grant consent or fabricate readiness. Keep the attempt active; the harness retains its broker and heartbeat. Stop without browser work or handoff.';
  const second = {
    'pending-cancel': 'Cancel my active application attempt through Needs Info. Preserve the entire saved pending-question checkpoint and all existing inputs; release the claim.',
    'pending-stale-handoff': 'The fixture owner changed the resume facts after the checkpoint. Inspect whether the attempt can continue under its original confirmed inputs. If blocked, save Needs Info and release the claim, preserving the entire saved pending-question checkpoint.',
    'pending-stale-recovery': 'The fixture owner changed the resume facts, then the broker was lost. The harness expired only the fictional claim and started a replacement. I authorize recovery of this same expired attempt, then cancellation through Needs Info. Preserve the original task input scope and the entire saved pending-question checkpoint; release the claim.',
  }[scenario];
  if (!second) throw Error('Unknown pending scenario');
  return [{ request: first }, { fresh: true, request: second + ' The harness archived and cleared prior proposal files before this fresh session. Use public state to preserve the saved checkpoint. Do not reconstruct question text, resolve answers, grant consent, repair or confirm facts, replace the run, acquire another job, submit, or do browser work.' }];
}
