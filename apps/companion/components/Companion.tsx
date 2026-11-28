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
import { SubmissionLab } from './SubmissionLab';
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
import './mobile-workflows.css';
import { Trash } from './Trash';
import { createTrashClient } from './trash-client';
import { compatibilityTrashCapabilities, nativeTrashCapabilities } from './trash-model';
import { MoreWorkspace, WorkspaceNavigation, workspaceTabs, type WorkspaceTab } from './WorkspaceNavigation';

type WorkspaceRoute = {
    tab: WorkspaceTab;
    item?: string;
    revision?: string;
};
type WorkspaceEntry = {
    route: WorkspaceRoute;
    key: string;
    position: number;
    parent?: 'jobs' | 'attention';
};

const defaultRoute: WorkspaceRoute = { tab: 'overview' };

function readWorkspaceRoute(): WorkspaceRoute {
    const params = new URLSearchParams(window.location.search);
    const tab = workspaceTabs.find(candidate => candidate === params.get('view')) ?? 'overview';
    const item = params.get('job');
    return item && (tab === 'jobs' || tab === 'attention') ? { tab, item } : { tab };
}

function sameWorkspaceRoute(a: WorkspaceRoute, b: WorkspaceRoute) {
    return a.tab === b.tab && a.item === b.item;
}

function readWorkspaceEntry(): WorkspaceEntry | undefined {
    const saved: WorkspaceEntry | undefined = window.history.state?.companion;
    if (saved?.route && sameWorkspaceRoute(saved.route, readWorkspaceRoute())) return saved;
}

function newWorkspaceEntry(route: WorkspaceRoute, position: number, parent?: WorkspaceEntry['parent']): WorkspaceEntry {
    return { route, position, parent, key: crypto.randomUUID() };
}

function writeWorkspaceEntry(entry: WorkspaceEntry, replace: boolean) {
    const url = new URL(window.location.href);
    if (entry.route.tab === 'overview') url.searchParams.delete('view');
    else url.searchParams.set('view', entry.route.tab);
    if (entry.route.item) url.searchParams.set('job', entry.route.item);
    else url.searchParams.delete('job');
    const state = { ...window.history.state, companion: entry };
    if (replace) window.history.replaceState(state, '', url);
    else window.history.pushState(state, '', url);
}

// Keep screens for the session; only their saved data has a refresh interval.
// Jobs and attention can change through agent or CLI work while this tab is hidden.
const refreshAfter: Record<WorkspaceTab,number> = {
    overview:15_000,jobs:0,attention:0,trash:30_000,
    facts:60_000,resumes:60_000,extractions:60_000,answers:60_000,consents:60_000,
    accounts:60_000,automation:60_000,settings:120_000,submission:0,more:0
};
export default function Companion({ submissionLabEnabled = false }: { submissionLabEnabled?: boolean }) {
    const [client,setClient]=useState<Client|null>(null);
    const [boot,setBoot]=useState<Boot|null>(null);
    const [error,setError]=useState('');
    const [token,setToken]=useState('');
    const [entry,setEntry]=useState<WorkspaceEntry|null>(null);
    const route=entry?.route ?? defaultRoute;
    const { tab }=route;
    const [visitedTabs,setVisitedTabs]=useState<WorkspaceTab[]>(['overview']);
    const [refreshKeys,setRefreshKeys]=useState<Partial<Record<WorkspaceTab,number>>>({});
    const [showJobsHandoff,setShowJobsHandoff]=useState(false);
    const [sidebarPreference,setSidebarPreference]=useState<boolean|null>(null);
    const [portraitTablet,setPortraitTablet]=useState(false);
    const collapsed=sidebarPreference ?? portraitTablet;
    const [attempt,setAttempt]=useState(0);
    const [shellCounts,setShellCounts]=useState<{attention?:number;trash?:number}>({});
    const content=useRef<HTMLElement|null>(null);
    const focusAfterNavigation=useRef(false);
    const activeEntry=useRef<WorkspaceEntry|null>(null);
    const snapshots=useRef(new Map<string,{scroll:number; focus?:string}>());
    const restoreEntry=useRef(false);
    const acceptedBack=useRef(false);
    const jobsBusy=useRef(false);
    const updateJobsBusy=useCallback((busy:boolean)=>{jobsBusy.current=busy;},[]);
    const onBrowserHistory=useRef<()=>void>(()=>{});
    const activeTab=useRef<WorkspaceTab>('overview');
    const visited=useRef(new Set<WorkspaceTab>(['overview']));
    const scrollPositions=useRef(new Map<WorkspaceTab,number>());
    const mutationVersion=useRef(0);
    const lastChecked=useRef(new Map<WorkspaceTab,{at:number;version:number}>([['overview',{at:Date.now(),version:0}]]));
    const dirtyRef=useRef(false);
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
        page,(value:boolean)=>{if(activeTab.current===page)dirtyRef.current=value;}
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
            if(dirtyRef.current) {
                event.preventDefault();
                event.returnValue='';
            }
        };
        window.addEventListener('beforeunload',before);
        return () => window.removeEventListener('beforeunload',before);
    },[]);
    const trashCountChanged=useCallback((trash:number)=>setShellCounts(current=>current.trash===trash?current:{...current,trash}),[]);
    useEffect(()=>{
        const tablet=window.matchMedia('(min-width: 761px) and (max-width: 1024px) and (orientation: portrait)');
        const update=()=>setPortraitTablet(tablet.matches);
        update();
        tablet.addEventListener('change',update);
        return ()=>tablet.removeEventListener('change',update);
    },[]);
    useEffect(()=>{
        const initial=readWorkspaceEntry() ?? newWorkspaceEntry(readWorkspaceRoute(),0);
        writeWorkspaceEntry(initial,true);
        applyEntry(initial,false);
        const previousRestoration=history.scrollRestoration;
        history.scrollRestoration='manual';
        const pop=()=>onBrowserHistory.current();
        window.addEventListener('popstate',pop);
        return ()=>{
            window.removeEventListener('popstate',pop);
            history.scrollRestoration=previousRestoration;
        };
    },[]);
    useLayoutEffect(()=>{
        if(!entry)return;
        const viewport=restoreEntry.current ? snapshots.current.get(entry.key) : undefined;
        const focus=focusAfterNavigation.current;
        restoreEntry.current=false;
        focusAfterNavigation.current=false;
        if(viewport) window.scrollTo(0,viewport.scroll);
        else if(tab==='attention'&&route.item) window.scrollTo(0,0);
        else if(!route.item) window.scrollTo(0,scrollPositions.current.get(tab)??0);
        if(!focus || tab==='jobs'&&route.item)return;
        let observer: MutationObserver | undefined;
        const frame=requestAnimationFrame(()=>{
            const page=content.current?.querySelector('.workspace-page:not([hidden])');
            const detail=tab==='attention'&&route.item
                ? page?.querySelector<HTMLElement>('[data-workspace-focus="attention-detail"]')
                : undefined;
            const fallback=detail ?? content.current;
            const key=viewport?.focus;
            const target=key ? page?.querySelector<HTMLElement>(`[data-workspace-focus="${CSS.escape(key)}"]`) : detail;
            if(!target?.getClientRects().length){
                fallback?.focus({preventScroll:true});
                return;
            }
            if(!target.matches(':disabled')){
                target.focus({preventScroll:true});
                return;
            }
            // A queue refresh can briefly disable the action that opened the job.
            fallback?.focus({preventScroll:true});
            observer=new MutationObserver(()=>{
                if(!target.isConnected || document.activeElement!==fallback){
                    observer?.disconnect();
                }else if(!target.matches(':disabled')){
                    target.focus({preventScroll:true});
                    observer?.disconnect();
                }
            });
            observer.observe(target,{attributes:true,attributeFilter:['disabled']});
        });
        return ()=>{
            cancelAnimationFrame(frame);
            observer?.disconnect();
        };
    },[entry,tab,route.item]);
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
    function rememberViewport(focus?:string) {
        const current=activeEntry.current;
        if(!current)return;
        const scroll=window.scrollY;
        const active=document.activeElement instanceof HTMLElement ? document.activeElement.dataset.workspaceFocus : undefined;
        snapshots.current.set(current.key,{scroll,focus:focus??active});
        if(!current.route.item)scrollPositions.current.set(current.route.tab,scroll);
    }
    function applyEntry(next:WorkspaceEntry, focusMain=true, restore=false) {
        const previous=activeEntry.current?.route.tab;
        const nextTab=next.route.tab;
        if(previous!==nextTab) {
            // Discard accepted drafts and release native dialogs before caching the destination.
            const openModal=content.current?.querySelector('.workspace-page:not([hidden]) dialog:modal');
            if(previous && !activeEntry.current?.route.item && (dirtyRef.current || openModal)){
                visited.current.delete(previous);
                lastChecked.current.delete(previous);
            }
            if(visited.current.has(nextTab))refreshIfNeeded(nextTab);
            else {
                visited.current.add(nextTab);
                lastChecked.current.set(nextTab,{at:Date.now(),version:mutationVersion.current});
            }
            setVisitedTabs(current=>{
                const retained=current.filter(view=>visited.current.has(view));
                return retained.includes(nextTab)?retained:[...retained,nextTab];
            });
        }else if(nextTab==='attention'&&activeEntry.current?.route.item&&!next.route.item){
            refreshIfNeeded(nextTab);
        }
        if(nextTab!=='jobs'||next.route.item)setShowJobsHandoff(false);
        activeTab.current=nextTab;
        activeEntry.current=next;
        dirtyRef.current=false;
        focusAfterNavigation.current=focusMain;
        restoreEntry.current=restore;
        setEntry(next);
    }
    function canLeave() {
        return !jobsBusy.current && (!dirtyRef.current || confirm('Discard unsaved changes?'));
    }
    function navigateRoute(next:WorkspaceRoute, {focusMain=true,opener,replace=false}:{
        focusMain?:boolean; opener?:string; replace?:boolean;
    }={}) {
        const current=activeEntry.current;
        if(!current || acceptedBack.current)return false;
        if(sameWorkspaceRoute(current.route,next))return true;
        if(!canLeave())return false;
        rememberViewport(opener);
        const changingQueueSelection=next.tab==='attention'&&Boolean(next.item)
            &&current.route.tab==='attention'&&Boolean(current.route.item);
        const replaceEntry=replace||changingQueueSelection;
        const parent=next.item && (current.route.tab==='attention'||current.route.tab==='jobs')
            ? (changingQueueSelection ? current.parent : current.route.tab) : undefined;
        const nextEntry=newWorkspaceEntry(next,current.position+(replaceEntry?0:1),parent);
        writeWorkspaceEntry(nextEntry,replaceEntry);
        applyEntry(nextEntry,focusMain);
        return true;
    }
    function navigate(next:WorkspaceTab, focusMain=true) {
        return navigateRoute({tab:next},{focusMain});
    }
    function closeDetail(saved=false) {
        const current=activeEntry.current;
        if(!current?.route.item || acceptedBack.current || !saved && !canLeave())return;
        if(current.parent){
            acceptedBack.current=true;
            history.back();
        } else {
            const next=newWorkspaceEntry({tab:current.route.tab},current.position);
            writeWorkspaceEntry(next,true);
            applyEntry(next);
        }
    }
    onBrowserHistory.current=()=>{
        const current=activeEntry.current;
        if(!current)return;
        const target=readWorkspaceEntry();
        if(target?.key===current.key)return;
        const approved=acceptedBack.current;
        acceptedBack.current=false;
        if(!approved && !canLeave()){
            const distance=current.position-(target?.position??current.position);
            if(distance)history.go(distance);
            else writeWorkspaceEntry(current,true);
            return;
        }
        rememberViewport();
        const next=target ?? newWorkspaceEntry(readWorkspaceRoute(),0);
        if(!target)writeWorkspaceEntry(next,true);
        applyEntry(next,true,true);
    };
    const legacyHref=`/legacy/#${new URLSearchParams({
        token
    }).toString()}`;
    const nativeWorkspace=boot?.status==='ready'&&boot.mode!==undefined;
    useEffect(()=>{
        if (boot?.status!=='ready')return;
        if (tab==='submission'&&(!submissionLabEnabled||!nativeWorkspace)
            || !nativeWorkspace&&(['attention','accounts','automation','answers','consents','settings'] as WorkspaceTab[]).includes(tab)) {
            navigateRoute(defaultRoute,{replace:true});
        }
    },[boot,tab,submissionLabEnabled,nativeWorkspace]);
    const trashCapabilities=nativeWorkspace?nativeTrashCapabilities:compatibilityTrashCapabilities;
    const trashClient=useMemo(() => createTrashClient(token,trashCapabilities),[token,trashCapabilities]);
    const refreshShellCounts=useCallback(async() => {
        if(!client||!nativeWorkspace)return;
        try {
            const overview=await client.overview();
            setShellCounts(current=>current.attention===overview.counts.attentionJobs?current:{...current,attention:overview.counts.attentionJobs});
        } catch { /* A failed summary read must not replace the last known counts. */ }
    },[client,nativeWorkspace]);
    const navProps={
        tab,navigate,ready:entry!==null,nativeWorkspace,submissionLabEnabled,counts:shellCounts,legacyHref,
        showLegacy:Boolean(token&&!nativeWorkspace),confirmLegacy:canLeave,
    };
    const requestedJob=useMemo(()=>tab==='jobs'&&route.item
        ? {id:route.item,revision:route.revision ? BigInt(route.revision) : 0n}
        : null,[tab,route.item,route.revision]);
    function renderPage(view: WorkspaceTab) {
        if(!client)return null;
        const markDirty=dirtyChangedByTab[view];
        switch(view) {
            case 'trash': return <Trash client={trashClient} capabilities={trashCapabilities} dirtyChanged={markDirty}
                refreshKey={refreshKeys[view]??0} onMutation={() => { markStoreChanged(); return refreshShellCounts(); }} countChanged={trashCountChanged}/>;
            case 'automation': return <Automation client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}/>;
            case 'accounts': return <Automation mode="accounts" client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}/>;
            case 'overview': return <Overview client={client} openJobs={() => navigate('jobs')}
                openAgentHandoff={nativeWorkspace ? () => {
                    if (navigate('jobs', false)) setShowJobsHandoff(true);
                } : undefined}
                openWorkspace={nativeWorkspace ? navigate : undefined} legacyHref={legacyHref} refreshKey={refreshKeys[view]??0}/>;
            case 'attention': return nativeWorkspace && <NeedsAttention client={client} refreshKey={refreshKeys[view]??0}
                selectedId={tab==='attention'?route.item:undefined} back={()=>closeDetail()}
                select={id=>navigateRoute({tab:'attention',item:id},{opener:`attention:${id}`,focusMain:window.matchMedia('(max-width: 760px)').matches})}
                openJob={job=>navigateRoute({tab:'jobs',item:job.id,revision:String(job.revision)},
                    {opener:`attention-action:${job.id}`})}/>;
            case 'facts': return <Facts client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}/>;
            case 'resumes': return <Resumes client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}
                openExtractions={()=>navigate('extractions')}/>;
            case 'extractions': return <Extractions client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}
                openResumes={()=>navigate('resumes')}/>;
            case 'answers':
            case 'consents': return <Answers client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}
                consentOnly={view==='consents'}/>;
            case 'settings': return <ApplicationSettings client={client} dirtyChanged={markDirty} refreshKey={refreshKeys[view]??0}/>;
            case 'submission': return nativeWorkspace && submissionLabEnabled && <SubmissionLab token={token}/>;
            case 'more': return <MoreWorkspace {...navProps}/>;
            case 'jobs': return <Jobs client={client} dirtyChanged={markDirty} active={view===tab} claimsEnabled={nativeWorkspace} showHandoff={view===tab && showJobsHandoff}
                refreshKey={refreshKeys[view]??0} requestedJob={requestedJob} backLabel={entry?.parent==='attention'?'Back to Needs Attention':'Back to Jobs'}
                openJob={id=>navigateRoute({tab:'jobs',item:id},{opener:`job:${id}`})}
                prepareNewJob={()=>navigateRoute({tab:'jobs'},{replace:true,focusMain:false})} closeJob={closeDetail}
                navigationBusyChanged={updateJobsBusy} openAnswers={() => navigate('answers')} workspaceChanged={refreshShellCounts}/>;
        }
    }
    useEffect(()=>{void refreshShellCounts();},[refreshShellCounts,tab]);
    useEffect(()=>{document.title=`${tab==='attention'?'Needs Attention':tab==='extractions'?'Resume extraction':tab==='submission'?'Submission lab':tab[0]!.toUpperCase()+tab.slice(1)} · Job Apply Workspace`;},[tab]);
    const connection=boot?.status==='ready'? 'Local data connected':boot?.status==='degraded'? 'Recovery needed':error?'Connection unavailable':'Connecting…';
    return <div className="focus-shell" data-collapsed={collapsed}>
        <a className="skip-link" href="#workspace-content" onClick={event=>{
            event.preventDefault();
            content.current?.focus();
        }}>Skip to workspace</a>
        <WorkspaceNavigation {...navProps} collapsed={collapsed} toggleSidebar={()=>setSidebarPreference(!collapsed)}
            connection={connection} online={boot?.status==='ready'}/>
        <main id="workspace-content" className="companion" ref={content} tabIndex={-1}>
        {nativeWorkspace&&(shellCounts.attention!==undefined||shellCounts.trash!==undefined)&&<p id="workspace-counts" className="visually-hidden" role="status" aria-live="polite">{shellCounts.attention!==undefined&&`${shellCounts.attention} jobs need attention.`} {shellCounts.trash!==undefined&&`${shellCounts.trash} ${shellCounts.trash===1?'record is':'records are'} in Trash.`}</p>}
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
