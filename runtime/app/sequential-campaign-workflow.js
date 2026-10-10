import { ClaimWorkflow } from './claim-workflow.js';
import { campaignProjection, requireCampaignOperation } from '../contracts/workspace/sequential-campaign.js';
import { exact, record, revision, snapshot } from '../harness/validation.js';
import { TaskProtocolError } from '../contracts/workspace/workflow-tasks.js';
/** A sequential campaign reuses one claim-owned attempt at a time, with no competing active task. */
export class SequentialCampaignWorkflow {
    store;
    authority;
    now;
    attempt;
    constructor(store, claims, authority, access, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), userEvents) {
        this.store = store;
        this.authority = authority;
        this.now = now;
        this.attempt = new ClaimWorkflow(store, claims, access, now, userEvents);
    }
    async inspect(requestedJobId) {
        const campaign = await this.store.transaction(async (tx) => {
            const projection = campaignProjection(tx.domain.snapshot, this.now());
            if (projection.nextJob) {
                try {
                    await requireCampaignOperation(tx.domain.snapshot, 'acquire', projection.nextJob.jobId, BigInt(projection.nextJob.jobRevision), undefined, this.now());
                }
                catch (error) {
                    if (!(error instanceof TaskProtocolError))
                        throw error;
                    return { ...projection, status: 'unavailable', reason: 'campaign_inputs_changed', nextJob: null };
                }
            }
            return projection;
        });
        const context = await this.attempt.inspect(requestedJobId ?? campaign.nextJob?.jobId);
        context.guidance.actions = context.guidance.actions.filter(action => {
            if (action.kind === 'cancel' || action.kind === 'handoff' && action.input.status === 'needs_info')
                return true;
            if (action.kind === 'recover')
                return true;
            if (campaign.status !== 'active' || action.kind === 'restart')
                return false;
            return action.kind !== 'acquire' || action.input.jobId === campaign.nextJob?.jobId;
        });
        for (const action of context.guidance.actions)
            action.args = action.args.map(arg => arg === 'attempt' ? 'campaign' : arg);
        if (campaign.reason)
            context.guidance.blockers.push(campaign.reason);
        if (campaign.status !== 'active' && context.guidance.actions.length)
            context.guidance.nextOperation =
                context.guidance.actions.some(action => action.kind === 'recover') ? 'recover_only_if_requested' : 'needs_info_handoff';
        if (!context.guidance.actions.length && !context.guidance.blockers.includes('different_active_workflow')) {
            context.guidance.nextOperation = campaign.status === 'complete' ? 'campaign_complete' : 'inspect_only';
        }
        return { ...context, campaign };
    }
    execute(raw, hostEvent) { return this.attempt.execute(raw, hostEvent); }
    reviewUserEvent(raw) { return this.attempt.reviewUserEvent(raw); }
    heartbeat() { return this.attempt.heartbeat(); }
    close() { return this.attempt.close(); }
    /** Fixture host attestation is explicit but does not authenticate a human identity. */
    control(action, expectedRevision, hostEvent) {
        if (!['pause', 'resume', 'stop'].includes(action))
            throw new TaskProtocolError('action_unavailable');
        revision(expectedRevision, 'invalid_event');
        if (hostEvent === undefined)
            throw new TaskProtocolError('user_event_required');
        const event = record(snapshot(hostEvent), 'invalid_event');
        exact(event, ['action', 'expectedRevision'], 'invalid_event');
        if (event.action !== action || event.expectedRevision !== expectedRevision)
            throw new TaskProtocolError('user_event_required');
        return this.authority.control(action, BigInt(expectedRevision));
    }
}
