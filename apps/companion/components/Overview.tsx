import { ownerBetaNextStep } from '../../../src/workspace-ui/lib/activity-view';
import { useEffect, useRef, useState } from 'react';
import type { Client } from './client';
import type { OverviewData } from './contracts';
import { readApplicationPreferences } from './application-preferences-model';

export function Overview({ client, openJobs, legacyHref, openWorkspace, refreshKey = 0 }: {
    client: Client;
    openJobs: () => void;
    legacyHref: string;
    openWorkspace?: (workspace: 'facts' | 'resumes' | 'attention' | 'answers' | 'automation' | 'settings' | 'trash') => void;
    refreshKey?: number;
}) {
    const [data, setData] = useState<OverviewData | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [applicationSetupComplete, setApplicationSetupComplete] = useState(false);
    const sequence = useRef(0);
    const previousRefreshKey = useRef(refreshKey);
    const pending = useRef<AbortController | null>(null);
    async function refresh() {
        pending.current?.abort();
        const controller = new AbortController();
        pending.current = controller;
        const request = ++sequence.current;
        setLoading(true);
        try {
            const [next,profile] = await Promise.all([client.overview(controller.signal),client.profile(controller.signal)]);
            if (request !== sequence.current) return;
            setData(next);
            setApplicationSetupComplete(readApplicationPreferences(profile.profile).complete);
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
    useEffect(() => {
        if (previousRefreshKey.current === refreshKey) return;
        previousRefreshKey.current = refreshKey;
        void refresh();
    }, [refreshKey]);
    const destinations: Record<string, string> = {
        facts: 'Facts', resumes: 'Resumes', attention: 'Needs Attention',
        answers: 'Answers', automation: 'Automation', settings: 'Settings', trash: 'Trash', overview: 'Overview',
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
        ? guidance[1] : 'Choose a section to get started.';
    const nativeDestinations = ['facts','resumes','attention','answers','automation','settings','trash'];
    const action = target === 'jobs' ? <button className="button primary" onClick={openJobs}>Open Jobs</button>
        : openWorkspace && nativeDestinations.includes(target)
            ? <button className="button primary" onClick={() => openWorkspace(target as 'facts'|'resumes'|'attention'|'answers'|'automation'|'settings'|'trash')}>Open {destinations[target]}</button>
            : <a className="button primary" href={link(destination)}>Open {destinations[destination]}</a>;
    return <div className="overview-workspace">
        <section className="overview-hero">
            <div><p className="eyebrow">Overview</p><h1>Your next move, at a glance.</h1></div>
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
                    <p className="eyebrow">Your setup</p><h2 id="setup-heading">Ready to apply?</h2>
                    <ul className="setup-checklist">
                        <li className={data.setup.hasResume?'complete':''}><span>{data.setup.hasResume?'✓':'○'} Resume {data.setup.hasResume?'available':'needed'}</span>
                            {openWorkspace?<button className="text-action" onClick={() => openWorkspace('resumes')}>Manage Resumes</button>:<a href={link('resumes')}>Manage Resumes</a>}</li>
                        <li className={data.setup.hasProfileFacts?'complete':''}><span>{data.setup.hasProfileFacts?'✓':'○'} Facts {data.setup.hasProfileFacts?'reviewed':'needed'}</span>
                            {openWorkspace?<button className="text-action" onClick={() => openWorkspace(factsDestination)}>{factsAction}</button>
                                :<a href={link(factsDestination)}>{factsAction}</a>}</li>
                        <li className={applicationSetupComplete?'complete':''}><span>{applicationSetupComplete?'✓':'○'} Application setup {applicationSetupComplete?'saved':'needed'}</span>
                            {openWorkspace?<button className="text-action" onClick={() => openWorkspace('settings')}>Edit Settings</button>
                                :<a href={link('settings')}>Edit Settings</a>}</li>
                    </ul>
                    {data.counts.attentionJobs > 0 && openWorkspace && <button className="text-action" onClick={() => openWorkspace('attention')}>Review {data.counts.attentionJobs} {data.counts.attentionJobs === 1 ? 'job' : 'jobs'} needing attention</button>}
                </article>
            </section>
        </>}
    </div>;
}
