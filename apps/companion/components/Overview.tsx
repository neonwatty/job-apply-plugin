import { ownerBetaNextStep } from '../../../src/workspace-ui/lib/activity-view';
import { useEffect, useRef, useState } from 'react';
import type { Client } from './client';
import type { OverviewData } from './contracts';

export function Overview({ client, openJobs, legacyHref, openWorkspace }: {
    client: Client;
    openJobs: () => void;
    legacyHref: string;
    openWorkspace?: (workspace: 'facts' | 'resumes' | 'attention' | 'answers' | 'automation' | 'trash') => void;
}) {
    const [data, setData] = useState<OverviewData | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [copyNotice, setCopyNotice] = useState('');
    const [fallback, setFallback] = useState('');
    const sequence = useRef(0);
    const pending = useRef<AbortController | null>(null);
    async function refresh() {
        pending.current?.abort();
        const controller = new AbortController();
        pending.current = controller;
        const request = ++sequence.current;
        setLoading(true);
        try {
            const next = await client.overview(controller.signal);
            if (request !== sequence.current) return;
            setData(next);
            setError('');
        } catch (error) {
            if (request === sequence.current && !controller.signal.aborted) {
                setError(error instanceof Error ? error.message : 'Overview unavailable');
            }
        } finally {
            if (request === sequence.current) setLoading(false);
        }
    }
    useEffect(() => {
        void refresh();
        return () => { sequence.current++; pending.current?.abort(); };
    }, [client]);
    const destinations: Record<string, string> = {
        facts: 'Facts', resumes: 'Resumes', attention: 'Needs Attention',
        answers: 'Answers', automation: 'Automation', trash: 'Trash', overview: 'Overview',
    };
    const target = data?.targetWorkspace ?? 'overview';
    const destination = Object.hasOwn(destinations, target) ? target : 'overview';
    const factsDestination = data?.setup.factsWorkspace ?? 'facts';
    const factsAction = factsDestination === 'resumes' ? 'Review resume facts' : 'Edit Facts';
    const link = (workspace: string) => `${legacyHref}&workspace=${encodeURIComponent(workspace)}`;
    const guidance = ownerBetaNextStep(data?.nextAction ?? '');
    const heading = Array.isArray(guidance) && typeof guidance[0] === 'string'
        ? guidance[0] : 'Review the workspace';
    const guidanceCopy = Array.isArray(guidance) && typeof guidance[1] === 'string'
        ? guidance[1] : 'Refresh the canonical Store and choose a workspace section.';
    const nativeDestinations = ['facts','resumes','attention','answers','automation','trash'];
    async function copyInvocation(value:string,label:string) {
        try {
            await navigator.clipboard.writeText(value);
            setFallback('');
            setCopyNotice(`${label} invocation copied.`);
        } catch {
            setFallback(value);
            setCopyNotice('Clipboard unavailable. Select and copy the invocation below.');
        }
    }
    const action = target === 'jobs' ? <button className="button primary" onClick={openJobs}>Open Jobs</button>
        : openWorkspace && nativeDestinations.includes(target)
            ? <button className="button primary" onClick={() => openWorkspace(target as 'facts'|'resumes'|'attention'|'answers'|'automation'|'trash')}>Open {destinations[target]}</button>
            : <a className="button primary" href={link(destination)}>Open {destinations[destination]}</a>;
    return <div className="overview-workspace">
        <section className="overview-hero">
            <div><p className="eyebrow">Private owner workspace</p><h1>Know what to do next.</h1><p>Your setup and next step come from the canonical local Store. This workspace never submits an application.</p></div>
            <button className="button secondary" aria-label="Refresh overview" onClick={() => void refresh()}>Refresh</button>
        </section>
        {loading && <p role="status">{data ? 'Refreshing overview…' : 'Loading overview…'}</p>}
        {error && <p role="alert" className="error">
            {data ? 'Showing the last loaded overview. ' : 'Overview could not be loaded. '}{error}{' '}
            <button onClick={() => void refresh()}>Retry overview</button>
        </p>}
        {data && <>
            <section className="overview-grid" aria-label="Workspace overview">
                <article className="next-step-card">
                    <p className="eyebrow">Next step</p><h2>{heading}</h2><p>{guidanceCopy}</p>{action}
                </article>
                <article className="setup-card" aria-labelledby="setup-heading">
                    <p className="eyebrow">Setup</p><h2 id="setup-heading">Local foundation</h2>
                    <ul className="setup-checklist">
                        <li className={data.setup.hasResume?'complete':''}><span>{data.setup.hasResume?'✓':'○'} Resume {data.setup.hasResume?'available':'needed'}</span>
                            {openWorkspace?<button className="text-action" onClick={() => openWorkspace('resumes')}>Manage Resumes</button>:<a href={link('resumes')}>Manage Resumes</a>}</li>
                        <li className={data.setup.hasProfileFacts?'complete':''}><span>{data.setup.hasProfileFacts?'✓':'○'} Facts {data.setup.hasProfileFacts?'reviewed':'needed'}</span>
                            {openWorkspace?<button className="text-action" onClick={() => openWorkspace(factsDestination)}>{factsAction}</button>
                                :<a href={link(factsDestination)}>{factsAction}</a>}</li>
                    </ul>
                    <p className="overview-counts">{data.counts.jobs} jobs · {data.counts.readyJobs} ready · {data.counts.attentionJobs} need attention</p>
                </article>
                <article className="handoff-card">
                    <p className="eyebrow">Ready-job handoff</p><h2>Start an application agent</h2>
                    <p>When a job is Ready, copy one supported invocation. The workspace does not run commands or submit.</p>
                    <div className="invocation"><span>Codex</span><code>$job-apply:job-apply</code><button className="button secondary" onClick={() => void copyInvocation('$job-apply:job-apply','Codex')}>Copy Codex invocation</button></div>
                    <div className="invocation"><span>Claude Code</span><code>/job-apply:job-apply</code><button className="button secondary" onClick={() => void copyInvocation('/job-apply:job-apply','Claude Code')}>Copy Claude invocation</button></div>
                    {copyNotice&&<p className="copy-notice" role="status">{copyNotice}</p>}
                    {fallback&&<label className="clipboard-fallback">Invocation to copy<input readOnly value={fallback} onFocus={event => event.currentTarget.select()} /></label>}
                    <p className="safety-note">The agent stops for final review. Only you may submit on the third-party site.</p>
                </article>
                <article className="recovery-card">
                    <p className="eyebrow">Restart &amp; recovery</p><h2>Canonical state survives this browser</h2>
                    <p>Restart the launcher to reconnect. Conflicts preserve your draft; interrupted attempts appear in Needs Attention; Trash restores individual records.</p>
                    {openWorkspace&&<div className="button-row"><button className="button secondary" onClick={() => openWorkspace('attention')}>Review attention queue</button><button className="button secondary" onClick={() => openWorkspace('trash')}>Open Trash</button></div>}
                </article>
            </section>
        </>}
    </div>;
}
