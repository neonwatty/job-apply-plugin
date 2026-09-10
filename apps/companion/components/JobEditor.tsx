import { useEffect,useId,useRef } from 'react';
import type { ReactNode } from 'react';
import { textFields,type JobFields,type Resume } from './contracts';
import type { Editor } from './job-editor-state';
export function JobEditor({ editor,resumes,busy,error,change,close,save,reapply,load,refresh,children }: {
    children?: ReactNode;
    editor: Editor;
    resumes: Resume[];
    busy: boolean;
    error: string;
    change: (fields: Partial<JobFields>) => void;
    close: () => void;
    save: () => void;
    reapply: () => void;
    load: () => void;
    refresh: () => void;
}) {
    const titleId = useId();
    const dialog=useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const opener = document.activeElement;
        const modal = dialog.current;
        modal?.showModal();
        modal?.querySelector<HTMLInputElement>('[name="url"]')?.focus();
        return () => {
            modal?.close();
            queueMicrotask(() => {
                if (modal?.open) return;
                const destination = opener instanceof HTMLElement && opener.isConnected
                    ? opener : document.querySelector<HTMLElement>('[data-job-create]');
                if (destination
                    && (document.activeElement === document.body || modal?.contains(document.activeElement))) {
                    destination.focus();
                }
            });
        };
    },[]);
    return <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onCancel={event => {
            event.preventDefault();
            close();
        }}
        className="editor">
        <form onSubmit={event => {
            event.preventDefault();
            save();
        }}>

            <header>
                <div>
                    <p className="eyebrow">
                        {editor.selected? `Canonical · Revision ${editor.selected.revision}`:'New canonical record'}
                    </p>
                    <h2 id={titleId}>
                        {editor.selected? 'Edit job':'Capture a job'}
                    </h2>
                </div>
                <button
                    type="button"
                    onClick={close}
                    disabled={busy}
                    aria-label="Close job details">×
                </button>
            </header>


            <button type="button" disabled={busy} onClick={refresh}>Refresh latest values</button>
            {error&&<p role="alert" className="error">
                {error}
            </p>}


            {editor.missing && <section className="notice" role="alert">
                <h3>This job is no longer available</h3>
                <p>Your draft is preserved. Check Trash in the full workspace or copy your text before closing. Saving is disabled until this record is available again.</p>
            </section>}
            {editor.latest&&<section className="notice" role="alert">
                <h3>This job changed elsewhere
                </h3>
                <p>Your draft is preserved. Review the latest canonical values before saving.
                </p>
                <dl>
                    {[...textFields,'priority','resumeId'].map(key => <div key={key}>
                        <dt>
                            {key}
                        </dt>
                        <dd>
                            {String(editor.latest?.[key]??'—')}
                        </dd>
                    </div>)}
                </dl>
                <button
                    type="button"
                    disabled={busy}
                    onClick={load}>Load canonical values
                </button>

                <button
                    type="button"
                    disabled={busy}
                    onClick={reapply}>Reapply my draft
                </button>
            </section>}


            <fieldset disabled={busy}>
                <div className="form-grid">
                    {textFields.map(key => <label key={key}>
                        {key==='url'? 'Job URL':key.replace(/([A-Z])/g,' $1')}
                        {key==='notes'||key==='description'? <textarea
                            name={key}
                            value={editor.fields[key]}
                            onChange={e => change({
                                [key]: e.target.value
                            })} />:<input
                            name={key}
                            type={key==='url'? 'url':'text'}
                            required={key==='url'}
                            value={editor.fields[key]}
                            onChange={e => change({
                                [key]: e.target.value
                            })} />}
                    </label>)}


                    <label>Priority
                        <input
                            name="priority"
                            type="number"
                            min={0}
                            max={5}
                            value={editor.fields.priority}
                            onChange={e => change({
                                priority: Number(e.target.value)
                            })} />
                    </label>


                    <label>Resume
                        <select
                            name="resumeId"
                            value={editor.fields.resumeId??''}
                            onChange={e => change({
                                resumeId: e.target.value||null
                            })}>
                            <option value="">Use default resume
                            </option>
                            {resumes.map(resume => <option key={resume.id} value={resume.id}>
                                {resume.label}
                                {resume.default? ' · default':''}
                            </option>)}
                        </select>
                    </label>
                </div>
                <footer>
                    <button type="button" onClick={close}>Cancel
                    </button>
                    <button type="submit" className="primary" disabled={editor.missing || Boolean(editor.latest)}>
                        {busy? 'Saving…':'Save job'}
                    </button>
                </footer>
            </fieldset>


        </form>
        {children}
    </dialog>;
}
