import { filterJobs } from '../../../src/workspace-ui/lib/activity-view';
import { useEffect, useRef, useState } from 'react';
import { ApiError, type Client } from './client';
import type { Job, JobFields, WorkspaceState } from './contracts';
import { edit, observe, openEditor, reapply, type Editor } from './job-editor-state';
import { JobEditor } from './JobEditor';
import { Claims } from './Claims';

export function Jobs({ client, dirtyChanged, claimsEnabled = false }: {
    client: Client;
    claimsEnabled?: boolean;
    dirtyChanged: (dirty: boolean) => void;
}) {
    const [data, setData] = useState<WorkspaceState | null>(null);
    const [editor, setEditor] = useState<Editor | null>(null);
    const [busy, setBusy] = useState(false);
    const [claimsActive, setClaimsActive] = useState(false);
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
        dirtyChanged(Boolean(editor?.dirty.size) || busy || claimsActive);
        return () => dirtyChanged(false);
    }, [editor, busy, claimsActive, dirtyChanged]);

    function open(job: Job | null) {
        if (mutation.current || claimsActive) return;
        if (editor?.dirty.size && !confirm('Discard unsaved job changes?')) return;
        generation.current++;
        setError('');
        setNotice('');
        setEditor(openEditor(job));
    }
    function close() {
        if (mutation.current) return;
        if (editor?.dirty.size && !confirm('Discard unsaved job changes?')) return;
        generation.current++;
        setEditor(null);
        setError('');
    }
    async function save() {
        if (!editor || mutation.current || editor.missing || editor.latest) return;
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
            setData(previous => ({ resumes: previous?.resumes ?? [], jobs:
                previous?.jobs.some(job => job.id === saved.id)
                    ? previous.jobs.map(job => job.id === saved.id ? saved : job)
                    : [saved, ...(previous?.jobs ?? [])] }));
            setEditor(null);
            setNotice('Job saved to the canonical store');
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
    return <section>
        <header>
            <div><p className="eyebrow">Your pipeline</p><h1>Jobs</h1></div>
            <div>
                <button disabled={busy} onClick={() => void refresh()}>Refresh</button>{' '}
                <button className="primary" data-job-create disabled={busy} onClick={() => open(null)}>New job</button>
            </div>
        </header>
        <p role="status">{loading ? (data ? 'Refreshing jobs…' : 'Loading jobs…') : notice}</p>
        {loadError && <p role="alert" className="error">
            {data ? 'Showing previously loaded jobs. ' : 'Jobs could not be loaded. '}{loadError}{' '}
            <button disabled={busy} onClick={() => void refresh()}>Retry loading jobs</button>
        </p>}
        <div className="filters">
            <label>Search jobs<input value={query} onChange={e => setQuery(e.target.value)} /></label>
            <label>Status<select value={status} onChange={e => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                {['saved', 'needs_info', 'ready', 'in_progress', 'awaiting_review', 'applied', 'closed'].map(value =>
                    <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
            </select></label>
        </div>
        <div className="job-list">
            {jobs.map(job => <button className="job-card" key={job.id} onClick={() => open(job)}>
                <strong>{String(job.role || job.url)}</strong>
                <span>{String(job.company || '')} · {String(job.location || '')}</span>
                <small>{job.status.replaceAll('_', ' ')} · revision {job.revision}</small>
            </button>)}
        </div>
        {data && !loading && !loadError && !jobs.length && (allJobs.length
            ? <p>No jobs match these filters. <button onClick={() => { setQuery(''); setStatus(''); }}>Clear filters</button></p>
            : <p>No jobs yet. Capture a job to get started.</p>)}
        {claimsEnabled && <Claims client={client} jobs={allJobs} disabled={busy || loading || Boolean(editor?.dirty.size)}
            activityChanged={setClaimsActive} changed={() => { void refresh(); }} />}
        {editor && <JobEditor editor={editor} resumes={data?.resumes ?? []} busy={busy || claimsActive} error={error}
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
            }} />}
    </section>;
}
