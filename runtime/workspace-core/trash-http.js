import { TrashService } from './trash.js';
import { PythonObject } from '../contracts/python-object.js';
import { JobsError, fromJSON, get, int, keys, parse, serialize } from '../contracts/workspace/values.js';
const failure = (status, code, message, details = {}) => ({
    status, body: serialize(fromJSON({ error: { code, message, ...details } })),
});
function lifecycleFailure(error, operation) {
    const message = error.message;
    const rules = [
        [message.includes('revision conflict'), 'revision_conflict',
            'This record changed elsewhere. Refresh and review the latest revision.', {}],
        [message.includes('does not exist') && message !== 'assigned resume does not exist',
            'not_found', 'This record no longer exists.', {}],
        [message.includes('claimed job'), 'claim_blocked',
            'This job has a coordinator claim that must be released or completed first.', { claims: 1 }],
        [message.includes('active job URL already exists'), 'duplicate_active_blocked',
            'An active job with the same canonical identity already exists.', { duplicateActiveRecords: 1 }],
        [message.includes('assigned resume does not exist'), 'assigned_resume_blocked',
            "This job's assigned resume is unavailable. Restore or reassign that resume first.", { unavailableAssignedResumes: 1 }],
    ];
    const [, code, safeMessage, counts] = rules.find(([matches]) => matches)
        ?? [true, 'store_rejected', 'The canonical store rejected this lifecycle operation.', {}];
    return failure(code === 'not_found' ? 404 : code === 'store_rejected' ? 400 : 409, code, safeMessage, { recordType: 'job', operation, counts });
}
/** Lifecycle failures carry only operation metadata and fixed blocker counts. */
export async function trashHttp(repository, method, path, body) {
    const service = new TrashService(repository);
    if (method === 'GET' && path === '/api/trash')
        return { status: 200, body: serialize(await service.list()) };
    const match = /^\/api\/jobs\/([^/]+)\/(trash|restore)$/.exec(path);
    if (method !== 'POST' || !match)
        return null;
    const operation = match[2];
    let payload;
    try {
        payload = parse(body);
    }
    catch {
        return failure(400, 'request_error', 'request body must be valid JSON');
    }
    if (!(payload instanceof PythonObject))
        return failure(400, 'request_error', 'request body must be a JSON object');
    if (keys(payload).length !== 1 || keys(payload)[0] !== 'expectedRevision') {
        return failure(400, 'request_error', `${operation} body requires expectedRevision`);
    }
    const revision = int(get(payload, 'expectedRevision'));
    if (revision === null || revision < 1n)
        return failure(400, 'request_error', 'expectedRevision must be a positive integer');
    try {
        const id = decodeURIComponent(match[1]);
        return { status: 200, body: serialize(await (operation === 'trash'
                ? service.trashJob(id, revision) : service.restoreJob(id, revision))) };
    }
    catch (error) {
        if (error instanceof JobsError)
            return lifecycleFailure(error, operation);
        if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) {
            return failure(500, 'storage_error', 'storage operation failed');
        }
        throw error;
    }
}
