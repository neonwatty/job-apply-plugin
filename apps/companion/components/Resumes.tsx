import { useEffect, useRef, useState } from 'react';
import { ApiError, type Client } from './client';
import type { ResumeRecord } from './contracts';

const accept = '.pdf,.docx,.txt';
const tags = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);

export function Resumes({ client, dirtyChanged }: { client: Client; dirtyChanged: (dirty: boolean) => void }) {
    const [records, setRecords] = useState<ResumeRecord[]>([]), [selected, setSelected] = useState<ResumeRecord | null>(null);
    const [creating, setCreating] = useState(false);
    const [label, setLabel] = useState(''), [tagText, setTagText] = useState(''), [file, setFile] = useState<File | null>(null);
    const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const alive = useRef(true), request = useRef<AbortController | null>(null);
    const dirty = Boolean(selected && (label !== selected.label || tagText !== selected.tags.join(', '))) || file !== null;
    async function refresh() {
        request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true);
        try {
            const next = await client.resumes(controller.signal);
            if (!alive.current) return;
            setRecords(next); setSelected(current => current ? next.find(item => item.id === current.id) ?? null : null); setError('');
        } catch (cause) { if (alive.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load resumes'); }
        finally { if (alive.current) setLoading(false); }
    }
    useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; request.current?.abort(); }; }, [client]);
    useEffect(() => { dirtyChanged(dirty || busy); return () => dirtyChanged(false); }, [dirty, busy, dirtyChanged]);
    function open(record: ResumeRecord | null) {
        if (dirty && !confirm('Discard unsaved resume changes?')) return;
        setCreating(record === null); setSelected(record); setLabel(record?.label ?? ''); setTagText(record?.tags.join(', ') ?? ''); setFile(null); setError(''); setNotice('');
    }
    function close() {
        if (dirty && !confirm('Discard unsaved resume changes?')) return;
        setCreating(false); setSelected(null); setLabel(''); setTagText(''); setFile(null); setError('');
    }
    async function mutate(operation: (signal: AbortSignal) => Promise<ResumeRecord>, message: string) {
        const controller = new AbortController(); setBusy(true); setError(''); setNotice('');
        try {
            const saved = await operation(controller.signal); if (!alive.current) return;
            setSelected(saved); setLabel(saved.label); setTagText(saved.tags.join(', ')); setFile(null); setNotice(message); await refresh();
        } catch (cause) {
            if (alive.current) setError(cause instanceof ApiError && cause.code === 'revision_conflict'
                ? 'This resume changed elsewhere. Refresh it before saving again.' : cause instanceof Error ? cause.message : 'The resume change was not confirmed.');
        } finally { if (alive.current) setBusy(false); }
    }
    async function save() {
        if (!label.trim()) { setError('Enter a resume label.'); return; }
        if (!selected) {
            if (!file) { setError('Choose a PDF, DOCX, or TXT resume.'); return; }
            await mutate(signal => client.importResume({ label: label.trim(), tags: tags(tagText) }, file, signal), 'Resume imported'); return;
        }
        const metadataChanged = label !== selected.label || tagText !== selected.tags.join(', ');
        if (metadataChanged && file) { setError('Save the label and tags before replacing the resume file.'); return; }
        if (metadataChanged) await mutate(signal => client.updateResume(selected.id, selected.revision,
            { label: label.trim(), tags: tags(tagText) }, signal), 'Resume details saved');
        else if (file) await mutate(signal => client.replaceResume(selected.id, selected.revision, file,
            selected.storageKind !== 'managed', signal), selected.storageKind === 'managed' ? 'Resume file replaced' : 'Resume adopted');
    }
    return <section>
        <header><div><p className="eyebrow">Your documents</p><h1>Resumes</h1></div><div>
            <button disabled={busy} onClick={() => void refresh()}>Refresh</button>{' '}
            <button className="primary" disabled={busy} onClick={() => open(null)}>Import resume</button>
        </div></header>
        <p role="status">{loading ? 'Loading resumes…' : notice}</p>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="job-list">
            {records.map(record => <button className="job-card" key={record.id} onClick={() => open(record)}>
                <strong>{record.label}{record.default ? ' · Default' : ''}</strong>
                <span>{record.mediaType ?? 'External file'} · {record.tags.join(', ') || 'No tags'}</span>
                <small>revision {record.revision}</small>
            </button>)}
        </div>
        {!loading && !records.length && <p>No resumes yet. Import one to use it with applications.</p>}
        {(selected || creating) && <div className="editor-panel">
            <h2>{selected ? selected.label : 'Import resume'}</h2>
            <label>Label<input value={label} onChange={event => setLabel(event.target.value)} disabled={busy} /></label>
            <label>Tags, separated by commas<input value={tagText} onChange={event => setTagText(event.target.value)} disabled={busy} /></label>
            <label>{selected?.storageKind === 'managed' ? 'Replacement file' : selected ? 'File to adopt' : 'Resume file'}
                <input type="file" accept={accept} onChange={event => setFile(event.target.files?.[0] ?? null)} disabled={busy} />
            </label>
            <div><button disabled={busy} onClick={close}>Cancel</button>{' '}
                <button className="primary" disabled={busy || !dirty && Boolean(selected)} onClick={() => void save()}>Save</button>{' '}
                {selected && !selected.default && <button disabled={busy || dirty} onClick={() => void mutate(signal => client.setDefaultResume(selected.id, selected.revision, signal), 'Default resume changed')}>Make default</button>}
            </div>
        </div>}
    </section>;
}
