'use client';
import { useEffect,useMemo,useRef,useState } from 'react';
import type { Client } from './client';
import type { WorkspaceState } from './contracts';
import { applicationAuthority,campaignProgress,type ApplicationAuthority,type CampaignProgress } from './automation-model';

type Mode='autofill_to_review'|'campaign_to_review';
const eligible = (job: WorkspaceState['jobs'][number]) => job.status==='ready'||job.status==='in_progress';
export function ApplicationAutomation({client,authority,refreshVersion,disabled,dirtyChanged,changed}:{client:Client;authority:ApplicationAuthority;refreshVersion:number;
  disabled:boolean;dirtyChanged(value:boolean):void;changed(value:ApplicationAuthority):void}) {
  const [state,setState]=useState<WorkspaceState|null>(null),[mode,setMode]=useState<Mode>('autofill_to_review');
  const [stateLoading,setStateLoading]=useState(true);
  const [step,setStep]=useState(1);
  const scopeForm=useRef<HTMLFormElement>(null);
  const focusStep=useRef(false);
  const changeStep=(next:number)=>{focusStep.current=true;setStep(next);};
  useEffect(()=>{
    if(!focusStep.current)return;
    focusStep.current=false;
    scopeForm.current?.querySelector<HTMLElement>(`[data-approval-step="${step}"] h3`)?.focus();
  },[step]);
  const [selected,setSelected]=useState<string[]>([]),[duration,setDuration]=useState(120),[sensitive,setSensitive]=useState('');
  const [progress,setProgress]=useState<CampaignProgress|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const active=authority.mode!=='guided',dirty=!active&&(selected.length>0||duration!==120||sensitive.trim()!==''||mode!=='autofill_to_review');
  useEffect(()=>{dirtyChanged(dirty||busy);return()=>dirtyChanged(false);},[dirty,busy,dirtyChanged]);
  useEffect(()=>{const controller=new AbortController();setStateLoading(true);setState(null);setSelected([]);setStep(1);
    void client.state(controller.signal).then(next=>{if(!controller.signal.aborted){setState(next);setError('');}})
      .catch(failure=>{if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'Unable to load application run.');})
      .finally(()=>{if(!controller.signal.aborted)setStateLoading(false);});
    return()=>controller.abort();},[client,refreshVersion]);
  useEffect(()=>{if(authority.mode==='campaign_to_review')void loadProgress();else setProgress(null);},[authority.mode,authority.revision]);
  const queued=useMemo(()=>{const ids=state?.applicationRun?.queueVersions.at(-1)?.jobIds??[];
    return ids.map(id=>state?.jobs.find(job=>job.id===id)).filter((job):job is NonNullable<typeof job>=>Boolean(job));
  },[state]);
  const eligibleJobs=queued.filter(eligible);
  const unavailableJobs=queued.filter(job=>!eligible(job));
  function jobChoice(job: WorkspaceState['jobs'][number]) {
    return <label className="check-row" key={job.id}>
      <input type="checkbox" checked={selected.includes(job.id)} disabled={!eligible(job)} onChange={()=>toggle(job.id)}/>
      <span><strong>{String(job.role||'Untitled role')} · {String(job.company||'Unknown company')}</strong><small>{job.status.replaceAll('_',' ')} · revision {job.revision}</small></span>
    </label>;
  }
  async function loadProgress(){try{setProgress(campaignProgress(await client.automationRequest('/api/application-authority/progress')));}
    catch(failure){setError(failure instanceof Error?failure.message:'Unable to load campaign progress.');}}
  function toggle(id:string){setSelected(current=>current.includes(id)?current.filter(item=>item!==id):mode==='autofill_to_review'?[id]:[...current,id]);}
  function changeMode(value:Mode){setMode(value);if(value==='autofill_to_review'&&selected.length>1)setSelected(selected.slice(0,1));}
  async function mutate(action:()=>Promise<unknown>,success:string){if(busy)return;setBusy(true);setError('');setNotice('');try{
    const value=applicationAuthority(await action());changed(value);setNotice(success);setStep(1);if(value.mode==='guided'){setSelected([]);setSensitive('');setDuration(120);setMode('autofill_to_review');}
  }catch(failure){setError(failure instanceof Error?failure.message:'Application automation update failed.');}finally{setBusy(false);}}
  function approve(event:React.FormEvent){event.preventDefault();const run=state?.applicationRun;
    const phoneApprovalIncomplete=window.matchMedia('(max-width: 760px)').matches&&step!==3;
    if(!run||!selected.length||disabled||stateLoading||busy||phoneApprovalIncomplete)return;
    void mutate(()=>client.automationRequest('/api/application-authority','POST',{authority:{mode,runId:run.runId,jobIds:selected,
      sensitiveAnswerRefs:sensitive.split(/\r?\n/u).map(value=>value.trim()).filter(Boolean),durationMinutes:duration},expectedRevision:authority.revision}),
    mode==='campaign_to_review'?'Campaign to Review approved.':'Autofill to Review approved.');}
  function control(action:'pause'|'resume'|'stop'){void mutate(()=>client.automationRequest(`/api/application-authority/${action}`,'POST',
    {expectedRevision:authority.revision}),`Campaign ${action==='stop'?'stopped':action+'d'}.`);}
  function guided(){void mutate(()=>client.automationRequest('/api/application-authority/revoke','POST',{expectedRevision:authority.revision}),'Guided mode restored.');}
  const counts=progress?.counts;
  return <section className="workspace-panel application-automation-panel" data-guided={!active} aria-labelledby="application-automation-heading">
    <div className="workspace-panel-heading"><div><p className="eyebrow">Application authority</p><h2 id="application-automation-heading">Application automation</h2></div><span className="automation-state">{authority.mode.replaceAll('_',' ')}</span></div>
    <p className="automation-safety">Every mode stops at your final review and submission.</p>
    <p className="notice approval-current-status" role="status">{authority.mode==='guided'?'Guided mode · confirm each step':`${authority.mode.replaceAll('_',' ')} · ${authority.status} · ${authority.jobIds.length} job${authority.jobIds.length===1?'':'s'} · expires ${authority.expiresAt}`}</p>
    {!active && !stateLoading && state && !state.applicationRun ? <div className="workspace-empty automation-guided-empty"><strong>No application run is active.</strong><span>Scoped controls appear when there are jobs to review.</span></div>
      : !active?<form ref={scopeForm} className="automation-form approval-wizard" data-current-step={step} onSubmit={approve}>
      <fieldset disabled={disabled||busy||stateLoading||!state?.applicationRun}><legend className="visually-hidden">Application automation scope</legend>
      <p className="approval-progress" aria-live="polite">Step {step} of 3</p>
      <div data-approval-step="1">
        <h3 className="approval-step-title" tabIndex={-1}>Choose a mode</h3>
        <label><span className="approval-mode-label">Mode</span><select value={mode} onChange={event=>changeMode(event.target.value as Mode)}><option value="autofill_to_review">Autofill to Review</option><option value="campaign_to_review">Campaign to Review</option></select></label>
        <p className="approval-step-note">{mode==='autofill_to_review'?'Prepare one approved job up to Review.':'Prepare multiple approved jobs up to Review.'}</p>
      </div>
      <div data-approval-step="2">
        <h3 className="approval-step-title" tabIndex={-1}>Select jobs</h3>
        <fieldset className="automation-job-scope"><legend>Jobs in the active application run</legend>
          {eligibleJobs.map(jobChoice)}
          {!eligibleJobs.length && <p>{stateLoading?'Loading application run…':'No jobs are ready for this approval.'}</p>}
          {unavailableJobs.length>0 && <details className="approval-ineligible">
            <summary>{unavailableJobs.length} unavailable {unavailableJobs.length===1?'job':'jobs'}</summary>
            <div className="approval-ineligible-list">{unavailableJobs.map(jobChoice)}</div>
          </details>}
        </fieldset>
      </div>
      <div data-approval-step="3">
        <h3 className="approval-step-title" tabIndex={-1}>Confirm approval</h3>
        <div className="approval-scope">
          <strong>{mode==='autofill_to_review'?'Autofill to Review':'Campaign to Review'}</strong>
          <ul>{queued.filter(job=>selected.includes(job.id)).map(job=><li key={job.id}>{String(job.role||'Untitled role')} · {String(job.company||'Unknown company')}</li>)}</ul>
        </div>
        <label>Duration in minutes<input type="number" min="1" max="1440" required value={duration} onChange={event=>setDuration(Number(event.target.value))}/></label>
        <details><summary>Exact sensitive answer permissions</summary><label>Approved answer references, one per line<textarea rows={3} value={sensitive} onChange={event=>setSensitive(event.target.value)}/></label><small>Current use only. Values and broad sensitive categories are never authorized here.</small></details>
      </div>
      <div className="button-row approval-actions">
        {step>1&&<button className="secondary approval-wizard-button" type="button" onClick={()=>changeStep(step-1)}>Back</button>}
        {step<3&&<button className="primary approval-wizard-button" type="button" disabled={step===2&&!selected.length}
          onClick={()=>changeStep(step+1)}>{step===1?'Continue to jobs':'Review approval'}</button>}
        <button className="primary approval-submit" type="submit" disabled={!selected.length}>Approve bounded mode</button>
      </div>
      </fieldset></form>:<div className="button-row"><button className="secondary" disabled={disabled||busy} onClick={guided}>Return to Guided</button>
      {authority.mode==='campaign_to_review'&&authority.status==='active'&&<button className="secondary" disabled={disabled||busy} onClick={()=>control('pause')}>Pause campaign</button>}
      {authority.mode==='campaign_to_review'&&authority.status==='paused'&&<button className="secondary" disabled={disabled||busy} onClick={()=>control('resume')}>Resume campaign</button>}
      {authority.mode==='campaign_to_review'&&<button className="trash-delete" disabled={disabled||busy} onClick={()=>control('stop')}>Emergency stop</button>}</div>}
    {counts&&<div className="automation-status-strip" aria-label="Campaign progress"><span><strong>{counts.ready}</strong> ready</span><span><strong>{counts.inProgress}</strong> active</span><span><strong>{counts.needsAttention}</strong> needs attention</span><span><strong>{counts.awaitingReview}</strong> at review</span></div>}
    {notice&&<p className="notice" role="status">{notice}</p>}{error&&<p className="error" role="alert">{error}</p>}
  </section>;
}
