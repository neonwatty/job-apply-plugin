import { createHash } from 'node:crypto';
import { activeApplicationRun } from '../../contracts/workspace/application-runs.js';
import { canonicalJson } from '../../contracts/workspace/canonical-json.js';
import { emptyObject } from '../../contracts/workspace/jobs.js';
import { get, object, set, string } from '../../contracts/workspace/values.js';
/** Bind the question to canonical input references, never applicant values or a reusable grant. */
export function preparationScope(snapshot, job) {
    const run = activeApplicationRun(snapshot.jobs), scope = emptyObject();
    const selection = run === null ? get(job, 'inputSelection') : get(run, 'selection');
    set(scope, 'runId', run === null ? null : get(run, 'runId'));
    set(scope, 'runRevision', run === null ? null : get(run, 'revision'));
    let resumeId = get(job, 'resumeId');
    if (selection !== null) {
        const selected = object(selection, 'input selection');
        resumeId = get(selected, 'resumeId');
        for (const field of ['resumeId', 'contentRevision', 'factRevision'])
            set(scope, field, get(selected, field));
    }
    set(scope, 'jobResumeId', get(job, 'resumeId'));
    const resumes = object(get(snapshot.resumes, 'resumes'), 'resumes');
    const raw = resumeId === null ? resumes.entries().map(([, value]) => object(value, 'resume'))
        .find(item => get(item, 'default') === true && get(item, 'deletedAt') === null) ?? null
        : get(resumes, string(resumeId));
    const resume = raw === null ? null : object(raw, 'resume');
    set(scope, 'resolvedResumeId', resume === null ? null : get(resume, 'id'));
    set(scope, 'resumeRevision', resume === null ? null : get(resume, 'revision'));
    set(scope, 'resumeContentRevision', resume === null ? null : get(resume, 'contentRevision'));
    const facts = snapshot.facts && resume !== null
        ? get(object(get(snapshot.facts, 'sets'), 'fact sets'), string(get(resume, 'id'))) : null;
    const versions = facts === null ? null : get(object(facts, 'facts'), 'versions');
    const latest = Array.isArray(versions) && versions.length ? object(versions[versions.length - 1], 'facts') : null;
    set(scope, 'latestFactRevision', latest === null ? null : get(latest, 'revision'));
    return createHash('sha256').update(canonicalJson(scope)).digest('hex');
}
