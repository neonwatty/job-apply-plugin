'use client';
import { useEffect,useRef,useState } from 'react';
import { ApiError, type Client } from './client';
import type { EmployerAccount } from './automation-model';

export function AutomationRealm({ account, client, disabled, changed, dirtyChanged }: {
  account: EmployerAccount; client: Client; disabled: boolean; changed(): void | Promise<void>; dirtyChanged(id:string,value:boolean):void;
}) {
  const [email,setEmail]=useState(''), [busy,setBusy]=useState(false), [error,setError]=useState('');
  const conflict=useRef<HTMLDivElement>(null);
  const label=account.adapterId==='oracle-recruiting'?'Oracle Recruiting site':'Workday realm';
  useEffect(()=>{dirtyChanged(account.realmRef,Boolean(email));return()=>dirtyChanged(account.realmRef,false);},[account.realmRef,email,dirtyChanged]);
  async function save(clear=false) {
    if (busy || (!clear && !email.trim())) { if (!clear) setError('Enter an email override or choose Clear override.'); return; }
    setBusy(true); setError('');
    try {
      await client.automationRequest(`/api/employer-accounts/${encodeURIComponent(account.realmRef)}`,'PATCH',{
        patch:{signupEmailOverride:clear?null:email.trim()},expectedRevision:account.revision
      });
      setEmail(''); await changed();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code==='revision_conflict') {
        setError('This realm changed elsewhere. Nothing was retried. Refresh and review the latest revision.');
        requestAnimationFrame(()=>conflict.current?.focus());
      } else setError(failure instanceof Error?failure.message:'Unable to save realm override.');
    } finally { setBusy(false); }
  }
  return <article className="automation-account">
    <div className="automation-account-heading"><span className="automation-realm-mark" aria-hidden="true">{account.adapterId==='workday'?'W':'O'}</span>
      <div><p className="eyebrow">{label}</p><h3>{account.realmRef.slice(0,12)}…</h3></div><span className="automation-state">{account.lifecycleState.replaceAll('_',' ')}</span></div>
    <p>Revision {account.revision} · {account.signupEmailOverrideConfigured?'Email override configured':'Global email setting'} · {account.flowKind.replaceAll('_',' ')}</p>
    <p>{account.credentialRequired?(account.providerAssigned?'Protected credential metadata assigned; value remains inaccessible.':'Credential not provisioned.'):'Email-only candidate profile; no password is created or stored.'}</p>
    <form className="realm-override-form" aria-label={`Edit signup email override for ${label} ${account.realmRef.slice(0,12)}`} onSubmit={event=>{event.preventDefault();void save();}}>
      <label>Signup email override<input type="email" autoComplete="email" value={email} placeholder={account.signupEmailOverrideConfigured?'Configured; enter a replacement':'Use global signup email'} disabled={disabled||busy} onChange={event=>setEmail(event.target.value)}/></label>
      <div className="button-row"><button className="secondary" disabled={disabled||busy}>Save override</button><button className="text-action" type="button" disabled={disabled||busy||!account.signupEmailOverrideConfigured} onClick={()=>void save(true)}>Clear override</button></div>
      {error&&<div ref={conflict} tabIndex={-1} className="error" role="alert">{error}</div>}
    </form>
  </article>;
}
