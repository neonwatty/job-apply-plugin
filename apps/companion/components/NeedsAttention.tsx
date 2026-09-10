'use client';
import { useState } from 'react';
import type { Client } from './client';
import { attentionGuidance, attentionProjection, attentionReasons, filterAttention, type AttentionReason } from './projection-model';
import { humanize, useProjection } from './projection-view';
export function NeedsAttention({client,openJob}:{client:Client;openJob:(id:string)=>void}) {
  const {data,loading,error,refresh}=useProjection(client,'/api/attention',attentionProjection);
  const [reason,setReason]=useState('');
  const visible=filterAttention(data?.items ?? [],reason);
  return <section aria-label="Needs Attention" style={{minWidth:0,overflowWrap:'anywhere'}}>
    <h2>Needs Attention</h2>
    <p>Review jobs that need your information, browser action, or recovery. Final submission stays manual.</p>
    <label>Filter by reason <select value={reason} onChange={event=>setReason(event.target.value)}>
      <option value="">All reasons</option>{Object.entries(attentionReasons).map(([code,label])=><option key={code} value={code}>{label}</option>)}
    </select></label>{' '}<button type="button" onClick={refresh} disabled={loading}>Refresh attention</button>
    {loading && <p role="status">Loading attention…</p>}
    {error && <p role="alert">{error} {data && 'Showing the last successful snapshot; it may be stale.'}</p>}
    {data && <><p role="status">{data.items.length} jobs need attention. {visible.length} shown.</p>
      {data.items.length===0 ? <p>No jobs need attention.</p> : visible.length===0 ? <p>No jobs match this reason filter.</p> :
        <ul>{visible.map(item=><li key={item.jobId}>
          <h3>{attentionReasons[item.reasonCode as AttentionReason]}</h3>
          <p>Job: {item.jobId} · {humanize(item.status)} · Revision {String(item.revision)}</p>
          <p>Since {item.attentionAt}{item.reasonCode==='needs_information' && ` · ${item.missingInformationCount} missing information items`}</p>
          <p>{attentionGuidance[item.reasonCode]}</p>
          {item.session.blockers.length>0 && <p>{item.session.blockers.length} blockers: {item.session.blockers.map(blocker=>humanize(blocker.code)).join(', ')}</p>}
          <button type="button" onClick={()=>openJob(item.jobId)} aria-label={`Open job ${item.jobId}`}>Open Job details</button>
        </li>)}</ul>}
    </>}
  </section>;
}
