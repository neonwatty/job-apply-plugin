import { get, int, object as document, parse, string as stringValue } from '../../../src/contracts/workspace/values';
export type TrashType = 'job' | 'resume' | 'answer';
export type TrashAction = 'restore' | 'delete';
export type TrashCapabilities = Readonly<Record<TrashType, Readonly<Record<TrashAction, boolean>>>>;
export const compatibilityTrashCapabilities: TrashCapabilities = {
    job: { restore: true, delete: true }, resume: { restore: true, delete: true }, answer: { restore: true, delete: true }
};
export const nativeTrashCapabilities: TrashCapabilities = {
    job: { restore: true, delete: true }, resume: { restore: false, delete: false }, answer: { restore: true, delete: true }
};
export interface TrashItem {
    type: TrashType;
    id: string;
    revision: bigint;
    deletedAt: string;
    label: string;
    blockerCounts: Record<string, number>;
}
export interface TrashSnapshot {
    items: TrashItem[];
    counts: Record<TrashType, number>;
    total: number;
}
function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function count(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}
export function isTrashType(value: unknown): value is TrashType {
    return value === 'job' || value === 'resume' || value === 'answer';
}
export function safeCounts(value: unknown): Record<string, number> {
    if (!object(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => count(entry[1])));
}
export function trashSnapshot(raw: string): TrashSnapshot {
    const value = document(parse(raw), 'Trash response');
    const records = get(value, 'items');
    const countsRecord = document(get(value, 'counts'), 'Trash counts');
    const total = int(get(value, 'total'));
    if (!Array.isArray(records) || total === null || total < 0n) throw Error('Invalid Trash response');
    const items = records.map((entry): TrashItem => {
        const item = document(entry, 'Trash item');
        const type = stringValue(get(item, 'type'));
        const id = stringValue(get(item, 'id'));
        const label = stringValue(get(item, 'label'));
        const deletedAt = stringValue(get(item, 'deletedAt'));
        const revision = int(get(item, 'revision'));
        if (!isTrashType(type) || !id || label === null || deletedAt === null || revision === null || revision < 1n)
            throw Error('Invalid Trash record');
        const blockers = document(get(item, 'blockerCounts'), 'Trash references');
        const blockerCounts: Record<string, number> = {};
        for (const [key, value] of blockers.entries()) {
            const number = int(value);
            if (number === null || number < 0n || number > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Invalid reference count');
            Object.defineProperty(blockerCounts, stringValue(key)!, { value: Number(number), enumerable: true });
        }
        return { type, id, label, deletedAt, revision, blockerCounts };
    });
    const counts = { job: 0, resume: 0, answer: 0 };
    for (const type of ['job', 'resume', 'answer'] as const) {
        const number = int(get(countsRecord, type));
        if (number !== BigInt(items.filter(item => item.type === type).length)) throw Error('Inconsistent Trash counts');
        counts[type] = Number(number);
    }
    if (total !== BigInt(items.length) || new Set(items.map(item => JSON.stringify([item.type, item.id]))).size !== items.length)
        throw Error('Inconsistent Trash response');
    return { items, counts, total: items.length };
}
export function deletePhrase(type: TrashType): string { return `DELETE ${type.toUpperCase()}`; }
export function referenceText(counts: Record<string, number>): string {
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return total ? `${total} protected reference${total === 1 ? '' : 's'}` : 'No known references';
}
export function trashErrorText(error: unknown): string {
    const detail = object(error) ? error : {};
    if (detail.code === 'revision_conflict')
        return 'This record changed elsewhere. Refresh Trash and review the latest revision. Nothing was retried.';
    const guidance: Record<string, string> = {
        not_found: 'This record no longer exists. Refresh Trash.',
        claim_blocked: 'Release or complete the coordinator claim before changing this job.',
        session_reference_blocked: 'Application session references protect this record from permanent deletion. Review the linked application records.',
        history_reference_blocked: 'Protected application history prevents permanent deletion.',
        job_reference_blocked: 'A job still references this resume. Review and reassign those jobs first.',
        default_reference_blocked: 'Active jobs use this default resume. Assign another default first.',
        duplicate_active_blocked: 'An active record with the same canonical identity already exists. Review it before restoring.',
        assigned_resume_blocked: 'The assigned resume is unavailable. Restore or reassign that resume first.',
        redirect_target_blocked: 'This answer is a canonical redirect target and cannot be moved or deleted.',
        store_rejected: 'The canonical store rejected this lifecycle operation. Refresh and review the record.'
    };
    if (typeof detail.code === 'string' && Object.hasOwn(guidance, detail.code)) {
        const counts = safeCounts(detail.counts);
        const suffix = Object.values(counts).some(value => value > 0) ? ` (${referenceText(counts)}.)` : '';
        return `${guidance[detail.code]}${suffix}`;
    }
    const total = Object.values(safeCounts(detail.counts)).reduce((sum, value) => sum + value, 0);
    if (total) return `The operation was rejected with ${total} protected reference${total === 1 ? '' : 's'}. Refresh and review the record.`;
    if (typeof detail.code === 'string' && /recovery/.test(detail.code))
        return 'Store recovery is required. Resolve recovery in the workspace before trying again.';
    if (detail.code === 'unsupported_operation') return 'This action is not available in this workspace.';
    // Do not render raw transport/storage messages: they may contain private values or paths.
    return 'The operation could not be confirmed. Refresh Trash to check canonical state before trying again.';
}
