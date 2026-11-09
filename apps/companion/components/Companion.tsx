'use client';
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from 'react';
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
import './title-discovery.css';
import './companion-polish.css';
import './companion-theme.css';
import './companion-interactions.css';
import './focus-queue.css';
import './focus-sidebar.css';
import { Trash } from './Trash';
import { createTrashClient } from './trash-client';
import { compatibilityTrashCapabilities, nativeTrashCapabilities } from './trash-model';
type WorkspaceTab = 'overview'|'jobs'|'facts'|'resumes'|'answers'|'consents'|'extractions'|'attention'|'accounts'|'automation'|'settings'|'trash';
const workspaceTabs: WorkspaceTab[] = ['overview','jobs','facts','resumes','answers','consents','extractions','attention','accounts','automation','settings','trash'];
// Keep screens for the session; only their saved data has a refresh interval.
// Jobs and attention can change through agent or CLI work while this tab is hidden.
const refreshAfter: Record<WorkspaceTab,number> = {
    overview:15_000,jobs:0,attention:0,trash:30_000,
    facts:60_000,resumes:60_000,extractions:60_000,answers:60_000,consents:60_000,
    accounts:60_000,automation:60_000,settings:120_000
};
const paths: Record<string,string> = {
  attention:'M4 5h16v14H4z M8 9h8 M8 13h5',
  jobs:'M4 7h16v13H4z M9 7V4h6v3 M4 12h16 M10 12v3h4v-3',
  overview:'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  facts:'M7 4h10v16H7z M10 8h4 M10 12h4 M10 16h2',
  resumes:'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
  answers:'M4 4h16v12H9l-5 4z M8 8h8 M8 12h5',
  automation:'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M6 6l2 2 M16 16l2 2 M6 18l2-2 M16 8l2-2 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  accounts:'M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0 M4 21v-3a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v3',
  consents:'M12 3l8 3v6c0 5-8 9-8 9S4 17 4 12V6z M8 12l3 3 5-6',
  settings:'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  trash:'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
  external:'M14 3h7v7 M21 3l-9 9 M10 5H4v15h15v-6',
  collapse:'M4 4h16v16H4z M9 4v16 M16 9l-3 3 3 3',
};
function SidebarIcon({name}:{name:string}) {
  return <svg className="sidebar-icon" width="20" height="20" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name] ?? paths.overview}/>
  </svg>;
}

export default function Companion() {
    const [client,setClient]=useState<Client|null>(null);
    const [boot,setBoot]=useState<Boot|null>(null);
    const [error,setError]=useState('');
    const [token,setToken]=useState('');
    const [tab,setTab]=useState<WorkspaceTab>('overview');
    const [visitedTabs,setVisitedTabs]=useState<WorkspaceTab[]>(['overview']);
    const [refreshKeys,setRefreshKeys]=useState<Partial<Record<WorkspaceTab,number>>>({});
    const [requestedJob,setRequestedJob]=useState<string|null>(null);
    const [dirty,setDirty]=useState(false);
    const [collapsed,setCollapsed]=useState(false);
    const [attempt,setAttempt]=useState(0);
    const [shellCounts,setShellCounts]=useState<{attention?:number;trash?:number}>({});
    const content=useRef<HTMLElement|null>(null);
    const focusAfterNavigation=useRef(false);
    const activeTab=useRef<WorkspaceTab>('overview');
    const visited=useRef(new Set<WorkspaceTab>(['overview']));
    const scrollPositions=useRef(new Map<WorkspaceTab,number>());
    const mutationVersion=useRef(0);
    const lastChecked=useRef(new Map<WorkspaceTab,{at:number;version:number}>([['overview',{at:Date.now(),version:0}]]));
    const dirtyRef=useRef(false);
    dirtyRef.current=dirty;
    const markStoreChanged=useCallback(() => {
        const version=++mutationVersion.current;
        lastChecked.current.set(activeTab.current,{at:Date.now(),version});
    },[]);
    const refreshIfNeeded=useCallback((view:WorkspaceTab) => {
        if(!visited.current.has(view))return;
        const now=Date.now(), prior=lastChecked.current.get(view);
        if(prior?.version===mutationVersion.current&&now-prior.at<refreshAfter[view])return;
        lastChecked.current.set(view,{at:now,version:mutationVersion.current});
        setRefreshKeys(current=>({...current,[view]:(current[view]??0)+1}));
    },[]);
    const dirtyChangedByTab=useMemo(() => Object.fromEntries(workspaceTabs.map(page=>[
        page,(value:boolean)=>{if(activeTab.current===page)setDirty(value);}
    ])) as Record<WorkspaceTab,(value:boolean)=>void>,[]);
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
        const client=createClient(token,markStoreChanged);
        setClient(client);
        void client.boot(controller.signal).then(value => {
            if(active) {
                setBoot(value);
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
    const jobOpened=useCallback(() => setRequestedJob(null),[]);
    const trashCountChanged=useCallback((trash:number)=>setShellCounts(current=>current.trash===trash?current:{...current,trash}),[]);
    useEffect(()=>{
        if(!focusAfterNavigation.current)return;
        focusAfterNavigation.current=false;
        requestAnimationFrame(()=>content.current?.focus({preventScroll:true}));
    },[tab]);
    useLayoutEffect(()=>{window.scrollTo(0,scrollPositions.current.get(tab)??0);},[tab]);
    useEffect(()=>{
        const check=()=>{if(document.visibilityState==='visible'&&!dirtyRef.current)refreshIfNeeded(activeTab.current);};
        window.addEventListener('focus',check);
        window.addEventListener('online',check);
        document.addEventListener('visibilitychange',check);
        return ()=>{
            window.removeEventListener('focus',check);
            window.removeEventListener('online',check);
            document.removeEventListener('visibilitychange',check);
        };
    },[refreshIfNeeded]);
    function navigate(next: WorkspaceTab): boolean {
        if(next===tab)return true;
        if(dirty&&!confirm('Discard unsaved changes?'))
            return false;
        scrollPositions.current.set(tab,window.scrollY);
        if(dirty){visited.current.delete(tab);lastChecked.current.delete(tab);}
        if(visited.current.has(next))refreshIfNeeded(next);
        else {
            visited.current.add(next);
            lastChecked.current.set(next,{at:Date.now(),version:mutationVersion.current});
        }
        setVisitedTabs(current=>{
            const retained=dirty?current.filter(view=>view!==tab):current;
            return retained.includes(next)?retained:[...retained,next];
        });
        activeTab.current=next;
        setDirty(false);
        focusAfterNavigation.current=true;
        setTab(next);
        return true;
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
    function renderPage(view: WorkspaceTab) {
        if(!client)return null;
        const markDirty=dirtyChangedByTab[view];
        switch(view) {
            case 'trash': return <Trash client={trashClient} capabilities={trashCapabilities} dirtyChanged={markDirty}
                refreshKey={refreshKeys[view]??0} onMutation={() => { markStoreChanged(); return refreshShellCounts(); }} countChanged={trashCountChanged}/>;
            case 'automation': return <Automation client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}/>;
            case 'accounts': return <Automation mode="accounts" client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}/>;
            case 'overview': return <Overview client={client} openJobs={() => navigate('jobs')}
                openWorkspace={nativeWorkspace ? navigate : undefined} legacyHref={legacyHref} refreshKey={refreshKeys[view]??0}/>;
            case 'attention': return <NeedsAttention client={client} refreshKey={refreshKeys[view]??0}
                openJob={id => { if(navigate('jobs'))setRequestedJob(id); }}/>;
            case 'facts': return <Facts client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}/>;
            case 'resumes': return <Resumes client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}
                openExtractions={()=>navigate('extractions')}/>;
            case 'extractions': return <Extractions client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}
                openResumes={()=>navigate('resumes')}/>;
            case 'answers':
            case 'consents': return <Answers client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}
                consentOnly={view==='consents'}/>;
            case 'settings': return <ApplicationSettings client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}/>;
            case 'jobs': return <Jobs client={client} dirtyChanged={markDirty} active={view===tab} claimsEnabled={nativeWorkspace}
                refreshKey={refreshKeys[view]??0} requestedJobId={view===tab?requestedJob:null} jobOpened={jobOpened} openAnswers={() => navigate('answers')}
                workspaceChanged={refreshShellCounts}/>;
        }
    }
    useEffect(()=>{void refreshShellCounts();},[refreshShellCounts,tab]);
    useEffect(()=>{document.title=`${tab==='attention'?'Needs Attention':tab==='extractions'?'Resume extraction':tab[0]!.toUpperCase()+tab.slice(1)} · Job Apply Workspace`;},[tab]);
    const connection=boot?.status==='ready'? 'Local data connected':boot?.status==='degraded'? 'Recovery needed':error?'Connection unavailable':'Connecting…';
    const navButton=(workspace:WorkspaceTab,label:string,count?:number,active=tab===workspace) => <button className="nav-link" aria-label={label} aria-current={active?'page':undefined} title={collapsed?label:undefined} onClick={() => navigate(workspace)}><SidebarIcon name={workspace}/><span className="nav-label">{label}</span>{count!==undefined&&<span className="nav-count" aria-hidden="true">{count}</span>}</button>;
    return <div className="focus-shell" data-collapsed={collapsed}>
        <a className="skip-link" href="#workspace-content">Skip to workspace</a>
        <header className="topbar">
            <button className="sidebar-toggle" type="button" aria-expanded={!collapsed} aria-controls="workspace-navigation"
                aria-label={collapsed?'Expand sidebar':'Collapse sidebar'} title={collapsed?'Expand sidebar':'Collapse sidebar'}
                onClick={()=>setCollapsed(value=>!value)}><SidebarIcon name="collapse"/><span>{collapsed?'Expand':'Collapse'}</span></button>
            <div className="product-context">
                <p className="eyebrow">Focus Queue</p>
                <h1>Job Apply</h1>
                <p id="workspace-trust-context" className="trust-context">Your data stays local. Only you submit applications.</p>
            </div>
            <div className={`connection ${boot?.status==='ready'?'online':''}`} role="status" aria-label={connection}>
                <span className="connection-dot" aria-hidden="true" />
                <span>{connection}</span>
            </div>

            <nav id="workspace-navigation" className="workspace-nav" aria-label="Workspace sections" aria-describedby="workspace-trust-context">
                <div className="nav-group" role="group" aria-labelledby="nav-group-pipeline">
                    <span id="nav-group-pipeline" className="nav-group-label">Pipeline</span>
                    <div className="nav-group-links">
                        {nativeWorkspace&&navButton('attention','Needs Attention',shellCounts?.attention)}
                        {navButton('jobs','Jobs')}
                        {navButton('overview','Overview')}
                    </div>
                </div>
                <div className="nav-group" role="group" aria-labelledby="nav-group-data">
                    <span id="nav-group-data" className="nav-group-label">Application data</span>
                    <div className="nav-group-links">
                        {navButton('facts','Facts')}
                        {navButton('resumes','Resumes',undefined,tab==='resumes'||tab==='extractions')}
                        {nativeWorkspace&&navButton('answers','Answers')}
                        {nativeWorkspace&&navButton('consents','Consent defaults')}
                    </div>
                </div>
                <div className="nav-group" role="group" aria-labelledby="nav-group-controls">
                    <span id="nav-group-controls" className="nav-group-label">Controls</span>
                    <div className="nav-group-links">
                        {token&&!nativeWorkspace&&<a className="nav-link" aria-label="Open full workspace" title={collapsed?'Open full workspace':undefined} href={legacyHref} onClick={event => {
                            if(dirty&&!confirm('Discard unsaved changes?')) event.preventDefault();
                        }}><SidebarIcon name="external"/><span className="nav-label">Open full workspace</span></a>}
                        {nativeWorkspace&&navButton('automation','Automation')}
                        {nativeWorkspace&&navButton('accounts','Accounts & Sign-in')}
                        {nativeWorkspace&&navButton('settings','Settings')}
                        {navButton('trash','Trash',nativeWorkspace?shellCounts?.trash:undefined)}
                    </div>
                </div>
            </nav>
        </header>
        <main id="workspace-content" className="companion" ref={content} tabIndex={-1}>
        {nativeWorkspace&&(shellCounts.attention!==undefined||shellCounts.trash!==undefined)&&<p className="visually-hidden" role="status" aria-live="polite">{shellCounts.attention!==undefined&&`${shellCounts.attention} jobs need attention.`} {shellCounts.trash!==undefined&&`${shellCounts.trash} ${shellCounts.trash===1?'record is':'records are'} in Trash.`}</p>}
        {nativeWorkspace&&<p className="fixture-notice" role="status">{boot?.status==='ready'&&boot.mode==='native-store-clone'?'Local Job Apply Store · Changes you make here are saved locally.':'Synthetic native workspace · Sample data only.'}</p>}
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
        </section>:boot?.status==='ready'&&client? visitedTabs.map(view=><div className="workspace-page" key={view}
            hidden={view!==tab} inert={view!==tab} aria-hidden={view!==tab}>{renderPage(view)}</div>):!error&&<p>Loading workspace…
            </p>}
        </main>
    </div>;
}
