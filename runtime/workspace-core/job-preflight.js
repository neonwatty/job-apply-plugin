import { emptyObject } from '../contracts/workspace/jobs.js';
import { get, keys, object, same, set, string, text, integer, truth } from '../contracts/workspace/values.js';
/** Inspect documents already held by the caller's transaction, without acquiring another lock. */
export async function preflightJobRecord(job, profileDocument, resumesDocument, files) {
    const errors = [], warnings = [];
    const profile = object(get(profileDocument, 'profile'), 'profile.profile');
    if (!keys(profile).some(key => key !== 'preferences'))
        errors.push('profile_empty');
    const resumes = object(get(resumesDocument, 'resumes'), 'resumes.resumes');
    let resumeId = get(job, 'resumeId');
    if (resumeId === null) {
        const defaultResume = resumes.entries().map(([, item]) => object(item, 'resume record'))
            .find(item => get(item, 'deletedAt') === null && truth(get(item, 'default')));
        resumeId = defaultResume ? get(defaultResume, 'id') : null;
    }
    const value = resumeId === null ? null : get(resumes, string(resumeId));
    const resume = value === null ? null : object(value, 'resume record');
    if (resume === null || get(resume, 'deletedAt') !== null)
        errors.push('resume_missing');
    else {
        const managed = string(get(resume, 'storageKind')) === 'managed';
        const observation = managed ? await files.observation(resume)
            : await files.externalObservation(string(get(resume, 'path')));
        if (!observation.exists)
            errors.push('resume_file_missing');
        else if (!same(observation.size === null ? null : integer(BigInt(observation.size)), get(resume, 'observedSize'))
            || observation.modifiedAt !== string(get(resume, 'observedModifiedAt'))
            || managed && observation.digest !== string(get(resume, 'digest'))) {
            (managed ? errors : warnings).push('resume_file_changed');
        }
    }
    if (!truth(get(job, 'role')))
        warnings.push('role_missing');
    if (!truth(get(job, 'company')))
        warnings.push('company_missing');
    const result = emptyObject();
    set(result, 'id', get(job, 'id'));
    set(result, 'revision', get(job, 'revision'));
    set(result, 'ready', errors.length === 0);
    set(result, 'resumeId', resumeId);
    set(result, 'errors', errors.map(text));
    set(result, 'warnings', warnings.map(text));
    return result;
}
