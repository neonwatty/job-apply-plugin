'use client';
import { useEffect, useRef, useState } from 'react';
import { object, type ResumeRecord } from './contracts';
import type { Client } from './client';
import { ResumeFactEditor } from './resume-fact-editor';

import { copy, serialize, type Document } from '../../../src/contracts/workspace/values';
import { confirmationBody, draftBody, factVersion, type FactVersion } from './resume-facts-model';

/** Facts are loaded only for the resume the owner has opened. */
export function ResumeFacts({ client, resume, dirtyChanged, statusChanged }: { client: Client; resume: ResumeRecord;
  dirtyChanged: (dirty: boolean, busy: boolean) => void; statusChanged: (status: string) => void }) {
  const [version, setVersion] = useState<FactVersion | null>(null);
  const [draft, setDraft] = useState<Document | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [invalid, setInvalid] = useState(false), [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(false);
  const form = useRef<HTMLFormElement | null>(null), generation = useRef(0);
  const action = useRef<AbortController | null>(null);
  const dirty = invalid || version !== null && draft !== null && serialize(draft) !== serialize(version.facts);
  const local = useRef({ version, dirty });
  local.current = { version, dirty };
  useEffect(() => { dirtyChanged(dirty, busy || loading); }, [dirty, busy, loading, dirtyChanged]);
  useEffect(() => () => { action.current?.abort(); dirtyChanged(false, false); }, [dirtyChanged]);
  const path = `/api/resume-facts/${encodeURIComponent(resume.id)}`;
  function publishStatus(next: FactVersion | null) {
    statusChanged(next === null ? 'No extracted facts' : next.current === false ? 'Stale facts'
      : next.state === 'confirmed' ? 'Facts confirmed' : 'Draft facts to review');
  }
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
      publishStatus(next);
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
      setNotice('These facts are confirmed for this resume. Confirm this resume and fact revision with the agent when starting an application run.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to confirm facts.'); }
    finally { setBusy(false); }
  }
  async function refreshFacts() {
    if (busy || loading || dirty
      && !confirm('Discard unsaved fact edits?')) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(true); setError(''); setNotice('');
    try { await refresh(controller.signal, true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to refresh facts.'); }
    finally { setBusy(false); }
  }
  return <section className="workspace-panel resume-facts-panel" aria-label={`Facts for ${resume.label}`}>
    <div className="resume-facts-heading"><div><p className="eyebrow">Resume facts</p><h3>Facts from {resume.label}</h3></div>
      <div className="resume-facts-sync"><button className="secondary" disabled={busy || loading} onClick={() => void refreshFacts()}>Check for agent updates</button>
        <small>Reload facts saved for this resume by a Job Apply agent.</small></div></div>
    {!version && <p>No extracted facts yet. The agent can process this resume’s extraction request.</p>}
    {version && <>
      <p className="resume-facts-meta"><strong>{version.current ? version.state : 'Stale'}</strong><span>Revision {version.revision.toString()}</span></p>
      <form ref={form} noValidate onChange={() => setInvalid(invalidNumbers())}
        onSubmit={event => { event.preventDefault(); if (!invalidNumbers()) void save(); }}>
      {draft && <ResumeFactEditor facts={draft} disabled={busy || loading || !version.current} change={setDraft} />}
      <div className="resume-editor-actions">
        <button type="submit" className="secondary" disabled={busy || loading || conflict || invalid || !version.current || !dirty}>Save edits as draft</button>
        <button type="button" className="primary" disabled={busy || loading || conflict || !version.current || version.state !== 'draft'
          || dirty} onClick={() => void confirmFacts()}>Confirm facts</button>
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
