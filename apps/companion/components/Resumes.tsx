import { useEffect, useRef, useState } from 'react';
import { ApiError, type Client } from './client';
import { object, type ResumeRecord } from './contracts';
import { ResumeFacts } from './ResumeFacts';
import { DetailDrawer } from './DetailDrawer';

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
    const [editing, setEditing] = useState(false);
    const [factStatus, setFactStatus] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
    const [contentBusy, setContentBusy] = useState(false);
    const [factsDirty, setFactsDirty] = useState(false);
    const [extractByDefault, setExtractByDefault] = useState(true);
    const [error, setError] = useState(''), [notice, setNotice] = useState('');
    const alive = useRef(true), request = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null);
    const contentRequest = useRef<AbortController | null>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);
    const dirty = isDirty(editor);
    async function refresh() {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setLoading(true);
        try {
            const [next, rawFacts] = await Promise.all([client.resumes(controller.signal),
                client.extractionRequest('/api/resume-facts', 'GET', undefined, controller.signal)]);
            if (!alive.current || controller.signal.aborted || request.current !== controller) return;
            setRecords(next);
            const facts = JSON.parse(rawFacts);
            if (!object(facts) || !Array.isArray(facts.facts)) throw Error('Invalid resume fact status.');
            setFactStatus(Object.fromEntries(facts.facts.filter(object).map(item => [String(item.resumeId),
                item.current === false ? 'Stale facts' : item.state === 'confirmed' ? 'Facts confirmed' : 'Draft facts to review'])));
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
        return () => { alive.current = false; request.current?.abort(); mutation.current?.abort(); contentRequest.current?.abort(); };
    }, [client]);
    useEffect(() => { dirtyChanged(dirty || busy || factsDirty); return () => dirtyChanged(false); }, [dirty, busy, factsDirty, dirtyChanged]);
    function open(record: ResumeRecord | null) {
        if (busy || (dirty || factsDirty) && !confirm('Discard unsaved resume or fact changes?')) return;
        setEditor(openEditor(record));
        setEditing(!record);
        setExtractByDefault(true);
        if (fileInput.current) fileInput.current.value = '';
        setError(''); setNotice('');
    }
    function close() {
        if (busy || (dirty || factsDirty) && !confirm('Discard unsaved resume or fact changes?')) return;
        setEditor(null); setError('');
    }
    function cancelEdit() {
        if (!editor?.base) { close(); return; }
        if (dirty && !confirm('Discard unsaved resume changes?')) return;
        setEditor({ ...openEditor(editor.latest ?? editor.base), missing: editor.missing });
        setEditing(false);
        setError('');
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
    async function mutate(operation: (signal: AbortSignal) => Promise<ResumeRecord>, message: string, queueFacts = false) {
        request.current?.abort();
        contentRequest.current?.abort();
        const controller = new AbortController();
        mutation.current = controller;
        setBusy(true); setError(''); setNotice('');
        try {
            const saved = await operation(controller.signal);
            if (!alive.current || controller.signal.aborted) return;
            let queueNotice = '';
            if (queueFacts) {
                try {
                    await client.extractionRequest('/api/resume-extraction-requests', 'POST', JSON.stringify({
                        resumeId: saved.id, expectedResumeRevision: saved.revision, scope: 'resume'
                    }), controller.signal);
                    queueNotice = ' Fact extraction requested.';
                } catch (cause) {
                    queueNotice = ` Resume saved, but extraction could not be requested: ${cause instanceof Error ? cause.message : 'unknown error'}`;
                }
            }
            setEditor(openEditor(saved));
            setEditing(false);
            if (fileInput.current) fileInput.current.value = '';
            setNotice(message + queueNotice);
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
        if (!editor || busy || factsDirty || editor.latest || editor.missing) return;
        const { base, label, tagText, file } = editor;
        if (!label.trim()) { setError('Enter a resume label.'); return; }
        if (!base) {
            if (!file) { setError('Choose a PDF, DOCX, or TXT resume.'); return; }
            await mutate(signal => client.importResume({ label: label.trim(), tags: tags(tagText) }, file, signal), 'Resume imported.', extractByDefault);
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
                base.storageKind === 'managed' ? 'Resume file replaced.' : 'Resume adopted.', extractByDefault);
    }
    async function openContent() {
        const record = editor?.base;
        if (!record || record.storageKind !== 'managed' || contentBusy) return;
        const preview = record.mediaType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        const popup = preview ? window.open('about:blank', '_blank') : null;
        if (popup) popup.opener = null;
        contentRequest.current?.abort();
        const controller = new AbortController();
        contentRequest.current = controller;
        setContentBusy(true); setError('');
        try {
            const content = await client.resumeContent(record.id, controller.signal);
            const url = URL.createObjectURL(content);
            if (popup) popup.location.replace(url);
            else {
                const extension = record.mediaType === 'application/pdf' ? '.pdf'
                    : record.mediaType?.startsWith('text/plain') ? '.txt' : '.docx';
                const anchor = document.createElement('a');
                anchor.href = url; anchor.download = `resume-${record.id}${extension}`; anchor.hidden = true;
                document.body.append(anchor); anchor.click(); anchor.remove();
            }
            window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (cause) {
            popup?.close();
            if (!alive.current || controller.signal.aborted || contentRequest.current !== controller) return;
            setError(cause instanceof Error ? cause.message : 'Unable to open the managed resume.');
        } finally {
            if (contentRequest.current === controller) contentRequest.current = null;
            if (alive.current) setContentBusy(false);
        }
    }
    return <section className="resumes-workspace" aria-labelledby="resumes-workspace-title">
        <header className="workspace-hero"><div className="workspace-hero-copy"><p className="eyebrow">Your materials</p><h1 id="resumes-workspace-title">Resumes</h1><p>Manage the resume files available to your application agents.</p></div><div className="workspace-hero-actions">
            <button className="secondary" disabled={busy} onClick={() => void refresh()}>Refresh</button>
            {openExtractions&&<button className="secondary" disabled={busy} onClick={openExtractions}>Resume extraction</button>}
            <button className="primary" disabled={busy} onClick={() => open(null)}>Import resume</button>
        </div></header>
        <div className="workspace-panel resumes-panel" aria-labelledby="resume-library-heading">
            <div className="workspace-panel-heading"><div><p className="eyebrow">Your documents</p><h2 id="resume-library-heading">Saved resumes</h2></div></div>
            <p className="workspace-status" role="status">{loading ? 'Loading resumes…' : notice}</p>
            {!editor && error && <p role="alert" className="error">{error}</p>}
            <ul className="resume-list">
                {records.map(record => <li key={record.id}><button className="resume-card" disabled={busy} onClick={() => open(record)}>
                    <span className="resume-card-heading"><span className="resume-file-mark" aria-hidden="true">DOC</span><strong>{record.label}{record.default ? ' · Default' : ''}</strong>{record.default && <span className="status-pill resume-default" aria-hidden="true">Default</span>}</span>
                    <span className="resume-card-meta"><span>{record.mediaType ?? 'External file'}</span><span>{record.storageKind === 'managed' ? 'Managed locally' : 'External file'}</span>
                        <span>{factStatus[record.id] ?? 'No extracted facts'}</span></span>
                    <span className="resume-tags">{record.tags.length ? record.tags.map(tag => <small key={tag}>{tag}</small>) : <small>No tags</small>}</span>
                    <span className="resume-card-action">Open resume <span aria-hidden="true">→</span></span>
                    <span className="visually-hidden">revision {record.revision}</span>
                </button></li>)}
            </ul>
            {!loading && !error && !records.length && <div className="workspace-empty resume-empty"><span className="resume-empty-mark" aria-hidden="true">DOC</span><strong>No resumes saved yet.</strong></div>}
        </div>
        {editor && <DetailDrawer titleId="resume-editor-title" close={close} className="resume-detail-drawer">
            <header className="detail-drawer-header"><div><p className="eyebrow">Resume</p><h2 id="resume-editor-title" tabIndex={-1} data-drawer-heading>{editor.base ? editor.base.label : 'Import resume'}</h2></div>
                <div className="button-row"><button className="secondary" type="button" disabled={busy || loading} onClick={() => void refresh()}>Refresh resume</button>
                    <button className="job-drawer-close" type="button" disabled={busy} onClick={close} aria-label="Close resume details">×</button></div></header>
            {error && <p role="alert" className="error">{error}</p>}
            {editor.missing && <p className="notice" role="alert">This resume is no longer available. Your draft is preserved; saving is disabled.</p>}
            {editor.latest && <div className="notice resume-conflict" role="alert">
                <p>This resume changed elsewhere. Your draft is preserved.</p>
                <button disabled={busy} onClick={reapply}>Reapply my draft</button>{' '}
                <button disabled={busy} onClick={() => open(editor.latest)}>Use latest resume</button>
            </div>}
            {!editing && editor.base ? <>
                <div className="detail-drawer-summary"><dl>
                    <div><dt>File</dt><dd>{editor.base.mediaType ?? 'External file'}</dd></div>
                    <div><dt>Storage</dt><dd>{editor.base.storageKind === 'managed' ? 'Managed locally' : 'External file'}</dd></div>
                    <div><dt>Facts</dt><dd>{factStatus[editor.base.id] ?? 'No extracted facts'}</dd></div>
                    <div><dt>Tags</dt><dd>{editor.base.tags.join(', ') || 'None'}</dd></div>
                    <div><dt>Default</dt><dd>{editor.base.default ? 'Yes' : 'No'}</dd></div>
                </dl></div>
                <div className="detail-drawer-actions">
                    {editor.base.storageKind === 'managed' && <button className="secondary" disabled={busy || contentBusy} onClick={() => void openContent()}>
                        {editor.base.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? 'Download resume' : 'Preview resume'}</button>}
                    {!editor.base.default && <button className="secondary" disabled={busy || loading || factsDirty || Boolean(editor.latest) || editor.missing}
                        onClick={() => void mutate(signal => client.setDefaultResume(editor.base!.id, editor.base!.revision, signal), 'Default resume changed')}>Make default</button>}
                    <button className="primary" disabled={busy || editor.missing || Boolean(editor.latest)} onClick={() => setEditing(true)}>Edit resume</button>
                </div>
                {editor.base.storageKind === 'managed' && <ResumeFacts key={editor.base.id} client={client} resume={editor.base}
                    dirtyChanged={setFactsDirty} statusChanged={status => setFactStatus(current => ({ ...current, [editor.base!.id]: status }))} />}
            </> : <>
                <p className="resume-editor-intro">{editor.base ? 'Update the label and tags, or replace the file.' : 'Add a PDF, DOCX, or text resume.'}</p>
                <div className="resume-editor-fields"><label>Label<input value={editor.label} onChange={event => setEditor({ ...editor, label: event.target.value })} disabled={busy} /></label>
                    <label>Tags, separated by commas<input value={editor.tagText} onChange={event => setEditor({ ...editor, tagText: event.target.value })} disabled={busy} /></label>
                    <label className="resume-file-field">{editor.base?.storageKind === 'managed' ? 'Replacement file' : editor.base ? 'File to adopt' : 'Resume file'}
                        <input ref={fileInput} type="file" accept={accept} onChange={event => setEditor({ ...editor, file: event.target.files?.[0] ?? null })} disabled={busy} /></label></div>
                {(!editor.base || editor.file) && <label><input type="checkbox" checked={extractByDefault}
                    onChange={event => setExtractByDefault(event.target.checked)} disabled={busy} /> Request fact extraction after saving</label>}
                <div className="detail-drawer-actions">
                    {editor.base?.storageKind === 'managed' && <button className="secondary" disabled={busy || contentBusy} onClick={() => void openContent()}>
                        {editor.base.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? 'Download resume' : 'Preview resume'}</button>}
                    <button className="secondary" disabled={busy || contentBusy} onClick={cancelEdit}>Cancel</button>
                    <button className="primary" disabled={busy || loading || factsDirty || Boolean(editor.latest) || editor.missing || !dirty && Boolean(editor.base)} onClick={() => void save()}>Save resume</button></div>
            </>}
        </DetailDrawer>}
    </section>;
}
