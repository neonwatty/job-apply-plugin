import { useEffect, useMemo, useState } from 'react';
import { createSubmissionLabClient, type LabPreview, type LabReport, type LabState } from './submission-lab-client';
import './submission-lab.css';

const outcomeLabels: Record<string, string> = {
    pending: 'Ready to submit', awaiting_approval: 'Awaiting approval', in_progress: 'In progress',
    confirmed_submitted: 'Submitted', needs_attention: 'Needs attention', submission_uncertain: 'Submission uncertain',
    stopped: 'Stopped', expired: 'Approval expired',
};
const reasons: Record<string, string> = {
    review_changed: 'The application changed after approval.',
    submission_blocked: 'The submission check blocked this application.',
    run_unavailable: 'The test form is unavailable.',
};

function Preview({ preview }: { preview: LabPreview }) {
    return <div className="lab-previews">
        {preview.jobs.map((job, index) => <details key={job.runId} open={index === 0}>
            <summary>{job.role} at {job.employer}</summary>
            <dl className="lab-fields">
                <dt>Destination</dt><dd>{job.destination}</dd>
                <dt>Résumé</dt><dd><a href={`${job.destination}/__qa/lab-resume`} target="_blank" rel="noreferrer">{job.resume}</a></dd>
                {job.fields.map(field => <div className="lab-field" key={field.id}><dt>{field.label}</dt><dd>{field.value || 'Blank'}</dd></div>)}
            </dl>
        </details>)}
    </div>;
}

function Outcomes({ report }: { report: LabReport }) {
    return <section aria-labelledby="lab-outcomes" className="workspace-panel lab-panel">
        <h2 id="lab-outcomes">Batch outcomes</h2>
        <ul className="lab-jobs">
            {report.jobs.map(job => <li key={job.runId}>
                <div><strong>{job.role}</strong><p>{job.employer}</p></div>
                <div><strong>{outcomeLabels[job.status] ?? job.status}</strong>
                    {job.reason && <p>{reasons[job.reason]}</p>}
                    {job.receiptId && <details><summary>Receipt</summary><code>{job.receiptId}</code></details>}
                </div>
            </li>)}
        </ul>
    </section>;
}

export function SubmissionLab({ token }: { token: string }) {
    const client = useMemo(() => createSubmissionLabClient(token), [token]);
    const [state, setState] = useState<LabState | null>(null);
    const [pendingApproval, setPendingApproval] = useState<boolean | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [preview, setPreview] = useState<LabPreview | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [submittingBatchId, setSubmittingBatchId] = useState<string | null>(null);
    const [stopping, setStopping] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        const controller = new AbortController();
        void client.load(controller.signal).then(setState).catch(cause => {
            if (!controller.signal.aborted) setError(cause.message);
        });
        return () => controller.abort();
    }, [client]);

    async function perform(action: string, operation: () => Promise<void>) {
        setBusy(action);
        setError('');
        try { await operation(); }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Unable to complete this action.');
            if (action === 'submit') await refresh().catch(() => {});
        }
        finally { setBusy(null); }
    }
    async function refresh() {
        const fresh = await client.load();
        setState(fresh);
        if (!fresh.session || fresh.report?.batchId !== preview?.batchId) setPreview(null);
    }
    async function executeApproved(batchId: string) {
        setSubmittingBatchId(batchId);
        try {
            const result = await client.execute(batchId);
            setState(current => current && { ...current, report: {
                ...result, status: current.report?.status === 'stopped' ? 'stopped' : result.status,
            } });
        } finally { setSubmittingBatchId(null); }
    }
    async function changeApproval(enabled: boolean) {
        setPendingApproval(enabled);
        setError('');
        try {
            const setting = await client.setApproval(enabled);
            if (!enabled) setPreview(null);
            setState(current => current && { ...current, approvalEnabled: setting.approvalEnabled,
                report: current.report?.status === 'finished' ? current.report : setting.report ?? current.report,
            });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Unable to change the approval setting.');
            await refresh().catch(() => {});
        } finally { setPendingApproval(null); }
    }
    async function stop(batchId: string) {
        setStopping(true);
        setError('');
        try {
            const report = await client.stop(batchId);
            setState(current => {
                if (!current) return current;
                const settled = current.report?.status === 'finished' ? current.report.jobs : null;
                return { ...current, report: { ...report, jobs: settled ?? report.jobs } };
            });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Unable to stop the batch.');
        } finally { setStopping(false); }
    }
    const session = state?.session, report = state?.report;
    const approvalEnabled = state?.approvalEnabled === true;
    const settingApproval = pendingApproval !== null;
    const reviewed = Boolean(session?.runs.every(run => run.reviewed));
    const untouchedBatch = report?.status === 'stopped' && report.jobs.every(job => job.status === 'stopped');
    const canReviewBatch = approvalEnabled && (!report || report.status === 'awaiting_approval' || untouchedBatch);
    const canApprove = approvalEnabled && preview && (!report || report.status === 'awaiting_approval');
    const stoppableBatchId = report?.status === 'stopped' ? null
        : submittingBatchId ?? (report?.status === 'approved' ? report.batchId : null);
    const status = submittingBatchId ? (report?.status === 'stopped' ? 'Stopping remaining jobs…' : 'Submitting the approved test applications…')
        : report?.status === 'finished' ? 'Batch finished.'
        : report?.status === 'stopped' ? 'Batch stopped.'
        : report?.status === 'approved' ? 'Batch approved. You can resume submission.'
        : report?.status === 'expired' ? 'Batch approval expired.'
        : reviewed && !approvalEnabled ? 'All selected jobs reached Review.'
        : busy ? 'Working…' : state ? '' : 'Loading submission lab…';

    return <section className="submission-lab" aria-labelledby="lab-title">
        <header className="workspace-hero">
            <div className="workspace-hero-copy"><h1 id="lab-title">Submission lab</h1>
                <p>Try the approval flow with fictional Greenhouse applications.</p></div>
            <div className="workspace-hero-actions"><button type="button" className="secondary" disabled={Boolean(busy) || stopping || settingApproval}
                onClick={() => void perform('refresh', refresh)}>Refresh status</button></div>
        </header>
        <p className="workspace-status" role="status">{status}</p>
        {error && <p className="error" role="alert">{error}</p>}
        {state && <div className="workspace-panel lab-panel">
            <label className="lab-toggle">
                <span><strong>Submit after approval</strong>
                    <span id="lab-mode-description">{(pendingApproval ?? approvalEnabled)
                        ? 'All test applications require approval before sending.'
                        : 'All test applications stop at Review.'}</span>
                </span>
                <input type="checkbox" role="switch" aria-label="Submit after approval" aria-describedby="lab-mode-description"
                    checked={pendingApproval ?? approvalEnabled} disabled={settingApproval || stopping || Boolean(busy && !submittingBatchId)}
                    onChange={event => void changeApproval(event.target.checked)} />
            </label>
        </div>}
        {state && !session && <form className="workspace-panel lab-panel" onSubmit={event => {
            event.preventDefault();
            void perform('start', async () => {
                const session = await client.start(selected);
                setState(current => current && { ...current, session, report: null });
            });
        }}>
            <fieldset className="lab-options" disabled={Boolean(busy) || settingApproval}>
                <legend>Fictional jobs</legend>
                <p>Select one to three jobs.</p>
                {state.jobs.map(job => <label key={job.jobId}>
                    <input type="checkbox" checked={selected.includes(job.jobId)} onChange={event => {
                        const checked = event.target.checked;
                        setSelected(current => checked ? [...current, job.jobId] : current.filter(id => id !== job.jobId));
                    }} /> {job.role} at {job.employer}
                </label>)}
            </fieldset>
            <button className="primary" type="submit" disabled={Boolean(busy) || settingApproval || !selected.length}>Prepare test applications</button>
        </form>}
        {session && <>
            <section className="workspace-panel lab-panel" aria-labelledby="lab-runs">
                <h2 id="lab-runs">Test applications</h2>
                <p>Open each test form, load the fictional answers and résumé, then continue to Review.</p>
                <ol className="lab-jobs">
                    {session.runs.map(run => <li key={run.runId}>
                        <div><strong>{run.role}</strong><p>{run.employer}</p></div>
                        <div><p>{run.reviewed ? 'Review reached' : 'Review pending'}</p>
                            <a href={run.url} target="_blank" rel="noreferrer" aria-label={`Open test form for ${run.role}`}>Open test form</a></div>
                    </li>)}
                </ol>
                <div className="button-row">
                    {!approvalEnabled && <button type="button" className="secondary" disabled={Boolean(busy) || settingApproval || reviewed}
                        onClick={() => void perform('review', async () => {
                            const session = await client.checkReviews();
                            setState(current => current && { ...current, session });
                        })}>Check reviews</button>}
                    {canReviewBatch && <button type="button" className={preview ? 'secondary' : 'primary'} disabled={Boolean(busy) || settingApproval}
                        onClick={() => void perform('preview', async () => {
                            const session = await client.checkReviews();
                            setState(current => current && { ...current, session });
                            if (session.runs.some(run => !run.reviewed)) {
                                throw new Error('Reach Review on each test form, then review the batch.');
                            }
                            const next = await client.preview();
                            setPreview(next);
                            setState(current => current && { ...current, report: null });
                        })}>{preview ? 'Refresh preview' : 'Review batch'}</button>}
                </div>
            </section>
            {preview && <section className="workspace-panel lab-panel" aria-labelledby="lab-preview">
                <h2 id="lab-preview">Approval preview</h2>
                <Preview preview={preview} />
                {canApprove && <><p>Companion sends these exact test applications in the order shown.</p>
                    <button className="primary" type="button" disabled={Boolean(busy) || settingApproval} onClick={() => void perform('submit', async () => {
                        await client.approve(preview);
                        await executeApproved(preview.batchId);
                    })}>Approve and submit</button></>}
            </section>}
            {report && report.status !== 'awaiting_approval' && <Outcomes report={report} />}
            <div className="button-row lab-actions">
                {approvalEnabled && report?.status === 'approved' && !submittingBatchId && <button className="primary" type="button" disabled={Boolean(busy) || stopping || settingApproval}
                    onClick={() => void perform('submit', () => executeApproved(report.batchId))}>Resume approved submission</button>}
                {stoppableBatchId && <button className="secondary" type="button" disabled={stopping || settingApproval || Boolean(busy && !submittingBatchId)}
                    onClick={() => void stop(stoppableBatchId)}>Stop remaining jobs</button>}
                <button className="secondary" type="button" disabled={Boolean(busy) || stopping || settingApproval}
                    onClick={() => void perform('end', async () => {
                        await client.end();
                        setSelected([]);
                        await refresh();
                    })}>End lab session</button>
            </div>
        </>}
    </section>;
}
