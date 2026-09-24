'use client';
import { useRef,useState } from 'react';
import { ApiError,type Client } from './client';
import type { EmployerAccount } from './automation-model';

const labels={workday:'Workday realm','oracle-recruiting':'Oracle Recruiting site',mygreenhouse:'MyGreenhouse'} as const;
export function AutomationRealm({account,client,disabled,changed}:{account:EmployerAccount;client:Client;disabled:boolean;changed():void|Promise<void>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const conflict=useRef<HTMLDivElement>(null),label=labels[account.adapterId];
  async function mutate(kind:'clear'|'remove') {if(busy)return;setBusy(true);setError('');try{
    const path=`/api/employer-accounts/${encodeURIComponent(account.realmRef)}`;
    if(kind==='clear')await client.automationRequest(path,'PATCH',{patch:{signupEmailOverride:null},expectedRevision:account.revision});
    else await client.automationRequest(`${path}/delete`,'POST',{expectedRevision:account.revision});
    await changed();
  }catch(failure){if(failure instanceof ApiError&&failure.code==='revision_conflict'){setError('This account changed elsewhere. Nothing was retried. Refresh and review the latest revision.');requestAnimationFrame(()=>conflict.current?.focus());}else setError(failure instanceof Error?failure.message:'Unable to update account metadata.');}finally{setBusy(false);}}
  const saved=account.adapterId==='workday'?(account.providerAssigned?'Keychain metadata configured':'Keychain setup pending'):account.adapterId==='mygreenhouse'?'Optional global passwordless profile':'Email-only profile metadata';
  return <article className="automation-account" role="listitem"><div className="automation-account-heading"><span className="automation-realm-mark" aria-hidden="true">{account.adapterId==='workday'?'W':account.adapterId==='mygreenhouse'?'G':'O'}</span><div><p className="eyebrow">{label}</p><h3>{account.adapterId==='mygreenhouse'?'Global account':`${account.realmRef.slice(0,12)}…`}</h3></div><span className="automation-state">{account.lifecycleState.replaceAll('_',' ')}</span></div>
    <dl className="account-readiness"><div><dt>Saved account metadata</dt><dd>{saved}</dd></div><div><dt>Browser session</dt><dd>Not observed</dd></div></dl>
    <p>Revision {account.revision} · {account.signupEmailOverrideConfigured?'Contact metadata configured':'No contact override stored'} · {account.flowKind.replaceAll('_',' ')}</p>
    <p>{account.adapterId==='workday'?'Credentials remain isolated in Keychain and are never exposed here.':account.adapterId==='mygreenhouse'?'Sign-in uses a browser-delivered email code; Companion never receives it.':'No credential provider or password is used.'}</p>
    <div className="button-row"><button className="secondary" type="button" disabled={disabled||busy||!account.signupEmailOverrideConfigured} onClick={()=>void mutate('clear')}>Clear contact metadata</button><button className="trash-delete" type="button" disabled={disabled||busy} onClick={()=>void mutate('remove')}>Remove saved account</button></div>{error&&<div ref={conflict} tabIndex={-1} className="error" role="alert">{error}</div>}</article>;
}
