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

export function Extractions({ client, dirtyChanged }: { client: ExtractionClient; dirtyChanged: (dirty: boolean) => void }) {
  const [resumes, setResumes] = useState<Document[]>([]);
  const [requests, setRequests] = useState<Document[]>([]);
  const [proposals, setProposals] = useState<Document[]>([]);
  const [resumeId, setResumeId] = useState('');
  const [base, setBase] = useState<Document | null>(null);
  const [latest, setLatest] = useState<Document | null>(null);
  const [choices, setChoices] = useState<Choices>({});
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0), listGeneration = useRef(0);
  const request = useRef<AbortController | null>(null), listRequest = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dirty = Object.keys(choices).length > 0;
  const managed = resumes.filter(item => string(get(item, 'storageKind')) === 'managed' && get(item, 'deletedAt') === null);
  const selectedResume = managed.find(item => string(get(item, 'id')) === resumeId);
  useEffect(() => { dirtyChanged(dirty || busy); return () => dirtyChanged(false); }, [dirty, busy, dirtyChanged]);
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
    setError('');
    setNotice('');
    const path = '/api/resume-extraction-requests' + (record ? `/${encodeURIComponent(string(get(record, 'requestId'))!)}/${action}` : '');
    try {
      await client.extractionRequest(path, 'POST', requestMutation(resume, record, action), controller.signal);
      if (version !== generation.current) return;
      setNotice(action === 'cancel' ? 'Extraction request cancelled.' : 'Extraction requested. An agent can now extract facts from this resume.');
      await refreshLists();
    } catch (failure) {
      if (version === generation.current && !controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : 'Unable to update extraction request');
        await refreshLists();
      }
    } finally { if (version === generation.current) setBusy(false); }
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
    setError('');
    setNotice('');
    try {
      await client.extractionRequest(`/api/resume-proposals/${encodeURIComponent(id)}/review`, 'POST', body, controller.signal);
      if (version !== generation.current) return;
      // The mutation succeeded even if its subsequent detail refresh fails.
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
      setError(failure instanceof Error ? failure.message : 'Unable to save review');
      try {
        const next = proposalSnapshot(await client.extractionRequest(`/api/resume-proposals/${encodeURIComponent(id)}`, 'GET', undefined, controller.signal));
        if (version === generation.current && string(get(next, 'id')) === id) setLatest(next);
      } catch { /* Keep the original failure and unsaved choices visible. */ }
    } finally { if (version === generation.current) setBusy(false); }
  }
  const staleReasons = base ? get(base, 'staleReasons') : null;
  const stale = Array.isArray(staleReasons) && staleReasons.length > 0;
  return <section>
    <h1>Resume extraction</h1>
    <p>Request an agent to extract facts from a managed resume, then review any conflicts with your current facts.</p>
    <button disabled={busy || loading} onClick={() => { setError(''); void refreshLists(); }}>Refresh extraction status</button>
    {loading && <p role="status">Loading extraction status…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <form onSubmit={event => { event.preventDefault(); if (selectedResume) void mutateRequest(selectedResume); }}>
      <label>Resume to extract<select value={resumeId} disabled={busy || loading} onChange={event => setResumeId(event.target.value)}>
        <option value="">Choose a managed resume</option>{managed.map(item => <option key={string(get(item, 'id'))!} value={string(get(item, 'id'))!}>{string(get(item, 'label')) || 'Untitled resume'}</option>)}
      </select></label>
      <button disabled={busy || loading || !selectedResume || requests.some(item => string(get(item, 'resumeId')) === resumeId && string(get(item, 'status')) === 'requested')}>Request extraction</button>
    </form>
    {loaded && !managed.length && <p>Import or adopt a resume in Resumes before requesting extraction.</p>}
    <h2>Extraction requests</h2>
    {loaded && !requests.length && <p>No extraction requests yet.</p>}
    <ul>{requests.map(item => {
      const id = string(get(item, 'requestId'))!, status = string(get(item, 'status'));
      const resume = resumes.find(value => string(get(value, 'id')) === string(get(item, 'resumeId')));
      return <li key={id}>
        <p>{resume ? string(get(resume, 'label')) || 'Untitled resume' : 'Unavailable resume'} — {status}</p>
        {string(get(item, 'failureReason')) && <p>{reasonMessage(string(get(item, 'failureReason'))!)}</p>}
        {status === 'requested' && <button disabled={busy || loading} onClick={() => void mutateRequest(resume ?? item, item, 'cancel')}>Cancel extraction</button>}
        {(status === 'failed' || status === 'stale') && <button disabled={busy || loading || !resume || string(get(resume, 'storageKind')) !== 'managed' || get(resume, 'deletedAt') !== null} onClick={() => { if (resume) void mutateRequest(resume, item, 'retry'); }}>Retry extraction</button>}
        {string(get(item, 'proposalId')) && <button disabled={busy} onClick={() => void selectProposal(string(get(item, 'proposalId'))!)}>Review extraction result</button>}
      </li>;
    })}</ul>
    <h2>Extracted proposals</h2>
    {loaded && !proposals.length && <p>No extracted proposals yet.</p>}
    <ul>{proposals.map(item => {
      const id = string(get(item, 'id'))!;
      const resume = resumes.find(value => string(get(value, 'id')) === string(get(item, 'resumeId')));
      return <li key={id}><button disabled={busy} onClick={() => void selectProposal(id)}>
        {resume ? string(get(resume, 'label')) || 'Untitled resume' : 'Unavailable resume'} — {string(get(item, 'status'))} — {serialize(get(item, 'pendingCount'))} decisions remaining
      </button></li>;
    })}</ul>
    <h2 ref={heading} tabIndex={-1}>Proposal review</h2>
    {base && <div>
      <p>Status: {string(get(base, 'status'))}. {pendingPaths(base).length} decisions remaining.</p>
      <p>{serialize(get(base, 'autoFilledCount'))} missing facts were filled automatically. Review existing conflicts below.</p>
      <button disabled={busy} onClick={() => void selectProposal(string(get(base, 'id'))!, true)}>Refresh selected proposal</button>
      {stale && <p role="alert">{staleReasons.map(value => reasonMessage(string(value) ?? '')).join(' ')} Request a new extraction before reviewing it.</p>}
      {latest && <aside role="alert">
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
      {string(get(base, 'status')) === 'completed' && <p>This proposal is complete. No further review is needed.</p>}
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
        <button disabled={busy || Boolean(latest) || stale || !dirty || string(get(base, 'status')) !== 'pending'}>Save review decisions</button>
      </form>}
    </div>}
  </section>;
}
