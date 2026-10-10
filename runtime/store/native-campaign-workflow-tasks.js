import { NativeClaimWorkflowTasks } from './native-claim-workflow-tasks.js';
import { requireCampaignOperation } from '../contracts/workspace/sequential-campaign.js';
/** Campaign policy and the existing claim journal share one canonical Store lock. */
export class NativeCampaignWorkflowTasks {
    now;
    attempts;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.now = now;
        this.attempts = new NativeClaimWorkflowTasks(repository, now);
    }
    transaction(operation) {
        return this.attempts.transaction(tx => operation({ ...tx, domain: { ...tx.domain,
                execute: async (kind, jobId, revision, token, session, status, savedSessionFingerprint) => {
                    await requireCampaignOperation(tx.domain.snapshot, kind, jobId, revision, status, this.now());
                    return tx.domain.execute(kind, jobId, revision, token, session, status, savedSessionFingerprint);
                },
            } }));
    }
}
