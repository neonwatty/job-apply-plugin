import { ProfileService } from './profile.js';
import { FactGroupsService } from './fact-groups.js';
import { PythonObject } from '../contracts/python-object.js';
import { get, has, int, keys, object, parse, serialize, set, string, JobsError } from '../contracts/workspace/values.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { topKey } from './profile-patch.js';
const named = new Set(['firstName', 'lastName', 'email', 'phone', 'location', 'linkedInUrl', 'portfolioUrl', 'githubUrl', 'workHistory', 'education', 'skills', 'preferences']);
const response = (value) => ({ status: 200, body: serialize(value) });
export async function profileHttp(repository, method, path, body) {
    const profile = new ProfileService(repository), groups = new FactGroupsService(repository);
    if (method === 'GET' && path === '/api/profile')
        return response(await profile.inspect());
    if (method === 'GET' && path === '/api/fact-groups')
        return response(set(emptyObject(), 'groups', await groups.list()));
    const match = /^\/api\/fact-groups\/([^/]+)(\/delete)?$/.exec(path);
    if (method === 'GET' && match && !match[2]) {
        const group = await groups.get(decodeURIComponent(match[1]));
        if (group === null)
            throw new JobsError('fact group does not exist');
        return response(group);
    }
    if (method === 'PATCH' && path === '/api/profile') {
        const payload = object(parse(body), 'body'), patch = get(payload, 'patch');
        const lists = (key) => {
            const value = has(payload, key) ? get(payload, key) : [];
            if (!Array.isArray(value) || value.some(item => string(item) === null))
                throw new JobsError('body requires valid path lists');
            return value.map(item => string(item));
        };
        if (keys(payload).some(key => !['patch', 'expectedRevision', 'atomicPaths', 'deletedPaths'].includes(key)) || !(patch instanceof PythonObject) || !patch.size)
            throw new JobsError('body requires a non-empty patch object, expectedRevision, and valid path lists');
        const atomic = lists('atomicPaths'), deleted = lists('deletedPaths');
        if (atomic.some(path => named.has(topKey(path))) || new Set(atomic).size !== atomic.length || new Set(deleted).size !== deleted.length || deleted.some(path => !atomic.includes(path)))
            throw new JobsError('atomic paths must uniquely identify Additional facts and include every deletion');
        return response(await profile.patch(patch, revision(get(payload, 'expectedRevision')), 'user', atomic, deleted));
    }
    if (method === 'POST' && path === '/api/fact-groups') {
        const payload = object(parse(body), 'body');
        if (payload.size !== 1 || keys(payload)[0] !== 'group' || !(get(payload, 'group') instanceof PythonObject))
            throw new JobsError('body must contain only a fact group object');
        return response(await groups.create(get(payload, 'group')));
    }
    if (match && (method === 'PATCH' && !match[2] || method === 'POST' && match[2])) {
        const payload = object(parse(body), 'body'), deleting = Boolean(match[2]);
        if (deleting ? payload.size !== 1 || keys(payload)[0] !== 'expectedRevision'
            : payload.size !== 2 || keys(payload).some(key => !['patch', 'expectedRevision'].includes(key)) || !(get(payload, 'patch') instanceof PythonObject))
            throw new JobsError(deleting ? 'delete body requires expectedRevision' : 'body requires patch and expectedRevision');
        return response(deleting ? await groups.delete(decodeURIComponent(match[1]), revision(get(payload, 'expectedRevision')))
            : await groups.update(decodeURIComponent(match[1]), get(payload, 'patch'), revision(get(payload, 'expectedRevision'))));
    }
    return null;
}
function revision(value) {
    const result = int(value);
    if (result === null || result < 1n)
        throw new JobsError('expectedRevision must be a positive integer');
    return result;
}
