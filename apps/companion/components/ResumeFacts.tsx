'use client';
import { useEffect, useState } from 'react';
import { object, type ResumeRecord } from './contracts';
import type { Client } from './client';
import { ResumeFactEditor } from './resume-fact-editor';

type FactVersion = { revision: number; contentRevision: string; state: 'draft' | 'confirmed';
  current: boolean; facts: Record<string, unknown>; versions: Array<{ revision: number; state: string;
    contentRevision: string; facts: Record<string, unknown> }> };

function copy(facts: Record<string, unknown>) { return JSON.parse(JSON.stringify(facts)) as Record<string, unknown>; }

/** Facts are loaded only for the resume the owner has opened. */
export function ResumeFacts({ client, resume, dirtyChanged, statusChanged }: { client: Client; resume: ResumeRecord;
  dirtyChanged: (dirty: boolean) => void; statusChanged: (status: string) => void }) {
  const [version, setVersion] = useState<FactVersion | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const dirty = version !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(version.facts);
  useEffect(() => { dirtyChanged(dirty || busy); return () => dirtyChanged(false); }, [dirty, busy, dirtyChanged]);
  const path = `/api/resume-facts/${encodeURIComponent(resume.id)}`;
  function publishStatus(next: FactVersion | null) {
    statusChanged(next === null ? 'No extracted facts' : next.current === false ? 'Stale facts'
      : next.state === 'confirmed' ? 'Facts confirmed' : 'Draft facts to review');
  }
  async function refresh(signal: AbortSignal): Promise<FactVersion | null> {
    const response = JSON.parse(await client.extractionRequest('/api/resume-facts', 'GET', undefined, signal));
    if (!object(response) || !Array.isArray(response.facts)) throw Error('Unable to read resume fact status.');
    if (!response.facts.some(item => object(item) && item.resumeId === resume.id)) {
      setVersion(null); setDraft(null); publishStatus(null); return null;
    }
    const detail = JSON.parse(await client.extractionRequest(path, 'GET', undefined, signal));
    if (!object(detail) || !object(detail.facts) || !Array.isArray(detail.versions) || typeof detail.revision !== 'number'
      || typeof detail.contentRevision !== 'string' || (detail.state !== 'draft' && detail.state !== 'confirmed')
      || typeof detail.current !== 'boolean') throw Error('Unable to read resume facts.');
    const next = detail as FactVersion;
    setVersion(next); setDraft(copy(next.facts));
    publishStatus(next);
    return next;
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load facts.'); });
    return () => controller.abort();
  }, [client, resume.id, resume.revision]);
  async function save() {
    if (!version || busy) return;
    if (!draft) return;
    const controller = new AbortController();
    setBusy(true); setError(''); setNotice('');
    try {
      await client.extractionRequest(path, 'POST', JSON.stringify({ facts: draft,
        expectedResumeRevision: resume.revision, expectedFactRevision: version.revision }), controller.signal);
      await refresh(controller.signal);
      setNotice('Fact edits saved as a new draft. Review and confirm it before application use.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save facts.'); }
    finally { setBusy(false); }
  }
  async function confirmFacts() {
    if (!version || busy || version.state !== 'draft' || !version.current) return;
    const controller = new AbortController();
    setBusy(true); setError(''); setNotice('');
    try {
      await client.extractionRequest(`${path}/confirm`, 'POST', JSON.stringify({
        expectedFactRevision: version.revision, expectedContentRevision: version.contentRevision
      }), controller.signal);
      await refresh(controller.signal);
      setNotice('These facts are confirmed for this resume. Confirm the resume and facts with the agent for each job.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to confirm facts.'); }
    finally { setBusy(false); }
  }
  async function refreshFacts() {
    if (busy || dirty
      && !confirm('Discard unsaved fact edits?')) return;
    const controller = new AbortController();
    setBusy(true); setError(''); setNotice('');
    try { await refresh(controller.signal); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to refresh facts.'); }
    finally { setBusy(false); }
  }
  return <section className="workspace-panel resume-facts-panel" aria-label={`Facts for ${resume.label}`}>
    <div className="resume-facts-heading"><div><p className="eyebrow">Resume facts</p><h3>Facts from {resume.label}</h3></div>
      <div className="resume-facts-sync"><button className="secondary" disabled={busy} onClick={() => void refreshFacts()}>Check for agent updates</button>
        <small>Reload facts saved for this resume by a Job Apply agent.</small></div></div>
    {!version && <p>No extracted facts yet. The agent can process this resume’s extraction request.</p>}
    {version && <>
      <p className="resume-facts-meta"><strong>{version.current ? version.state : 'Stale'}</strong><span>Revision {version.revision}</span></p>
      {draft && <ResumeFactEditor facts={draft} disabled={busy || !version.current} change={setDraft} />}
      <div className="resume-editor-actions">
        <button className="secondary" disabled={busy || !version.current || !dirty}
          onClick={() => void save()}>Save edits as draft</button>
        <button className="primary" disabled={busy || !version.current || version.state !== 'draft'
          || dirty} onClick={() => void confirmFacts()}>Confirm facts</button>
      </div>
      {version.versions.length > 1 && <details className="resume-facts-history"><summary>Earlier fact revisions</summary>
        {version.versions.slice(0, -1).map(item => <details key={item.revision}>
          <summary>Revision {item.revision} · {item.state}</summary>
          <pre>{JSON.stringify(item.facts, null, 2)}</pre>
        </details>)}
      </details>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
  </section>;
}
