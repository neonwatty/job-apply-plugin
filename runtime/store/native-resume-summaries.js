import { safeId } from '../contracts/workspace/jobs.js';
import { fromJSON, get, object, string, JobsError } from '../contracts/workspace/values.js';
export async function nativeResumeSummaries(document) {
    const resumes = object(get(await document(), 'resumes'), 'resumes.resumes');
    return resumes.entries().flatMap(([key, value]) => {
        const record = object(value, 'resume record');
        if (get(record, 'deletedAt') !== null)
            return [];
        const id = safeId(string(key)), label = string(get(record, 'label'));
        if (string(get(record, 'id')) !== id || !label || typeof get(record, 'default') !== 'boolean') {
            throw new JobsError('resume projection is invalid');
        }
        return [fromJSON({ id, label, default: get(record, 'default') })];
    });
}
