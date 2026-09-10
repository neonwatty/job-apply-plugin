import { PendingAnswersService } from './pending-answers.js';
import { get, int, keys, object, parse, serialize, string, JobsError } from '../contracts/workspace/values.js';
export async function pendingAnswersHttp(repository, method, path, body) {
    const service = new PendingAnswersService(repository);
    if (method === 'GET' && path === '/api/pending-answers')
        return { status: 200, body: serialize(await service.list()) };
    const match = /^\/api\/jobs\/([^/]+)\/resolve-pending-answer$/.exec(path);
    if (method !== 'POST' || !match)
        return null;
    const payload = object(parse(body), 'answer resolution body');
    const fields = ['reference', 'expectedJobRevision', 'expectedSessionRevision', 'expectedAnswerRevision', 'ownerConfirmed'];
    if (payload.size !== fields.length || keys(payload).some(key => !fields.includes(key)))
        throw new JobsError('answer resolution body contains unsupported or missing fields');
    const reference = string(get(payload, 'reference'));
    if (reference === null)
        throw new JobsError('pending question reference is invalid');
    if (get(payload, 'ownerConfirmed') !== true)
        throw new JobsError('answer resolution requires explicit owner confirmation');
    const revisions = fields.slice(1, 4).map(field => {
        const value = int(get(payload, field));
        if (value === null || value < 1n)
            throw new JobsError('answer resolution revision is invalid');
        return value;
    });
    const result = await service.resolve(decodeURIComponent(match[1]), reference, revisions[0], revisions[1], revisions[2], true);
    return { status: 200, body: serialize(result) };
}
