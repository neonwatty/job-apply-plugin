'use client';
import { useEffect,useMemo,useState } from 'react';
import type { Client } from './client';
import type { WorkspaceState } from './contracts';
import { applicationAuthority,campaignProgress,type ApplicationAuthority,type CampaignProgress } from './automation-model';

type Mode='autofill_to_review'|'campaign_to_review';
export function ApplicationAutomation({client,authority,disabled,dirtyChanged,changed}:{client:Client;authority:ApplicationAuthority;
  disabled:boolean;dirtyChanged(value:boolean):void;changed(value:ApplicationAuthority):void}) {
  const [state,setState]=useState<WorkspaceState|null>(null),[mode,setMode]=useState<Mode>('autofill_to_review');
  const [selected,setSelected]=useState<string[]>([]),[duration,setDuration]=useState(120),[sensitive,setSensitive]=useState('');
  const [progress,setProgress]=useState<CampaignProgress|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const active=authority.mode!=='guided',dirty=!active&&(selected.length>0||duration!==120||sensitive.trim()!==''||mode!=='autofill_to_review');
  useEffect(()=>{dirtyChanged(dirty||busy);return()=>dirtyChanged(false);},[dirty,busy,dirtyChanged]);
  useEffect(()=>{void client.state().then(setState).catch(failure=>setError(failure instanceof Error?failure.message:'Unable to load application run.'));},[client]);
  useEffect(()=>{if(authority.mode==='campaign_to_review')void loadProgress();else setProgress(null);},[authority.mode,authority.revision]);
  const queued=useMemo(()=>{const ids=state?.applicationRun?.queueVersions.at(-1)?.jobIds??[];
    return ids.map(id=>state?.jobs.find(job=>job.id===id)).filter((job):job is NonNullable<typeof job>=>Boolean(job));},[state]);
  async function loadProgress(){try{setProgress(campaignProgress(await client.automationRequest('/api/application-authority/progress')));}
    catch(failure){setError(failure instanceof Error?failure.message:'Unable to load campaign progress.');}}
  function toggle(id:string){setSelected(current=>current.includes(id)?current.filter(item=>item!==id):mode==='autofill_to_review'?[id]:[...current,id]);}
  function changeMode(value:Mode){setMode(value);if(value==='autofill_to_review'&&selected.length>1)setSelected(selected.slice(0,1));}
  async function mutate(action:()=>Promise<unknown>,success:string){if(busy)return;setBusy(true);setError('');setNotice('');try{
    const value=applicationAuthority(await action());changed(value);setNotice(success);if(value.mode==='guided'){setSelected([]);setSensitive('');setDuration(120);setMode('autofill_to_review');}
  }catch(failure){setError(failure instanceof Error?failure.message:'Application automation update failed.');}finally{setBusy(false);}}
  function approve(event:React.FormEvent){event.preventDefault();const run=state?.applicationRun;if(!run||!selected.length)return;
    void mutate(()=>client.automationRequest('/api/application-authority','POST',{authority:{mode,runId:run.runId,jobIds:selected,
      sensitiveAnswerRefs:sensitive.split(/\r?\n/u).map(value=>value.trim()).filter(Boolean),durationMinutes:duration},expectedRevision:authority.revision}),
    mode==='campaign_to_review'?'Campaign to Review approved.':'Autofill to Review approved.');}
  function control(action:'pause'|'resume'|'stop'){void mutate(()=>client.automationRequest(`/api/application-authority/${action}`,'POST',
    {expectedRevision:authority.revision}),`Campaign ${action==='stop'?'stopped':action+'d'}.`);}
  function guided(){void mutate(()=>client.automationRequest('/api/application-authority/revoke','POST',{expectedRevision:authority.revision}),'Guided mode restored.');}
  const counts=progress?.counts;
  return <section className="workspace-panel application-automation-panel" aria-labelledby="application-automation-heading">
    <div className="workspace-panel-heading"><div><p className="eyebrow">Application authority</p><h2 id="application-automation-heading">Application automation</h2></div><span className="automation-state">{authority.mode.replaceAll('_',' ')}</span></div>
    <p className="automation-safety">Every mode stops at final review. Submit, Send, Apply, login, CAPTCHA, MFA, verification, and legal consent remain manual.</p>
    <p className="notice" role="status">{authority.mode==='guided'?'Guided · granular confirmation remains active':`${authority.mode.replaceAll('_',' ')} · ${authority.status} · ${authority.jobIds.length} job${authority.jobIds.length===1?'':'s'} · expires ${authority.expiresAt}`}</p>
    {!active?<form className="automation-form" onSubmit={approve}><fieldset disabled={disabled||busy||!state?.applicationRun}><legend className="visually-hidden">Application automation scope</legend>
      <label>Mode<select value={mode} onChange={event=>changeMode(event.target.value as Mode)}><option value="autofill_to_review">Autofill to Review</option><option value="campaign_to_review">Campaign to Review</option></select></label>
      <label>Duration in minutes<input type="number" min="1" max="1440" value={duration} onChange={event=>setDuration(Number(event.target.value))}/></label>
      <fieldset className="automation-job-scope"><legend>Jobs in the active application run</legend>{queued.length?queued.map(job=><label className="check-row" key={job.id}><input type="checkbox" checked={selected.includes(job.id)} disabled={!['ready','in_progress'].includes(job.status)} onChange={()=>toggle(job.id)}/><span><strong>{String(job.role||'Untitled role')} · {String(job.company||'Unknown company')}</strong><small>{job.status.replaceAll('_',' ')} · revision {job.revision}</small></span></label>):<p>No queued jobs are available. Start an application run and prepare its jobs first.</p>}</fieldset>
      <details><summary>Exact sensitive answer permissions</summary><label>Approved answer references, one per line<textarea rows={3} value={sensitive} onChange={event=>setSensitive(event.target.value)}/></label><small>Current use only. Values and broad sensitive categories are never authorized here.</small></details>
      <button className="primary" disabled={!selected.length}>Approve bounded mode</button></fieldset></form>:<div className="button-row"><button className="secondary" disabled={disabled||busy} onClick={guided}>Return to Guided</button>
      {authority.mode==='campaign_to_review'&&authority.status==='active'&&<button className="secondary" disabled={disabled||busy} onClick={()=>control('pause')}>Pause campaign</button>}
      {authority.mode==='campaign_to_review'&&authority.status==='paused'&&<button className="secondary" disabled={disabled||busy} onClick={()=>control('resume')}>Resume campaign</button>}
      {authority.mode==='campaign_to_review'&&<button className="trash-delete" disabled={disabled||busy} onClick={()=>control('stop')}>Emergency stop</button>}</div>}
    {counts&&<div className="automation-status-strip" aria-label="Campaign progress"><span><strong>{counts.ready}</strong> ready</span><span><strong>{counts.inProgress}</strong> active</span><span><strong>{counts.needsAttention}</strong> needs attention</span><span><strong>{counts.awaitingReview}</strong> at review</span></div>}
    {notice&&<p className="notice" role="status">{notice}</p>}{error&&<p className="error" role="alert">{error}</p>}
  </section>;
}
