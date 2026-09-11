'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrashClient } from './trash-client';
import { referenceText, trashErrorText, type TrashAction, type TrashCapabilities, type TrashItem, type TrashSnapshot, type TrashType } from './trash-model';
import { TrashConfirmation } from './TrashConfirmation';
export interface TrashProps {
    client: TrashClient;
    capabilities: TrashCapabilities;
    dirtyChanged(value: boolean): void;
    onMutation?(): void | Promise<void>;
}
export function Trash({ client, capabilities, dirtyChanged, onMutation }: TrashProps) {
    const [snapshot, setSnapshot] = useState<TrashSnapshot | null>(null);
    const [filter, setFilter] = useState<TrashType | ''>('');
    const [selection, setSelection] = useState<{ item: TrashItem; action: TrashAction } | null>(null);
    const [loading, setLoading] = useState(true);
    const [stale, setStale] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const generation = useRef(0);
    const controller = useRef<AbortController | null>(null);
    const mutation = useRef(false);
    const mounted = useRef(false);
    const wasBusy = useRef(false);
    const opener = useRef<HTMLElement | null>(null);
    useEffect(() => {
        if (wasBusy.current && !busy) document.getElementById('trash-refresh')?.focus();
        wasBusy.current = busy;
    }, [busy]);
    const refresh = useCallback(async (): Promise<boolean> => {
        controller.current?.abort();
        const abort = new AbortController();
        controller.current = abort;
        const request = ++generation.current;
        setLoading(true);
        setStale(true);
        try {
            const value = await client.list(abort.signal);
            if (!mounted.current || request !== generation.current) return false;
            setSnapshot(value);
            setStale(false);
            setError('');
            return true;
        } catch {
            if (mounted.current && request === generation.current)
                setError('Trash could not be refreshed. Displayed records may be outdated; actions are disabled until refresh succeeds.');
            return false;
        } finally {
            if (mounted.current && request === generation.current) setLoading(false);
        }
    }, [client]);
    useEffect(() => {
        mounted.current = true;
        setSnapshot(null);
        setSelection(null);
        setNotice('');
        void refresh();
        return () => { mounted.current = false; ++generation.current; controller.current?.abort(); };
    }, [refresh]);
    useEffect(() => {
        dirtyChanged(selection !== null || busy);
        return () => dirtyChanged(false);
    }, [selection, busy, dirtyChanged]);
    async function submit() {
        if (!selection || mutation.current || stale || !capabilities[selection.item.type][selection.action]) return;
        mutation.current = true;
        setBusy(true);
        setError('');
        setNotice('');
        const current = selection;
        const request = generation.current;
        controller.current?.abort();
        const abort = new AbortController();
        controller.current = abort;
        try {
            await client.mutate(current.item, current.action, abort.signal);
            if (!mounted.current || request !== generation.current) return;
            setSelection(null);
            setStale(true);
            setNotice(`${current.item.type} ${current.action === 'restore' ? 'restored' : 'permanently deleted'}. The change was saved; do not repeat it if refresh fails.`);
            await refresh();
            if (mounted.current) {
                try { await onMutation?.(); }
                catch { if (mounted.current) setError('The change was saved, but another workspace view could not refresh. Refresh that view before continuing.'); }
            }
        } catch (failure) {
            if (!mounted.current || request !== generation.current) return;
            setSelection(null);
            setStale(true);
            setError(trashErrorText(failure));
        } finally {
            mutation.current = false;
            if (mounted.current) setBusy(false);
        }
    }
    const items = snapshot?.items.filter(item => !filter || item.type === filter) ?? [];
    const limited = (['job', 'resume', 'answer'] as const).some(type => !capabilities[type].restore || !capabilities[type].delete);
    return <section className="trash-workspace" aria-labelledby="trash-title" aria-busy={loading || busy}>
        <div className="trash-heading">
            <h1 id="trash-title">Trash</h1>
            <button id="trash-refresh" disabled={loading || busy || selection !== null} onClick={() => { void refresh(); }}>Refresh Trash</button>
        </div>
        <p>Restore individual records or review them for permanent deletion.</p>
        {limited && <p>Some lifecycle actions are not available in this workspace. Only supported actions are enabled.</p>}
        <label>Record type <select value={filter} disabled={busy || selection !== null} onChange={event => setFilter(event.target.value as TrashType | '')}>
            <option value="">All types</option><option value="job">Jobs</option><option value="resume">Resumes</option><option value="answer">Answers</option>
        </select></label>
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert" className="error">{error}</p>}
        {loading && <p role="status">Loading Trash…</p>}
        {snapshot && <>
            <p>{snapshot.counts.job} jobs · {snapshot.counts.resume} resumes · {snapshot.counts.answer} answers{stale ? ' (outdated)' : ''}</p>
            {!stale && <p role="status">{items.length ? `${items.length} trashed records in this view.` : filter ? 'No trashed records of this type.' : 'Trash is empty.'}</p>}
            <ul className="trash-list" aria-label="Trashed records">
                {items.map(item => <li key={JSON.stringify([item.type, item.id])}>
                    <article className="trash-card">
                        <div><p className="eyebrow">{item.type}</p><h2>{item.label}</h2>
                            <p>{referenceText(item.blockerCounts)}. Checked again when you act.</p></div>
                        <div className="trash-actions">
                            {(['restore', 'delete'] as const).map(action => <button key={action}
                                disabled={stale || loading || busy || selection !== null || !capabilities[item.type][action]}
                                onClick={event => { opener.current = event.currentTarget; setSelection({ item, action }); }}>
                                {action === 'restore' ? 'Restore' : 'Delete permanently…'}{!capabilities[item.type][action] ? ' (unavailable)' : ''}
                            </button>)}
                        </div>
                    </article>
                </li>)}
            </ul>
        </>}
        {selection && <TrashConfirmation opener={opener.current} item={selection.item} action={selection.action} busy={busy} confirm={() => { void submit(); }} cancel={() => { if (!mutation.current) setSelection(null); }} />}
    </section>;
}
