import { activeApplicationAuthority, applicationOrigin } from './application-authority.js';
import { activeApplicationRun, currentRunJobIds } from './application-runs.js';
import { applicationPreflight } from './application-policy.js';
import { claimTime } from './claim-time.js';
import { get, has, int, object, string } from './values.js';
import { TaskProtocolError } from './workflow-tasks.js';
/** Queue position is a projection of durable authority scope and canonical job states. */
export function campaignProjection(snapshot, now) {
    const authority = activeApplicationAuthority(snapshot.authority);
    const result = { status: 'unavailable', reason: 'campaign_authority_unavailable',
        authorityRevision: int(get(object(get(snapshot.authority, 'metadata'), 'authority metadata'), 'revision')).toString(),
        authorizationId: authority ? string(get(authority, 'authorizationId')) : null,
        runId: authority ? string(get(authority, 'runId')) : null, queue: [], nextJob: null };
    if (!authority || string(get(authority, 'mode')) !== 'campaign_to_review')
        return result;
    const status = string(get(authority, 'status'));
    if (status !== 'active' && status !== 'paused')
        return result;
    if (claimTime(now) >= claimTime(string(get(authority, 'expiresAt'))))
        return { ...result, reason: 'campaign_authority_expired' };
    const run = activeApplicationRun(snapshot.jobs);
    if (!run || string(get(run, 'runId')) !== result.runId || int(get(run, 'revision')) !== int(get(authority, 'runRevision'))) {
        return { ...result, reason: 'campaign_run_changed' };
    }
    const metadata = object(get(snapshot.profile, 'metadata'), 'profile metadata');
    const profileRevision = has(metadata, 'revision') ? int(get(metadata, 'revision')) : 1n;
    if (!has(authority, 'profileRevision') || int(get(authority, 'profileRevision')) !== profileRevision) {
        return { ...result, reason: 'campaign_inputs_changed' };
    }
    const queued = currentRunJobIds(run), records = object(get(snapshot.jobs, 'jobs'), 'jobs');
    const bindings = get(authority, 'jobBindings').map(value => object(value, 'job binding'));
    const ids = bindings.map(binding => string(get(binding, 'jobId')));
    if (ids.some(id => !queued.includes(id)) || queued.filter(id => ids.includes(id)).join('\0') !== ids.join('\0')) {
        return { ...result, reason: 'campaign_run_changed' };
    }
    result.queue = ids.map(jobId => {
        const raw = get(records, jobId), job = raw === null ? null : object(raw, 'job');
        return { jobId, jobRevision: job ? int(get(job, 'revision')).toString() : null,
            status: !job || get(job, 'deletedAt') !== null ? 'unavailable' : string(get(job, 'status')) };
    });
    if (status === 'paused')
        return { ...result, status: 'paused', reason: 'campaign_paused' };
    const next = result.queue.find(job => job.status === 'ready');
    result.status = next || result.queue.some(job => job.status === 'in_progress') ? 'active'
        : result.queue.some(job => !['awaiting_review', 'applied', 'closed'].includes(job.status)) ? 'needs_attention' : 'complete';
    result.reason = result.status === 'needs_attention' ? 'campaign_jobs_need_attention' : null;
    // A claim or in-progress job blocks moving to another job, including after broker loss.
    if (get(snapshot.coordinator, 'claim') === null && !result.queue.some(job => job.status === 'in_progress') && next) {
        result.nextJob = { jobId: next.jobId, jobRevision: next.jobRevision };
    }
    return result;
}
/** Called inside the same native transaction as the claim journal and workflow receipt. */
export async function requireCampaignOperation(snapshot, kind, jobId, revision, status, now) {
    // Recovery can only replace an expired same-job claim on the existing task.
    // Restoring its capability permits a guarded exit after pause or revocation.
    if (kind === 'recover' || kind === 'cancel' || kind === 'handoff' && status === 'needs_info')
        return;
    const campaign = campaignProjection(snapshot, now);
    if (campaign.status !== 'active')
        throw new TaskProtocolError('action_unavailable');
    if (kind === 'restart')
        throw new TaskProtocolError('action_unavailable');
    if (kind === 'acquire' && (campaign.nextJob?.jobId !== jobId || campaign.nextJob.jobRevision !== revision.toString())) {
        throw new TaskProtocolError('action_unavailable');
    }
    const authority = activeApplicationAuthority(snapshot.authority);
    const binding = get(authority, 'jobBindings').map(value => object(value, 'binding'))
        .find(value => string(get(value, 'jobId')) === jobId);
    if (!binding)
        throw new TaskProtocolError('action_unavailable');
    const job = object(get(object(get(snapshot.jobs, 'jobs'), 'jobs'), jobId), 'job');
    const resume = object(get(object(get(snapshot.resumes, 'resumes'), 'resumes'), string(get(binding, 'resumeId'))), 'resume');
    const run = activeApplicationRun(snapshot.jobs);
    const selection = object(get(run, 'selection'), 'selection');
    if (get(job, 'deletedAt') !== null || applicationOrigin(get(job, 'normalizedUrl')) !== string(get(binding, 'destinationOrigin'))
        || int(get(resume, 'revision')) !== int(get(binding, 'resumeRevision'))
        || string(get(resume, 'contentRevision')) !== string(get(binding, 'contentRevision'))
        || string(get(selection, 'resumeId')) !== string(get(binding, 'resumeId'))
        || int(get(selection, 'factRevision')) !== int(get(binding, 'factRevision'))
        || get(await applicationPreflight(snapshot, job), 'ready') !== true)
        throw new TaskProtocolError('stale_revision');
}
