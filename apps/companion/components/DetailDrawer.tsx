import { useEffect,useRef } from 'react';
import type { ReactNode } from 'react';

export function DetailDrawer({ titleId,close,children,className='' }: {
    titleId:string;
    close:()=>void;
    children:ReactNode;
    className?:string;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const opener = document.activeElement;
        const node = dialog.current;
        node?.showModal();
        node?.querySelector<HTMLElement>('[data-drawer-heading]')?.focus();
        return () => {
            node?.close();
            queueMicrotask(() => {
                if (node?.open) return;
                if (opener instanceof HTMLElement && opener.isConnected &&
                    (document.activeElement === document.body || node?.contains(document.activeElement))) opener.focus();
            });
        };
    }, []);
    return <dialog ref={dialog} aria-labelledby={titleId} className={`detail-drawer ${className}`}
        onCancel={event => { event.preventDefault(); close(); }}
        onClick={event => { if (event.target === dialog.current) close(); }}>
        {children}
    </dialog>;
}
