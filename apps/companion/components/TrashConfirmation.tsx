'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { deletePhrase, referenceText, type TrashAction, type TrashItem } from './trash-model';
export function TrashConfirmation({ item, action, busy, confirm, cancel, opener }: {
    opener: HTMLElement | null; item: TrashItem; action: TrashAction; busy: boolean; confirm(): void; cancel(): void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const cancelButton = useRef<HTMLButtonElement>(null);
    const [phrase, setPhrase] = useState('');
    const title = useId();
    const description = useId();
    useEffect(() => {
        const node = dialog.current;
        node?.showModal();
        (action === 'delete' ? input.current : cancelButton.current)?.focus();
        return () => {
            node?.close();
            if (opener?.isConnected) opener.focus();
            else document.getElementById('trash-refresh')?.focus();
        };
    }, [action, opener]);
    return <dialog ref={dialog} className="trash-confirmation" aria-labelledby={title} aria-describedby={description}
        onCancel={event => { event.preventDefault(); if (!busy) cancel(); }}>
        <form onSubmit={event => { event.preventDefault(); if (!busy && (action === 'restore' || phrase === deletePhrase(item.type))) confirm(); }}>
            <h2 id={title}>{action === 'delete' ? 'Confirm permanent deletion' : 'Restore record?'}</h2>
            <p>{item.type}: {item.label}</p>
            <div id={description}>
                {action === 'delete' ? <p>This permanently deletes the selected canonical record{item.type === 'resume' ? ' and its managed resume file' : ''}.
                    It does not cascade or erase application history, sessions, or audit evidence.</p> :
                    <p>This returns the selected record to its library. The server will check its current revision and restore constraints.</p>}
                <p>{referenceText(item.blockerCounts)}. Reference counts are advisory; the server decides whether this action is allowed.</p>
            </div>
            {action === 'delete' && <label>Type <strong>{deletePhrase(item.type)}</strong> to continue
                <input ref={input} value={phrase} onChange={event => setPhrase(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
            </label>}
            <div className="trash-actions">
                <button ref={cancelButton} type="button" onClick={cancel} disabled={busy}>Cancel</button>
                <button type="submit" disabled={busy || (action === 'delete' && phrase !== deletePhrase(item.type))}>
                    {busy ? 'Saving…' : action === 'delete' ? 'Delete permanently' : 'Restore'}
                </button>
            </div>
        </form>
    </dialog>;
}
