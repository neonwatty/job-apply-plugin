'use client';
import { useEffect, useRef, useState } from 'react';
import { get, serialize, string } from '../../../src/contracts/workspace/values';
import { ExtractionReview } from './extraction-review';
import { extractionList, pendingPaths, proposalSnapshot, reapplyChoices, requestMutation, reviewMutation } from './extraction-model';
import type { Choices, Document, ExtractionClient } from './extraction-model';

const reasonMessages = new Map([
  ['content_unreadable', 'The resume content could not be read.'],
  ['unsupported_resume', 'This resume format could not be extracted.'],
  ['extraction_failed', 'The extraction did not finish successfully.'],
  ['candidate_invalid', 'The extracted facts could not be validated.'],
  ['interrupted', 'The extraction was interrupted.'],
  ['resume_deleted', 'The resume was deleted.'],
  ['resume_trashed', 'The resume is in Trash.'],
  ['resume_not_managed', 'The resume is no longer a managed file.'],
  ['resume_content_revision_changed', 'The resume content was replaced.'],
  ['resume_revision_changed', 'The resume changed after this extraction.'],
  ['resume_digest_changed', 'The resume content changed after this extraction.'],
  ['resume_file_missing', 'The resume file is missing.'],
  ['resume_file_changed', 'The resume file changed after this extraction.'],
]);
const reasonMessage = (code: string): string => reasonMessages.get(code) ?? 'The extraction is no longer available for review.';
const extractionHandoff = (requestId: string): string =>
  `Use the Job Apply resume workflow to process extraction request ${requestId}.`;
const fallbackNotice = 'Clipboard unavailable. Select and copy the agent handoff below.';

export function Extractions({ client, dirtyChanged, openResumes }: { client: ExtractionClient; dirtyChanged: (dirty: boolean) => void; openResumes?:()=>void }) {
  const [resumes, setResumes] = useState<Document[]>([]);
  const [requests, setRequests] = useState<Document[]>([]);
  const [proposals, setProposals] = useState<Document[]>([]);
  const [resumeId, setResumeId] = useState('');
  const [base, setBase] = useState<Document | null>(null);
  const [latest, setLatest] = useState<Document | null>(null);
  const [choices, setChoices] = useState<Choices>({});
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fallback, setFallback] = useState<{requestId:string;value:string}|null>(null);
  const generation = useRef(0), listGeneration = useRef(0);
  const request = useRef<AbortController | null>(null), listRequest = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dirty = Object.keys(choices).length > 0;
  const managed = resumes.filter(item => string(get(item, 'storageKind')) === 'managed' && get(item, 'deletedAt') === null);
  const selectedResume = managed.find(item => string(get(item, 'id')) === resumeId);
  useEffect(() => { dirtyChanged(dirty || writing); return () => dirtyChanged(false); }, [dirty, writing, dirtyChanged]);
  useEffect(() => () => {
    generation.current++;
    listGeneration.current++;
    request.current?.abort();
    listRequest.current?.abort();
  }, []);
  async function refreshLists() {
    listRequest.current?.abort();
    const controller = new AbortController(), version = ++listGeneration.current;
    listRequest.current = controller;
    setLoading(true);
    try {
      const results = await Promise.all(['resumes', 'resume-extraction-requests', 'resume-proposals'].map(path =>
        client.extractionRequest(`/api/${path}`, 'GET', undefined, controller.signal)));
      const nextResumes = extractionList(results[0]!, 'resumes');
      const nextRequests = extractionList(results[1]!, 'requests');
      const nextProposals = extractionList(results[2]!, 'proposals');
      if (version !== listGeneration.current) return;
      setResumes(nextResumes);
      setRequests(nextRequests);
      setProposals(nextProposals);
      setFallback(current => current && nextRequests.some(item => string(get(item, 'requestId')) === current.requestId
        && string(get(item, 'status')) === 'requested') ? current : null);
      setNotice(current => current === fallbackNotice ? '' : current);
      setLoaded(true);
    } catch (failure) {
      if (version === listGeneration.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load extraction status');
    } finally { if (version === listGeneration.current) setLoading(false); }
  }
  useEffect(() => { void refreshLists(); }, [client]);
  function loadProposal(next: Document) {
    setBase(next);
    setLatest(null);
    setChoices({});
    setConfirmed([]);
  }
  async function selectProposal(id: string, refresh = false) {
    if (!refresh && dirty && !confirm('Discard your unsaved review decisions?')) return;
    request.current?.abort();
    const controller = new AbortController(), version = ++generation.current;
    request.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = proposalSnapshot(await client.extractionRequest(`/api/resume-proposals/${encodeURIComponent(id)}`, 'GET', undefined, controller.signal));
      if (version !== generation.current) return;
      if (string(get(next, 'id')) !== id) throw Error('Proposal identity changed. Refresh the proposal list.');
      if (refresh && dirty) {
        setLatest(next);
        setNotice('Latest comparisons loaded. Your decisions are retained until you choose how to continue.');
      } else loadProposal(next);
      heading.current?.focus();
    } catch (failure) {
      if (version === generation.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load proposal');
    } finally { if (version === generation.current) setBusy(false); }
  }
  async function mutateRequest(resume: Document, record?: Document, action?: string) {
    const controller = new AbortController(), version = ++generation.current;
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setWriting(true);
    setError('');
    setNotice('');
    const path = '/api/resume-extraction-requests' + (record ? `/${encodeURIComponent(string(get(record, 'requestId'))!)}/${action}` : '');
    try {
      await client.extractionRequest(path, 'POST', requestMutation(resume, record, action), controller.signal);
      if (version !== generation.current) return;
      setWriting(false);
      if (action === 'cancel' && record) {
        const requestId = string(get(record, 'requestId'));
        setFallback(current => current?.requestId === requestId ? null : current);
      }
      setNotice(action === 'cancel' ? 'Extraction request cancelled.' : 'Extraction requested. An agent can now extract facts from this resume.');
      await refreshLists();
    } catch (failure) {
      if (version === generation.current && !controller.signal.aborted) {
        setWriting(false);
        setError(failure instanceof Error ? failure.message : 'Unable to update extraction request');
        await refreshLists();
      }
    } finally { if (version === generation.current) { setBusy(false); setWriting(false); } }
  }
  async function copyHandoff(requestId: string) {
    const value = extractionHandoff(requestId);
    try {
      await navigator.clipboard.writeText(value);
      setFallback(null);
      setNotice('Agent handoff copied.');
    } catch {
      setFallback({requestId, value});
      setNotice(fallbackNotice);
    }
  }
  async function saveReview() {
    if (!base || latest) return;
    let body: string;
    try { body = reviewMutation(base, choices, confirmed); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Invalid review choices'); return; }
    const controller = new AbortController(), version = ++generation.current;
    request.current?.abort();
    request.current = controller;
    const id = string(get(base, 'id'))!;
    setBusy(true);
    setWriting(true);
    setError('');
    setNotice('');
    let committed = false;
    try {
      await client.extractionRequest(`/api/resume-proposals/${encodeURIComponent(id)}/review`, 'POST', body, controller.signal);
      if (version !== generation.current) return;
      committed = true;
      setWriting(false);
      setBase(null);
      setChoices({});
      setConfirmed([]);
      setLatest(null);
      setNotice('Review decisions saved.');
      const next = proposalSnapshot(await client.extractionRequest(`/api/resume-proposals/${encodeURIComponent(id)}`, 'GET', undefined, controller.signal));
      if (version !== generation.current) return;
      if (string(get(next, 'id')) !== id) throw Error('Proposal identity changed. Refresh the proposal list.');
      loadProposal(next);
      await refreshLists();
    } catch (failure) {
      if (version !== generation.current || controller.signal.aborted) return;
      setWriting(false);
      if (committed) {
        setError('Review decisions were saved, but current proposal details could not be refreshed. Refresh extraction status to load the latest state.');
        return;
      }
      setError(failure instanceof Error ? failure.message : 'Unable to save review');
      try {
        const next = proposalSnapshot(await client.extractionRequest(`/api/resume-proposals/${encodeURIComponent(id)}`, 'GET', undefined, controller.signal));
        if (version === generation.current && string(get(next, 'id')) === id) setLatest(next);
      } catch { /* Keep the original failure and unsaved choices visible. */ }
    } finally { if (version === generation.current) { setBusy(false); setWriting(false); } }
  }
  const staleReasons = base ? get(base, 'staleReasons') : null;
  const stale = Array.isArray(staleReasons) && staleReasons.length > 0;
  const activeRequests = requests.filter(item => string(get(item, 'status')) === 'requested').length;
  const pendingProposals = proposals.filter(item => string(get(item, 'status')) === 'pending').length;
  return <section className="extractions-workspace" aria-labelledby="extractions-workspace-title">
    <header className="workspace-hero"><div className="workspace-hero-copy"><p className="eyebrow">Resumes · Resume intelligence</p><h1 id="extractions-workspace-title">Resume extraction</h1><p>Request an agent to extract facts from a managed resume, then review any conflicts with your current canonical profile.</p></div><div className="workspace-hero-actions">{openResumes&&<button className="secondary" disabled={busy} onClick={openResumes}>Back to resumes</button>}<button className="secondary" disabled={busy || loading} onClick={() => { setError(''); void refreshLists(); }}>Refresh extraction status</button></div></header>
    <div className="extraction-metrics" aria-label="Extraction summary">
      <div><strong>{managed.length}</strong><span>Managed resumes</span></div><div><strong>{activeRequests}</strong><span>Active requests</span></div><div><strong>{pendingProposals}</strong><span>Proposals to review</span></div>
    </div>
    <section className="workspace-panel extraction-request-panel" aria-labelledby="extraction-request-heading">
      <div className="workspace-panel-heading"><div><p className="eyebrow">Start extraction</p><h2 id="extraction-request-heading">Request facts from a resume</h2></div><span className="extraction-step">Step 1 of 3</span></div>
      <p className="workspace-status" role="status">{loading ? 'Loading extraction status…' : notice || 'Choose a managed resume to prepare an extraction request.'}</p>
      {fallback && <label className="clipboard-fallback">Agent handoff to copy<input readOnly value={fallback.value} onFocus={event => event.currentTarget.select()} /></label>}
      {error && <p className="error" role="alert">{error}</p>}
      <form className="extraction-request-form" onSubmit={event => { event.preventDefault(); if (selectedResume) void mutateRequest(selectedResume); }}>
        <label>Resume to extract<select value={resumeId} disabled={busy || loading} onChange={event => setResumeId(event.target.value)}>
          <option value="">Choose a managed resume</option>{managed.map(item => <option key={string(get(item, 'id'))!} value={string(get(item, 'id'))!}>{string(get(item, 'label')) || 'Untitled resume'}</option>)}
        </select></label>
        <button className="primary" disabled={busy || loading || !selectedResume || requests.some(item => string(get(item, 'resumeId')) === resumeId && string(get(item, 'status')) === 'requested')}>Request extraction</button>
      </form>
      {loaded && !managed.length && <div className="workspace-empty extraction-empty"><strong>No managed resumes are available.</strong><span>Import or adopt a resume in Resumes before requesting extraction.</span></div>}
    </section>
    <div className="extraction-queues">
    <section className="workspace-panel extraction-queue-panel" aria-labelledby="extraction-requests-heading"><div className="extraction-panel-heading"><div><p className="eyebrow">Agent work</p><h2 id="extraction-requests-heading">Extraction requests</h2></div><span>Step 2 of 3</span></div>
    {loaded && !requests.length && <div className="workspace-empty extraction-empty"><strong>No extraction requests yet.</strong><span>New requests will appear here while an agent processes them.</span></div>}
    <ul className="extraction-list">{requests.map(item => {
      const id = string(get(item, 'requestId'))!, status = string(get(item, 'status'));
      const resume = resumes.find(value => string(get(value, 'id')) === string(get(item, 'resumeId')));
      return <li key={id}>
        <div className="extraction-item-heading"><strong>{resume ? string(get(resume, 'label')) || 'Untitled resume' : 'Unavailable resume'}</strong><span className={`status-pill status-${status}`}>{status}</span></div>
        {string(get(item, 'failureReason')) && <p>{reasonMessage(string(get(item, 'failureReason'))!)}</p>}
        <div className="button-row">{status === 'requested' && <><button className="secondary" disabled={busy || loading} onClick={() => void copyHandoff(id)}>Copy agent handoff</button><button className="secondary" disabled={busy || loading} onClick={() => void mutateRequest(resume ?? item, item, 'cancel')}>Cancel extraction</button></>}
        {(status === 'failed' || status === 'stale') && <button className="secondary" disabled={busy || loading || !resume || string(get(resume, 'storageKind')) !== 'managed' || get(resume, 'deletedAt') !== null} onClick={() => { if (resume) void mutateRequest(resume, item, 'retry'); }}>Retry extraction</button>}
        {string(get(item, 'proposalId')) && <button className="primary" disabled={busy} onClick={() => void selectProposal(string(get(item, 'proposalId'))!)}>Review extraction result</button>}</div>
      </li>;
    })}</ul>
    </section>
    <section className="workspace-panel extraction-queue-panel" aria-labelledby="extracted-proposals-heading"><div className="extraction-panel-heading"><div><p className="eyebrow">Review queue</p><h2 id="extracted-proposals-heading">Extracted proposals</h2></div><span>Step 3 of 3</span></div>
    {loaded && !proposals.length && <div className="workspace-empty extraction-empty"><strong>No extracted proposals yet.</strong><span>Completed agent requests will create reviewable proposals here.</span></div>}
    <ul className="extraction-list proposal-list">{proposals.map(item => {
      const id = string(get(item, 'id'))!;
      const resume = resumes.find(value => string(get(value, 'id')) === string(get(item, 'resumeId')));
      return <li key={id}><button className="extraction-proposal-button" disabled={busy} onClick={() => void selectProposal(id)}>
        <span><strong>{resume ? string(get(resume, 'label')) || 'Untitled resume' : 'Unavailable resume'}</strong><small>{string(get(item, 'status'))}</small></span><span>{serialize(get(item, 'pendingCount'))} decisions remaining</span><b aria-hidden="true">→</b>
      </button></li>;
    })}</ul>
    </section></div>
    <section className="workspace-panel proposal-review-panel" aria-labelledby="proposal-review-heading"><div className="workspace-panel-heading"><div><p className="eyebrow">Extraction review</p><h2 id="proposal-review-heading" ref={heading} tabIndex={-1}>Proposal review</h2></div>{base && <span className="extraction-step">{pendingPaths(base).length} decisions remaining</span>}</div>
    {base ? <div className="proposal-review-body">
      <div className="proposal-summary-native"><div><small>Status</small><strong>{string(get(base, 'status'))}</strong></div><div><small>Auto-filled</small><strong>{serialize(get(base, 'autoFilledCount'))} missing facts</strong></div></div>
      <p>Review existing conflicts below. Unselected paths remain pending.</p>
      <button className="secondary" disabled={busy} onClick={() => void selectProposal(string(get(base, 'id'))!, true)}>Refresh selected proposal</button>
      {stale && <p className="error" role="alert">{staleReasons.map(value => reasonMessage(string(value) ?? '')).join(' ')} Request a new extraction before reviewing it.</p>}
      {latest && <aside className="notice" role="alert">
        <p>Your decisions are retained. Reapply them to display the latest comparisons, then review each choice and confirm any replacements again.</p>
        <button disabled={busy} onClick={() => {
          setChoices(reapplyChoices(choices, latest));
          setBase(latest);
          setLatest(null);
          setConfirmed([]);
          setNotice('Decisions reapplied to the latest comparisons. Decisions for resolved fields were removed. Review before saving.');
        }}>Reapply my decisions</button>
        <button disabled={busy} onClick={() => { if (confirm('Discard your unsaved review decisions?')) loadProposal(latest); }}>Load saved proposal</button>
      </aside>}
      {string(get(base, 'status')) === 'completed' && <p className="notice">This proposal is complete. No further review is needed.</p>}
      {string(get(base, 'status')) === 'superseded' && <p>A newer extraction replaced this proposal. Open the latest proposal to continue.</p>}
      {pendingPaths(base).length > 0 && <form onSubmit={event => { event.preventDefault(); void saveReview(); }}>
        <ExtractionReview proposal={base} choices={choices} confirmed={confirmed} disabled={busy || Boolean(latest) || stale || string(get(base, 'status')) !== 'pending'} change={(pointer, decision) => {
          setChoices(previous => {
            const next = { ...previous };
            if (decision) next[pointer] = decision;
            else delete next[pointer];
            return next;
          });
          setConfirmed(previous => previous.filter(item => item !== pointer));
        }} confirmReplacement={(pointer, checked) => setConfirmed(previous => checked ? [...previous.filter(item => item !== pointer), pointer] : previous.filter(item => item !== pointer))} />
        <div className="proposal-review-actions"><button className="primary" disabled={busy || Boolean(latest) || stale || !dirty || string(get(base, 'status')) !== 'pending'}>Save review decisions</button></div>
      </form>}
    </div> : <div className="workspace-empty proposal-review-empty"><strong>Select an extraction result to review.</strong><span>Current facts stay unchanged until you explicitly save review decisions.</span></div>}
    </section>
  </section>;
}
