'use client';
import { useEffect, useRef, useState } from 'react';
import type { Client } from './client';
import { trustedFillStatus, type TrustedFillStatus } from './automation-model';

const operations=[['fill_text','Fill text'],['select_option','Select option'],['toggle_non_consent','Toggle a non-consent field'],['upload_approved_resume','Upload the approved resume']] as const;
export function TrustedFill({client,disabled,dirtyChanged}:{client:Client;disabled:boolean;dirtyChanged(value:boolean):void}) {
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('No approval loaded.');
  const [status,setStatus]=useState<TrustedFillStatus|null>(null),[jobId,setJobId]=useState('');
  const approval=useRef<HTMLFormElement>(null);
  useEffect(()=>{dirtyChanged(dirty||busy);return()=>dirtyChanged(false);},[dirty,busy,dirtyChanged]);
  async function approve(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form=new FormData(event.currentTarget), allowed=form.getAll('allowedOperations').map(String).sort();
    if (!allowed.length) {setError('Select at least one non-final operation.');return;}
    setBusy(true);setError('');
    try {
      const value=trustedFillStatus(await client.automationRequest('/api/trusted-fill/approve','POST',{
        jobId:String(form.get('jobId')||'').trim(),expectedJobRevision:Number(form.get('expectedJobRevision')),
        realmRef:String(form.get('realmRef')||'').trim(),answerRefs:String(form.get('answerRefs')||'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean),
        observedQuestionFingerprint:String(form.get('observedQuestionFingerprint')||'').trim(),observedControlFingerprint:String(form.get('observedControlFingerprint')||'').trim(),
        formFingerprint:String(form.get('formFingerprint')||'').trim(),allowedOperations:allowed,durationMinutes:Number(form.get('durationMinutes'))
      }));
      setStatus(value);setJobId('jobId' in value?value.jobId:'');setNotice('Exact Trusted Fill packet approved.');setDirty(false);
    } catch(failure){setError(failure instanceof Error?failure.message:'Unable to approve this packet.');}
    finally{setBusy(false);}
  }
  async function load(event?:React.FormEvent) {
    event?.preventDefault(); if(!jobId.trim())return; setBusy(true);setError('');
    try{const value=trustedFillStatus(await client.automationRequest(`/api/trusted-fill/${encodeURIComponent(jobId.trim())}`));setStatus(value);setNotice('jobId' in value?`${value.status.replaceAll('_',' ')} · approval revision ${value.approvalRevision} · expires ${value.expiresAt}`:'No approval exists for this job.');}
    catch(failure){setError(failure instanceof Error?failure.message:'Unable to load approval status.');}
    finally{setBusy(false);}
  }
  async function revoke(){if(!status||status.status!=='active'||!('jobId' in status))return;setBusy(true);setError('');try{
    const value=trustedFillStatus(await client.automationRequest(`/api/trusted-fill/${encodeURIComponent(status.jobId)}/revoke`,'POST',{expectedApprovalRevision:status.approvalRevision}));
    setStatus(value);setNotice('Trusted Fill approval revoked.');
  }catch(failure){setError(failure instanceof Error?failure.message:'Unable to revoke approval.');}finally{setBusy(false);}}
  return <section className="workspace-panel trusted-fill-panel" aria-labelledby="trusted-fill-heading">
    <div className="workspace-panel-heading"><div><p className="eyebrow">Grounded trusted fill</p><h2 id="trusted-fill-heading">Approve exact non-final field operations</h2></div><span className="automation-state">No final action</span></div>
    <p className="automation-safety">This inert authority evaluates fingerprints only. It cannot operate a browser, authenticate, accept consent, enter credentials, navigate, or activate Submit, Send, Apply, or any equivalent final control.</p>
    <form ref={approval} className="automation-form trusted-fill-form" onChange={()=>setDirty(true)} onSubmit={approve}>
      <fieldset disabled={disabled||busy}><legend className="visually-hidden">Trusted Fill approval packet</legend><div className="automation-form-grid">
        <label>Claimed job ID<input name="jobId" required/></label><label>Expected job revision<input name="expectedJobRevision" type="number" min="1" required/></label>
        <label className="wide">Portal realm reference<input name="realmRef" pattern="[0-9a-f]{64}" required/></label>
        <label className="wide">Accepted answer references (one per line)<textarea name="answerRefs" rows={3}/></label>
        <label className="wide">Observed question fingerprint<input name="observedQuestionFingerprint" pattern="sha256:[0-9a-f]{64}" required/></label>
        <label className="wide">Observed control fingerprint<input name="observedControlFingerprint" pattern="sha256:[0-9a-f]{64}" required/></label>
        <label className="wide">Form fingerprint<input name="formFingerprint" pattern="sha256:[0-9a-f]{64}" required/></label>
        <label>Duration in minutes<input name="durationMinutes" type="number" min="1" max="60" defaultValue="30" required/></label>
      </div><fieldset className="trusted-operations"><legend>Allowed non-final operations</legend>{operations.map(([value,label])=><label key={value}><input name="allowedOperations" value={value} type="checkbox"/> {label}</label>)}</fieldset>
      <button className="primary">Approve exact packet</button></fieldset>
    </form>
    <form className="trusted-status-form" onSubmit={load}><label>Job ID for status or revocation<input value={jobId} required disabled={disabled||busy} onChange={event=>setJobId(event.target.value)}/></label><div className="button-row"><button className="secondary" disabled={disabled||busy}>Check approval status</button><button className="secondary" type="button" disabled={disabled||busy||status?.status!=='active'} onClick={()=>void revoke()}>Revoke approval</button></div></form>
    <p className="notice" role="status">{notice}</p>{error&&<p className="error" role="alert">{error}</p>}
  </section>;
}
