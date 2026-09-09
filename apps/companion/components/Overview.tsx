import { ownerBetaNextStep } from '../../../src/workspace-ui/lib/activity-view';
import { useEffect, useRef, useState } from 'react';
import type { Client } from './client';
import type { OverviewData } from './contracts';

export function Overview({ client, openJobs, legacyHref }: {
    client: Client;
    openJobs: () => void;
    legacyHref: string;
}) {
    const [data, setData] = useState<OverviewData | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
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
    const link = (workspace: string) => `${legacyHref}&workspace=${encodeURIComponent(workspace)}`;
    const guidance = ownerBetaNextStep(data?.nextAction ?? '');
    const heading = Array.isArray(guidance) && typeof guidance[0] === 'string'
        ? guidance[0] : 'Review the workspace';
    const countLabels: Record<string, string> = {
        jobs: 'Jobs', readyJobs: 'Ready jobs', attentionJobs: 'Need attention', resumes: 'Resumes', answers: 'Answers',
    };
    return <section>
        <header>
            <div><p className="eyebrow">Local application workspace</p><h1>Your next step</h1></div>
            <button onClick={() => void refresh()}>Refresh overview</button>
        </header>
        {loading && <p role="status">{data ? 'Refreshing overview…' : 'Loading overview…'}</p>}
        {error && <p role="alert" className="error">
            {data ? 'Showing the last loaded overview. ' : 'Overview could not be loaded. '}{error}{' '}
            <button onClick={() => void refresh()}>Retry overview</button>
        </p>}
        {data && <>
            <div className="hero">
                <h2>{heading}</h2>
                <p>Your canonical data stays local. You direct changes and submissions.</p>
                {target === 'jobs' ? <button className="primary" onClick={openJobs}>Open Jobs</button>
                    : <a className="button primary" href={link(destination)}>Open {destinations[destination]}</a>}
            </div>
            <section aria-labelledby="setup-heading">
                <h2 id="setup-heading">Application setup</h2>
                <ul className="setup-list">
                    <li><span>{data.setup.hasProfileFacts ? 'Profile facts added' : 'Add your profile facts'}</span>
                        <a href={link('facts')}>Edit Facts</a></li>
                    <li><span>{data.setup.hasResume ? 'Resume available' : 'Add a resume'}</span>
                        <a href={link('resumes')}>Manage Resumes</a></li>
                </ul>
            </section>
            <div className="counts">
                {Object.entries(data.counts).map(([name, count]) => <div key={name}>
                    <strong>{count}</strong><span>{countLabels[name]}</span>
                </div>)}
            </div>
        </>}
    </section>;
}
