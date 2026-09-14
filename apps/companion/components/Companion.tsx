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
import { Automation } from './Automation';
import './companion.css';
import './automation.css';
import './trash.css';
import { Trash } from './Trash';
import { createTrashClient } from './trash-client';
import { compatibilityTrashCapabilities, nativeTrashCapabilities } from './trash-model';
type WorkspaceTab = 'overview'|'jobs'|'facts'|'resumes'|'answers'|'extractions'|'attention'|'automation'|'trash';
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
    const connection=boot?.status==='ready'? 'Canonical store connected':boot?.status==='degraded'? 'Recovery needed':error?'Connection unavailable':'Connecting…';
    const navButton=(workspace:WorkspaceTab,label:string) => <button className="nav-link" aria-current={tab===workspace?'page':undefined} onClick={() => navigate(workspace)}>{label}</button>;
    return <>
        <a className="skip-link" href="#workspace-content">Skip to workspace</a>
        <header className="topbar">
            <div className="product-context">
                <p className="eyebrow">Local companion</p>
                <h1>Job Apply</h1>
                <p id="workspace-trust-context" className="trust-context">Your canonical data stays local. You direct changes and submissions; agents assist from the same record.</p>
            </div>
            <div className={`connection ${boot?.status==='ready'?'online':''}`} role="status">
                <span className="connection-dot" aria-hidden="true" />
                <span>{connection}</span>
            </div>
            <p id="workspace-nav-overflow-hint" className="nav-overflow-hint">Scroll horizontally to explore all navigation groups <span aria-hidden="true">→</span></p>
            <nav className="workspace-nav" aria-label="Workspace sections" aria-describedby="workspace-trust-context workspace-nav-overflow-hint">
                <div className="nav-group" role="group" aria-labelledby="nav-group-pipeline">
                    <span id="nav-group-pipeline" className="nav-group-label">Pipeline</span>
                    <div className="nav-group-links">
                        {navButton('overview','Overview')}
                        {navButton('jobs','Jobs')}
                        {nativeFixture&&navButton('attention','Needs Attention')}
                    </div>
                </div>
                <div className="nav-group" role="group" aria-labelledby="nav-group-data">
                    <span id="nav-group-data" className="nav-group-label">Application data</span>
                    <div className="nav-group-links">
                        {navButton('facts','Facts')}
                        {navButton('resumes','Resumes')}
                        {nativeFixture&&navButton('answers','Answers')}
                        {nativeFixture&&navButton('extractions','Resume extraction')}
                    </div>
                </div>
                <div className="nav-group" role="group" aria-labelledby="nav-group-controls">
                    <span id="nav-group-controls" className="nav-group-label">Controls</span>
                    <div className="nav-group-links">
                        {token&&!nativeFixture&&<a className="nav-link" href={legacyHref} onClick={event => {
                            if(dirty&&!confirm('Discard unsaved changes?')) event.preventDefault();
                        }}>Open full workspace</a>}
                        {nativeFixture&&navButton('automation','Automation')}
                        {navButton('trash','Trash')}
                    </div>
                </div>
            </nav>
        </header>
        <main id="workspace-content" className="companion">
        {nativeFixture&&<p className="fixture-notice" role="status">Synthetic native workspace · Jobs, facts, resumes, extraction reviews, remembered answers, and application activity use isolated canonical data.</p>}
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
        </section>:boot?.status==='ready'&&client? (tab==='trash'?<Trash client={trashClient} capabilities={trashCapabilities} dirtyChanged={dirtyChanged}/>:tab==='automation'?<Automation client={client} dirtyChanged={dirtyChanged}/>:tab==='overview'? <Overview
            client={client}
            openJobs={() => navigate('jobs')}
            openWorkspace={nativeFixture ? navigate : undefined}
            legacyHref={legacyHref} />:tab==='attention'?<NeedsAttention client={client} openJob={id => { setRequestedJob(id); navigate('jobs'); }}/>:tab==='facts'?<Facts client={client} dirtyChanged={dirtyChanged}/>:tab==='resumes'?<Resumes client={client} dirtyChanged={dirtyChanged}/>:tab==='extractions'?<Extractions client={client} dirtyChanged={dirtyChanged}/>:tab==='answers'?<Answers client={client} dirtyChanged={dirtyChanged}/>:<Jobs client={client} dirtyChanged={dirtyChanged} claimsEnabled={nativeFixture} requestedJobId={requestedJob} jobOpened={jobOpened} openAnswers={() => navigate('answers')} />):!error&&<p>Loading workspace…
            </p>}
        </main>
    </>;
}
