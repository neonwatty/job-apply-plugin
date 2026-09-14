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

export function Resumes({ client, dirtyChanged, openExtractions }: { client: Client; dirtyChanged: (dirty: boolean) => void; openExtractions?:()=>void }) {
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
    const managed = records.filter(record => record.storageKind === 'managed').length;
    const defaultResume = records.find(record => record.default);
    return <section className="resumes-workspace" aria-labelledby="resumes-workspace-title">
        <header className="workspace-hero"><div className="workspace-hero-copy"><p className="eyebrow">Resumes workspace</p><h1 id="resumes-workspace-title">Your private resume library.</h1><p>Managed files stay in the canonical local store and remain available to Job Apply agents and the CLI.</p></div><div className="workspace-hero-actions">
            <button className="secondary" disabled={busy} onClick={() => void refresh()}>Refresh</button>
            {openExtractions&&<button className="secondary" disabled={busy} onClick={openExtractions}>Resume extraction</button>}
            <button className="primary" disabled={busy} onClick={() => open(null)}>Import resume</button>
        </div></header>
        <div className="resume-metrics" aria-label="Resume library summary">
            <div><strong>{records.length}</strong><span>Active resumes</span></div>
            <div><strong>{managed}</strong><span>Managed locally</span></div>
            <div><strong>{defaultResume?.label ?? 'None'}</strong><span>Application default</span></div>
        </div>
        <div className="workspace-panel resumes-panel" aria-labelledby="resume-library-heading">
            <div className="workspace-panel-heading"><div><p className="eyebrow">Canonical library</p><h2 id="resume-library-heading">Resumes</h2></div><strong className="resume-count">{records.length} {records.length === 1 ? 'document' : 'documents'}</strong></div>
            <p className="workspace-status" role="status">{loading ? 'Loading resumes…' : notice}</p>
            {!editor && error && <p role="alert" className="error">{error}</p>}
            <ul className="resume-list">
                {records.map(record => <li key={record.id}><button className="resume-card" disabled={busy} onClick={() => open(record)}>
                    <span className="resume-card-heading"><span className="resume-file-mark" aria-hidden="true">DOC</span><strong>{record.label}{record.default ? ' · Default' : ''}</strong>{record.default && <span className="status-pill resume-default" aria-hidden="true">Default</span>}</span>
                    <span className="resume-card-meta"><span>{record.mediaType ?? 'External file'}</span><span>{record.storageKind === 'managed' ? 'Managed locally' : 'External file'}</span></span>
                    <span className="resume-tags">{record.tags.length ? record.tags.map(tag => <small key={tag}>{tag}</small>) : <small>No tags</small>}</span>
                    <span className="resume-card-action">Open resume <span aria-hidden="true">→</span></span>
                    <span className="visually-hidden">revision {record.revision}</span>
                </button></li>)}
            </ul>
            {!loading && !error && !records.length && <div className="workspace-empty resume-empty"><span className="resume-empty-mark" aria-hidden="true">DOC</span><strong>No resumes yet.</strong><span>Import one to use it with applications.</span><button className="text-action" type="button" onClick={() => open(null)}>Import your first resume</button></div>}
        </div>
        {editor && <section className="workspace-panel resume-editor-panel" aria-labelledby="resume-editor-title">
            <div className="workspace-panel-heading"><div><p className="eyebrow">Canonical resume</p><h2 id="resume-editor-title">{editor.base ? editor.base.label : 'Import resume'}</h2></div>{editor.base && <span className="facts-revision">Revision {editor.base.revision}</span>}</div>
            <p className="resume-editor-intro">{editor.base ? 'Update the document label and tags, or choose a file to replace the managed copy.' : 'Add a PDF, DOCX, or UTF-8 text resume to the canonical local library.'}</p>
            {error && <p role="alert" className="error">{error}</p>}
            {editor.missing && <p className="notice" role="alert">This resume is no longer available. Your draft is preserved; saving is disabled.</p>}
            {editor.latest && <div className="notice resume-conflict" role="alert">
                <p>This resume changed elsewhere. Your draft is preserved.</p>
                <button disabled={busy} onClick={reapply}>Reapply my draft</button>{' '}
                <button disabled={busy} onClick={() => open(editor.latest)}>Use latest resume</button>
            </div>}
            <div className="resume-editor-fields"><label>Label<input value={editor.label} onChange={event => setEditor({ ...editor, label: event.target.value })} disabled={busy} /></label>
            <label>Tags, separated by commas<input value={editor.tagText} onChange={event => setEditor({ ...editor, tagText: event.target.value })} disabled={busy} /></label>
            <label className="resume-file-field">{editor.base?.storageKind === 'managed' ? 'Replacement file' : editor.base ? 'File to adopt' : 'Resume file'}
                <input ref={fileInput} type="file" accept={accept} onChange={event => setEditor({ ...editor, file: event.target.files?.[0] ?? null })} disabled={busy} />
            </label></div>
            <div className="resume-editor-actions"><button className="secondary" disabled={busy} onClick={close}>Cancel</button>
                <button className="primary" disabled={busy || loading || Boolean(editor.latest) || editor.missing || !dirty && Boolean(editor.base)} onClick={() => void save()}>Save</button>{' '}
                {editor.base && !editor.base.default && <button className="secondary" disabled={busy || loading || dirty || Boolean(editor.latest) || editor.missing}
                    onClick={() => void mutate(signal => client.setDefaultResume(editor.base!.id, editor.base!.revision, signal), 'Default resume changed')}>Make default</button>}
            </div>
        </section>}
    </section>;
}
