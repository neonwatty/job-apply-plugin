import { useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';

const CODEX_INVOCATION = '$job-apply:job-apply';
const CLAUDE_INVOCATION = '/job-apply:job-apply';

export function Claims({ ready, loading, unavailable, headingRef }: {
    ready: boolean;
    loading: boolean;
    unavailable: boolean;
    headingRef: Ref<HTMLHeadingElement>;
}) {
    const [notice, setNotice] = useState('');
    const [fallback, setFallback] = useState('');
    const copyGeneration = useRef(0);
    const canCopy = ready && !loading && !unavailable;
    useEffect(() => () => { copyGeneration.current++; }, []);
    async function copy(value: string, label: string) {
        const version = ++copyGeneration.current;
        try {
            await navigator.clipboard.writeText(value);
            if (version !== copyGeneration.current) return;
            setFallback('');
            setNotice(`${label} invocation copied.`);
        } catch {
            if (version !== copyGeneration.current) return;
            setFallback(value);
            setNotice('Clipboard unavailable. Select and copy the invocation below.');
        }
    }
    return <section className="application-control workspace-panel" aria-label="Ready-job handoff">
        <div className="application-control-heading">
            <div><h2 ref={headingRef} tabIndex={-1}>Continue in Codex or Claude Code</h2>
                <p>Copy the command for your host, paste it in chat, then confirm which job to prepare. Job Apply checks the selected job again before starting.</p></div>
        </div>
        {loading && <p className="application-state" role="status">Checking saved jobs…</p>}
        {!loading && !canCopy && <p className="application-state" role="status">{unavailable
            ? 'Refresh Jobs to check which jobs are ready.'
            : 'No jobs are currently marked Ready for agent. Open a saved job to prepare it.'}</p>}
        <div className="application-invocations">
            <div className="invocation"><span>Codex</span><code>{CODEX_INVOCATION}</code><button className="button secondary" disabled={!canCopy} onClick={() => void copy(CODEX_INVOCATION, 'Codex')}>Copy Codex invocation</button></div>
            <div className="invocation"><span>Claude Code</span><code>{CLAUDE_INVOCATION}</code><button className="button secondary" disabled={!canCopy} onClick={() => void copy(CLAUDE_INVOCATION, 'Claude Code')}>Copy Claude invocation</button></div>
        </div>
        {canCopy && notice && <p role="status">{notice}</p>}
        {canCopy && fallback && <label className="clipboard-fallback">Invocation to copy<input readOnly value={fallback} onFocus={event => event.currentTarget.select()} /></label>}
    </section>;
}
