import { randomUUID } from 'node:crypto';
import { activeApplicationRun, currentRunJobIds, validateApplicationRuns } from '../contracts/workspace/application-runs.js';
import { safeId } from '../contracts/workspace/jobs.js';
import { copy, fromJSON, get, int, integer, keys, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
const doc = (value) => object(fromJSON(value), 'application run value');
function jobIds(value) {
    if (!Array.isArray(value))
        throw new JobsError('application run jobIds must be a list');
    const result = value.map(item => safeId(string(item)));
    if (new Set(result).size !== result.length)
        throw new JobsError('application run queue contains duplicate jobs');
    return result;
}
function inputJobIds(input) {
    if (input.size !== 1 || keys(input)[0] !== 'jobIds')
        throw new JobsError('application run input must contain only jobIds');
    return jobIds(get(input, 'jobIds'));
}
function requireJobs(jobs, ids) {
    const records = object(get(jobs, 'jobs'), 'jobs');
    for (const id of ids) {
        const value = get(records, id);
        if (value === null || get(object(value, 'job'), 'deletedAt') !== null)
            throw new JobsError(`application run job is unavailable: ${id}`);
    }
}
export class ApplicationRunsService {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    status() {
        return this.repository.claimTransaction(async (tx) => activeApplicationRun(tx.jobs));
    }
    start(resumeId, expectedResume, expectedFacts, confirmed, input) {
        safeId(resumeId);
        if (!confirmed)
            throw new JobsError('application run inputs require owner confirmation in chat');
        const ids = inputJobIds(input);
        return this.repository.claimTransaction(async (tx) => {
            if (activeApplicationRun(tx.jobs) !== null)
                throw new JobsError('an application run is already active');
            requireJobs(tx.jobs, ids);
            const resumeValue = get(object(get(tx.resumes, 'resumes'), 'resumes'), resumeId);
            if (resumeValue === null)
                throw new JobsError('resume does not exist');
            const resume = object(resumeValue, 'resume');
            if (get(resume, 'deletedAt') !== null || string(get(resume, 'storageKind')) !== 'managed'
                || int(get(resume, 'revision')) !== expectedResume)
                throw new JobsError('resume revision conflict');
            const observation = await tx.files.observation(resume);
            if (!observation.exists || observation.digest !== string(get(resume, 'digest')))
                throw new JobsError('resume file changed');
            const setValue = tx.facts ? get(object(get(tx.facts, 'sets'), 'resume fact sets'), resumeId) : null;
            const versions = setValue === null ? null : get(object(setValue, 'resume fact set'), 'versions');
            const latest = Array.isArray(versions) && versions.length ? object(versions[versions.length - 1], 'resume facts') : null;
            if (!latest || int(get(latest, 'revision')) !== expectedFacts || string(get(latest, 'state')) !== 'confirmed'
                || string(get(latest, 'contentRevision')) !== string(get(resume, 'contentRevision'))) {
                throw new JobsError('confirmed resume facts are unavailable or stale');
            }
            const now = this.now(), runId = `run-${randomUUID()}`;
            const selection = doc({ resumeId, contentRevision: string(get(resume, 'contentRevision')), factRevision: null, confirmedAt: now });
            set(selection, 'factRevision', integer(expectedFacts));
            const run = doc({ runId, status: 'active', revision: 1, selection: {}, queueVersions: [], createdAt: now, updatedAt: now, completedAt: null });
            set(run, 'selection', selection);
            set(run, 'queueVersions', [set(doc({ revision: 1, jobIds: [], updatedAt: now }), 'jobIds', ids.map(text))]);
            const metadata = object(get(tx.jobs, 'metadata'), 'jobs metadata');
            let applicationRuns = validateApplicationRuns(metadata);
            if (applicationRuns === null) {
                applicationRuns = doc({ activeRunId: null, runs: {} });
                set(metadata, 'applicationRuns', applicationRuns);
            }
            set(object(get(applicationRuns, 'runs'), 'application runs'), runId, run);
            set(applicationRuns, 'activeRunId', text(runId));
            set(metadata, 'updatedAt', text(now));
            await tx.saveJobs(tx.jobs);
            return run;
        });
    }
    update(runId, expectedRevision, input) {
        safeId(runId);
        const ids = inputJobIds(input);
        return this.repository.claimTransaction(async (tx) => {
            const run = activeApplicationRun(tx.jobs);
            if (run === null || string(get(run, 'runId')) !== runId)
                throw new JobsError('application run is not active');
            if (int(get(run, 'revision')) !== expectedRevision)
                throw new JobsError('application run revision conflict');
            requireJobs(tx.jobs, ids);
            const claim = get(tx.coordinator, 'claim');
            if (claim !== null) {
                const claimedId = string(get(object(claim, 'claim'), 'jobId'));
                if (!ids.includes(claimedId))
                    throw new JobsError('active claimed job cannot be removed from its application run');
            }
            if (currentRunJobIds(run).join('\0') === ids.join('\0'))
                return run;
            const now = this.now(), nextRevision = expectedRevision + 1n, next = copy(run);
            const versions = [...get(run, 'queueVersions')];
            versions.push(set(doc({ revision: null, jobIds: [], updatedAt: now }), 'revision', integer(nextRevision)));
            set(object(versions[versions.length - 1], 'queue version'), 'jobIds', ids.map(text));
            set(next, 'queueVersions', versions);
            set(next, 'revision', integer(nextRevision));
            set(next, 'updatedAt', text(now));
            const metadata = object(get(tx.jobs, 'metadata'), 'jobs metadata');
            const runs = validateApplicationRuns(metadata);
            set(object(get(runs, 'runs'), 'application runs'), runId, next);
            set(metadata, 'updatedAt', text(now));
            await tx.saveJobs(tx.jobs);
            return next;
        });
    }
    complete(runId, expectedRevision) {
        safeId(runId);
        return this.repository.claimTransaction(async (tx) => {
            const run = activeApplicationRun(tx.jobs);
            if (run === null || string(get(run, 'runId')) !== runId)
                throw new JobsError('application run is not active');
            if (int(get(run, 'revision')) !== expectedRevision)
                throw new JobsError('application run revision conflict');
            if (get(tx.coordinator, 'claim') !== null)
                throw new JobsError('application run cannot complete while a job is claimed');
            const now = this.now(), next = copy(run), metadata = object(get(tx.jobs, 'metadata'), 'jobs metadata');
            set(next, 'status', text('completed'));
            set(next, 'revision', integer(expectedRevision + 1n));
            set(next, 'updatedAt', text(now));
            set(next, 'completedAt', text(now));
            const runs = validateApplicationRuns(metadata);
            set(object(get(runs, 'runs'), 'application runs'), runId, next);
            set(runs, 'activeRunId', null);
            set(metadata, 'updatedAt', text(now));
            await tx.saveJobs(tx.jobs);
            return next;
        });
    }
}
