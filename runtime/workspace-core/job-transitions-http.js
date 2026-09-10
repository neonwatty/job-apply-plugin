import { JobTransitionsService } from './job-transitions.js';
import { get, has, int, keys, object, parse, serialize, string, JobsError } from '../contracts/workspace/values.js';
export async function jobTransitionsHttp(repository, method, path, body) {
    const match = /^\/api\/jobs\/([^/]+)\/transition$/.exec(path);
    if (method !== 'POST' || !match)
        return null;
    const payload = object(parse(body), 'transition body');
    const allowed = ['status', 'expectedRevision', 'closedOutcome', 'userConfirmed'];
    if (!has(payload, 'status') || !has(payload, 'expectedRevision') || keys(payload).some(key => !allowed.includes(key)))
        throw new JobsError('transition body is invalid');
    const status = string(get(payload, 'status'));
    if (status === null)
        throw new JobsError('transition status must be a string');
    const outcome = get(payload, 'closedOutcome');
    if (outcome !== null && string(outcome) === null)
        throw new JobsError('closedOutcome must be a string or null');
    if (has(payload, 'userConfirmed') && typeof get(payload, 'userConfirmed') !== 'boolean')
        throw new JobsError('userConfirmed must be a boolean');
    const revision = int(get(payload, 'expectedRevision'));
    if (revision === null || revision < 1n)
        throw new JobsError('expectedRevision must be a positive integer');
    const result = await new JobTransitionsService(repository).transition(decodeURIComponent(match[1]), status, revision, outcome, get(payload, 'userConfirmed') === true);
    return { status: 200, body: serialize(result) };
}
