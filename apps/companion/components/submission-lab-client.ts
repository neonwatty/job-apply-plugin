export type LabJob = { jobId: string; employer: string; role: string };
export type LabRun = LabJob & { runId: string; url: string; reviewed: boolean };
export type LabSession = { runs: LabRun[] };
export type LabPreview = {
    batchId: string; batchRevision: string;
    jobs: (LabJob & { runId: string; destination: string; resume: string; fields: { id: string; label: string; value: string }[] })[];
};
export type LabReport = {
    batchId: string;
    status: 'awaiting_approval' | 'approved' | 'finished' | 'stopped' | 'expired';
    jobs: (LabJob & { runId: string; status: string; reason?: string; receiptId?: string })[];
};
export type LabState = { approvalEnabled: boolean; jobs: LabJob[]; session: LabSession | null; report: LabReport | null };

export function createSubmissionLabClient(token: string) {
    async function request<T>(action?: string, body: object = {}, signal?: AbortSignal): Promise<T> {
        const deadline = AbortSignal.timeout(28_000);
        const response = await fetch(`/api/submission-lab${action ? `/${action}` : ''}`, {
            method: action ? 'POST' : 'GET', cache: 'no-store',
            signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
            headers: { Authorization: `Bearer ${token}`, ...(action ? { 'Content-Type': 'application/json' } : {}) },
            ...(action ? { body: JSON.stringify(body) } : {}),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(typeof payload.error?.message === 'string'
            ? payload.error.message : 'The submission lab is unavailable.');
        return payload as T;
    }
    return {
        load: (signal?: AbortSignal) => request<LabState>(undefined, {}, signal),
        setApproval: (enabled: boolean) => request<Pick<LabState, 'approvalEnabled' | 'report'>>('set-approval', { enabled }),
        start: (jobIds: string[]) => request<LabSession>('start', { jobIds }),
        checkReviews: () => request<LabSession>('check-reviews'),
        preview: () => request<LabPreview>('preview'),
        approve: ({ batchId, batchRevision }: LabPreview) => request('approve', { batchId, batchRevision, ownerConfirmed: true }),
        execute: (batchId: string) => request<LabReport>('execute', { batchId }),
        stop: (batchId: string) => request<LabReport>('stop', { batchId }),
        end: () => request('end'),
    };
}
