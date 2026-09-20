import { filterJobs } from '../../../src/workspace-ui/lib/activity-view';
import { useEffect, useRef, useState } from 'react';
import { ApiError, type Client } from './client';
import type { Job, JobFields, WorkspaceState } from './contracts';
import { edit, observe, openEditor, reapply, type Editor } from './job-editor-state';
import { JobEditor } from './JobEditor';
import { Claims } from './Claims';
import { JobActivity } from './JobActivity';
import { JobTransitions } from './JobTransitions';

export function Jobs({ client, dirtyChanged, claimsEnabled = false, requestedJobId, jobOpened, openAnswers, workspaceChanged }: {
    client: Client;
    claimsEnabled?: boolean;
    requestedJobId?: string | null;
    jobOpened?: () => void;
    openAnswers?: () => void;
    workspaceChanged?: () => void | Promise<void>;
    dirtyChanged: (dirty: boolean) => void;
}) {
    const [data, setData] = useState<WorkspaceState | null>(null);
    const [editor, setEditor] = useState<Editor | null>(null);
    const [busy, setBusy] = useState(false);
    const [transitionBusy, setTransitionBusy] = useState(false);
    const [claimsActive, setClaimsActive] = useState(false);
    const [claimsDirty, setClaimsDirty] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [error, setError] = useState('');
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState('');
    const [notice, setNotice] = useState('');
    const alive = useRef(false);
    const refreshRequest = useRef<AbortController | null>(null);
    const mutation = useRef<AbortController | null>(null);
    const generation = useRef(0);
    const listGeneration = useRef(0);

    async function refresh() {
        refreshRequest.current?.abort();
        const controller = new AbortController();
        refreshRequest.current = controller;
        const version = ++listGeneration.current;
        setLoading(true);
        try {
            const next = await client.state(controller.signal);
            if (!alive.current || version !== listGeneration.current) return;
            setData(next);
            setEditor(current => current ? observe(current, next.jobs) : null);
            setLoadError('');
            return true;
        } catch (error) {
            if (alive.current && version === listGeneration.current && !controller.signal.aborted) {
                setLoadError(error instanceof Error ? error.message : 'Unable to load jobs');
                return false;
            }
        } finally {
            if (alive.current && version === listGeneration.current) setLoading(false);
        }
    }
    useEffect(() => {
        alive.current = true;
        void refresh();
        return () => {
            alive.current = false;
            generation.current++;
            listGeneration.current++;
            refreshRequest.current?.abort();
            mutation.current?.abort();
        };
    }, [client]);
    useEffect(() => {
        dirtyChanged(Boolean(editor?.dirty.size) || busy || transitionBusy || claimsDirty);
        return () => dirtyChanged(false);
    }, [editor, busy, transitionBusy, claimsDirty, dirtyChanged]);
    useEffect(() => {
        if (!requestedJobId || !data || loading || loadError || claimsActive) return;
        const selected = data.jobs.find(job => job.id === requestedJobId);
        if (selected) open(selected);
        else setError('The selected job is no longer available. Refresh Jobs to check its current state.');
        jobOpened?.();
    }, [requestedJobId, data, loading, loadError, claimsActive, jobOpened]);

    function open(job: Job | null) {
        if (mutation.current || transitionBusy || claimsActive) return;
        if (editor?.dirty.size && !confirm('Discard unsaved job changes?')) return;
        generation.current++;
        setError('');
        setNotice('');
        setEditor(openEditor(job));
    }
    function close() {
        if (mutation.current || transitionBusy) return;
        if (editor?.dirty.size && !confirm('Discard unsaved job changes?')) return;
        generation.current++;
        setEditor(null);
        setError('');
    }
    async function save() {
        if (!editor || mutation.current || transitionBusy || editor.missing || editor.latest) return;
        const current = editor;
        const version = generation.current;
        const controller = new AbortController();
        mutation.current = controller;
        // A read started before this mutation must not overwrite its result.
        refreshRequest.current?.abort();
        listGeneration.current++;
        setLoading(false);
        setBusy(true);
        setError('');
        try {
            const saved = current.selected
                ? await client.update(current.selected.id, current.selected.revision, current.fields, controller.signal)
                : await client.create(current.fields, controller.signal);
            if (!alive.current || version !== generation.current) return;
            setData(previous => ({ resumes: previous?.resumes ?? [], applicationRun: previous?.applicationRun ?? null, jobs:
                previous?.jobs.some(job => job.id === saved.id)
                    ? previous.jobs.map(job => job.id === saved.id ? saved : job)
                    : [saved, ...(previous?.jobs ?? [])] }));
            setEditor(null);
            setNotice('Job saved to the canonical store');
            void workspaceChanged?.();
            void refresh();
        } catch (error) {
            if (!alive.current || version !== generation.current) return;
            if (error instanceof ApiError && error.status === 404 && current.selected) {
                setEditor(value => value ? { ...value, missing: true, latest: null } : value);
            } else if (error instanceof ApiError && error.code === 'revision_conflict' && current.selected) {
                try {
                    const latest = await client.job(current.selected.id, controller.signal);
                    if (alive.current && version === generation.current) {
                        setEditor(value => value ? { ...value, latest, missing: false } : value);
                    }
                } catch (latestError) {
                    if (alive.current && version === generation.current) {
                        if (latestError instanceof ApiError && latestError.status === 404) {
                            setEditor(value => value ? { ...value, missing: true, latest: null } : value);
                        } else {
                            setError('Unable to load the latest job. Your draft is preserved. Refresh and try again.');
                        }
                    }
                }
            } else {
                setError(error instanceof ApiError ? error.message
                    : 'Save was not confirmed. Your draft is preserved. Refresh to check the record before retrying.');
            }
        } finally {
            if (mutation.current === controller) mutation.current = null;
            if (alive.current && version === generation.current) setBusy(false);
        }
    }
    const allJobs = data?.jobs ?? [];
    const visible = new Set(filterJobs(allJobs, query, status));
    const jobs = allJobs.filter(job => visible.has(job));
    const readyJobs = allJobs.filter(job => job.status === 'ready').length;
    const attentionJobs = allJobs.filter(job => job.status === 'needs_info').length;
    const run = data?.applicationRun ?? null;
    const runQueue = new Set(run?.queueVersions.at(-1)?.jobIds ?? []);
    const runResume = data?.resumes.find(resume => resume.id === run?.selection.resumeId);
    return <section className="jobs-workspace" aria-labelledby="jobs-workspace-title">
        <header className="workspace-hero">
            <div className="workspace-hero-copy">
                <p className="eyebrow">Jobs workspace</p>
                <h1 id="jobs-workspace-title">Keep every opportunity moving.</h1>
                <p>Save opportunities, prepare applications, and track progress in your canonical local queue.</p>
            </div>
            <div className="workspace-hero-actions">
                <button disabled={busy || transitionBusy} onClick={() => void refresh()}>Refresh</button>{' '}
                <button className="primary" data-job-create disabled={busy || transitionBusy || claimsActive} onClick={() => open(null)}>New job</button>
            </div>
        </header>
        {allJobs.length > 0 && <div className="pipeline-metrics" aria-label="Pipeline summary">
            <div><strong>{allJobs.length}</strong><span>Active jobs</span></div>
            <div><strong>{readyJobs}</strong><span>Ready for agent</span></div>
            <div><strong>{attentionJobs}</strong><span>Need information</span></div>
        </div>}
        {run ? <div className="workspace-panel application-run-panel" aria-label="Active application run">
            <div><p className="eyebrow">Locked inputs</p><h2>{runResume?.label ?? run.selection.resumeId}</h2></div>
            <p><strong>{runQueue.size}</strong> {runQueue.size === 1 ? 'job' : 'jobs'} in queue · queue revision {run.queueVersions.at(-1)?.revision} · confirmed facts revision {run.selection.factRevision}</p>
            <p>You confirmed this resume and fact set in chat for the whole run. Jobs marked “In active run” are in the current queue. Ask the Job Apply agent to update the queue or complete the run before switching inputs.</p>
        </div> : allJobs.length > 0 && <div className="workspace-panel application-run-panel" aria-label="No active application run">
            <div><p className="eyebrow">Application run</p><h2>Not started</h2></div>
            <p>Saved jobs can stay here until you are ready to apply.</p>
            <p>Ask the Job Apply agent to review the proposed queue with you and confirm one resume and fact revision. Those inputs stay locked for the whole run.</p>
        </div>}
        <div className="workspace-panel jobs-panel">
            <div className="workspace-panel-heading">
                <div><p className="eyebrow">Pipeline</p><h2>Jobs</h2></div>
                <div className="filters">
                    <label>Search jobs<input value={query} onChange={e => setQuery(e.target.value)} /></label>
                    <label>Status<select value={status} onChange={e => setStatus(e.target.value)}>
                        <option value="">All statuses</option>
                        {['saved', 'needs_info', 'ready', 'in_progress', 'awaiting_review', 'applied', 'closed'].map(value =>
                            <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
                    </select></label>
                </div>
            </div>
            <p className="workspace-status" role="status">{loading ? (data ? 'Refreshing jobs…' : 'Loading jobs…') : notice}</p>
            {loadError && <p role="alert" className="error">
                {data ? 'Showing previously loaded jobs. ' : 'Jobs could not be loaded. '}{loadError}{' '}
                <button disabled={busy || transitionBusy} onClick={() => void refresh()}>Retry loading jobs</button>
            </p>}
            {!editor && error && <p role="alert" className="error">{error}</p>}
            <div className="job-list">
                {jobs.map(job => {
                    const role = String(job.role || job.url);
                    const company = String(job.company || 'Company not set');
                    const location = String(job.location || job.workplaceType || 'Location not set');
                    const priority = typeof job.priority === 'number' && Number.isFinite(job.priority) ? Math.max(0, Math.min(5, Math.round(job.priority))) : 0;
                    return <button className="job-card" aria-label={`${role}, ${company}${runQueue.has(job.id) ? ', in active application run' : ''}`} disabled={busy || transitionBusy || claimsActive} key={job.id} onClick={() => open(job)}>
                        <span className="company-mark" aria-hidden="true">{company.trim().charAt(0).toUpperCase() || '?'}</span>
                        <span className="job-identity"><strong>{role}</strong><span>{company}</span></span>
                        <span className="job-location">{location}</span>
                        <span className="job-priority" aria-label={`Priority ${priority} of 5`}>{priority ? `${'★'.repeat(priority)}${'☆'.repeat(5-priority)}` : 'Priority —'}</span>
                        <span className={`status-pill status-${job.status}`}>{job.status.replaceAll('_', ' ')}</span>
                        {runQueue.has(job.id) && <span className="run-pill">In active run</span>}
                        <span className="visually-hidden">revision {job.revision}</span>
                    </button>;
                })}
            </div>
            {data && !loading && !loadError && !jobs.length && <div className="workspace-empty">
                {allJobs.length ? <><strong>No jobs match these filters.</strong><button className="text-action" onClick={() => { setQuery(''); setStatus(''); }}>Clear filters</button></>
                    : <><strong>No jobs yet. Capture a job to get started.</strong><span>Your saved opportunities will appear here.</span><button className="text-action" onClick={() => open(null)}>Create your first job</button></>}
            </div>}
        </div>
        {claimsEnabled && <Claims client={client} jobs={allJobs} disabled={busy || transitionBusy || loading || Boolean(editor?.dirty.size)}
            activityChanged={setClaimsActive} navigationChanged={setClaimsDirty} changed={() => { void workspaceChanged?.(); void refresh(); }} />}
        {editor && <JobEditor editor={editor} resumes={data?.resumes ?? []} busy={busy || transitionBusy || claimsActive} error={error}
            change={(fields: Partial<JobFields>) => setEditor(current => current ? edit(current, fields) : current)}
            close={close} save={() => void save()}
            refresh={() => {
                const version = generation.current;
                void refresh().then(success => {
                    if (alive.current && version === generation.current && success !== undefined) {
                        setError(success ? '' : 'Unable to load the latest jobs. Your draft is preserved.');
                    }
                });
            }}
            reapply={() => { setEditor(current => current ? reapply(current) : current); setError(''); }}
            load={() => {
                if (editor.latest && (!editor.dirty.size || confirm('Discard your draft and load canonical values?'))) {
                    setEditor(openEditor(editor.latest));
                    setError('');
                }
            }} >
            {claimsEnabled && editor.selected && <JobTransitions client={client} job={editor.selected}
                disabled={busy || loading || claimsActive || Boolean(editor.dirty.size) || Boolean(editor.latest) || editor.missing}
                onBusyChanged={setTransitionBusy} onChanged={job => {
                    // The write is acknowledged: replace the clean editor before a background read.
                    refreshRequest.current?.abort(); listGeneration.current++;
                    setData(current => current ? {...current,jobs:current.jobs.map(item=>item.id===job.id?job:item)} : current);
                    setEditor(openEditor(job)); setError('');
                    void workspaceChanged?.();
                    void refresh();
                }} />}
            {claimsEnabled && editor.selected && <JobActivity client={client} jobId={editor.selected.id}
                refreshKey={editor.selected.revision} openAnswers={openAnswers} />}
        </JobEditor>}
    </section>;
}
