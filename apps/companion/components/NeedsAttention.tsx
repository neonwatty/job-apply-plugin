'use client';
import { useState } from 'react';
import type { Client } from './client';
import { attentionGuidance, attentionProjection, attentionReasons, filterAttention, handoffChecklistLabels, type AttentionReason } from './projection-model';
import { humanize, useProjection } from './projection-view';
export function NeedsAttention({client,openJob,refreshKey=0}:{client:Client;openJob:(id:string)=>void;refreshKey?:number}) {
  const {data,loading,error,refresh}=useProjection(client,'/api/attention',attentionProjection,refreshKey);
  const [reason,setReason]=useState('');
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const visible=filterAttention(data?.items ?? [],reason);
  const selected=visible.find(item=>item.jobId===selectedId) ?? visible[0];
  return <section className="attention-workspace" aria-label="Needs Attention">
    <header className="workspace-hero">
      <div className="workspace-hero-copy">

        <h1>Needs attention</h1>
        <p>Select a job to review its next step. Final submission stays manual.</p>
      </div>
      <div className="workspace-hero-actions"><button type="button" onClick={refresh} disabled={loading}>Refresh attention</button></div>
    </header>
    <div className="workspace-panel attention-panel">
      <div className="workspace-panel-heading">
        <div><p className="eyebrow">Review queue</p><h2>Jobs requiring action</h2></div>
        <div className="attention-controls">
          {data && data.items.length>0 && <strong className="queue-count">{visible.length} {visible.length===1?'job':'jobs'}</strong>}
          {data && data.items.length>0 && <label>Filter by reason <select value={reason} onChange={event=>setReason(event.target.value)}>
            <option value="">All reasons</option>{Object.entries(attentionReasons).map(([code,label])=><option key={code} value={code}>{label}</option>)}
          </select></label>}
        </div>
      </div>
      {loading && <p className="workspace-status" role="status">{data?'Refreshing attention…':'Loading attention…'}</p>}
      {error && <p role="alert" className="error">{error} {data && 'Showing the last loaded data; it may be outdated.'}</p>}
      {data && <><p className="visually-hidden" role="status">{data.items.length} jobs need attention. {visible.length} shown.</p>
        {data.items.length===0 ? <div className="workspace-empty attention-empty"><span className="empty-check" aria-hidden="true">✓</span><strong>Nothing needs your attention.</strong><span>Check Jobs to continue preparing applications.</span></div>
          : visible.length===0 ? <div className="workspace-empty"><strong>No jobs match this reason filter.</strong><button className="text-action" type="button" onClick={()=>setReason('')}>Clear filter</button></div> :
          <div className="focus-review-layout">
            <ul className="attention-list focus-items" aria-label="Choose a job to review">{visible.map(item=><li key={item.jobId}>
              <button className="focus-item" type="button" aria-pressed={selected?.jobId===item.jobId}
                onClick={()=>setSelectedId(item.jobId)} aria-label={`Review job ${item.jobId}`} aria-controls="focus-decision">
                <span>{attentionReasons[item.reasonCode as AttentionReason]}</span>
                <small>Job {item.jobId}</small>
                <small>{humanize(item.status)}</small>
              </button>
            </li>)}</ul>
            {selected && <div id="focus-decision" className="focus-decision" aria-live="polite">
              <p className="focus-context">Job {selected.jobId}</p>
              <h2>{attentionReasons[selected.reasonCode]}</h2>
              <p className="focus-guidance">{attentionGuidance[selected.reasonCode]}</p>
              <dl className="focus-context-list">
                <div><dt>Current status</dt><dd>{humanize(selected.status)}</dd></div>
                <div><dt>Since</dt><dd>{selected.attentionAt}</dd></div>
                {['needs_information','pending_live_reconfirmation'].includes(selected.reasonCode) && <div><dt>Missing information</dt><dd>{String(selected.missingInformationCount)}</dd></div>}
                {selected.session.blockers.length>0 && <div><dt>Blockers</dt><dd>{selected.session.blockers.map(blocker=>humanize(blocker.code)).join(', ')}</dd></div>}
                {selected.session.handoffChecklist.length>0 && <div><dt>To do on form</dt><dd>{handoffChecklistLabels(selected.session.handoffChecklist).join(' · ')}</dd></div>}
                {selected.session.handoff!=='Not recorded' && <div><dt>Browser handoff</dt><dd>{humanize(selected.session.handoff)}{selected.session.handoffReason&&` · ${humanize(selected.session.handoffReason)}`}</dd></div>}
              </dl>
              <button className="primary" type="button" onClick={()=>openJob(selected.jobId)} aria-label={`Open job ${selected.jobId}`}>Open Job details</button>
              <p className="focus-footnote">Only you can submit on the employer site.</p>
              <span className="visually-hidden">Revision {String(selected.revision)}</span>
            </div>}
          </div>}
      </>}
    </div>
  </section>;
}
