import { boot, job, object, overview, workspaceState, type JobFields } from './contracts';
export class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(message);
    }
}
export function createClient(token: string) {
    async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
        const deadline = AbortSignal.timeout(30_000);
        const response = await fetch(path, {
            signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
            method, headers: {
                Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {
                    'Content-Type': 'application/json'
                })
            }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store'
        });
        let payload: unknown = null;
        try {
            payload = await response.json();
        }
        catch { /* Status handling remains authoritative. */
        }
        if (!response.ok) {
            const error = object(payload) && object(payload.error) ? payload.error : {};
            throw new ApiError(response.status, typeof error.code === 'string' ? error.code : 'request_error', typeof error.message === 'string' ? error.message : `Workspace request failed (${response.status})`);
        }
        return payload;
    }
    return {
        boot: async (signal?: AbortSignal) => boot(await request('/api/boot', 'GET', undefined, signal)),
        state: async (signal?: AbortSignal) => workspaceState(await request('/api/state', 'GET', undefined, signal)),
        overview: async (signal?: AbortSignal) => overview(await request('/api/overview', 'GET', undefined, signal)),
        job: async (id: string, signal?: AbortSignal) => job(await request(`/api/jobs/${encodeURIComponent(id)}`, 'GET', undefined, signal)),
        create: async (fields: JobFields, signal?: AbortSignal) => job(await request('/api/jobs', 'POST', {
            job: fields
        }, signal)),
        update: async (id: string, revision: number, fields: JobFields, signal?: AbortSignal) => job(await request(`/api/jobs/${encodeURIComponent(id)}`, 'PATCH', {
            patch: fields, expectedRevision: revision
        }, signal))
    };
}
export type Client = ReturnType<typeof createClient>;
export function sessionToken(): string {
    const incoming = new URLSearchParams(window.location.hash.slice(1)).get('token');
    try {
        if (incoming)
            sessionStorage.setItem('jobApplyWorkspaceToken', incoming);
        return incoming || sessionStorage.getItem('jobApplyWorkspaceToken') || '';
    }
    catch {
        return incoming || '';
    }
}
