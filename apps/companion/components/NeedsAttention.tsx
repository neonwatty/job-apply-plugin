'use client';
import { useState } from 'react';
import type { Client } from './client';
import { attentionGuidance, attentionProjection, attentionReasons, filterAttention, type AttentionReason } from './projection-model';
import { humanize, useProjection } from './projection-view';
export function NeedsAttention({client,openJob}:{client:Client;openJob:(id:string)=>void}) {
  const {data,loading,error,refresh}=useProjection(client,'/api/attention',attentionProjection);
  const [reason,setReason]=useState('');
  const visible=filterAttention(data?.items ?? [],reason);
  return <section className="attention-workspace" aria-label="Needs Attention">
    <header className="workspace-hero">
      <div className="workspace-hero-copy">
        <p className="eyebrow">Needs attention</p>
        <h1>A calm queue for human intervention.</h1>
        <p>Review jobs that need your information, browser action, or recovery. Open a job to use the supported resolution actions; final submission stays manual.</p>
      </div>
      <div className="workspace-hero-actions"><button type="button" onClick={refresh} disabled={loading}>Refresh attention</button></div>
    </header>
    <div className="workspace-panel attention-panel">
      <div className="workspace-panel-heading">
        <div><p className="eyebrow">Canonical queue</p><h2>Jobs requiring action</h2></div>
        <div className="attention-controls">
          {data && <strong className="queue-count">{visible.length} {visible.length===1?'job':'jobs'}</strong>}
          <label>Filter by reason <select value={reason} onChange={event=>setReason(event.target.value)}>
            <option value="">All reasons</option>{Object.entries(attentionReasons).map(([code,label])=><option key={code} value={code}>{label}</option>)}
          </select></label>
        </div>
      </div>
      {loading && <p className="workspace-status" role="status">{data?'Refreshing attention…':'Loading attention…'}</p>}
      {error && <p role="alert" className="error">{error} {data && 'Showing the last successful snapshot; it may be stale.'}</p>}
      {data && <><p className="visually-hidden" role="status">{data.items.length} jobs need attention. {visible.length} shown.</p>
        {data.items.length===0 ? <div className="workspace-empty attention-empty"><span className="empty-check" aria-hidden="true">✓</span><strong>Nothing needs your attention.</strong><span>No jobs need attention.</span></div>
          : visible.length===0 ? <div className="workspace-empty"><strong>No jobs match this reason filter.</strong><button className="text-action" type="button" onClick={()=>setReason('')}>Clear filter</button></div> :
          <ul className="attention-list">{visible.map(item=>{
            const blockers=item.session.blockers.map(blocker=>humanize(blocker.code));
            const handoff=item.session.handoff==='Not recorded' ? '' : humanize(item.session.handoff);
            return <li key={item.jobId}>
              <button className="attention-card" type="button" onClick={()=>openJob(item.jobId)} aria-label={`Open job ${item.jobId}`}>
                <span className="attention-identity"><small>Application attention item</small><strong>{attentionReasons[item.reasonCode as AttentionReason]}</strong></span>
                <span className="attention-guidance">{attentionGuidance[item.reasonCode]}</span>
                <span className="attention-detail">
                  {blockers.length>0 && <span><small>Blockers</small><strong>{blockers.join(', ')}</strong></span>}
                  {handoff && <span><small>Browser handoff</small><strong>{handoff}{item.session.handoffReason&&` · ${humanize(item.session.handoffReason)}`}</strong></span>}
                </span>
                <span className="attention-meta">
                  <span><small>Status</small><strong>{humanize(item.status)}</strong></span>
                  <span><small>Since</small><strong>{item.attentionAt}</strong></span>
                  {item.reasonCode==='needs_information' && <span><small>Missing</small><strong>{String(item.missingInformationCount)}</strong></span>}
                </span>
                <span className="attention-action">Open Job details <span aria-hidden="true">→</span></span>
                <span className="visually-hidden">Revision {String(item.revision)}</span>
              </button>
            </li>;
          })}</ul>}
      </>}
    </div>
  </section>;
}
