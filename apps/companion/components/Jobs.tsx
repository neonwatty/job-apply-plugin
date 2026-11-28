import { filterJobs } from '../../../src/workspace-ui/lib/activity-view';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, type Client } from './client';
import type { Job, JobFields, WorkspaceState } from './contracts';
import { edit, observe, openEditor, reapply, type Editor } from './job-editor-state';
import { JobEditor } from './JobEditor';
import { Claims } from './Claims';
import { JobActivity } from './JobActivity';
import { JobHandoff } from './JobHandoff';
import { activityProjection, attentionGuidance, attentionProjection, attentionReasons } from './projection-model';
import { useProjection } from './projection-view';
import { JobTransitions } from './JobTransitions';

function jobStatusLabel(status: string) {
    if (status === 'ready') return 'Ready for agent';
    if (status === 'awaiting_review') return 'Awaiting your review';
    return status.replaceAll('_', ' ');
}

export function Jobs({ client, dirtyChanged, active = true, claimsEnabled = false, showHandoff = false, requestedJob, backLabel, openJob, prepareNewJob, closeJob, navigationBusyChanged, openAnswers, workspaceChanged, refreshKey = 0 }: {
    client: Client;
    active?: boolean;
    claimsEnabled?: boolean;
    showHandoff?: boolean;
    requestedJob?: { id: string; revision: bigint } | null;
    backLabel: string;
    openJob: (id:string) => boolean;
    prepareNewJob: () => boolean;
    closeJob: (saved?:boolean) => void;
    navigationBusyChanged: (busy:boolean) => void;
    openAnswers?: () => void;
    workspaceChanged?: () => void | Promise<void>;
    refreshKey?: number;
    dirtyChanged: (dirty: boolean) => void;
}) {
    const [data, setData] = useState<WorkspaceState | null>(null);
    const [editor, setEditor] = useState<Editor | null>(null);
    const [busy, setBusy] = useState(false);
    const [transitionBusy, setTransitionBusy] = useState(false);
    const [closingOutcome, setClosingOutcome] = useState('');
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [error, setError] = useState('');
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [notice, setNotice] = useState('');
    const [editorNotice, setEditorNotice] = useState('');
    const alive = useRef(false);
    const refreshRequest = useRef<AbortController | null>(null);
    const mutation = useRef<AbortController | null>(null);
    const generation = useRef(0);
    const listGeneration = useRef(0);
    const previousRefreshKey = useRef(refreshKey);
    const handoffHeading = useRef<HTMLHeadingElement>(null);
    const handoffFocused = useRef(false);
    const handoffLoading = loading || previousRefreshKey.current !== refreshKey;
    const requestedRefresh = useRef<typeof requestedJob>(null);
    const allJobs = data?.jobs ?? [];
    const ready = allJobs.some(job => job.status === 'ready');
    const reconfirmation = useProjection(client, active && claimsEnabled && ready ? '/api/attention' : null,
        attentionProjection);
    const pending = new Map(reconfirmation.data?.items
        .filter(item => item.reasonCode === 'pending_live_reconfirmation')
        .map(item => [item.jobId, item.revision]));
    const selectedJob = claimsEnabled && editor?.selected?.id === requestedJob?.id ? editor?.selected : null;
    const activity = useProjection(client, active && selectedJob ? `/api/jobs/${encodeURIComponent(selectedJob.id)}/activity` : null,
        activityProjection, `${refreshKey}:${selectedJob?.revision ?? ''}`);

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
            reconfirmation.refresh();
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
        if (!active) {
            refreshRequest.current?.abort();
            listGeneration.current++;
            setLoading(false);
        }
    }, [active]);
    useEffect(() => {
        if (previousRefreshKey.current === refreshKey) return;
        previousRefreshKey.current = refreshKey;
        void refresh();
    }, [refreshKey]);
    useEffect(() => {
        if (showHandoff && editor) close();
    }, [showHandoff]);
    useEffect(() => {
        if (!showHandoff) {
            handoffFocused.current = false;
            return;
        }
        if (handoffLoading || handoffFocused.current) return;
        const frame = requestAnimationFrame(() => {
            const heading = handoffHeading.current;
            if (!heading) return;
            handoffFocused.current = true;
            heading.focus({preventScroll:true});
            heading.scrollIntoView({block:'start'});
        });
        return () => cancelAnimationFrame(frame);
    }, [showHandoff, handoffLoading]);
    useLayoutEffect(() => {
        dirtyChanged(Boolean(editor?.dirty.size) || busy || transitionBusy);
        return () => dirtyChanged(false);
    }, [editor, busy, transitionBusy, dirtyChanged]);
    useLayoutEffect(() => {
        navigationBusyChanged(active && (busy || transitionBusy));
        return () => navigationBusyChanged(false);
    }, [active, busy, transitionBusy, navigationBusyChanged]);
    useEffect(() => {
        if (!requestedJob) {
            if (editor?.selected) setEditor(null);
            if (requestedRefresh.current) {
                requestedRefresh.current = null;
                setError('');
            }
            return;
        }
        if (editor?.selected?.id === requestedJob.id || !data) return;
        const selected = data.jobs.find(job => job.id === requestedJob.id);
        if (selected && selected.revision >= requestedJob.revision) {
            open(selected);
            return;
        }
        if (loading || loadError) return;
        if (requestedRefresh.current !== requestedJob) {
            requestedRefresh.current = requestedJob;
            void refresh();
            return;
        } else setError('This job is unavailable. Refresh Jobs to check again.');
    }, [requestedJob, data, loading, loadError, editor?.selected]);

    function open(job: Job | null) {
        if (mutation.current || transitionBusy) return;
        generation.current++;
        setError('');
        setNotice('');
        setEditorNotice('');
        setClosingOutcome('');
        setEditor(openEditor(job));
    }
    function close() {
        if (mutation.current || transitionBusy) return;
        if (requestedJob) { closeJob(); return; }
        if (editor?.dirty.size && !confirm('Discard unsaved job changes?')) return;
        generation.current++;
        setClosingOutcome('');
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
            setNotice('Job saved locally');
            if (current.selected) closeJob(true);
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
    const visible = new Set(filterJobs(allJobs, query, status));
    const jobs = allJobs.filter(job => visible.has(job));
    const run = data?.applicationRun ?? null;
    const runQueue = new Set(run?.queueVersions.at(-1)?.jobIds ?? []);
    const runResume = data?.resumes.find(resume => resume.id === run?.selection.resumeId);
    const awaitingReview = selectedJob?.status === 'awaiting_review';
    const selectedNeedsConfirmation = selectedJob?.status === 'ready' && pending.get(selectedJob.id) === selectedJob.revision;
    const reviewRecordUnavailable = activity.loading || Boolean(selectedJob && activity.data
        && (activity.data.job.revision > selectedJob.revision
            || activity.data.job.revision === selectedJob.revision && activity.data.claim.state !== 'none'));
    const transitions = editor && selectedJob && <JobTransitions key={selectedJob.id} client={client} job={selectedJob}
        outcome={closingOutcome} onOutcomeChanged={setClosingOutcome}
        runSetup={run ? runQueue.has(selectedJob.id) ? undefined : 'add-job' : 'start-run'}
        recordInHandoff={awaitingReview && !editor.latest && !editor.missing}
        verifySubmission={activity.data?.job.revision === selectedJob.revision && Boolean(activity.data.submission)}
        disabled={busy || loading || Boolean(editor.dirty.size) || Boolean(editor.latest) || editor.missing || (awaitingReview && reviewRecordUnavailable)}
        onBusyChanged={setTransitionBusy} onChanged={job => {
            // The write is acknowledged: replace the clean editor before a background read.
            refreshRequest.current?.abort();
            listGeneration.current++;
            setData(current => current ? {...current,jobs:current.jobs.map(item=>item.id===job.id?job:item)} : current);
            setEditor(openEditor(job));
            setError('');
            if (awaitingReview) setEditorNotice(job.status === 'applied' ? 'Submission recorded in Companion.' : 'Job closed in Companion.');
            else setEditorNotice('');
            void workspaceChanged?.();
            void refresh();
        }} />;
    const activityPanel = selectedJob && <JobActivity key={selectedJob.id} activity={activity} jobId={selectedJob.id} openAnswers={openAnswers} />;
    return <section className="jobs-workspace" aria-labelledby="jobs-workspace-title">
        <header className="workspace-hero">
            <div className="workspace-hero-copy">
                <h1 id="jobs-workspace-title">Jobs</h1>
                <p>Save opportunities, prepare applications, and track each job from one place.</p>
            </div>
            <div className="workspace-hero-actions">
                <button className="jobs-refresh" aria-label="Refresh" disabled={busy || transitionBusy} onClick={() => void refresh()}>
                    <svg className="jobs-refresh-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"
                        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 4v5h-5M19.5 9a8 8 0 1 0 .3 5"/>
                    </svg><span>Refresh</span>
                </button>
                <button className="primary" data-job-create disabled={busy || transitionBusy} onClick={() => { if (prepareNewJob()) open(null); }}>New job</button>
            </div>
        </header>
        {run && <details className="workspace-panel application-run-panel" aria-label="Active application run">
            <summary>Active application run <span>{runQueue.size} {runQueue.size === 1 ? 'job' : 'jobs'}</span></summary>
            <p><strong>{runResume?.label ?? run.selection.resumeId}</strong> and its confirmed facts stay locked until the run ends.</p>
        </details>}
        <div className="workspace-panel jobs-panel">
            <div className="workspace-panel-heading jobs-list-heading">
                <h2>Saved jobs</h2>
                {allJobs.length > 0 && <div className="filters jobs-filters">
                    <label className="jobs-search"><span className="visually-hidden">Search jobs</span>
                        <input type="search" placeholder="Search jobs" value={query} onChange={e => setQuery(e.target.value)} />
                    </label>
                    <button type="button" className="jobs-filter-toggle" aria-expanded={filtersOpen} aria-controls="jobs-status-filter" aria-label={status ? `Filters: ${jobStatusLabel(status)}` : 'Filters'}
                        onClick={()=>setFiltersOpen(open=>!open)}>{status ? jobStatusLabel(status) : 'Filters'}
                    </button>
                    <label id="jobs-status-filter" className="jobs-status-filter" data-expanded={filtersOpen}>Status
                        <select aria-label="Status" value={status} onChange={e => setStatus(e.target.value)}>
                            <option value="">All statuses</option>
                            {['saved', 'needs_info', 'ready', 'in_progress', 'awaiting_review', 'applied', 'closed'].map(value =>
                                <option key={value} value={value}>{jobStatusLabel(value)}</option>)}
                        </select>
                    </label>
                </div>}
            </div>
            <p className="workspace-status" role="status">{loading ? (data ? 'Refreshing jobs…' : 'Loading jobs…') : notice}</p>
            {loadError && <p role="alert" className="error">
                {data ? 'Showing previously loaded jobs. ' : 'Jobs could not be loaded. '}{loadError}{' '}
                <button disabled={busy || transitionBusy} onClick={() => void refresh()}>Retry loading jobs</button>
            </p>}
            {!editor && error && <p role="alert" className="error">{error}</p>}
            {requestedJob && (loadError || error) && !editor && <button className="secondary" onClick={()=>closeJob()}>{backLabel}</button>}
            <div className="job-list">
                {jobs.map(job => {
                    const role = String(job.role || job.url);
                    const company = String(job.company || 'Company not set');
                    const location = String(job.location || job.workplaceType || 'Location not set');
                    const priority = typeof job.priority === 'number' && Number.isFinite(job.priority) ? Math.max(0, Math.min(5, Math.round(job.priority))) : 0;
                    const needsConfirmation = job.status === 'ready' && pending.get(job.id) === job.revision;
                    const label = jobStatusLabel(job.status);
                    const name = [role, company, runQueue.has(job.id) ? 'in active application run' : '', label,
                        needsConfirmation ? attentionReasons.pending_live_reconfirmation : ''].filter(Boolean).join(', ');
                    return <button className="job-card" aria-label={name} disabled={busy || transitionBusy} key={job.id}
                        data-workspace-focus={`job:${job.id}`} onClick={() => openJob(job.id)}>
                        <span className="company-mark" aria-hidden="true">{company.trim().charAt(0).toUpperCase() || '?'}</span>
                        <span className="job-identity">
                            <strong>{role}</strong><span>{company}</span>
                            {needsConfirmation && <small className="job-confirmation">{attentionReasons.pending_live_reconfirmation}</small>}
                        </span>
                        <span className="job-location">{location}</span>
                        <span className="job-priority" aria-label={`Priority ${priority} of 5`}>{priority ? `${'★'.repeat(priority)}${'☆'.repeat(5-priority)}` : 'Priority —'}</span>
                        <span className={`status-pill status-${job.status}`}>{label}</span>
                        {runQueue.has(job.id) && <span className="run-pill">In active run</span>}
                        <span className="visually-hidden">revision {job.revision}</span>
                    </button>;
                })}
            </div>
            {data && !loading && !loadError && !jobs.length && <div className="workspace-empty">
                {allJobs.length ? <><strong>No jobs match these filters.</strong><button className="text-action" onClick={() => { setQuery(''); setStatus(''); }}>Clear filters</button></>
                    : <strong>No jobs saved yet.</strong>}
            </div>}
        </div>
        {claimsEnabled && (ready || showHandoff) && <Claims ready={ready}
            loading={handoffLoading} unavailable={Boolean(loadError)}
            headingRef={handoffHeading} />}
        {active && editor && editor.selected?.id === requestedJob?.id && <JobEditor key={editor.selected?.id ?? 'new'}
            editor={editor} backLabel={backLabel} resumes={data?.resumes ?? []} busy={busy || transitionBusy} error={error}
            notice={editorNotice}
            handoff={selectedJob && !editor.latest && !editor.missing && (
                selectedNeedsConfirmation
                    ? <section className="workspace-panel job-handoff" aria-label={attentionReasons.pending_live_reconfirmation}>
                        <h3>{attentionReasons.pending_live_reconfirmation}</h3>
                        <p>{attentionGuidance.pending_live_reconfirmation}</p>
                    </section>
                    : <JobHandoff job={selectedJob} activity={activity}>
                        {awaitingReview ? transitions : null}
                    </JobHandoff>
            )}
            change={(fields: Partial<JobFields>) => {
                const draft = edit(editor, fields);
                dirtyChanged(Boolean(draft.dirty.size) || busy || transitionBusy);
                setEditor(draft);
            }}
            close={close} reset={() => { setEditor(current => current?.selected
                ? { ...openEditor(current.latest ?? current.selected), missing: current.missing } : null); setError(''); }} save={() => void save()}
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
                if (editor.latest && (!editor.dirty.size || confirm('Discard your draft and load saved values?'))) {
                    setEditor(openEditor(editor.latest));
                    setError('');
                }
            }} >
            {(!awaitingReview || editor.latest || editor.missing) && transitions}
            {awaitingReview ? <details className="job-activity-details">
                <summary>Full job activity</summary>{activityPanel}
            </details> : activityPanel}
        </JobEditor>}
    </section>;
}
