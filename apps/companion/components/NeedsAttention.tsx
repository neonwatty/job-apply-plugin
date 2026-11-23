'use client';
import { useState } from 'react';
import type { Client } from './client';
import { object, workspaceState } from './contracts';
import { attentionGuidance, attentionProjection, attentionReasons, filterAttention, handoffActionLabels, isCurrentHandoff, recordedFormActions, type AttentionItem, type AttentionReason } from './projection-model';
import { formatActivityTime, useProjection } from './projection-view';

const attentionActionLabels: Record<AttentionReason, string> = {
  awaiting_human_review: 'See review steps',
  browser_action_required: 'See browser steps',
  needs_information: 'See what’s missing',
  owner_confirmation_required: 'See what to confirm',
  pending_live_reconfirmation: 'See what to confirm',
  site_consent_conflict: 'See consent details',
  expired_agent_attempt: 'See recovery steps',
  claimless_interrupted_attempt: 'See recovery steps',
};

function displayAttention(item: AttentionItem) {
  const {session, missingInformationCount} = item;
  const currentHandoff = item.status === 'needs_info' && isCurrentHandoff(session, item.revision);
  const browserHandoff = currentHandoff && session.handoff === 'required';
  const checklist = currentHandoff ? recordedFormActions(session) : [];
  let {reasonCode} = item;
  if (reasonCode === 'needs_information' && browserHandoff && session.handoffReason === 'owner-upload-required'
    && missingInformationCount === 0n) reasonCode = 'browser_action_required';
  return {...item, reasonCode, checklist, browserHandoff};
}

function jobLabels(raw: string) {
  const {jobs} = workspaceState(object.parseJson(raw));
  return new Map(jobs.map(job => [job.id, {
    revision: job.revision,
    company: typeof job.company === 'string' ? job.company.trim() : '',
    role: typeof job.role === 'string' ? job.role.trim() : '',
  }]));
}

export function NeedsAttention({client,openJob,refreshKey=0}:{client:Client;openJob:(job:{id:string;revision:bigint})=>void;refreshKey?:number}) {
  const {data,loading,error,refresh}=useProjection(client,'/api/attention',attentionProjection,refreshKey);
  const labels = useProjection(client,'/api/state',jobLabels,refreshKey);
  function identity(item: AttentionItem) {
    const job = labels.data?.get(item.jobId);
    if (!job || job.revision !== item.revision) return [`Job ${item.jobId}`];
    const name = [job.company, job.role].filter(Boolean);
    return name.length ? name : [`Job ${item.jobId}`];
  }
  const [reason,setReason]=useState('');
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const visible=filterAttention(data?.items.map(displayAttention) ?? [],reason);
  const selected=visible.find(item=>item.jobId===selectedId) ?? visible[0];
  const checklist = selected?.checklist ?? [];
  const upload = selected?.reasonCode === 'browser_action_required'
    && checklist.length === 1 && checklist[0] === handoffActionLabels.resume_upload;
  const confirmBrowserStep = selected?.reasonCode === 'browser_action_required' && !selected.browserHandoff;
  return <section className="attention-workspace" aria-label="Needs Attention">
    <header className="workspace-hero">
      <div className="workspace-hero-copy">
        <h1>Needs attention</h1>
        <p>Select a job to review its next step. Final submission stays manual.</p>
      </div>
      <div className="workspace-hero-actions"><button type="button" onClick={() => { refresh(); labels.refresh(); }} disabled={loading || labels.loading}>Refresh attention</button></div>
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
            <ul className="attention-list focus-items" aria-label="Choose a job to review">{visible.map(item=>{
              const [title, role] = identity(item);
              return <li key={item.jobId}>
                <button className="focus-item" type="button" aria-pressed={selected?.jobId===item.jobId}
                  onClick={()=>setSelectedId(item.jobId)} aria-controls="focus-decision">
                  <span>{title}</span>
                  {role && <small>{role}</small>}
                  <small>{attentionReasons[item.reasonCode]}</small>
                </button>
              </li>;
            })}</ul>
            {selected && <div id="focus-decision" className="focus-decision" aria-live="polite">
              <p className="focus-context">{identity(selected).join(' · ')}</p>
              <h2>{attentionReasons[selected.reasonCode]}</h2>
              <p className="focus-guidance">{upload
                ? 'The agent paused at the upload control. Attach your saved resume in your application tab.'
                : confirmBrowserStep ? 'A browser action was recorded. Check your application tab or ask Job Apply to confirm the current step.'
                : attentionGuidance[selected.reasonCode]}</p>
              <dl className="focus-context-list">
                <div><dt>Since</dt><dd>{formatActivityTime(selected.attentionAt)}</dd></div>
                {selected.missingInformationCount > 0n && <div><dt>Missing information</dt><dd>{String(selected.missingInformationCount)}</dd></div>}
                {checklist.length > 0 && <div><dt>To do on form</dt><dd>{checklist.join(' · ')}</dd></div>}
              </dl>
              <button className="primary" type="button" onClick={()=>openJob({id:selected.jobId, revision:selected.revision})}
                disabled={loading || Boolean(error)}>{upload ? 'See upload steps'
                  : confirmBrowserStep ? 'Open job details' : attentionActionLabels[selected.reasonCode]}</button>
              {selected.reasonCode === 'awaiting_human_review' && <p className="focus-footnote">Only you can submit on the employer site.</p>}
              <span className="visually-hidden">Revision {String(selected.revision)}</span>
            </div>}
          </div>}
      </>}
    </div>
  </section>;
}
