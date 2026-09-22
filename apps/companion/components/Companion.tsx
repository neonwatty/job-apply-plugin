'use client';
import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
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
import { ApplicationSettings } from './ApplicationSettings';
import './companion.css';
import './automation.css';
import './trash.css';
import './resume-facts.css';
import { Trash } from './Trash';
import { createTrashClient } from './trash-client';
import { compatibilityTrashCapabilities, nativeTrashCapabilities } from './trash-model';
type WorkspaceTab = 'overview'|'jobs'|'facts'|'resumes'|'answers'|'extractions'|'attention'|'automation'|'settings'|'trash';
export default function Companion() {
    const [client,setClient]=useState<Client|null>(null);
    const [boot,setBoot]=useState<Boot|null>(null);
    const [error,setError]=useState('');
    const [token,setToken]=useState('');
    const [tab,setTab]=useState<WorkspaceTab>('overview');
    const [requestedJob,setRequestedJob]=useState<string|null>(null);
    const [dirty,setDirty]=useState(false);
    const [attempt,setAttempt]=useState(0);
    const [shellCounts,setShellCounts]=useState<{attention?:number;trash?:number}>({});
    const content=useRef<HTMLElement|null>(null);
    const focusAfterNavigation=useRef(false);
    const ownerSelectedWorkspace=useRef(false);
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
                if(value.status==='ready'&&value.mode!==undefined&&!ownerSelectedWorkspace.current) setTab('jobs');
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
    const trashCountChanged=useCallback((trash:number)=>setShellCounts(current=>current.trash===trash?current:{...current,trash}),[]);
    useEffect(()=>{
        if(!focusAfterNavigation.current)return;
        focusAfterNavigation.current=false;
        requestAnimationFrame(()=>content.current?.focus({preventScroll:true}));
    },[tab]);
    function navigate(next: WorkspaceTab) {
        if(next===tab)
            return;
        if(dirty&&!confirm('Discard unsaved changes?'))
            return;
        setDirty(false);
        ownerSelectedWorkspace.current=true;
        focusAfterNavigation.current=true;
        setTab(next);
    }
    const legacyHref=`/legacy/#${new URLSearchParams({
        token
    }).toString()}`;
    const nativeWorkspace=boot?.status==='ready'&&boot.mode!==undefined;
    const trashCapabilities=nativeWorkspace?nativeTrashCapabilities:compatibilityTrashCapabilities;
    const trashClient=useMemo(() => createTrashClient(token,trashCapabilities),[token,trashCapabilities]);
    const refreshShellCounts=useCallback(async() => {
        if(!client||!nativeWorkspace)return;
        try {
            const overview=await client.overview();
            setShellCounts(current=>current.attention===overview.counts.attentionJobs?current:{...current,attention:overview.counts.attentionJobs});
        } catch { /* A failed summary read must not replace the last known counts. */ }
    },[client,nativeWorkspace]);
    useEffect(()=>{void refreshShellCounts();},[refreshShellCounts,tab]);
    useEffect(()=>{document.title=`${tab==='attention'?'Needs Attention':tab==='extractions'?'Resume extraction':tab[0]!.toUpperCase()+tab.slice(1)} · Job Apply Workspace`;},[tab]);
    const connection=boot?.status==='ready'? 'Canonical store connected':boot?.status==='degraded'? 'Recovery needed':error?'Connection unavailable':'Connecting…';
    const navButton=(workspace:WorkspaceTab,label:string,count?:number,active=tab===workspace) => <button className="nav-link" aria-label={label} aria-current={active?'page':undefined} onClick={() => navigate(workspace)}>{label}{count!==undefined&&<span className="nav-count" aria-hidden="true">{count}</span>}</button>;
    return <>
        <a className="skip-link" href="#workspace-content">Skip to workspace</a>
        <header className="topbar">
            <div className="topbar-inner">
                <button className="brand-home" aria-label="Open overview" onClick={() => navigate('overview')}>J</button>
                <p id="workspace-nav-overflow-hint" className="visually-hidden">Workspace navigation scrolls horizontally on narrow screens.</p>
                <nav className="workspace-nav" aria-label="Workspace sections" aria-describedby="workspace-nav-overflow-hint">
                    <div className="nav-group" role="group" aria-labelledby="nav-group-pipeline">
                        <span id="nav-group-pipeline" className="visually-hidden">Pipeline</span>
                        <div className="nav-group-links">
                            {navButton('overview','Overview')}
                            {navButton('jobs','Jobs')}
                            {nativeWorkspace&&navButton('attention','Needs Attention',shellCounts?.attention)}
                        </div>
                    </div>
                    <div className="nav-group" role="group" aria-labelledby="nav-group-data">
                        <span id="nav-group-data" className="visually-hidden">Application data</span>
                        <div className="nav-group-links">
                            {navButton('facts','Facts')}
                            {navButton('resumes','Resumes',undefined,tab==='resumes'||tab==='extractions')}
                            {nativeWorkspace&&navButton('answers','Answers')}
                        </div>
                    </div>
                    <div className="nav-group" role="group" aria-labelledby="nav-group-controls">
                        <span id="nav-group-controls" className="visually-hidden">Controls</span>
                        <div className="nav-group-links">
                            {token&&!nativeWorkspace&&<a className="nav-link" href={legacyHref} onClick={event => {
                                if(dirty&&!confirm('Discard unsaved changes?')) event.preventDefault();
                            }}>Open full workspace</a>}
                            {nativeWorkspace&&navButton('automation','Automation')}
                            {nativeWorkspace&&navButton('settings','Settings')}
                            {navButton('trash','Trash',nativeWorkspace?shellCounts?.trash:undefined)}
                        </div>
                    </div>
                </nav>
                <div className={`connection ${boot?.status==='ready'?'online':''}`} role="status" aria-label={connection}>
                    <span className="connection-dot" aria-hidden="true" />
                    <span className="connection-label">{connection}</span>
                </div>
            </div>
        </header>
        <main id="workspace-content" className="companion" ref={content} tabIndex={-1}>
        {nativeWorkspace&&(shellCounts.attention!==undefined||shellCounts.trash!==undefined)&&<p className="visually-hidden" role="status" aria-live="polite">{shellCounts.attention!==undefined&&`${shellCounts.attention} jobs need attention.`} {shellCounts.trash!==undefined&&`${shellCounts.trash} ${shellCounts.trash===1?'record is':'records are'} in Trash.`}</p>}
        {nativeWorkspace&&<p className="fixture-notice" role="status">{boot?.status==='ready'&&boot.mode==='native-store-clone'?'Native migration clone · Changes use an isolated copy of canonical data.':'Synthetic native workspace · Jobs, facts, resumes, extraction reviews, remembered answers, and application activity use isolated canonical data.'}</p>}
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
        </section>:boot?.status==='ready'&&client? (tab==='trash'?<Trash client={trashClient} capabilities={trashCapabilities} dirtyChanged={dirtyChanged} onMutation={refreshShellCounts} countChanged={trashCountChanged}/>:tab==='automation'?<Automation client={client} dirtyChanged={dirtyChanged}/>:tab==='overview'? <Overview
            client={client}
            openJobs={() => navigate('jobs')}
            openWorkspace={nativeWorkspace ? navigate : undefined}
            legacyHref={legacyHref} />:tab==='attention'?<NeedsAttention client={client} openJob={id => { setRequestedJob(id); navigate('jobs'); }}/>:tab==='facts'?<Facts client={client} dirtyChanged={dirtyChanged}/>:tab==='resumes'?<Resumes client={client} dirtyChanged={dirtyChanged} openExtractions={()=>navigate('extractions')}/>:tab==='extractions'?<Extractions client={client} dirtyChanged={dirtyChanged} openResumes={()=>navigate('resumes')}/>:tab==='answers'?<Answers client={client} dirtyChanged={dirtyChanged}/>:tab==='settings'?<ApplicationSettings client={client} dirtyChanged={dirtyChanged}/>:<Jobs client={client} dirtyChanged={dirtyChanged} claimsEnabled={nativeWorkspace} requestedJobId={requestedJob} jobOpened={jobOpened} openAnswers={() => navigate('answers')} workspaceChanged={refreshShellCounts} />):!error&&<p>Loading workspace…
            </p>}
        </main>
    </>;
}
