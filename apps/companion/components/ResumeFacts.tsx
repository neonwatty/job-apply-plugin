'use client';
import { useEffect, useRef, useState } from 'react';
import { object, type ResumeRecord } from './contracts';
import type { Client } from './client';
import { ResumeFactEditor } from './resume-fact-editor';

import { copy, serialize, type Document } from '../../../src/contracts/workspace/values';
import { confirmationBody, draftBody, factVersion, type ExtractionRequestStatus, type FactVersion, type ResumeFactStatus } from './resume-facts-model';

/** Facts are loaded only for the resume the owner has opened. */
export function ResumeFacts({ client, resume, dirtyChanged, statusChanged, focusReview, requestStatus, refreshRequests, openExtractions }: {
  client: Client;
  resume: ResumeRecord;
  dirtyChanged: (dirty: boolean, busy: boolean) => void;
  statusChanged: (status: ResumeFactStatus) => void;
  focusReview: boolean;
  requestStatus: ExtractionRequestStatus;
  refreshRequests: () => void;
  openExtractions?: () => void;
}) {
  const [version, setVersion] = useState<FactVersion | null>(null);
  const [draft, setDraft] = useState<Document | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [invalid, setInvalid] = useState(false), [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(false);
  const form = useRef<HTMLFormElement | null>(null), generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const action = useRef<AbortController | null>(null);
  const dirty = invalid || version !== null && draft !== null && serialize(draft) !== serialize(version.facts);
  const local = useRef({ version, dirty });
  local.current = { version, dirty };
  useEffect(() => { dirtyChanged(dirty, busy || loading); }, [dirty, busy, loading, dirtyChanged]);
  useEffect(() => () => { action.current?.abort(); dirtyChanged(false, false); }, [dirtyChanged]);
  const path = `/api/resume-facts/${encodeURIComponent(resume.id)}`;
  useEffect(() => {
    if (!focusReview) return;
    const frame = requestAnimationFrame(() => {
      heading.current?.focus({preventScroll:true});
      heading.current?.scrollIntoView({block:'start'});
    });
    return () => cancelAnimationFrame(frame);
  }, [focusReview]);
  async function refresh(signal: AbortSignal, discard = false): Promise<void> {
    const ticket = ++generation.current;
    setLoading(true);
    try {
      const response = JSON.parse(await client.extractionRequest('/api/resume-facts', 'GET', undefined, signal));
      if (!object(response) || !Array.isArray(response.facts)) throw Error('Unable to read resume fact status.');
      const exists = response.facts.some(item => object(item) && item.resumeId === resume.id);
      const next = exists ? factVersion(await client.extractionRequest(path, 'GET', undefined, signal)) : null;
      if (signal.aborted || ticket !== generation.current) return;
      const current = local.current;
      if (!discard && current.dirty && current.version) {
        // Metadata refreshes may advance the resume without changing its extracted facts.
        // Keep the local draft; a changed fact version requires an explicit owner reload.
        const changed = !next || current.version.revision !== next.revision
          || current.version.contentRevision !== next.contentRevision
          || serialize(current.version.facts) !== serialize(next.facts);
        setConflict(changed);
        if (next && !changed) setVersion(next);
      } else {
        setVersion(next); setDraft(next ? copy(next.facts) : null);
        setInvalid(false); setConflict(false);
      }
      statusChanged(next === null ? 'none' : next.current ? next.state : 'stale');
    } finally { if (!signal.aborted && ticket === generation.current) setLoading(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load facts.'); });
    return () => controller.abort();
  }, [client, resume.id, resume.revision]);
  function invalidNumbers() {
    return Array.from(form.current?.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]') ?? [])
      .some(input => !input.validity.valid);
  }
  async function save() {
    if (!version || busy || loading || conflict || invalid) return;
    if (!draft) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      await client.extractionRequest(path, 'POST', draftBody(draft, resume.revision, version.revision), controller.signal);
      await refresh(controller.signal, true);
      setNotice('Fact edits saved as a new draft. Review and confirm it before application use.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save facts.'); }
    finally { setBusy(false); }
  }
  async function confirmFacts() {
    if (!version || busy || loading || conflict || dirty || version.state !== 'draft' || !version.current) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      await client.extractionRequest(`${path}/confirm`, 'POST', confirmationBody(version), controller.signal);
      await refresh(controller.signal, true);
      setNotice('These facts are confirmed for this resume.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to confirm facts.'); }
    finally { setBusy(false); }
  }
  async function refreshFacts() {
    if (busy || loading || dirty
      && !confirm('Discard unsaved fact edits?')) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      await refresh(controller.signal, true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to refresh facts.'); }
    finally {
      if (!controller.signal.aborted) refreshRequests();
      setBusy(false);
    }
  }
  return <section className="workspace-panel resume-facts-panel" aria-label={`Facts for ${resume.label}`}>
    <div className="resume-facts-heading"><div><p className="eyebrow">Resume facts</p><h3 ref={heading} tabIndex={-1}>Facts from {resume.label}</h3></div>
      <div className="resume-facts-sync"><button className="secondary" disabled={busy || loading} onClick={() => void refreshFacts()}>Check for agent updates</button>
        <small>Reload facts saved for this resume by a Job Apply agent.</small></div></div>
    {(requestStatus === 'waiting' || requestStatus === 'unavailable') && <div className="resume-facts-waiting">
      {requestStatus === 'unavailable' ? <p role="alert">Extraction request status unavailable. Use “Check for agent updates” to retry.</p>
        : <p>{version?.current ? 'A new extraction is waiting for a Job Apply agent.' : 'Waiting for a Job Apply agent to extract facts for this resume.'}</p>}
      {openExtractions && <button className="secondary" type="button" disabled={busy || loading} onClick={openExtractions}>
        View extraction requests</button>}
    </div>}
    {loading && !version && <p role="status">Loading resume facts…</p>}
    {!version && requestStatus === 'none' && !loading && !error && <p>No facts have been extracted for this resume yet.</p>}
    {version && <>
      <p className="resume-facts-meta"><strong data-state={version.current ? version.state : 'stale'}>{!version.current ? 'Earlier file' : version.state === 'draft' ? 'Draft to review' : 'Confirmed for this resume'}</strong>
        <span>Revision {version.revision.toString()}</span></p>
      {version.current && version.state === 'draft'
        ? <p>Review the draft and confirm the facts Job Apply can use when you select this resume for an application run.</p>
        : !version.current && <p>These facts belong to an earlier resume file. Review a new extraction from the current file before using its facts.</p>}
      {version.current && version.state === 'confirmed' && <p>When you start an application run, confirm the selected resume and facts with Job Apply in chat.</p>}
      <form ref={form} noValidate onChange={() => setInvalid(invalidNumbers())}
        onSubmit={event => { event.preventDefault(); if (!invalidNumbers()) void save(); }}>
      {draft && <ResumeFactEditor facts={draft} disabled={busy || loading || !version.current} change={setDraft} />}
      <div className="resume-editor-actions">
        <button type="submit" className="secondary" disabled={busy || loading || conflict || invalid || !version.current || !dirty}>Save edits as draft</button>
        <button type="button" className="primary" disabled={busy || loading || conflict || !version.current || version.state !== 'draft'
          || dirty} onClick={() => void confirmFacts()}>Confirm facts for this resume</button>
      </div></form>
      {version.versions.length > 1 && <details className="resume-facts-history"><summary>Earlier fact revisions</summary>
        {version.versions.slice(0, -1).map(item => <details key={item.revision.toString()}>
          <summary>Revision {item.revision.toString()} · {item.state}</summary>
          <pre>{serialize(item.facts)}</pre>
        </details>)}
      </details>}
    </>}
    {conflict && <p role="alert" className="notice">These facts changed elsewhere. Your draft is preserved. Use “Check for agent updates” to review the latest facts before saving.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
  </section>;
}
