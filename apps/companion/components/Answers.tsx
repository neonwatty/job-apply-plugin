'use client';
import { useEffect, useRef, useState } from 'react';
import { AnswerFields } from './answer-fields';
import { AnswerCleanup } from './AnswerCleanup';
import { PendingAnswers } from './PendingAnswers';
import { DetailDrawer } from './DetailDrawer';
import { string, get, int, object, parse, serialize } from '../../../src/contracts/workspace/values';
import { answerCreateMutation, newAnswerDraft, answerDraft, answerMutation, answerPath, answerSnapshot, reapplyAnswer } from './answer-model';
import type { AnswerClient, Document } from './answer-model';

export function Answers({ client, dirtyChanged, consentOnly = false }: { client: AnswerClient; dirtyChanged: (dirty: boolean) => void; consentOnly?: boolean }) {
  const [pendingBusy, setPendingBusy] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [cleanupRevision, setCleanupRevision] = useState(0);
  const [items, setItems] = useState<Document[]>([]);
  const [migrationSuggestions, setMigrationSuggestions] = useState<Document[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('accepted');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
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
  const [focusEditorVersion, setFocusEditorVersion] = useState(0);
  const editorForm = useRef<HTMLFormElement>(null);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const listGeneration = useRef(0);
  const listRequest = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dirty = creating || invalid || base !== null && draft !== null && serialize(draft) !== serialize(answerDraft(base));
  useEffect(() => { dirtyChanged(dirty || busy || mergeBusy || pendingBusy); return () => dirtyChanged(false); }, [dirty, busy, mergeBusy, pendingBusy, dirtyChanged]);
  useEffect(() => () => { generation.current++; listGeneration.current++; request.current?.abort(); listRequest.current?.abort(); }, []);
  useEffect(() => { if (focusEditorVersion) heading.current?.focus(); }, [focusEditorVersion]);
  async function refreshList() {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    const version = ++listGeneration.current;
    setLoading(true);
    setError('');
    try {
      const [raw, auditRaw] = await Promise.all([
        client.answerRequest('/api/answers/query', 'POST', JSON.stringify({ query, reviewStatus: status === 'all' ? null : status, consentOnly }), controller.signal),
        consentOnly ? client.answerRequest('/api/answers/consent-audit', 'GET', undefined, controller.signal) : Promise.resolve(null),
      ]);
      const page = object(parse(raw), 'answers response'), values = get(page, 'items');
      if (!Array.isArray(values)) throw Error('Invalid answer list');
      const suggestions = auditRaw === null ? [] : get(object(parse(auditRaw), 'consent audit'), 'suggestions');
      if (!Array.isArray(suggestions)) throw Error('Invalid consent audit');
      if (version !== listGeneration.current) return;
      setItems(values.map(value => object(value, 'answer')));
      setMigrationSuggestions(suggestions.map(value => object(value, 'suggestion')));
      setLoaded(true);
      if (get(page, 'hasMore') === true) setNotice('Showing the first 50 results. Narrow your search to find more.');
    } catch (failure) {
      if (version === listGeneration.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load answers');
    } finally { if (version === listGeneration.current) setLoading(false); }
  }
  useEffect(() => { void refreshList(); }, [client, consentOnly]);
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
        setEditing(reveal);
        setBase(next);
        setDraft(answerDraft(next));
        setInvalid(false);
        setEditorVersion(value => value + 1);
        setLatest(null);
        setRemember(false);
        setFocusEditorVersion(value => value + 1);
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
    setEditing(true);
    setBase(null);
    setDraft(newAnswerDraft(consentOnly));
    setLatest(null);
    setRemember(false);
    setInvalid(false);
    setEditorVersion(value => value + 1);
    setError('');
    setNotice('');
    setFocusEditorVersion(value => value + 1);
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
  function closeEditor() {
    if (busy || pendingBusy || mergeBusy) return;
    if (dirty && !confirm('Discard your unsaved answer changes?')) return;
    setCreating(false);
    setEditing(false);
    setBase(null);
    setDraft(null);
    setLatest(null);
    setRemember(false);
    setInvalid(false);
    setError('');
  }
  function cancelEdit() {
    if (creating) { cancelNew(); return; }
    if (dirty && !confirm('Discard your unsaved answer changes?')) return;
    if (base) {
      const saved = latest ?? base;
      setBase(saved);
      setDraft(answerDraft(saved));
    }
    setRemember(false);
    setInvalid(false);
    setLatest(null);
    setEditing(false);
    setError('');
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
      answerSnapshot(raw);
      setCreating(false);
      setEditing(false);
      setBase(null);
      setDraft(null);
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
  const label = consentOnly ? 'Consent defaults' : 'Answers';
  return <section className="answers-workspace" aria-labelledby="answers-workspace-title">
    <header className="workspace-hero">
      <div className="workspace-hero-copy"><p className="eyebrow">Your materials</p><h1 id="answers-workspace-title">{consentOnly ? 'Consent defaults' : 'Answers'}</h1><p>{consentOnly ? 'Save choices by purpose. Always review the live notice and approve the current form; sensitive choices stay hidden until you reveal them.' : 'Review answers you can reuse on applications. Sensitive values stay hidden until you reveal them.'}</p></div>
      <div className="workspace-hero-actions"><button className="secondary" disabled={pendingBusy || mergeBusy || loading || busy} onClick={() => void refreshList()}>Refresh {label.toLowerCase()}</button><button className="primary" disabled={pendingBusy || mergeBusy || busy} onClick={startNew}>New {consentOnly ? 'consent default' : 'answer'}</button></div>
    </header>
    {consentOnly && migrationSuggestions.length > 0 && <section className="workspace-panel" aria-label="Possible saved consent choices">
      <h2>Review existing answers</h2><p>These answers may belong in Consent defaults. Review each purpose and scope before marking it; this suggestion does not change saved data.</p>
      <ul>{migrationSuggestions.map(item => <li key={string(get(item, 'key'))}>
        <button className="text-action" onClick={() => void select(string(get(item, 'key'))!)}>{string(get(item, 'question'))}</button>
        {' · Suggested purpose: '}{string(get(object(get(item, 'suggestedIntent'), 'intent'), 'purpose'))}
        {get(item, 'requiresRetentionConsent') === true && ' · Needs your permission to remember this as a sensitive decision'}
      </li>)}</ul>
    </section>}
    <section className="workspace-panel answers-panel" aria-labelledby="answer-library-heading">
      <div className="workspace-panel-heading"><div><p className="eyebrow">Canonical library</p><h2 id="answer-library-heading">{label}</h2></div>
        <form className="answer-filters" onSubmit={event => { event.preventDefault(); void refreshList(); }}>
          <label>Find {label.toLowerCase()}<input type="search" placeholder="Question or alias" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <label>Review status<select aria-label="Review status" value={status} onChange={event => setStatus(event.target.value)}>
            <option value="accepted">Accepted</option><option value="pending">Pending</option><option value="declined">Declined</option><option value="all">All</option>
          </select></label>
          <button className="secondary" disabled={pendingBusy || mergeBusy || loading || busy}>Search {label.toLowerCase()}</button>
        </form>
      </div>
      <p className="workspace-status" role="status">{loading ? 'Loading answers…' : !base && !creating ? notice : ''}</p>
      {!base && !creating && error && <p className="error" role="alert">{error}</p>}
      {loaded && !items.length && <div className="workspace-empty answer-empty"><span className="answer-empty-mark" aria-hidden="true">?</span><strong>{query ? 'No matching answers.' : `No ${label.toLowerCase()} to show.`}</strong></div>}
      <ul className="answer-list-native">{items.map(item => {
        const key = string(get(item, 'key'))!;
        const state = get(item, 'valueRedacted') === true ? 'Sensitive value hidden' : get(item, 'hasValue') === true ? 'Value retained' : 'No retained value';
        const intent = get(item, 'consentIntent');
        const purpose = intent ? string(get(object(intent, 'consent intent'), 'purpose'))?.replaceAll('_', ' ') : null;
        const kind = intent ? string(get(object(intent, 'consent intent'), 'kind'))?.replaceAll('_', ' ') : null;
        const scope = get(item, 'scope');
        const employer = scope ? string(get(object(scope, 'scope'), 'employer')) : null;
        const scopeLabel = scope && object(scope, 'scope').size ? employer ?? 'Specific scope' : 'General';
        return <li key={key}><div><span className="answer-question-mark" aria-hidden="true">Q</span><button className="text-action" disabled={pendingBusy || mergeBusy || busy || invalid} onClick={() => void select(key)}>{string(get(item, 'question')) || key}</button></div>
          {consentOnly && <span className="answer-value-state">{purpose} · {kind} · {scopeLabel} · {string(get(item, 'source')) ?? 'Unknown source'}</span>}
          <span className={get(item, 'valueRedacted') === true ? 'answer-value-state sensitive' : 'answer-value-state'}>{state}</span>
          <span className="answer-row-action" aria-hidden="true">Open →</span>
        </li>;
      })}</ul>
    </section>
    {(base || creating) && <DetailDrawer titleId="answer-editor-heading" close={closeEditor} className="answer-detail-drawer">
      <header className="detail-drawer-header"><div><p className="eyebrow">{consentOnly ? 'Consent default' : 'Answer'}</p>
        <h2 id="answer-editor-heading" ref={heading} tabIndex={-1} data-drawer-heading>{creating ? `New ${consentOnly ? 'consent default' : 'answer'}` : string(get(base!, 'question')) || 'Answer details'}</h2></div>
        <button className="job-drawer-close" type="button" disabled={busy || pendingBusy || mergeBusy} onClick={closeEditor} aria-label="Close answer details">×</button></header>
      {notice && <p role="status" className="notice">{notice}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {base && <p className="facts-revision">Revision {int(get(base, 'revision'))!.toString()}</p>}
    {draft && (base || creating) ? <div className="answer-editor-body">
      {creating && <p>Save an answer for future review. Sensitive values require consent.</p>}
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
      {!editing && base ? <>
        <div className="detail-drawer-summary"><dl>
          <div><dt>Status</dt><dd>{string(get(base, 'reviewStatus')) ?? 'Unknown'}</dd></div>
          <div><dt>Value</dt><dd>{get(base, 'valueRedacted') === true ? 'Sensitive value hidden' : get(base, 'hasValue') === true ? 'Value retained' : 'No retained value'}</dd></div>
          <div><dt>Scope</dt><dd>{get(base, 'scope') ? 'Saved for the selected scope' : 'General'}</dd></div>
          {get(base, 'consentIntent') && <div><dt>Purpose</dt><dd>{string(get(object(get(base, 'consentIntent'), 'intent'), 'purpose')) ?? 'Not set'}</dd></div>}
        </dl></div>
        <div className="detail-drawer-actions"><button className="primary" type="button" disabled={busy || Boolean(latest)} onClick={() => setEditing(true)}>Edit {consentOnly ? 'default' : 'answer'}</button></div>
      </> :
      <form className="answer-editor-form" ref={editorForm} onChange={event => setInvalid(!event.currentTarget.checkValidity())} onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={pendingBusy || mergeBusy || busy}>
          <legend className="visually-hidden">{creating ? 'Create answer' : 'Edit answer'}</legend>
          <AnswerFields key={editorVersion} draft={draft} change={setDraft} remember={remember} creating={creating} />
          <label className="answer-consent"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} /><span>I consent to remembering the sensitive value in this {creating ? 'new answer' : 'edit'}.</span></label>
          <div className="answer-editor-actions detail-drawer-actions"><button className="primary" disabled={!dirty || Boolean(latest) || invalid}>{creating ? 'Create answer' : 'Save answer'}</button>
          <button className="secondary" type="button" onClick={cancelEdit}>{creating ? 'Discard new answer' : 'Cancel editing'}</button>
          {base && string(get(base, 'reviewStatus')) === 'pending' && <>
            <button className="secondary" type="button" disabled={Boolean(latest) || invalid} onClick={() => void save('accept')}>Accept answer</button>
            <button className="secondary" type="button" disabled={Boolean(latest) || invalid} onClick={() => void save('decline')}>Decline answer</button>
          </>}</div>
        </fieldset>
      </form>}
    </div> : null}
    </DetailDrawer>}
    {!consentOnly && <div className="answer-support-grid">
      <AnswerCleanup client={client} revision={cleanupRevision} disabled={dirty || busy || mergeBusy || pendingBusy} onBusyChanged={setMergeBusy} onMerged={() => { setBase(null); setDraft(null); setLatest(null); setRemember(false); setInvalid(false); setCreating(false); setNotice('Answers merged.'); setCleanupRevision(value => value + 1); void refreshList(); }} />
      <PendingAnswers client={client} revision={cleanupRevision} disabled={dirty || busy || mergeBusy || pendingBusy} onBusyChanged={setPendingBusy} onOpenAnswer={key => { void select(key); }} onResolved={() => {
        setBase(null); setDraft(null); setLatest(null); setRemember(false); setInvalid(false); setCreating(false);
        setNotice('Pending question resolved. Refresh pending questions to check remaining information.');
        setCleanupRevision(value => value + 1);
        void refreshList();
      }} />
    </div>}
  </section>;
}
