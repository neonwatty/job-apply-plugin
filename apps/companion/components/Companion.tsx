'use client';
import { useCallback,useEffect,useState } from 'react';
import { createClient,sessionToken,type Client } from './client';
import type { Boot } from './contracts';
import { Overview } from './Overview';
import { Jobs } from './Jobs';
import './companion.css';
export default function Companion() {
    const [client,setClient]=useState<Client|null>(null);
    const [boot,setBoot]=useState<Boot|null>(null);
    const [error,setError]=useState('');
    const [token,setToken]=useState('');
    const [tab,setTab]=useState<'overview'|'jobs'>('overview');
    const [dirty,setDirty]=useState(false);
    const [attempt,setAttempt]=useState(0);
    useEffect(() => {
        let active=true;
        const controller=new AbortController();
        setError('');
        setBoot(null);
        const token=sessionToken();
        setToken(token);
        if(!token) {
            setError('Open the authenticated URL from your workspace launcher.');
            return;
        }
        const client=createClient(token);
        setClient(client);
        void client.boot(controller.signal).then(value => {
            if(active) {
                setBoot(value);
                if(value.status==='ready'&&value.mode==='native-jobs-fixture') setTab('jobs');
            }
        }).catch(error => {
            if(active)
                setError(error instanceof Error? error.message:'Unable to connect');
        });
        return () => {
            active=false;
            controller.abort();
        };
    },[attempt]);
    useEffect(() => {
        const before=(event: BeforeUnloadEvent) => {
            if(dirty) {
                event.preventDefault();
                event.returnValue='';
            }
        };
        window.addEventListener('beforeunload',before);
        return () => window.removeEventListener('beforeunload',before);
    },[dirty]);
    const dirtyChanged=useCallback((value: boolean) => setDirty(value),[]);
    function navigate(next: 'overview'|'jobs') {
        if(next===tab)
            return;
        if(dirty&&!confirm('Discard unsaved job changes?'))
            return;
        setDirty(false);
        setTab(next);
    }
    const legacyHref=`/legacy/#${new URLSearchParams({
        token
    }).toString()}`;
    const nativeFixture=boot?.status==='ready'&&boot.mode==='native-jobs-fixture';
    return <main className="companion">
        <div className="topbar">
            <div>
                <p className="eyebrow">Job Apply
                </p>
                <strong>Companion
                </strong>
            </div>
            <span role="status">
                {boot?.status==='ready'? 'Canonical store connected':boot?.status==='degraded'? 'Recovery needed':error?'Connection unavailable':'Connecting…'}
            </span>
        </div>
        <nav aria-label="Workspace sections">
            {!nativeFixture&&<button aria-current={tab==='overview'? 'page':undefined} onClick={() => navigate('overview')}>Overview
            </button>}
            <button aria-current={tab==='jobs'? 'page':undefined} onClick={() => navigate('jobs')}>Jobs
            </button>
            {token&&!nativeFixture&&<a href={legacyHref} onClick={event => {
                if(dirty&&!confirm('Discard unsaved job changes?'))
                    event.preventDefault();
            }}>Open full workspace
            </a>}
        </nav>
        <p className="trust">Your canonical data stays local. You direct changes and submissions; agents assist from the same record.
        </p>
        {nativeFixture&&<p role="status">Synthetic native Jobs workspace. Create and edit jobs here; other workflows are not available yet.</p>}
        {error&&<p role="alert" className="error">
            {error}{' '}
            {token&&<button onClick={() => setAttempt(value => value+1)}>Retry connection</button>}
        </p>}
        {boot?.status==='degraded'? <section role="alert">
            <h1>
                {boot.summary}
            </h1>
            <p>
                {boot.guidance}
            </p>
        </section>:boot?.status==='ready'&&client? (tab==='overview'? <Overview
            client={client}
            openJobs={() => navigate('jobs')}
            legacyHref={legacyHref} />:<Jobs client={client} dirtyChanged={dirtyChanged} />):!error&&<p>Loading workspace…
            </p>}
    </main>;
}
