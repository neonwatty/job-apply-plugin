export const workspaceTabs = [
    'overview', 'jobs', 'facts', 'resumes', 'answers', 'consents', 'extractions',
    'attention', 'accounts', 'automation', 'settings', 'trash', 'submission', 'more',
] as const;
export type WorkspaceTab = typeof workspaceTabs[number];

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
  submission:'M4 4h16v16H4z M8 12l3 3 5-6',
  settings:'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  trash:'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
  external:'M14 3h7v7 M21 3l-9 9 M10 5H4v15h15v-6',
  more:'M5 12h.01 M12 12h.01 M19 12h.01',
  chevron:'M9 6l6 6-6 6',
  collapse:'M4 4h16v16H4z M9 4v16 M16 9l-3 3 3 3',
};
function SidebarIcon({name}:{name:string}) {
  return <svg className="sidebar-icon" width="20" height="20" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name] ?? paths.overview}/>
  </svg>;
}

type Destination = { tab: WorkspaceTab; label: string; count?: number };
type NavigationProps = {
    tab: WorkspaceTab;
    navigate: (tab: WorkspaceTab) => boolean;
    ready: boolean;
    nativeWorkspace: boolean;
    submissionLabEnabled: boolean;
    counts: { attention?: number; trash?: number };
    legacyHref: string;
    showLegacy: boolean;
    confirmLegacy: () => boolean;
};

function isCurrent(tab: WorkspaceTab, destination: WorkspaceTab) {
    return tab === destination || destination === 'resumes' && tab === 'extractions';
}

function destinationButton(props: NavigationProps, destination: Destination, variant?: 'phone' | 'more') {
    const { tab, label, count } = destination;
    return <button type="button" key={tab} className="nav-link" aria-label={label} disabled={!props.ready}
        aria-current={isCurrent(props.tab, tab) ? 'page' : undefined}
        aria-describedby={variant === 'phone' && tab === 'attention' && count !== undefined ? 'workspace-counts' : undefined}
        title={label} onClick={() => props.navigate(tab)}>
        <SidebarIcon name={tab}/>
        <span className="nav-label">{label}</span>
        {count !== undefined && <span className="nav-count" aria-hidden="true">{count}</span>}
        {variant === 'more' && <SidebarIcon name="chevron"/>}
    </button>;
}

function WorkspaceGroups(props: NavigationProps & { secondaryOnly?: boolean }) {
    const { nativeWorkspace, submissionLabEnabled, counts, secondaryOnly = false } = props;
    const pipeline: Destination[] = [{ tab: 'overview', label: 'Overview' }];
    if (!secondaryOnly) {
        pipeline.unshift({ tab: 'jobs', label: 'Jobs' });
        if (nativeWorkspace) pipeline.unshift({ tab: 'attention', label: 'Needs Attention', count: counts.attention });
    }
    const applicationData: Destination[] = [{ tab: 'facts', label: 'Facts' }, { tab: 'resumes', label: 'Resumes' }];
    const controls: Destination[] = [];
    if (nativeWorkspace) {
        applicationData.push({ tab: 'answers', label: 'Answers' }, { tab: 'consents', label: 'Consent defaults' });
        const settings: Destination = { tab: 'settings', label: 'Settings' };
        if (secondaryOnly) pipeline.unshift(settings);
        controls.push({ tab: 'automation', label: 'Automation' }, { tab: 'accounts', label: 'Accounts & Sign-in' });
        if (!secondaryOnly) controls.push(settings);
        if (submissionLabEnabled) controls.push({ tab: 'submission', label: 'Submission lab' });
    }
    controls.push({ tab: 'trash', label: 'Trash', count: nativeWorkspace ? counts.trash : undefined });
    return [
        { label: secondaryOnly ? 'Workspace' : 'Pipeline', links: pipeline },
        { label: 'Application data', links: applicationData },
        { label: 'Controls', links: controls },
    ].map(group => <div className="nav-group" key={group.label} role="group" aria-label={group.label}>
        <span className="nav-group-label" aria-hidden="true">{group.label}</span>
        <div className="nav-group-links">
            {group.label === 'Controls' && props.showLegacy && <a className="nav-link" href={props.legacyHref}
                aria-label="Open full workspace" title="Open full workspace" onClick={event => {
                    if (!props.confirmLegacy()) event.preventDefault();
                }}>
                <SidebarIcon name="external"/><span className="nav-label">Open full workspace</span>
                {secondaryOnly && <SidebarIcon name="chevron"/>}
            </a>}
            {group.links.map(destination => destinationButton(props, destination, secondaryOnly ? 'more' : undefined))}
        </div>
    </div>);
}

export function WorkspaceNavigation(props: NavigationProps & {
    collapsed: boolean;
    toggleSidebar: () => void;
    connection: string;
    online: boolean;
}) {
    const { collapsed, toggleSidebar, connection, online, nativeWorkspace, counts } = props;
    return <>
        <header className="topbar">
            <button className="sidebar-toggle" type="button" aria-expanded={!collapsed} aria-controls="workspace-navigation"
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={toggleSidebar}>
                <SidebarIcon name="collapse"/><span>{collapsed ? 'Expand' : 'Collapse'}</span>
            </button>
            <div className="product-context">
                <p className="eyebrow">Focus Queue</p>
                <h1>Job Apply</h1>
                <p id="workspace-trust-context" className="trust-context">Your data stays local. You approve what gets sent.</p>
            </div>
            <div className={`connection ${online ? 'online' : ''}`} role="status" aria-label={connection}>
                <span className="connection-dot" aria-hidden="true"/><span>{connection}</span>
            </div>
            <nav id="workspace-navigation" className="workspace-nav" aria-label="Workspace sections"
                aria-describedby="workspace-trust-context">
                <WorkspaceGroups {...props}/>
            </nav>
        </header>
        <nav className="phone-navigation" aria-label="Mobile workspace sections">
            {nativeWorkspace && destinationButton(props, { tab: 'attention', label: 'Needs Attention', count: counts.attention }, 'phone')}
            {destinationButton(props, { tab: 'jobs', label: 'Jobs' })}
            <button type="button" className="nav-link" disabled={!props.ready} aria-current={props.tab === 'more' ? 'page' : undefined}
                data-selected={props.tab !== 'jobs' && props.tab !== 'attention'}
                onClick={() => props.navigate('more')}>
                <SidebarIcon name="more"/><span className="nav-label">More</span>
            </button>
        </nav>
    </>;
}

export function MoreWorkspace(props: NavigationProps) {
    return <section className="more-workspace" aria-labelledby="more-title">
        <header className="workspace-hero">
            <div className="workspace-hero-copy"><h1 id="more-title">More</h1></div>
        </header>
        <nav className="more-destinations" aria-label="More workspace sections">
            <WorkspaceGroups {...props} secondaryOnly/>
        </nav>
    </section>;
}
