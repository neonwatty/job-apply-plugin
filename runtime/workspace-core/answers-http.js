import { AnswersService } from './answers.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { get, has, int, keys, object, parse, serialize, string, JobsError } from '../contracts/workspace/values.js';
const response = (value) => ({ status: 200, body: serialize(value) });
function fields(payload, allowed, required = []) {
    if (keys(payload).some(key => !allowed.includes(key)) || required.some(key => !has(payload, key)))
        throw new JobsError('answer body contains unsupported or missing fields');
}
function consent(payload) {
    const value = has(payload, 'rememberSensitive') ? get(payload, 'rememberSensitive') : false;
    if (typeof value !== 'boolean')
        throw new JobsError('rememberSensitive must be a boolean');
    return value;
}
function revision(payload) {
    const value = int(get(payload, 'expectedRevision'));
    if (value === null || value < 1n)
        throw new JobsError('expectedRevision must be a positive integer');
    return value;
}
function decodeKey(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
        throw new JobsError('encoded answer key is invalid');
    try {
        const result = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'base64url'));
        if (!result)
            throw new Error();
        return result;
    }
    catch {
        throw new JobsError('encoded answer key is invalid');
    }
}
export async function answerHttp(repository, method, path, body) {
    if (!path.startsWith('/api/answers'))
        return null;
    if (['/api/answers/cleanup-preview', '/api/answers/cleanup-approve'].includes(path))
        return null;
    const service = new AnswersService(repository);
    if (method === 'POST' && path === '/api/answers/semantic')
        return response(await service.semanticLookup(parse(body)));
    if (method === 'POST' && path === '/api/answers/query') {
        const payload = object(parse(body), 'body');
        fields(payload, ['query', 'state', 'reviewStatus', 'includeTrashed', 'trashedOnly', 'offset', 'limit']);
        const options = {};
        for (const field of ['query', 'state', 'reviewStatus']) {
            if (!has(payload, field))
                continue;
            const raw = get(payload, field), value = string(raw);
            if (value === null && (raw !== null || field === 'query'))
                throw new JobsError(`answer ${field} must be a string`);
            if (field === 'query')
                options.query = value;
            else
                options[field] = value;
        }
        for (const field of ['includeTrashed', 'trashedOnly']) {
            if (!has(payload, field))
                continue;
            const value = get(payload, field);
            if (typeof value !== 'boolean')
                throw new JobsError('answer trash filters must be booleans');
            options[field] = value;
        }
        for (const field of ['offset', 'limit']) {
            if (!has(payload, field))
                continue;
            const value = int(get(payload, field));
            if (value === null || value > BigInt(Number.MAX_SAFE_INTEGER))
                throw new JobsError(`answer ${field} is invalid`);
            options[field] = Number(value);
        }
        return response(await service.query(options));
    }
    if (method === 'POST' && path === '/api/answers') {
        const payload = object(parse(body), 'body');
        fields(payload, ['answer', 'expectedRevision', 'rememberSensitive'], ['answer']);
        return response(await service.put(get(payload, 'answer'), consent(payload), has(payload, 'expectedRevision') ? revision(payload) : null));
    }
    if (method === 'POST' && path === '/api/answers/observe') {
        const payload = object(parse(body), 'body');
        fields(payload, ['answer'], ['answer']);
        return response(await service.observe(get(payload, 'answer')));
    }
    const match = /^\/api\/answers\/(?:by-key\/([^/]+)|([^/]+))(?:\/(reveal|accept|decline))?$/.exec(path);
    if (!match)
        return null;
    const key = match[1] ? decodeKey(match[1]) : decodeURIComponent(match[2]);
    if (method === 'GET' && !match[3]) {
        const answer = await service.get(key, false, true);
        if (answer === null)
            throw new JobsError('answer does not exist');
        return response(answer);
    }
    if (method === 'PATCH' && !match[3]) {
        const payload = object(parse(body), 'body');
        fields(payload, ['patch', 'expectedRevision', 'rememberSensitive'], ['patch', 'expectedRevision']);
        return response(await service.update(key, get(payload, 'patch'), revision(payload), consent(payload)));
    }
    if (method === 'POST' && match[3]) {
        const payload = object(parse(body), 'body');
        if (match[3] === 'reveal') {
            fields(payload, []);
            const revealed = await service.get(key, true);
            if (revealed === null)
                throw new JobsError('answer does not exist');
            return response(revealed);
        }
        fields(payload, ['patch', 'expectedRevision', 'rememberSensitive'], ['expectedRevision']);
        return response(await service.update(key, has(payload, 'patch') ? get(payload, 'patch') : emptyObject(), revision(payload), consent(payload), match[3] === 'accept' ? 'accepted' : 'declined'));
    }
    return null;
}
