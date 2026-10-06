'use client';
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from 'react';
import { createPortal } from 'react-dom';
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
import './companion-nav.css';
import './companion-theme.css';
import './companion-interactions.css';
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
type Menu = 'materials'|'more';
type Props = {
  tab: WorkspaceTab;
  navigate: (next: WorkspaceTab) => boolean;
  nativeWorkspace: boolean;
  attentionCount?: number;
  token: string;
  legacyHref: string;
  dirty: boolean;
};

function CompanionNav({ tab, navigate, nativeWorkspace, attentionCount, token, legacyHref, dirty }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<Menu|null>(null);
  const [activeRect, setActiveRect] = useState<{ x:number;y:number;width:number;height:number }|null>(null);
  const [indicatorReady, setIndicatorReady] = useState(false);
  const nav = useRef<HTMLElement|null>(null);
  const mobileToggle = useRef<HTMLButtonElement|null>(null);
  const materialsToggle = useRef<HTMLButtonElement|null>(null);
  const moreToggle = useRef<HTMLButtonElement|null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const container = nav.current;
      const active = container?.querySelector<HTMLElement>('[data-nav-active="true"]');
      if (!container || !active) return;
      const bounds = container.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      setActiveRect({ x:item.left-bounds.left+container.scrollLeft, y:item.top-bounds.top,
        width:item.width, height:item.height });
    };
    measure();
    const frame = requestAnimationFrame(() => setIndicatorReady(true));
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(frame);window.removeEventListener('resize', measure); };
  }, [tab, nativeWorkspace, attentionCount]);

  useEffect(() => {
    setMobileOpen(false);
    setOpenMenu(null);
  }, [tab]);
  useEffect(() => {
    if (!mobileOpen) return;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    nav.current?.querySelector<HTMLElement>('.nav-link')?.focus();
    const media = window.matchMedia('(max-width: 1020px)');
    const onResize = () => { if (!media.matches) setMobileOpen(false); };
    media.addEventListener('change', onResize);
    return () => {
      document.body.style.overflow = priorOverflow;
      media.removeEventListener('change', onResize);
    };
  }, [mobileOpen]);
  useEffect(() => {
    if (!mobileOpen && !openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as Element).closest?.('.mobile-nav-backdrop')) return;
      if (!nav.current?.contains(event.target as Node) && !mobileToggle.current?.contains(event.target as Node)) {
        if (mobileOpen) mobileToggle.current?.focus();
        setMobileOpen(false);
        setOpenMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && mobileOpen && nav.current) {
        const links = [...nav.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')]
          .filter(link => link.getClientRects().length > 0);
        if (links.length) {
          const first = links[0]!, last = links[links.length - 1]!;
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
        return;
      }
      if (event.key !== 'Escape') return;
      if (openMenu) {
        (openMenu === 'materials' ? materialsToggle : moreToggle).current?.focus();
        setOpenMenu(null);
      } else if (mobileOpen) {
        mobileToggle.current?.focus();
        setMobileOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [mobileOpen, openMenu]);

  const go = (next: WorkspaceTab) => {
    const changed = navigate(next);
    setOpenMenu(null);
    setMobileOpen(false);
    if (!changed && mobileOpen) mobileToggle.current?.focus();
  };
  const link = (target: WorkspaceTab, label: string, active = tab === target, count?: number) =>
    <button className="nav-link" type="button" aria-label={label} aria-current={active ? 'page' : undefined}
      data-nav-active={active && ['overview','jobs','attention'].includes(target) ? 'true' : undefined}
      onClick={() => go(target)}>{label}{count !== undefined && count > 0 && <span className="nav-count" aria-hidden="true">{count}</span>}</button>;
  const menu = (id: Menu, label: string, active: boolean, toggle: typeof materialsToggle, items: React.ReactNode) =>
    <div className="nav-menu">
      <button ref={toggle} className="nav-link nav-menu-toggle" type="button"
        data-active={active || undefined} data-nav-active={active ? 'true' : undefined}
        aria-expanded={openMenu === id} aria-controls={`${id}-nav-menu`}
        onClick={() => setOpenMenu(current => current === id ? null : id)}>{label}<span className="nav-chevron" aria-hidden="true" /></button>
      <div id={`${id}-nav-menu`} className="nav-popover" hidden={openMenu !== id}>{items}</div>
    </div>;
  const materialsActive = ['facts', 'resumes', 'extractions', 'answers', 'consents'].includes(tab);
  const moreActive = ['automation', 'accounts', 'settings', 'trash'].includes(tab);

  return <>
    {mobileOpen && createPortal(<button className="mobile-nav-backdrop" type="button" tabIndex={-1}
      aria-label="Close workspace menu" onClick={() => { setMobileOpen(false); mobileToggle.current?.focus(); }} />, document.body)}
    <button ref={mobileToggle} className="mobile-nav-toggle" type="button" aria-expanded={mobileOpen}
      aria-controls="workspace-navigation" onClick={() => { setMobileOpen(value => !value); setOpenMenu(null); }}>
      <span className="mobile-nav-icon" aria-hidden="true" />Menu
    </button>
    <nav ref={nav} id="workspace-navigation" className={`workspace-nav${mobileOpen ? ' is-open' : ''}`}
      aria-label="Workspace sections">
      {activeRect && <span className="nav-active-indicator" data-ready={indicatorReady || undefined}
        style={{width:activeRect.width,height:activeRect.height,transform:`translate3d(${activeRect.x}px,${activeRect.y}px,0)`}}
        aria-hidden="true" />}
      {link('overview', 'Overview')}
      {link('jobs', 'Jobs')}
      {nativeWorkspace && link('attention', 'Needs Attention', tab === 'attention', attentionCount)}
      {menu('materials', 'Materials', materialsActive, materialsToggle, <>
        {link('facts', 'Facts')}
        {link('resumes', 'Resumes', tab === 'resumes' || tab === 'extractions')}
        {nativeWorkspace && link('answers', 'Answers')}
        {nativeWorkspace && link('consents', 'Consent defaults')}
      </>)}
      {menu('more', 'More', moreActive, moreToggle, <>
        {token && !nativeWorkspace && <a className="nav-link" href={legacyHref} onClick={event => {
          if (dirty && !confirm('Discard unsaved changes?')) event.preventDefault();
        }}>Open full workspace</a>}
        {nativeWorkspace && link('automation', 'Automation')}
        {nativeWorkspace && link('accounts', 'Accounts & Sign-in')}
        {nativeWorkspace && link('settings', 'Settings')}
        {link('trash', 'Trash')}
      </>)}
    </nav>
  </>;
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
    const connection=boot?.status==='ready'? 'Canonical store connected':boot?.status==='degraded'? 'Recovery needed':error?'Connection unavailable':'Connecting…';
    return <>
        <a className="skip-link" href="#workspace-content">Skip to workspace</a>
        <header className="topbar">
            <div className="topbar-inner">
                <button className="brand-home" aria-label="Open overview" onClick={() => navigate('overview')}><span className="brand-mark" aria-hidden="true">J</span><span className="brand-name" aria-hidden="true">Job Apply<span>Companion</span></span></button>
                <CompanionNav tab={tab} navigate={navigate} nativeWorkspace={nativeWorkspace}
                    attentionCount={shellCounts.attention} token={token} legacyHref={legacyHref} dirty={dirty}/>
                <div className={`connection ${boot?.status==='ready'?'online':''}`} role="status" aria-label={connection}>
                    <span className="connection-dot" aria-hidden="true" />
                    <span className="connection-label">{connection}</span>
                </div>
            </div>
        </header>
        <main id="workspace-content" className="companion" ref={content} tabIndex={-1}>
        {nativeWorkspace&&(shellCounts.attention!==undefined||shellCounts.trash!==undefined)&&<p className="visually-hidden" role="status" aria-live="polite">{shellCounts.attention!==undefined&&`${shellCounts.attention} jobs need attention.`} {shellCounts.trash!==undefined&&`${shellCounts.trash} ${shellCounts.trash===1?'record is':'records are'} in Trash.`}</p>}
        {nativeWorkspace&&<p className="fixture-notice" role="status">{boot?.status==='ready'&&boot.mode==='native-store-clone'?'Local Job Apply Store · Changes you make here are saved locally.':'Synthetic native workspace · Jobs, facts, resumes, extraction reviews, remembered answers, and application activity use isolated canonical data.'}</p>}
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
    </>;
}
