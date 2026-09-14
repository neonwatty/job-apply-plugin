'use client';
import { useEffect, useRef, useState } from 'react';
import { AnswerFields } from './answer-fields';
import { AnswerCleanup } from './AnswerCleanup';
import { PendingAnswers } from './PendingAnswers';
import { string, get, object, parse, serialize } from '../../../src/contracts/workspace/values';
import { answerCreateMutation, newAnswerDraft, answerDraft, answerMutation, answerPath, answerSnapshot, reapplyAnswer } from './answer-model';
import type { AnswerClient, Document } from './answer-model';

export function Answers({ client, dirtyChanged }: { client: AnswerClient; dirtyChanged: (dirty: boolean) => void }) {
  const [pendingBusy, setPendingBusy] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [cleanupRevision, setCleanupRevision] = useState(0);
  const [items, setItems] = useState<Document[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('accepted');
  const [creating, setCreating] = useState(false);
  const [base, setBase] = useState<Document | null>(null);
  const [draft, setDraft] = useState<Document | null>(null);
  const [latest, setLatest] = useState<Document | null>(null);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const editorForm = useRef<HTMLFormElement>(null);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const listGeneration = useRef(0);
  const listRequest = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dirty = creating || invalid || base !== null && draft !== null && serialize(draft) !== serialize(answerDraft(base));
  useEffect(() => { dirtyChanged(dirty || busy || mergeBusy || pendingBusy); return () => dirtyChanged(false); }, [dirty, busy, mergeBusy, pendingBusy, dirtyChanged]);
  useEffect(() => () => { generation.current++; listGeneration.current++; request.current?.abort(); listRequest.current?.abort(); }, []);
  async function refreshList() {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    const version = ++listGeneration.current;
    setLoading(true);
    setError('');
    try {
      const raw = await client.answerRequest('/api/answers/query', 'POST', JSON.stringify({ query, reviewStatus: status === 'all' ? null : status }), controller.signal);
      const page = object(parse(raw), 'answers response'), values = get(page, 'items');
      if (!Array.isArray(values)) throw Error('Invalid answer list');
      if (version !== listGeneration.current) return;
      setItems(values.map(value => object(value, 'answer')));
      setLoaded(true);
      if (get(page, 'hasMore') === true) setNotice('Showing the first 50 results. Narrow your search to find more.');
    } catch (failure) {
      if (version === listGeneration.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load answers');
    } finally { if (version === listGeneration.current) setLoading(false); }
  }
  useEffect(() => { void refreshList(); }, [client]);
  async function select(key: string, refresh = false, reveal = false) {
    if (pendingBusy || mergeBusy || busy) return;
    if (!refresh && dirty && !confirm('Discard your unsaved answer changes?')) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const version = ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const raw = await client.answerRequest(answerPath(key) + (reveal ? '/reveal' : ''), reveal ? 'POST' : 'GET', reveal ? '{}' : undefined, controller.signal);
      if (version !== generation.current) return;
      const next = answerSnapshot(raw);
      if (string(get(next, 'key')) !== key) throw Error('Answer identity changed. Reload the answer list.');
      if (refresh && dirty) {
        setLatest(next);
        setNotice('Latest answer loaded. Your draft is retained.');
      } else {
        setCreating(false);
        setBase(next);
        setDraft(answerDraft(next));
        setInvalid(false);
        setEditorVersion(value => value + 1);
        setLatest(null);
        setRemember(false);
        heading.current?.focus();
      }
    } catch (failure) {
      if (version === generation.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load answer');
    } finally { if (version === generation.current) setBusy(false); }
  }
  function startNew() {
    if (pendingBusy || mergeBusy || busy) return;
    if (dirty && !confirm('Discard your unsaved answer changes?')) return;
    request.current?.abort();
    generation.current++;
    setCreating(true);
    setBase(null);
    setDraft(newAnswerDraft());
    setLatest(null);
    setRemember(false);
    setInvalid(false);
    setEditorVersion(value => value + 1);
    setError('');
    setNotice('');
    heading.current?.focus();
  }
  function cancelNew() {
    if (!confirm('Discard this new answer?')) return;
    setCreating(false);
    setDraft(null);
    setRemember(false);
    setInvalid(false);
    setError('');
    setNotice('New answer discarded.');
  }
  async function save(action = '') {
    if (pendingBusy || mergeBusy || busy) return;
    if ((!base && !creating) || !draft || invalid || !editorForm.current?.reportValidity()) return;
    const key = base ? string(get(base, 'key'))! : null;
    let body: string;
    try { body = creating ? answerCreateMutation(draft, remember) : answerMutation(base!, draft, remember); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Invalid JSON draft'); return; }
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const version = ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const raw = await client.answerRequest(creating ? '/api/answers' : answerPath(key!) + (action ? `/${action}` : ''), creating || action ? 'POST' : 'PATCH', body, controller.signal);
      if (version !== generation.current) return;
      const next = answerSnapshot(raw);
      setCreating(false);
      setBase(next);
      setDraft(answerDraft(next));
        setInvalid(false);
        setEditorVersion(value => value + 1);
      setLatest(null);
      setRemember(false);
      setNotice(creating ? 'Answer created.' : 'Answer saved.');
      setCleanupRevision(value => value + 1);
      void refreshList();
    } catch (failure) {
      if (version !== generation.current || controller.signal.aborted) return;
      const message = failure instanceof Error ? failure.message : 'Unable to save answer';
      setError(creating && message === 'existing answer put requires expected revision'
        ? 'An answer to this question already exists for this scope. Your draft is retained. Search for the existing answer to edit it.'
        : message);
      if (creating) return;
      // A failed mutation never replaces the draft. Loading latest state is read-only.
      try {
        const raw = await client.answerRequest(answerPath(key!), 'GET', undefined, controller.signal);
        if (version === generation.current) setLatest(answerSnapshot(raw));
      } catch { /* Preserve the original mutation error and draft. */ }
    } finally { if (version === generation.current) setBusy(false); }
  }
  return <section className="answers-workspace" aria-labelledby="answers-workspace-title">
    <header className="workspace-hero">
      <div className="workspace-hero-copy"><p className="eyebrow">Answers workspace</p><h1 id="answers-workspace-title">Reusable answers, reviewed by you.</h1><p>Observed questions and reusable answers share one canonical local record. Sensitive values stay hidden until you explicitly reveal them.</p></div>
      <div className="workspace-hero-actions"><button className="secondary" disabled={pendingBusy || mergeBusy || loading || busy} onClick={() => void refreshList()}>Refresh answers</button><button className="primary" disabled={pendingBusy || mergeBusy || busy} onClick={startNew}>New answer</button></div>
    </header>
    <section className="workspace-panel answers-panel" aria-labelledby="answer-library-heading">
      <div className="workspace-panel-heading"><div><p className="eyebrow">Canonical library</p><h2 id="answer-library-heading">Answers</h2></div>
        <form className="answer-filters" onSubmit={event => { event.preventDefault(); void refreshList(); }}>
          <label>Find answers<input type="search" placeholder="Question or alias" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <label>Review status<select aria-label="Review status" value={status} onChange={event => setStatus(event.target.value)}>
            <option value="accepted">Accepted</option><option value="pending">Pending</option><option value="declined">Declined</option><option value="all">All</option>
          </select></label>
          <button className="secondary" disabled={pendingBusy || mergeBusy || loading || busy}>Search answers</button>
        </form>
      </div>
      <p className="workspace-status" role="status">{loading ? 'Loading answers…' : notice || (loaded ? `${items.length} ${items.length === 1 ? 'answer' : 'answers'} shown.` : '')}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {loaded && !items.length && <div className="workspace-empty answer-empty"><span className="answer-empty-mark" aria-hidden="true">?</span><strong>{query ? 'No matching answers.' : 'No answers with this review status.'}</strong><span>Create an answer or wait for an agent to observe a question.</span></div>}
      <ul className="answer-list-native">{items.map(item => {
        const key = string(get(item, 'key'))!;
        const state = get(item, 'valueRedacted') === true ? 'Sensitive value hidden' : get(item, 'hasValue') === true ? 'Value retained' : 'No retained value';
        return <li key={key}><div><span className="answer-question-mark" aria-hidden="true">Q</span><button className="text-action" disabled={pendingBusy || mergeBusy || busy || invalid} onClick={() => void select(key)}>{string(get(item, 'question')) || key}</button></div>
          <span className={get(item, 'valueRedacted') === true ? 'answer-value-state sensitive' : 'answer-value-state'}>{state}</span>
          <span className="answer-row-action" aria-hidden="true">Open →</span>
        </li>;
      })}</ul>
    </section>
    <section className="workspace-panel answer-editor-panel" aria-labelledby="answer-editor-heading">
      <div className="workspace-panel-heading"><div><p className="eyebrow">Canonical answer</p><h2 id="answer-editor-heading" ref={heading} tabIndex={-1}>{creating ? 'New answer' : 'Answer editor'}</h2></div>{base && <span className="facts-revision">Revision {String(get(base, 'revision'))}</span>}</div>
    {draft && (base || creating) ? <div className="answer-editor-body">
      {creating && <p>Create an accepted answer. Choose its state and scope, and give consent before storing a sensitive value.</p>}
      {base && <><div className="button-row answer-editor-tools"><button className="secondary" disabled={pendingBusy || mergeBusy || busy || invalid} onClick={() => void select(string(get(base, 'key'))!, true)}>Refresh selected answer</button>
      {get(base, 'valueRedacted') === true && <button className="secondary" disabled={pendingBusy || mergeBusy || busy || dirty} onClick={() => void select(string(get(base, 'key'))!, false, true)}>Reveal sensitive value</button>}</div>
      {latest && <aside className="notice" role="alert"><p>Your draft is retained. Review the latest revision before saving.</p>
        <button disabled={pendingBusy || mergeBusy || busy || invalid} onClick={() => {
          try {
            setDraft(reapplyAnswer(base, draft, latest));
            setBase(latest);
            setLatest(null);
            setRemember(false);
            setNotice('Draft reapplied. Review before saving.');
          } catch (failure) { setError(failure instanceof Error ? failure.message : 'Invalid draft'); }
        }}>Reapply my changes</button>
        <button disabled={pendingBusy || mergeBusy || busy} onClick={() => {
          if (!confirm('Discard your unsaved answer changes?')) return;
          setBase(latest);
          setDraft(answerDraft(latest));
          setLatest(null);
          setRemember(false);
          setInvalid(false);
          setEditorVersion(value => value + 1);
        }}>Load saved answer</button>
      </aside>}</>}
      <form className="answer-editor-form" ref={editorForm} onChange={event => setInvalid(!event.currentTarget.checkValidity())} onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={pendingBusy || mergeBusy || busy}>
          <legend className="visually-hidden">{creating ? 'Create answer' : 'Edit answer'}</legend>
          <AnswerFields key={editorVersion} draft={draft} change={setDraft} remember={remember} creating={creating} />
          <label className="answer-consent"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} /><span>I consent to remembering the sensitive value in this {creating ? 'new answer' : 'edit'}.</span></label>
          <div className="answer-editor-actions"><button className="primary" disabled={!dirty || Boolean(latest) || invalid}>{creating ? 'Create answer' : 'Save answer'}</button>
          {creating && <button className="secondary" type="button" onClick={cancelNew}>Discard new answer</button>}
          {base && string(get(base, 'reviewStatus')) === 'pending' && <>
            <button className="secondary" type="button" disabled={Boolean(latest) || invalid} onClick={() => void save('accept')}>Accept answer</button>
            <button className="secondary" type="button" disabled={Boolean(latest) || invalid} onClick={() => void save('decline')}>Decline answer</button>
          </>}</div>
        </fieldset>
      </form>
    </div> : <div className="workspace-empty answer-editor-empty"><strong>Select an answer to review.</strong><span>Choose a question from the library or create a new reusable answer.</span></div>}
    </section>
    <div className="answer-support-grid">
      <AnswerCleanup client={client} revision={cleanupRevision} disabled={dirty || busy || mergeBusy || pendingBusy} onBusyChanged={setMergeBusy} onMerged={() => { setBase(null); setDraft(null); setLatest(null); setRemember(false); setInvalid(false); setCreating(false); setNotice('Answers merged.'); setCleanupRevision(value => value + 1); void refreshList(); }} />
      <PendingAnswers client={client} revision={cleanupRevision} disabled={dirty || busy || mergeBusy || pendingBusy} onBusyChanged={setPendingBusy} onOpenAnswer={key => { void select(key); }} onResolved={() => {
        setBase(null); setDraft(null); setLatest(null); setRemember(false); setInvalid(false); setCreating(false);
        setNotice('Pending question resolved. Refresh pending questions to check remaining information.');
        setCleanupRevision(value => value + 1);
        void refreshList();
      }} />
    </div>
  </section>;
}
