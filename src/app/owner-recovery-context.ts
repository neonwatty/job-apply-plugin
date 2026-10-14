import { claimExpired } from '../contracts/workspace/claims.js';
import { get, int, object, string } from '../contracts/workspace/values.js';
import { TaskProtocolError } from '../contracts/workspace/workflow-tasks.js';
import type { Document } from '../contracts/workspace/values.js';

export interface RecoveryContextReader {
  inspect<T>(callback: (snapshot: { jobs: Document; coordinator: Document; sessions: Document[] }) => Promise<T>): Promise<T>;
}

/** Paused-job inspection only: no broker, activation, descriptors, or claim authority. */
export async function ownerRecoveryContext(repository: RecoveryContextReader, jobId: string,
  now = () => new Date().toISOString().replace(/\.\d{3}Z$/, '')) {
  return repository.inspect(async tx => {
    const raw = get(object(get(tx.jobs, 'jobs'), 'jobs'), jobId);
    if (raw === null) throw new TaskProtocolError('action_unavailable');
    const job = object(raw, 'job');
    if (get(job, 'deletedAt') !== null) throw new TaskProtocolError('action_unavailable');
    const status = string(get(job, 'status'));
    if (status !== 'needs_info' && status !== 'awaiting_review') throw new TaskProtocolError('action_unavailable');
    const revision = int(get(job, 'revision'))!.toString();
    const rawClaim = get(tx.coordinator, 'claim');
    const claim = rawClaim === null ? null : object(rawClaim, 'claim');
    const session = tx.sessions.find(item => string(get(item, 'applicationId')) === jobId);
    return { ok: true, ownerWorkflow: 1, result: {
      readOnly: true, evidenceKind: 'agent_attested', browserAuthority: 'none', finalSubmission: 'manual',
      ownerScope: { jobId, jobRevision: revision },
      broker: { connected: false, ownsClaim: false },
      guidance: {
        nextOperation: 'resolve_workflow_blocker',
        blockers: [status === 'needs_info' ? 'resolve_needs_info_before_preparation' : 'explicit_restart_required'],
        selection: { jobId, jobRevision: revision, status, inputsCurrent: false, preflightReady: false },
        claim: claim === null ? null : { jobId: string(get(claim, 'jobId')), state: claimExpired(claim, now()) ? 'expired' : 'live' },
        checkpoint: session ? { status: string(get(session, 'status')),
          attemptRevision: int(get(session, 'attemptRevision'))?.toString() ?? null } : null,
        sessionRequiresObservation: true, actions: [],
      },
      hostBrowser: { reports: [] },
    } };
  });
}
