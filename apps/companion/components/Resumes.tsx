import { useEffect, useRef, useState } from 'react';
import { ApiError, type Client } from './client';
import type { ResumeRecord } from './contracts';

const accept = '.pdf,.docx,.txt';
const tags = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
type Editor = {
    base: ResumeRecord | null;
    latest: ResumeRecord | null;
    missing: boolean;
    label: string;
    tagText: string;
    file: File | null;
};
const openEditor = (base: ResumeRecord | null): Editor => ({
    base, latest: null, missing: false, label: base?.label ?? '', tagText: base?.tags.join(', ') ?? '', file: null
});
const isDirty = (editor: Editor | null) => Boolean(editor && (
    editor.label !== (editor.base?.label ?? '') || editor.tagText !== (editor.base?.tags.join(', ') ?? '') || editor.file
));

export function Resumes({ client, dirtyChanged }: { client: Client; dirtyChanged: (dirty: boolean) => void }) {
    const [records, setRecords] = useState<ResumeRecord[]>([]), [editor, setEditor] = useState<Editor | null>(null);
    const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
    const [error, setError] = useState(''), [notice, setNotice] = useState('');
    const alive = useRef(true), request = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);
    const dirty = isDirty(editor);
    async function refresh() {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setLoading(true);
        try {
            const next = await client.resumes(controller.signal);
            if (!alive.current || controller.signal.aborted || request.current !== controller) return;
            setRecords(next);
            setEditor(current => {
                if (!current?.base) return current;
                const latest = next.find(item => item.id === current.base?.id);
                if (!latest) return { ...current, latest: null, missing: true };
                if (latest.revision < Math.max(current.base.revision, current.latest?.revision ?? 0)) return current;
                if (!isDirty(current)) return openEditor(latest);
                return { ...current, missing: false, latest: latest.revision > current.base.revision ? latest : null };
            });
            setError('');
        } catch (cause) {
            if (alive.current && !controller.signal.aborted && request.current === controller)
                setError(cause instanceof Error ? cause.message : 'Unable to load resumes');
        } finally {
            if (alive.current && request.current === controller) setLoading(false);
        }
    }
    useEffect(() => {
        alive.current = true;
        void refresh();
        return () => { alive.current = false; request.current?.abort(); mutation.current?.abort(); };
    }, [client]);
    useEffect(() => { dirtyChanged(dirty || busy); return () => dirtyChanged(false); }, [dirty, busy, dirtyChanged]);
    function open(record: ResumeRecord | null) {
        if (busy || dirty && !confirm('Discard unsaved resume changes?')) return;
        setEditor(openEditor(record));
        if (fileInput.current) fileInput.current.value = '';
        setError(''); setNotice('');
    }
    function close() {
        if (busy || dirty && !confirm('Discard unsaved resume changes?')) return;
        setEditor(null); setError('');
    }
    function reapply() {
        setEditor(current => {
            if (!current?.latest || current.missing) return current;
            const next = openEditor(current.latest);
            if (current.label !== current.base?.label) next.label = current.label;
            if (current.tagText !== current.base?.tags.join(', ')) next.tagText = current.tagText;
            next.file = current.file;
            return next;
        });
        setError('');
    }
    async function mutate(operation: (signal: AbortSignal) => Promise<ResumeRecord>, message: string) {
        request.current?.abort();
        const controller = new AbortController();
        mutation.current = controller;
        setBusy(true); setError(''); setNotice('');
        try {
            const saved = await operation(controller.signal);
            if (!alive.current || controller.signal.aborted) return;
            setEditor(openEditor(saved));
            if (fileInput.current) fileInput.current.value = '';
            setNotice(message);
            await refresh();
        } catch (cause) {
            if (alive.current && !controller.signal.aborted) {
                setError(cause instanceof ApiError && cause.code === 'revision_conflict'
                    ? 'This resume changed elsewhere. Refresh to compare it with your draft.'
                    : cause instanceof Error ? cause.message : 'The resume change was not confirmed.');
            }
        } finally { if (alive.current) setBusy(false); }
    }
    async function save() {
        if (!editor || busy || editor.latest || editor.missing) return;
        const { base, label, tagText, file } = editor;
        if (!label.trim()) { setError('Enter a resume label.'); return; }
        if (!base) {
            if (!file) { setError('Choose a PDF, DOCX, or TXT resume.'); return; }
            await mutate(signal => client.importResume({ label: label.trim(), tags: tags(tagText) }, file, signal), 'Resume imported');
            return;
        }
        const patch: { label?: string; tags?: string[] } = {};
        if (label !== base.label) patch.label = label.trim();
        if (tagText !== base.tags.join(', ')) patch.tags = tags(tagText);
        if (Object.keys(patch).length && file) { setError('Save the label and tags before replacing the resume file.'); return; }
        if (Object.keys(patch).length)
            await mutate(signal => client.updateResume(base.id, base.revision, patch, signal), 'Resume details saved');
        else if (file)
            await mutate(signal => client.replaceResume(base.id, base.revision, file, base.storageKind !== 'managed', signal),
                base.storageKind === 'managed' ? 'Resume file replaced' : 'Resume adopted');
    }
    return <section>
        <header><div><p className="eyebrow">Your documents</p><h1>Resumes</h1></div><div>
            <button disabled={busy} onClick={() => void refresh()}>Refresh</button>{' '}
            <button className="primary" disabled={busy} onClick={() => open(null)}>Import resume</button>
        </div></header>
        <p role="status">{loading ? 'Loading resumes…' : notice}</p>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="job-list">
            {records.map(record => <button className="job-card" key={record.id} disabled={busy} onClick={() => open(record)}>
                <strong>{record.label}{record.default ? ' · Default' : ''}</strong>
                <span>{record.mediaType ?? 'External file'} · {record.tags.join(', ') || 'No tags'}</span>
                <small>revision {record.revision}</small>
            </button>)}
        </div>
        {!loading && !error && !records.length && <p>No resumes yet. Import one to use it with applications.</p>}
        {editor && <div className="editor-panel">
            <h2>{editor.base ? editor.base.label : 'Import resume'}</h2>
            {editor.missing && <p role="alert">This resume is no longer available. Your draft is preserved; saving is disabled.</p>}
            {editor.latest && <div role="alert">
                <p>This resume changed elsewhere. Your draft is preserved.</p>
                <button disabled={busy} onClick={reapply}>Reapply my draft</button>{' '}
                <button disabled={busy} onClick={() => open(editor.latest)}>Use latest resume</button>
            </div>}
            <label>Label<input value={editor.label} onChange={event => setEditor({ ...editor, label: event.target.value })} disabled={busy} /></label>
            <label>Tags, separated by commas<input value={editor.tagText} onChange={event => setEditor({ ...editor, tagText: event.target.value })} disabled={busy} /></label>
            <label>{editor.base?.storageKind === 'managed' ? 'Replacement file' : editor.base ? 'File to adopt' : 'Resume file'}
                <input ref={fileInput} type="file" accept={accept} onChange={event => setEditor({ ...editor, file: event.target.files?.[0] ?? null })} disabled={busy} />
            </label>
            <div><button disabled={busy} onClick={close}>Cancel</button>{' '}
                <button className="primary" disabled={busy || loading || Boolean(editor.latest) || editor.missing || !dirty && Boolean(editor.base)} onClick={() => void save()}>Save</button>{' '}
                {editor.base && !editor.base.default && <button disabled={busy || loading || dirty || Boolean(editor.latest) || editor.missing}
                    onClick={() => void mutate(signal => client.setDefaultResume(editor.base!.id, editor.base!.revision, signal), 'Default resume changed')}>Make default</button>}
            </div>
        </div>}
    </section>;
}
