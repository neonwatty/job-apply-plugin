import { snapshot } from './facts-model';
import { boot, job, object, overview, resume, resumeList, workspaceState, type JobFields } from './contracts';
export class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(message);
    }
}
export function createClient(token: string) {
    async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, raw = false): Promise<unknown> {
        const deadline = AbortSignal.timeout(30_000);
        const response = await fetch(path, {
            signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
            method, headers: {
                Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {
                    'Content-Type': 'application/json'
                })
            }, body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body), cache: 'no-store'
        });
        let payload: unknown = null;
        try {
            const content = await response.text();
            payload = raw && response.ok ? content : JSON.parse(content);
        }
        catch { /* Status handling remains authoritative. */
        }
        if (!response.ok) {
            const error = object(payload) && object(payload.error) ? payload.error : {};
            throw new ApiError(response.status, typeof error.code === 'string' ? error.code : 'request_error', typeof error.message === 'string' ? error.message : `Workspace request failed (${response.status})`);
        }
        return payload;
    }
    async function encoded(file: File): Promise<string> {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768)
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        return btoa(binary);
    }
    return {
        extractionRequest: async (path: string, method: string, body: string | undefined, signal: AbortSignal) => request(path, method, body, signal, true) as Promise<string>,
        answerRequest: async (path: string, method: string, body: string | undefined, signal: AbortSignal) => request(path, method, body, signal, true) as Promise<string>,
        profile: async (signal?: AbortSignal) => snapshot(await request('/api/profile', 'GET', undefined, signal, true) as string),
        patchProfile: async (body: string, signal?: AbortSignal) => snapshot(await request('/api/profile', 'PATCH', body, signal, true) as string),
        groups: async (signal?: AbortSignal) => request('/api/fact-groups', 'GET', undefined, signal),
        createGroup: async (group: unknown, signal?: AbortSignal) => request('/api/fact-groups', 'POST', { group }, signal),
        updateGroup: async (id: string, expectedRevision: number, patch: unknown, signal?: AbortSignal) => request(`/api/fact-groups/${encodeURIComponent(id)}`, 'PATCH', { patch, expectedRevision }, signal),
        deleteGroup: async (id: string, expectedRevision: number, signal?: AbortSignal) => request(`/api/fact-groups/${encodeURIComponent(id)}/delete`, 'POST', { expectedRevision }, signal),
        boot: async (signal?: AbortSignal) => boot(await request('/api/boot', 'GET', undefined, signal)),
        state: async (signal?: AbortSignal) => workspaceState(await request('/api/state', 'GET', undefined, signal)),
        overview: async (signal?: AbortSignal) => overview(await request('/api/overview', 'GET', undefined, signal)),
        job: async (id: string, signal?: AbortSignal) => job(await request(`/api/jobs/${encodeURIComponent(id)}`, 'GET', undefined, signal)),
        create: async (fields: JobFields, signal?: AbortSignal) => job(await request('/api/jobs', 'POST', {
            job: fields
        }, signal)),
        update: async (id: string, revision: number, fields: JobFields, signal?: AbortSignal) => job(await request(`/api/jobs/${encodeURIComponent(id)}`, 'PATCH', {
            patch: fields, expectedRevision: revision
        }, signal)),
        resumes: async (signal?: AbortSignal) => resumeList(await request('/api/resumes', 'GET', undefined, signal)),
        importResume: async (metadata: unknown, file: File, signal?: AbortSignal) => resume(await request('/api/resumes/import', 'POST', {
            metadata, filename: file.name, content: await encoded(file)
        }, signal)),
        updateResume: async (id: string, expectedRevision: number, patch: unknown, signal?: AbortSignal) => resume(await request(`/api/resumes/${encodeURIComponent(id)}`, 'PATCH', {
            patch, expectedRevision
        }, signal)),
        setDefaultResume: async (id: string, expectedRevision: number, signal?: AbortSignal) => resume(await request(`/api/resumes/${encodeURIComponent(id)}/default`, 'POST', {
            expectedRevision
        }, signal)),
        replaceResume: async (id: string, expectedRevision: number, file: File, adopt: boolean, signal?: AbortSignal) => resume(await request(`/api/resumes/${encodeURIComponent(id)}/${adopt ? 'adopt' : 'replace'}`, 'POST', {
            metadata: { expectedRevision }, filename: file.name, content: await encoded(file)
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
