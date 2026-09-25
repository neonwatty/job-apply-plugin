import { useState } from 'react';
import type { Job } from './contracts';

const CODEX_INVOCATION = '$job-apply:job-apply';
const CLAUDE_INVOCATION = '/job-apply:job-apply';

export function Claims({ jobs }: { jobs: Job[] }) {
    const [notice, setNotice] = useState('');
    const [fallback, setFallback] = useState('');
    const ready = jobs.filter(job => job.status === 'ready').length;
    async function copy(value: string, label: string) {
        try {
            await navigator.clipboard.writeText(value);
            setFallback('');
            setNotice(`${label} invocation copied.`);
        } catch {
            setFallback(value);
            setNotice('Clipboard unavailable. Select and copy the invocation below.');
        }
    }
    return <section className="application-control workspace-panel" aria-label="Ready-job handoff">
        <div className="application-control-heading">
            <div><p className="eyebrow">Application agent</p><h2>Hand off a Ready job</h2>
                <p>{ready ? `${ready} ${ready === 1 ? 'job is' : 'jobs are'} ready for an agent.` : 'Prepare a job before handing it to an agent.'}</p></div>
        </div>
        <p className="application-guidance">Copy the invocation for the host you already use. The agent—not this browser—acquires the job and stops before final submission.</p>
        <div className="application-invocations">
            <div className="invocation"><span>Codex</span><code>{CODEX_INVOCATION}</code><button className="button secondary" disabled={!ready} onClick={() => void copy(CODEX_INVOCATION, 'Codex')}>Copy Codex invocation</button></div>
            <div className="invocation"><span>Claude Code</span><code>{CLAUDE_INVOCATION}</code><button className="button secondary" disabled={!ready} onClick={() => void copy(CLAUDE_INVOCATION, 'Claude Code')}>Copy Claude invocation</button></div>
        </div>
        {notice && <p role="status">{notice}</p>}
        {fallback && <label className="clipboard-fallback">Invocation to copy<input readOnly value={fallback} onFocus={event => event.currentTarget.select()} /></label>}
    </section>;
}
