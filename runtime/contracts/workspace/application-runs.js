import { contentRevision, exact } from './extraction-requests.js';
import { get, int, object, string, JobsError } from './values.js';
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const id = (value, label) => {
    const result = string(value);
    if (!result || !idPattern.test(result) || result.includes('..'))
        throw new JobsError(`${label} is invalid`);
    return result;
};
export function validateRunSelection(value) {
    const selection = object(value, 'application run selection');
    exact(selection, ['resumeId', 'contentRevision', 'factRevision', 'confirmedAt'], 'application run selection is invalid');
    id(get(selection, 'resumeId'), 'application run resume id');
    contentRevision(get(selection, 'contentRevision'));
    const revision = int(get(selection, 'factRevision'));
    if (revision === null || revision < 1n || !string(get(selection, 'confirmedAt'))) {
        throw new JobsError('application run selection is invalid');
    }
    return selection;
}
function validateQueueVersion(value, previous) {
    const version = object(value, 'application run queue version');
    exact(version, ['revision', 'jobIds', 'updatedAt'], 'application run queue version is invalid');
    const revision = int(get(version, 'revision'));
    const jobIds = get(version, 'jobIds');
    if (revision !== previous + 1n || !Array.isArray(jobIds) || !string(get(version, 'updatedAt'))) {
        throw new JobsError('application run queue version is invalid');
    }
    const values = jobIds.map(item => id(item, 'application run job id'));
    if (new Set(values).size !== values.length)
        throw new JobsError('application run queue contains duplicate jobs');
    return revision;
}
export function validateApplicationRun(key, value) {
    const run = object(value, 'application run');
    exact(run, ['runId', 'status', 'revision', 'selection', 'queueVersions', 'createdAt', 'updatedAt', 'completedAt'], 'application run is invalid');
    if (id(get(run, 'runId'), 'application run id') !== key)
        throw new JobsError('application run id does not match its index');
    const status = string(get(run, 'status'));
    const revision = int(get(run, 'revision'));
    const versions = get(run, 'queueVersions');
    if (!['active', 'completed'].includes(status ?? '') || revision === null || revision < 1n
        || !Array.isArray(versions) || versions.length === 0 || !string(get(run, 'createdAt')) || !string(get(run, 'updatedAt'))) {
        throw new JobsError('application run is invalid');
    }
    validateRunSelection(get(run, 'selection'));
    let queueRevision = 0n;
    for (const version of versions)
        queueRevision = validateQueueVersion(version, queueRevision);
    if (revision < queueRevision || (status === 'active' && revision !== queueRevision))
        throw new JobsError('application run revision is invalid');
    if ((status === 'completed') !== Boolean(string(get(run, 'completedAt'))))
        throw new JobsError('application run completion is invalid');
    return run;
}
export function validateApplicationRuns(metadata) {
    const raw = get(metadata, 'applicationRuns');
    if (raw === null)
        return null;
    const document = object(raw, 'application runs');
    exact(document, ['activeRunId', 'runs'], 'application runs are invalid');
    const runs = object(get(document, 'runs'), 'application runs');
    let active = null;
    for (const [key, value] of runs.entries()) {
        const run = validateApplicationRun(id(key, 'application run id'), value);
        if (string(get(run, 'status')) === 'active') {
            if (active !== null)
                throw new JobsError('multiple application runs are active');
            active = string(get(run, 'runId'));
        }
    }
    const activeRunId = get(document, 'activeRunId') === null ? null : id(get(document, 'activeRunId'), 'active run id');
    if (activeRunId !== active)
        throw new JobsError('active application run reference is invalid');
    return document;
}
export function activeApplicationRun(jobs) {
    const metadata = get(jobs, 'metadata');
    if (metadata === null)
        return null;
    const runs = validateApplicationRuns(object(metadata, 'jobs metadata'));
    if (runs === null || get(runs, 'activeRunId') === null)
        return null;
    return object(get(object(get(runs, 'runs'), 'application runs'), string(get(runs, 'activeRunId'))), 'active application run');
}
export function currentRunJobIds(run) {
    const versions = get(run, 'queueVersions');
    return get(object(versions[versions.length - 1], 'application run queue version'), 'jobIds').map(item => string(item));
}
