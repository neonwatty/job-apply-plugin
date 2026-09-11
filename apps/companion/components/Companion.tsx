'use client';
import { useCallback,useEffect,useMemo,useState } from 'react';
import { createClient,sessionToken,type Client } from './client';
import type { Boot } from './contracts';
import { Overview } from './Overview';
import { Facts } from './Facts';
import { Jobs } from './Jobs';
import { Resumes } from './Resumes';
import { Answers } from './Answers';
import { Extractions } from './Extractions';
import { NeedsAttention } from './NeedsAttention';
import './companion.css';
import './trash.css';
import { Trash } from './Trash';
import { createTrashClient } from './trash-client';
import { compatibilityTrashCapabilities, nativeTrashCapabilities } from './trash-model';
type WorkspaceTab = 'overview'|'jobs'|'facts'|'resumes'|'answers'|'extractions'|'attention'|'trash';
export default function Companion() {
    const [client,setClient]=useState<Client|null>(null);
    const [boot,setBoot]=useState<Boot|null>(null);
    const [error,setError]=useState('');
    const [token,setToken]=useState('');
    const [tab,setTab]=useState<WorkspaceTab>('overview');
    const [requestedJob,setRequestedJob]=useState<string|null>(null);
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
    const jobOpened=useCallback(() => setRequestedJob(null),[]);
    function navigate(next: WorkspaceTab) {
        if(next===tab)
            return;
        if(dirty&&!confirm('Discard unsaved changes?'))
            return;
        setDirty(false);
        setTab(next);
    }
    const legacyHref=`/legacy/#${new URLSearchParams({
        token
    }).toString()}`;
    const nativeFixture=boot?.status==='ready'&&boot.mode==='native-jobs-fixture';
    const trashCapabilities=nativeFixture?nativeTrashCapabilities:compatibilityTrashCapabilities;
    const trashClient=useMemo(() => createTrashClient(token,trashCapabilities),[token,trashCapabilities]);
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
            <button aria-current={tab==='overview'? 'page':undefined} onClick={() => navigate('overview')}>Overview
            </button>
            {nativeFixture&&<button aria-current={tab==='attention'?'page':undefined} onClick={() => navigate('attention')}>Needs Attention</button>}
            <button aria-current={tab==='jobs'? 'page':undefined} onClick={() => navigate('jobs')}>Jobs
            </button>
            <button aria-current={tab==='facts'?'page':undefined} onClick={()=>navigate('facts')}>Facts</button>
            <button aria-current={tab==='resumes'?'page':undefined} onClick={()=>navigate('resumes')}>Resumes</button>
            {nativeFixture&&<button aria-current={tab==='extractions'?'page':undefined} onClick={()=>navigate('extractions')}>Resume extraction</button>}
            {nativeFixture&&<button aria-current={tab==='answers'?'page':undefined} onClick={()=>navigate('answers')}>Answers</button>}
            {token&&!nativeFixture&&<a href={legacyHref} onClick={event => {
                if(dirty&&!confirm('Discard unsaved changes?'))
                    event.preventDefault();
            }}>Open full workspace
            </a>}
            <button aria-current={tab==='trash'?'page':undefined} onClick={() => navigate('trash')}>Trash</button>
        </nav>
        <p className="trust">Your canonical data stays local. You direct changes and submissions; agents assist from the same record.
        </p>
        {nativeFixture&&<p role="status">Synthetic native workspace. Manage jobs, facts, resumes, extraction reviews and remembered answers; review your next step, attention items and application activity.</p>}
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
        </section>:boot?.status==='ready'&&client? (tab==='trash'?<Trash client={trashClient} capabilities={trashCapabilities} dirtyChanged={dirtyChanged}/>:tab==='overview'? <Overview
            client={client}
            openJobs={() => navigate('jobs')}
            openWorkspace={nativeFixture ? navigate : undefined}
            legacyHref={legacyHref} />:tab==='attention'?<NeedsAttention client={client} openJob={id => { setRequestedJob(id); navigate('jobs'); }}/>:tab==='facts'?<Facts client={client} dirtyChanged={dirtyChanged}/>:tab==='resumes'?<Resumes client={client} dirtyChanged={dirtyChanged}/>:tab==='extractions'?<Extractions client={client} dirtyChanged={dirtyChanged}/>:tab==='answers'?<Answers client={client} dirtyChanged={dirtyChanged}/>:<Jobs client={client} dirtyChanged={dirtyChanged} claimsEnabled={nativeFixture} requestedJobId={requestedJob} jobOpened={jobOpened} openAnswers={() => navigate('answers')} />):!error&&<p>Loading workspace…
            </p>}
    </main>;
}
