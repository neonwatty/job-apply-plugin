import { experimentalClaimWorkflow } from '../../cli/experimental-claim-workflow.js';
import { createUserEventAuthority } from '../../harness/user-events.js';
import type { ClaimWorkflow } from '../../app/claim-workflow.js';
import { TaskProtocolError } from '../../contracts/workspace/workflow-tasks.js';

/** Trusted embedding API, not a model tool or CLI. The host authenticates human decisions
 * and retains these methods outside the model's transport. A caller-controlled IPC/file
 * that auto-approves requests would destroy this boundary. Still fictional-Store-only.
 */
export function createTrustedAttemptHost(root: string, nativeLock: string) {
  const { approvals, verifier } = createUserEventAuthority();
  let started = false;
  let review: ((raw: unknown) => ReturnType<ClaimWorkflow['reviewUserEvent']>) | undefined;
  return Object.freeze({
    async run(): Promise<unknown> {
      if (started) throw new TaskProtocolError('broker_unavailable');
      started = true;
      try {
        return await experimentalClaimWorkflow(['serve', '--root', root, '--native-lock', nativeLock],
          { userEvents: verifier, ready: callback => { review = callback; } });
      } finally { review = undefined; approvals.close(); }
    },
    review(raw: unknown): ReturnType<ClaimWorkflow['reviewUserEvent']> {
      if (!review) return Promise.reject(new TaskProtocolError('broker_unavailable'));
      return review(raw);
    },
    approvals,
  });
}
