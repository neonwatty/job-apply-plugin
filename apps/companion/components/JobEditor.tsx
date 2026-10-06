import { useEffect,useId,useRef,useState } from 'react';
import type { ReactNode } from 'react';
import { object,textFields,type JobFields,type Resume } from './contracts';
import type { Editor } from './job-editor-state';

export function JobEditor({ editor,resumes,busy,error,change,close,reset,save,reapply,load,refresh,children }: {
    children?: ReactNode;
    editor: Editor;
    resumes: Resume[];
    busy: boolean;
    error: string;
    change: (fields: Partial<JobFields>) => void;
    close: () => void;
    reset: () => void;
    save: () => void;
    reapply: () => void;
    load: () => void;
    refresh: () => void;
}) {
    const titleId = useId();
    const dialog = useRef<HTMLDialogElement>(null);
    const heading = useRef<HTMLHeadingElement>(null);
    const [editing,setEditing] = useState(!editor.selected);
    useEffect(() => {
        const opener = document.activeElement;
        const modal = dialog.current;
        modal?.showModal();
        if (editor.selected) heading.current?.focus();
        else modal?.querySelector<HTMLInputElement>('[name="url"]')?.focus();
        return () => {
            modal?.close();
            queueMicrotask(() => {
                if (modal?.open) return;
                const destination = opener instanceof HTMLElement && opener.isConnected
                    ? opener : document.querySelector<HTMLElement>('[data-job-create]');
                if (destination && (document.activeElement === document.body || modal?.contains(document.activeElement))) {
                    destination.focus();
                }
            });
        };
    }, []);
    function cancelEdit() {
        if (!editor.selected) { close(); return; }
        if (editor.dirty.size && !confirm('Discard unsaved job changes?')) return;
        reset();
        setEditing(false);
        heading.current?.focus();
    }
    const selection = object(editor.selected?.inputSelection) ? editor.selected.inputSelection : null;
    const selectedResume = selection && resumes.find(item => item.id === selection.resumeId);
    const postingUrl = /^https?:\/\//i.test(editor.fields.url) ? editor.fields.url : null;
    const title = editing ? editor.selected ? 'Edit job' : 'New job'
        : String(editor.selected?.role || editor.selected?.company || 'Job details');
    return <dialog ref={dialog} aria-labelledby={titleId} className="editor job-drawer"
        onCancel={event => { event.preventDefault(); close(); }}
        onClick={event => { if (event.target === dialog.current) close(); }}>
        <header className="job-drawer-header">
            <div><p className="eyebrow">{editor.selected ? 'Saved job' : 'New job'}</p>
                <h2 ref={heading} tabIndex={-1} id={titleId}>{title}</h2></div>
            <button className="job-drawer-close" type="button" onClick={close} disabled={busy} aria-label="Close job details">×</button>
        </header>
        {error && <p role="alert" className="error">{error}</p>}
        {editor.missing && <section className="notice" role="alert">
            <h3>This job is no longer available</h3>
            <p>Your draft is preserved. Saving is disabled until this record is available again.</p>
        </section>}
        {editor.latest && <section className="notice" role="alert">
            <h3>This job changed elsewhere</h3>
            <p>{editor.dirty.size ? 'Your draft is preserved. Review the latest values before saving.' : 'Load the latest values to continue.'}</p>
            {editing && editor.dirty.size > 0 && <dl>{[...textFields,'priority','resumeId'].map(key =>
                <div key={key}><dt>{key}</dt><dd>{String(editor.latest?.[key] ?? '—')}</dd></div>)}</dl>}
            <div className="button-row"><button type="button" disabled={busy} onClick={load}>Load latest values</button>
                {editing && editor.dirty.size > 0 && <button type="button" disabled={busy} onClick={reapply}>Reapply my draft</button>}</div>
        </section>}
        {selection && <p className="notice">{String(selection.jobRevision) === String(editor.selected?.revision)
            ? 'Application inputs confirmed' : 'Application inputs need reconfirmation'} · {selectedResume?.label ?? String(selection.resumeId)}</p>}
        {!editing && editor.selected ? <>
            <div className="job-drawer-summary">
                <span className={`status-pill status-${editor.selected.status}`}>{editor.selected.status.replaceAll('_',' ')}</span>
                <dl>
                    <div><dt>Company</dt><dd>{editor.fields.company || 'Not set'}</dd></div>
                    <div><dt>Location</dt><dd>{editor.fields.location || editor.fields.workplaceType || 'Not set'}</dd></div>
                    {editor.fields.employmentType && <div><dt>Type</dt><dd>{editor.fields.employmentType}</dd></div>}
                    {editor.fields.compensation && <div><dt>Compensation</dt><dd>{editor.fields.compensation}</dd></div>}
                    <div><dt>Priority</dt><dd>{editor.fields.priority ? `${editor.fields.priority} of 5` : 'Not set'}</dd></div>
                    {editor.fields.resumeId && <div><dt>Resume</dt><dd>{resumes.find(item => item.id === editor.fields.resumeId)?.label ?? editor.fields.resumeId}</dd></div>}
                </dl>
                {postingUrl && <a className="job-posting-link" href={postingUrl} target="_blank" rel="noopener noreferrer">Open job posting ↗</a>}
                {editor.fields.notes && <section><h3>Notes</h3><p>{editor.fields.notes}</p></section>}
                {editor.fields.description && <details><summary>Description</summary><p>{editor.fields.description}</p></details>}
            </div>
            <div className="job-drawer-actions"><button type="button" disabled={busy} onClick={refresh}>Refresh latest values</button>
                <button className="primary" type="button" disabled={busy || editor.missing || Boolean(editor.latest)}
                    onClick={() => { setEditing(true); requestAnimationFrame(() => dialog.current?.querySelector<HTMLInputElement>('[name="url"]')?.focus()); }}>Edit job</button></div>
            {children && <div className="job-drawer-secondary">{children}</div>}
        </> : <form className="job-drawer-form" onSubmit={event => { event.preventDefault(); save(); }}>
            {editor.selected && <button type="button" disabled={busy} onClick={refresh}>Refresh latest values</button>}
            <fieldset disabled={busy}>
                <div className="form-grid">
                    {textFields.map(key => <label key={key}>
                        {key === 'url' ? 'Job URL' : key.replace(/([A-Z])/g,' $1')}
                        {key === 'notes' || key === 'description' ? <textarea name={key} value={editor.fields[key]}
                            onChange={event => change({ [key]: event.target.value })} />
                            : <input name={key} type={key === 'url' ? 'url' : 'text'} required={key === 'url'}
                                value={editor.fields[key]} onChange={event => change({ [key]: event.target.value })} />}
                    </label>)}
                    <label>Priority<input name="priority" type="number" min={0} max={5} value={editor.fields.priority}
                        onChange={event => change({ priority: Number(event.target.value) })} /></label>
                    <label>Resume<select name="resumeId" value={editor.fields.resumeId ?? ''}
                        onChange={event => change({ resumeId: event.target.value || null })}>
                        <option value="">Use default resume</option>
                        {resumes.map(resume => <option key={resume.id} value={resume.id}>{resume.label}{resume.default ? ' · default' : ''}</option>)}
                    </select></label>
                </div>
                <footer className="job-drawer-actions"><button type="button" onClick={cancelEdit}>{editor.selected ? 'Cancel editing' : 'Cancel'}</button>
                    <button type="submit" className="primary" disabled={editor.missing || Boolean(editor.latest)}>{busy ? 'Saving…' : 'Save job'}</button></footer>
            </fieldset>
        </form>}
    </dialog>;
}
