'use client';
import { useState } from 'react';
import { repeatReviewRequest } from '../repeat-review-request';
import type { Client } from './client';
import { activityProjection, handoffChecklistLabels, recoveryGuidance } from './projection-model';
import { humanize, useProjection } from './projection-view';
export function JobActivity({client,jobId,refreshKey=0,openAnswers}:{client:Client;jobId:string;refreshKey?:number|bigint;openAnswers?:()=>void}) {
  const [copyNotice,setCopyNotice]=useState('');
  const [fallback,setFallback]=useState('');
  const {data,loading,error,refresh}=useProjection(client,`/api/jobs/${encodeURIComponent(jobId)}/activity`,activityProjection,refreshKey);
  async function copyRepeatRequest() {
    const request=repeatReviewRequest(jobId);
    try { await navigator.clipboard.writeText(request); setFallback(''); setCopyNotice('Repeat-review request copied.'); }
    catch { setFallback(request); setCopyNotice('Clipboard unavailable. Select and copy the request below.'); }
  }
  return <section aria-label="Job activity" style={{minWidth:0,overflowWrap:'anywhere'}}>
    <h3>Job activity</h3><button type="button" onClick={refresh} disabled={loading}>Refresh activity</button>
    {loading && <p role="status">Loading job activity…</p>}
    {error && <p role="alert">{error} {data && 'Showing the last successful snapshot for this job; it may be stale.'}</p>}
    {data && <>
      <p>Status: {humanize(data.job.status)} · Revision {String(data.job.revision)}</p>
      {data.job.status==='awaiting_review' && data.claim.state==='none' && !error && <>
        <p>Want to repeat this review from a blank form? The agent will ask you to confirm the previous form was not submitted and request fresh form-specific approval.</p>
        <button type="button" onClick={() => void copyRepeatRequest()}>Copy repeat-review request</button>
        {copyNotice && <p role="status">{copyNotice}</p>}
        {fallback && <label className="clipboard-fallback">Request to copy<input readOnly value={fallback} onFocus={event=>event.currentTarget.select()} /></label>}
      </>}
      <h4>Agent attempt</h4><p>{humanize(data.claim.state)}</p>
      {data.claim.state==='active' || data.claim.state==='expired' ? <p>Acquired: {data.claim.acquiredAt}<br/>Last heartbeat: {data.claim.heartbeatAt}<br/>Expires: {data.claim.expiresAt}</p> : null}
      {(data.claim.state==='expired'||data.claim.state==='interrupted') && <p>{recoveryGuidance[data.claim.state]} Current job revision: {String(data.job.revision)}.</p>}
      {!data.session ? <p>No application session recorded.</p> : <>
        <h4>Application session</h4>
        <p>{humanize(data.session.status)} · Session revision {String(data.session.revision)}{data.session.attemptRevision!==undefined && ` · Attempt revision ${data.session.attemptRevision}`}</p>
        <p>Step: {data.session.step}<br/>Updated: {data.session.updatedAt}<br/>Readiness: {humanize(data.session.readiness)}</p>
        <p>Browser handoff: {humanize(data.session.handoff)}{data.session.handoffReason && ` · ${humanize(data.session.handoffReason)}`}</p>
        {data.session.handoff==='required' && <p>Continue in the visible browser. Personally review and perform final submission.</p>}
        <h4>To do on form</h4>
        {data.session.handoffChecklist.length>0 ? <ol>{handoffChecklistLabels(data.session.handoffChecklist).map(label=><li key={label}>{label}</li>)}</ol>
          : <p>{data.job.status==='needs_info' && !data.session.handoffChecklistRecorded ? 'Detailed actions were not recorded for this attempt. Check the agent’s handoff and the visible draft.' : 'No remaining form actions recorded.'}</p>}
        <h4>Optional fields left blank</h4>
        {!data.session.optionalUnansweredRecorded ? <p>Not recorded for this attempt.</p>
          : data.session.optionalUnansweredControlIds.length===0 ? <p>None recorded.</p>
            : <><p>These fields did not block manual review. Check the visible form if you want to answer them.</p>
              <ul>{data.session.optionalUnansweredControlIds.map(id=><li key={id}>{humanize(id).replaceAll('.',' ')}</li>)}</ul></>}
        <h4>Blockers</h4>{data.session.blockers.length===0 ? <p>No typed blockers recorded.</p> : <ul>{data.session.blockers.map((blocker,index)=><li key={index}>{humanize(blocker.type)}: {humanize(blocker.code)}</li>)}</ul>}
        <h4>Pending information</h4><p>{data.session.pending.length} pending items · {data.session.approvalCount} current session approvals</p>
        <ul>{data.session.pending.map((field,index)=><li key={index}>Item {index+1} · {humanize(field.fieldClass)} · {humanize(field.state)}. {field.sensitive ? 'Sensitive: separate confirmation required.' : field.eligible ? 'Saved answer eligible for recheck with your confirmation.' : 'Further review required before resolution.'} {field.approved ? 'Current session approval recorded.' : 'No current session approval.'}</li>)}</ul>
        {data.session.pending.length>0 && openAnswers && <button type="button" onClick={openAnswers}>Open Answers</button>}
      </>}
      <h4>History</h4>{data.history.length===0 ? <p>No history recorded for this job.</p> : <ol>{data.history.map((event,index)=><li key={index}>{event.at} · {humanize(event.event)} · {humanize(event.status)}</li>)}</ol>}
    </>}
  </section>;
}
