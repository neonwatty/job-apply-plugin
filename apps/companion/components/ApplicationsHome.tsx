'use client';
import {useEffect,useState} from 'react';
import type {Client} from './client';
import type {Job,OverviewData} from './contracts';
import {NeedsAttention} from './NeedsAttention';
export function ApplicationsHome({client,refreshKey=0,openJob,openWorkspace,onMutation}:{client:Client;onMutation?:()=>void;refreshKey?:number;openJob:(id:string)=>void;openWorkspace:(view:'jobs'|'resumes'|'facts'|'settings')=>void}) {
  const [data,setData]=useState<{overview:OverviewData;jobs:Job[];queue:string[]}|null>(null);
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  const [completed,setCompleted]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    void Promise.all([client.overview(controller.signal),client.state(controller.signal)]).then(([overview,state])=>{
      if(!controller.signal.aborted){setData({overview,jobs:state.jobs,queue:state.applicationRun?.queueVersions.at(-1)?.jobIds ?? []});setError('');}
    }).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Unable to load applications');});
    return ()=>controller.abort();
  },[client,refreshKey,revision]);
  const setup=data?.overview.setup;
  const needsSetup=setup && (!setup.hasResume || !setup.hasProfileFacts);
  const jobs=data?.jobs ?? [];
  const queue=data?.queue ?? [];
  const upcoming=jobs.filter(job=>['saved','ready'].includes(job.status)).sort((a,b)=>(queue.includes(a.id)?queue.indexOf(a.id):Number.MAX_SAFE_INTEGER)-(queue.includes(b.id)?queue.indexOf(b.id):Number.MAX_SAFE_INTEGER)).slice(0,5);
  const running=jobs.filter(job=>job.status==='in_progress');
  const applied=jobs.filter(job=>job.status==='applied');
  const cards=(items:Job[])=>items.map(job=><button key={job.id} type="button" onClick={()=>openJob(job.id)} style={{display:'block',width:'100%',textAlign:'left',marginBottom:8}}><strong>{typeof job.company==='string'?job.company:'Company not recorded'}</strong> · {typeof job.role==='string'?job.role:'Role not recorded'}</button>);
  return <section aria-label="Applications">
    <header className="workspace-hero"><div><h1>Applications</h1><p>Your next step, from preparation to submission.</p></div><button onClick={()=>setRevision(v=>v+1)}>Refresh applications</button></header>
    {error && <p role="alert">{error} {data && 'Showing the last loaded information.'}<button onClick={()=>setRevision(v=>v+1)}>Retry</button></p>}
    {!data && !error && <p role="status">Loading applications…</p>}
    {needsSetup && <section className="workspace-panel" aria-label="Get ready to apply"><h2>{!setup.hasResume?'Add your resume':'Review your resume facts'}</h2><p>{!setup.hasResume?'Start with the resume you want to use for applications.':'Check the information extracted from your resume before starting an application.'}</p><button className="primary" onClick={()=>openWorkspace(!setup.hasResume?'resumes':setup.factsWorkspace ?? 'facts')}>{!setup.hasResume?'Add resume':'Review facts'}</button></section>}
    {data && !needsSetup && <>
      <div className="button-row"><button aria-pressed={!completed} onClick={()=>setCompleted(false)}>Active</button><button aria-pressed={completed} onClick={()=>setCompleted(true)}>Completed ({applied.length})</button></div>
      {completed ? <section className="workspace-panel" aria-label="Completed applications"><h2>Completed applications</h2>{applied.length?cards(applied):<p>No completed applications yet.</p>}</section> : <>
        <NeedsAttention client={client} refreshKey={refreshKey+revision} openJob={openJob} embedded onMutation={()=>{setRevision(v=>v+1);onMutation?.();}}/>
        {running.length>0 && <section className="workspace-panel"><h2>In progress</h2><p>These applications have been started. Check the review queue above for any steps that need your input.</p>{cards(running)}</section>}
        <section className="workspace-panel" aria-label="Up next"><h2>Up next</h2>{upcoming.length?<><p>Choose a saved job to review and prepare.</p>{cards(upcoming)}</>:<p>No saved jobs are waiting. Add an opportunity to get started.</p>}<button onClick={()=>openWorkspace('jobs')}>{jobs.length?'Browse saved jobs':'Add a job'}</button></section>
        <p className="focus-footnote">Resume and information ready. Only you submit applications.</p>
      </>}
    </>}
  </section>;
}
