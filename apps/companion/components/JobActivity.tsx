'use client';
import type { Client } from './client';
import { activityProjection, recoveryGuidance } from './projection-model';
import { humanize, useProjection } from './projection-view';
export function JobActivity({client,jobId,refreshKey=0,openAnswers}:{client:Client;jobId:string;refreshKey?:number;openAnswers?:()=>void}) {
  const {data,loading,error,refresh}=useProjection(client,`/api/jobs/${encodeURIComponent(jobId)}/activity`,activityProjection,refreshKey);
  return <section aria-label="Job activity" style={{minWidth:0,overflowWrap:'anywhere'}}>
    <h3>Job activity</h3><button type="button" onClick={refresh} disabled={loading}>Refresh activity</button>
    {loading && <p role="status">Loading job activity…</p>}
    {error && <p role="alert">{error} {data && 'Showing the last successful snapshot for this job; it may be stale.'}</p>}
    {data && <>
      <p>Status: {humanize(data.job.status)} · Revision {String(data.job.revision)}</p>
      <h4>Agent attempt</h4><p>{humanize(data.claim.state)}</p>
      {data.claim.state==='active' || data.claim.state==='expired' ? <p>Acquired: {data.claim.acquiredAt}<br/>Last heartbeat: {data.claim.heartbeatAt}<br/>Expires: {data.claim.expiresAt}</p> : null}
      {(data.claim.state==='expired'||data.claim.state==='interrupted') && <p>{recoveryGuidance[data.claim.state]} Current job revision: {String(data.job.revision)}.</p>}
      {!data.session ? <p>No application session recorded.</p> : <>
        <h4>Application session</h4>
        <p>{humanize(data.session.status)} · Session revision {String(data.session.revision)}{data.session.attemptRevision!==undefined && ` · Attempt revision ${data.session.attemptRevision}`}</p>
        <p>Step: {data.session.step}<br/>Updated: {data.session.updatedAt}<br/>Readiness: {humanize(data.session.readiness)}</p>
        <p>Browser handoff: {humanize(data.session.handoff)}{data.session.handoffReason && ` · ${humanize(data.session.handoffReason)}`}</p>
        {data.session.handoff==='required' && <p>Continue in the visible browser. Personally review and perform final submission.</p>}
        <h4>Blockers</h4>{data.session.blockers.length===0 ? <p>No typed blockers recorded.</p> : <ul>{data.session.blockers.map((blocker,index)=><li key={index}>{humanize(blocker.type)}: {humanize(blocker.code)}</li>)}</ul>}
        <h4>Pending information</h4><p>{data.session.pending.length} pending items · {data.session.approvalCount} current session approvals</p>
        <ul>{data.session.pending.map((field,index)=><li key={index}>Item {index+1} · {humanize(field.fieldClass)} · {humanize(field.state)}. {field.sensitive ? 'Sensitive: separate confirmation required.' : field.eligible ? 'Saved answer eligible for recheck with your confirmation.' : 'Further review required before resolution.'} {field.approved ? 'Current session approval recorded.' : 'No current session approval.'}</li>)}</ul>
        {data.session.pending.length>0 && openAnswers && <button type="button" onClick={openAnswers}>Open Answers</button>}
      </>}
      <h4>History</h4>{data.history.length===0 ? <p>No history recorded for this job.</p> : <ol>{data.history.map((event,index)=><li key={index}>{event.at} · {humanize(event.event)} · {humanize(event.status)}</li>)}</ol>}
    </>}
  </section>;
}
