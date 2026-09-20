import { contentRevision, exact } from './extraction-requests.js';
import { safeId } from './jobs.js';
import { get, int, object, string, JobsError } from './values.js';
/** Value-free receipt of the owner's exact chat-confirmed application inputs. */
export function validateJobInputSelection(value) {
    const record = object(value, 'job input selection');
    exact(record, ['resumeId', 'contentRevision', 'factRevision', 'jobRevision', 'confirmedAt'], 'job input selection is invalid');
    safeId(string(get(record, 'resumeId')));
    contentRevision(get(record, 'contentRevision'));
    for (const field of ['factRevision', 'jobRevision']) {
        const revision = int(get(record, field));
        if (revision === null || revision < 1n)
            throw new JobsError('job input selection revision is invalid');
    }
    if (!string(get(record, 'confirmedAt')))
        throw new JobsError('job input confirmation time is invalid');
    return record;
}
