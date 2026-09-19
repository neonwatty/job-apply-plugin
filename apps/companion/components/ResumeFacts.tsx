'use client';
import { useEffect, useState } from 'react';
import { object, type ResumeRecord } from './contracts';
import type { Client } from './client';

type FactVersion = { revision: number; contentRevision: string; state: 'draft' | 'confirmed';
  current: boolean; facts: Record<string, unknown>; versions: Array<{ revision: number; state: string;
    contentRevision: string; facts: Record<string, unknown> }> };

function readable(key: string) { return key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' '); }
function FactValues({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <ol>{value.map((item, index) => <li key={index}><FactValues value={item} /></li>)}</ol>;
  if (object(value)) return <dl>{Object.entries(value).map(([key, item]) => <div key={key}>
    <dt>{readable(key)}</dt><dd><FactValues value={item} /></dd>
  </div>)}</dl>;
  return <span>{String(value)}</span>;
}

/** Facts are loaded only for the resume the owner has opened. */
export function ResumeFacts({ client, resume, dirtyChanged }: { client: Client; resume: ResumeRecord;
  dirtyChanged: (dirty: boolean) => void }) {
  const [version, setVersion] = useState<FactVersion | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const dirty = version !== null && draft !== JSON.stringify(version.facts, null, 2);
  useEffect(() => { dirtyChanged(dirty || busy); return () => dirtyChanged(false); }, [dirty, busy, dirtyChanged]);
  const path = `/api/resume-facts/${encodeURIComponent(resume.id)}`;
  async function refresh(signal: AbortSignal) {
    const response = JSON.parse(await client.extractionRequest('/api/resume-facts', 'GET', undefined, signal));
    if (!object(response) || !Array.isArray(response.facts)) throw Error('Unable to read resume fact status.');
    if (!response.facts.some(item => object(item) && item.resumeId === resume.id)) { setVersion(null); setDraft(''); return; }
    const detail = JSON.parse(await client.extractionRequest(path, 'GET', undefined, signal));
    if (!object(detail) || !object(detail.facts) || !Array.isArray(detail.versions) || typeof detail.revision !== 'number'
      || typeof detail.contentRevision !== 'string' || (detail.state !== 'draft' && detail.state !== 'confirmed')
      || typeof detail.current !== 'boolean') throw Error('Unable to read resume facts.');
    const next = detail as FactVersion;
    setVersion(next); setDraft(JSON.stringify(next.facts, null, 2));
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load facts.'); });
    return () => controller.abort();
  }, [client, resume.id, resume.revision]);
  async function save() {
    if (!version || busy) return;
    let facts: unknown;
    try { facts = JSON.parse(draft); if (!object(facts)) throw Error('Facts must be a JSON object.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Invalid facts.'); return; }
    const controller = new AbortController();
    setBusy(true); setError(''); setNotice('');
    try {
      await client.extractionRequest(path, 'POST', JSON.stringify({ facts,
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
    if (busy || version && draft !== JSON.stringify(version.facts, null, 2)
      && !confirm('Discard unsaved fact edits?')) return;
    const controller = new AbortController();
    setBusy(true); setError(''); setNotice('');
    try { await refresh(controller.signal); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to refresh facts.'); }
    finally { setBusy(false); }
  }
  return <section className="workspace-panel" aria-label={`Facts for ${resume.label}`}>
    <h3>Facts from {resume.label}</h3><button className="secondary" disabled={busy} onClick={() => void refreshFacts()}>Refresh facts</button>
    {!version && <p>No extracted facts yet. The agent can process this resume’s extraction request.</p>}
    {version && <>
      <p>Revision {version.revision} · {version.current ? version.state : 'Stale after resume replacement'}</p>
      <p>Review every value against this resume before confirming.</p>
      <FactValues value={version.facts} />
      <details><summary>Edit facts</summary>
        <p>Edit the structured fact record, then save it as a new draft.</p>
        <label>Structured resume facts<textarea rows={16} value={draft} disabled={busy || !version.current}
          onChange={event => setDraft(event.target.value)} /></label>
      </details>
      <div className="resume-editor-actions">
        <button className="secondary" disabled={busy || !version.current || draft === JSON.stringify(version.facts, null, 2)}
          onClick={() => void save()}>Save edits as draft</button>
        <button className="primary" disabled={busy || !version.current || version.state !== 'draft'
          || draft !== JSON.stringify(version.facts, null, 2)} onClick={() => void confirmFacts()}>Confirm facts</button>
      </div>
      {version.versions.length > 1 && <details><summary>Earlier fact revisions</summary>
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
