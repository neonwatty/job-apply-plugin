'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import { ApiError,type Client } from './client';
import { accountOperationStatus,automationProjection,type AccountOperationStatus,type AutomationProjection } from './automation-model';
import { AutomationRealm } from './AutomationRealm';
import { TrustedFill } from './TrustedFill';
import { ApplicationAutomation } from './ApplicationAutomation';

function ApplicationAutomationWorkspace({client,dirtyChanged}:{client:Client;dirtyChanged(value:boolean):void}) {
  const [data,setData]=useState<AutomationProjection|null>(null);
  const [loading,setLoading]=useState(true),[error,setError]=useState('');
  const [refreshVersion,setRefreshVersion]=useState(0);
  const [trustedDirty,setTrustedDirty]=useState(false),[authorityDirty,setAuthorityDirty]=useState(false);
  const request=useRef<AbortController|null>(null),dirty=trustedDirty||authorityDirty;
  useEffect(()=>{dirtyChanged(dirty);return()=>dirtyChanged(false);},[dirty,dirtyChanged]);
  const refresh=useCallback(async()=>{request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');try{
    const next=automationProjection(await client.automationRequest('/api/automation','GET',undefined,controller.signal));
    if(controller.signal.aborted)return;
    setData(next);
    setRefreshVersion(value=>value+1);
  }catch(failure){if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'Unable to load automation controls.');}finally{if(!controller.signal.aborted)setLoading(false);}},[client]);
  useEffect(()=>{void refresh();return()=>request.current?.abort();},[refresh]);
  return <section className="automation-workspace" aria-labelledby="automation-title">
    <header className="workspace-hero"><div className="workspace-hero-copy"><p className="eyebrow">Controls</p><h1 id="automation-title">Automation</h1><p>Review permissions for an active application run. Final submission stays with you.</p></div><div className="workspace-hero-actions"><button className="secondary" disabled={loading||dirty} onClick={()=>void refresh()}>Refresh</button></div></header>
    {loading&&!data&&<p className="workspace-status" role="status">Loading automation controls…</p>}{error&&<p className="error" role="alert">{error}</p>}
    {data&&<><div className="automation-grid">
      <ApplicationAutomation client={client} authority={data.applicationAuthority} refreshVersion={refreshVersion} disabled={loading} dirtyChanged={setAuthorityDirty} changed={applicationAuthority=>setData({...data,applicationAuthority})}/>
      <details className="automation-advanced"><summary><span><strong>Trusted Fill approvals</strong><small>Advanced controls for exact, non-final field operations</small></span><span className="automation-state">No final action</span></summary><TrustedFill client={client} disabled={loading} dirtyChanged={setTrustedDirty}/></details>
    </div></>}
  </section>;
}

function AccountsSignIn({client,dirtyChanged}:{client:Client;dirtyChanged(value:boolean):void}) {
  const [data,setData]=useState<AutomationProjection|null>(null),[operation,setOperation]=useState<AccountOperationStatus|null>(null);
  const [realmUrl,setRealmUrl]=useState(''),[adding,setAdding]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const request=useRef<AbortController|null>(null),conflict=useRef<HTMLDivElement>(null);
  const dirty=Boolean(realmUrl);
  useEffect(()=>{dirtyChanged(dirty||busy);return()=>dirtyChanged(false);},[dirty,busy,dirtyChanged]);
  const refresh=useCallback(async(quiet=false)=>{request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');try{const [projectionValue,operationValue]=await Promise.all([client.automationRequest('/api/automation','GET',undefined,controller.signal),client.automationRequest('/api/account-operation','GET',undefined,controller.signal)]);const projection=automationProjection(projectionValue);setData(projection);setOperation(accountOperationStatus(operationValue));if(!quiet)setNotice('Accounts and sign-in status refreshed.');}catch(failure){if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'Unable to load accounts and sign-in status.');}finally{if(!controller.signal.aborted)setLoading(false);}},[client]);
  useEffect(()=>{void refresh(true);return()=>request.current?.abort();},[refresh]);
  async function mutate(action:()=>Promise<unknown>,success:string){if(busy)return;setBusy(true);setError('');setNotice('');try{await action();await refresh(true);setNotice(success);}catch(failure){if(failure instanceof ApiError&&failure.code==='revision_conflict'){setError('Account data changed elsewhere. Nothing was retried. Refresh and review the latest revision.');requestAnimationFrame(()=>conflict.current?.focus());}else setError(failure instanceof Error?failure.message:'Account operation failed.');}finally{setBusy(false);}}
  function add(event?:React.FormEvent,url=realmUrl,clearDraft=true){event?.preventDefault();void mutate(async()=>{try{await client.automationRequest('/api/employer-accounts','POST',{url});}catch(failure){if(failure instanceof ApiError&&failure.code==='store_rejected'&&failure.message==='employer account realm is unresolved')throw new Error('This portal is not supported. Use an exact Workday or Oracle Recruiting job URL; direct Greenhouse applications need no account.');throw failure;}if(clearDraft)setRealmUrl('');setAdding(false);},'Saved account metadata created.');}
  function toggleAdding(){if(adding){setRealmUrl('');setAdding(false);return;}setAdding(true);}
  async function refreshOperation(){if(busy)return;setBusy(true);setError('');try{setOperation(accountOperationStatus(await client.automationRequest('/api/account-operation')));}catch(failure){setError(failure instanceof Error?failure.message:'Unable to load account operation.');}finally{setBusy(false);}}
  async function recover(){if(busy)return;setBusy(true);setError('');try{setOperation(accountOperationStatus(await client.automationRequest('/api/account-operation/recover','POST',{})));setNotice('Stranded account operation marked ambiguous.');await refresh(true);}catch(failure){setError(failure instanceof Error?failure.message:'Unable to recover account operation.');}finally{setBusy(false);}}
  const flow=data?.capability.accountFlowAutomation,hasMyGreenhouse=data?.accounts.some(account=>account.adapterId==='mygreenhouse');
  return <section className="automation-workspace accounts-workspace" aria-labelledby="accounts-title"><header className="workspace-hero"><div className="workspace-hero-copy"><p className="eyebrow">Controls</p><h1 id="accounts-title">Accounts &amp; Sign-in</h1><p>Sign in through your browser; credentials and email codes stay out of this workspace.</p></div><div className="workspace-hero-actions"><button className="secondary" disabled={loading||busy||dirty} onClick={()=>void refresh()}>Refresh</button></div></header>
    {loading&&!data&&<p className="workspace-status" role="status">Loading accounts and sign-in status…</p>}{notice&&<p className="notice" role="status">{notice}</p>}{error&&<div ref={conflict} tabIndex={-1} className="error" role="alert">{error}</div>}{data&&<div className="automation-grid">
      <section className="workspace-panel automation-settings-panel" aria-labelledby="account-settings-heading"><div className="workspace-panel-heading"><div><p className="eyebrow">Readiness</p><h2 id="account-settings-heading">Before you apply</h2></div></div><div className="automation-capabilities" role="status"><span className={flow?.workdayPasswordAccountReady?'is-available':'is-unavailable'}>{flow?.workdayPasswordAccountReady?'Workday Keychain ready':'Workday setup unavailable'}</span><span className={flow?.myGreenhousePasswordlessConfigurationReady?'is-available':'is-unavailable'}>{flow?.myGreenhousePasswordlessExecutionReady?'MyGreenhouse browser sign-in ready':'MyGreenhouse configuration only'}</span><span className={flow?.emailOnlyCandidateProfileReady?'is-available':'is-unavailable'}>{flow?.emailOnlyCandidateProfileReady?'Oracle email-only ready':'Oracle setup unavailable'}</span></div>
        <div className="account-callout"><div><strong>Sign-in is yours to complete</strong><p>Saved account details do not confirm a browser sign-in. Sign in on the employer portal when needed.</p></div></div>
      </section>
      <section className="workspace-panel automation-realms-panel" aria-labelledby="saved-accounts-heading"><div className="workspace-panel-heading"><div><p className="eyebrow">Saved metadata</p><h2 id="saved-accounts-heading">Supported accounts</h2></div><button className="secondary compact-action" type="button" onClick={toggleAdding}>{adding?'Cancel':'Add portal'}</button></div>{adding&&<form className="automation-form realm-form" onSubmit={event=>add(event)}><fieldset disabled={busy}><legend className="visually-hidden">Add supported portal</legend><label>Exact employer portal URL<input type="url" required value={realmUrl} placeholder="Workday or Oracle Recruiting job URL" onChange={event=>setRealmUrl(event.target.value)}/></label><button className="primary">Add portal</button></fieldset></form>}{!hasMyGreenhouse&&<div className="account-callout"><div><strong>MyGreenhouse</strong><p>One optional global passwordless account. Browser sign-in remains separate.</p></div><button className="secondary" disabled={busy} onClick={()=>add(undefined,'https://my.greenhouse.io/',false)}>Add MyGreenhouse</button></div>}{data.accounts.length?<div className="automation-accounts" role="list">{data.accounts.map(account=><AutomationRealm key={account.realmRef} account={account} client={client} disabled={busy} changed={()=>refresh(true)}/>)}</div>:<div className="workspace-empty"><strong>No account metadata saved.</strong><span>Add an exact supported portal only when account preparation is needed.</span></div>}
        <p>Direct Greenhouse applications do not require an account.</p></section>
      {operation?.status==='recovery_required'&&<section className="workspace-panel operation-panel needs-recovery" aria-labelledby="account-operation-heading"><div className="workspace-panel-heading"><div><p className="eyebrow">Recovery</p><h2 id="account-operation-heading">Account operation</h2></div><span className="automation-state">Action needed</span></div><p className="notice" role="status">Recovery required · {operation.operation.stage.replaceAll('_',' ')} · account {operation.operation.realmRef.slice(0,12)}…</p><p className="automation-safety">Recovery records an ambiguous outcome. It cannot retry, rotate, provision, or sign in.</p><div className="button-row"><button className="secondary" disabled={busy} onClick={()=>void refreshOperation()}>Refresh status</button><button className="trash-delete" disabled={busy} onClick={()=>void recover()}>Mark operation ambiguous</button></div></section>}
    </div>}</section>;
}

export function Automation({mode='automation',...props}:{client:Client;dirtyChanged(value:boolean):void;mode?:'automation'|'accounts'}) {
  return mode==='accounts'?<AccountsSignIn {...props}/>:<ApplicationAutomationWorkspace {...props}/>;
}
