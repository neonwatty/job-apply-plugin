import { answerPath } from './answer-model';
import { trashSnapshot, type TrashAction, type TrashCapabilities, type TrashItem, type TrashSnapshot, safeCounts } from './trash-model';
export interface TrashClient {
    list(signal: AbortSignal): Promise<TrashSnapshot>;
    mutate(item: TrashItem, action: TrashAction, signal: AbortSignal): Promise<void>;
}
export class TrashApiError extends Error {
    constructor(public status: number, public code: string, public counts: Record<string, number> = {}) {
        super('Trash request failed');
    }
}
export function createTrashClient(token: string, capabilities: TrashCapabilities, fetcher: typeof fetch = fetch): TrashClient {
    async function request(path: string, signal: AbortSignal, expectedRevision?: bigint): Promise<string> {
        const response = await fetcher(path, {
            method: expectedRevision === undefined ? 'GET' : 'POST', cache: 'no-store',
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            headers: { Authorization: `Bearer ${token}`, ...(expectedRevision === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: expectedRevision === undefined ? undefined : `{"expectedRevision":${expectedRevision}}`
        });
        const raw = await response.text();
        if (!response.ok) {
            let payload: unknown = null;
            try { payload = JSON.parse(raw); } catch { /* Status remains authoritative. */ }
            const envelope = payload as { error?: { code?: unknown; counts?: unknown } } | null;
            throw new TrashApiError(response.status, typeof envelope?.error?.code === 'string' ? envelope.error.code : 'request_error', safeCounts(envelope?.error?.counts));
        }
        return raw;
    }
    return {
        list: async signal => trashSnapshot(await request('/api/trash', signal)),
        mutate: async (item, action, signal) => {
            if (!capabilities[item.type]?.[action]) throw new TrashApiError(405, 'unsupported_operation');
            if (typeof item.revision !== 'bigint' || item.revision <= 0n) throw new TrashApiError(400, 'invalid_revision');
            const collection = { job: 'jobs', resume: 'resumes', answer: 'answers' }[item.type];
            const path = item.type === 'answer' ? answerPath(item.id) : `/api/${collection}/${encodeURIComponent(item.id)}`;
            await request(`${path}/${action}`, signal, item.revision);
            // Successful deletion need not return a record. The UI reloads the canonical list.
        }
    };
}
