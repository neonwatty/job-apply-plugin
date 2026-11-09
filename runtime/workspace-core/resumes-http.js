import { resumeLimit } from '../contracts/workspace/resume-content.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { copy, fromJSON, get, int, keys, object, parse, serialize, set, string, text, JobsError } from '../contracts/workspace/values.js';
const hidden = ['path', 'managedFile', 'originalFilename', 'digest', 'contentRevision'];
export function publicResume(record) {
    const result = copy(record);
    for (const field of hidden)
        result.delete(text(field));
    return result;
}
const response = (value, status = 200) => ({ status, body: serialize(value) });
function upload(body) {
    const payload = object(parse(body), 'body');
    if (payload.size !== 3 || keys(payload).some(key => !['metadata', 'filename', 'content'].includes(key))) {
        throw new JobsError('upload body requires metadata, filename, and content');
    }
    object(get(payload, 'metadata'), 'upload metadata');
    const filename = string(get(payload, 'filename')), encoded = string(get(payload, 'content'));
    if (filename === null || encoded === null)
        throw new JobsError('upload envelope fields have invalid types');
    if (encoded.length > Math.ceil(resumeLimit / 3) * 4)
        throw new JobsError('encoded resume content is too large');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new JobsError('resume content must be strict base64');
    }
    const content = Buffer.from(encoded, 'base64');
    if (content.length > resumeLimit)
        throw new JobsError('decoded resume content is too large');
    return { metadata: get(payload, 'metadata'), filename, content };
}
function expected(value) {
    const payload = object(value, 'body');
    if (payload.size !== 1 || keys(payload)[0] !== 'expectedRevision')
        throw new JobsError('body requires expectedRevision');
    const revision = int(get(payload, 'expectedRevision'));
    if (revision === null || revision < 1n)
        throw new JobsError('expectedRevision must be a positive integer');
    return revision;
}
export async function resumesHttp(service, method, path, body) {
    if (method === 'GET' && path === '/api/resumes') {
        const result = emptyObject();
        set(result, 'resumes', (await service.list()).map(publicResume));
        return response(result);
    }
    const match = /^\/api\/resumes\/([^/]+)$/.exec(path);
    if (method === 'GET' && match) {
        const record = await service.get(decodeURIComponent(match[1]));
        return record === null ? responseError(404, 'not_found', 'resume does not exist') : response(publicResume(record));
    }
    const contentMatch = /^\/api\/resumes\/([^/]+)\/content$/.exec(path);
    if (method === 'GET' && contentMatch) {
        const { record, content } = await service.content(decodeURIComponent(contentMatch[1]));
        const mediaType = string(get(record, 'mediaType')), extension = mediaType === 'application/pdf' ? '.pdf'
            : mediaType.startsWith('text/plain') ? '.txt' : '.docx';
        return { status: 200, body: content, contentType: mediaType,
            disposition: `${extension === '.docx' ? 'attachment' : 'inline'}; filename="resume-${string(get(record, 'id'))}${extension}"` };
    }
    if (method === 'POST' && path === '/api/resumes/import') {
        const value = upload(body);
        return response(publicResume(await service.import(value.metadata, value.filename, value.content)));
    }
    if (method === 'PATCH' && match) {
        const payload = object(parse(body), 'body');
        if (payload.size !== 2 || keys(payload).some(key => !['patch', 'expectedRevision'].includes(key)))
            throw new JobsError('body requires patch and expectedRevision');
        const revision = int(get(payload, 'expectedRevision'));
        if (revision === null || revision < 1n)
            throw new JobsError('expectedRevision must be a positive integer');
        return response(publicResume(await service.update(decodeURIComponent(match[1]), get(payload, 'patch'), revision)));
    }
    const action = /^\/api\/resumes\/([^/]+)\/(replace|adopt|default)$/.exec(path);
    if (method === 'POST' && action) {
        const id = decodeURIComponent(action[1]);
        if (action[2] === 'default')
            return response(publicResume(await service.setDefault(id, expected(parse(body)))));
        const value = upload(body), revision = expected(value.metadata);
        return response(publicResume(await service.replace(id, value.filename, value.content, revision, action[2] === 'adopt')));
    }
    return path.startsWith('/api/resumes') ? responseError(501, 'unsupported_native_workflow', 'This native resume workflow is not available yet.') : null;
}
function responseError(status, code, message) {
    return response(fromJSON({ error: { code, message } }), status);
}
