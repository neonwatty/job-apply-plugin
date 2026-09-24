import { useEffect, useRef, useState } from 'react';
import { PythonObject } from '../../../src/contracts/python-object';
import { copy, get, has, set, string, text, type Value } from '../../../src/contracts/workspace/values';
import { patchBody, type ProfileSnapshot } from './facts-model';
import { ApiError, type Client } from './client';
import { parseTitleDiscoveryPacket, titleKey, type TitleDiscoveryPacket } from './title-discovery-model';

type Choice = { id: string; title: string; selected: boolean; existing: boolean; category?: string; rationale?: string; evidence?: TitleDiscoveryPacket['suggestions'][number]['evidence'] };
function savedTitles(snapshot: ProfileSnapshot): string[] {
  const preferences = get(snapshot.profile, 'preferences');
  if (!(preferences instanceof PythonObject)) return [];
  const titles = get(preferences, 'targetTitles');
  return Array.isArray(titles) ? titles.map(string).filter((value): value is string => value !== null) : [];
}
function savedTitlesExactlyMatch(snapshot: ProfileSnapshot, titles: string[]): boolean {
  const preferences = get(snapshot.profile, 'preferences');
  if (!(preferences instanceof PythonObject) || !has(preferences, 'targetTitles')) return titles.length === 0;
  const stored = get(preferences, 'targetTitles');
  return Array.isArray(stored) && stored.length === titles.length && stored.every((value, index) => string(value) === titles[index]);
}
function writablePreferences(snapshot: ProfileSnapshot): boolean {
  return !has(snapshot.profile, 'preferences') || get(snapshot.profile, 'preferences') instanceof PythonObject;
}
function uniqueTitles(choices: Choice[]): string[] {
  const seen = new Set<string>();
  return choices.filter(choice => choice.selected).map(choice => choice.title.trim()).filter(title => {
    const key = titleKey(title);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function choicesFor(snapshot: ProfileSnapshot, packet?: TitleDiscoveryPacket): Choice[] {
  const choices: Choice[] = savedTitles(snapshot).map((title, index) => ({ id: `saved-${index}`, title, selected: true, existing: true }));
  for (const [index, suggestion] of (packet?.suggestions ?? []).entries()) {
    const existing = choices.find(choice => titleKey(choice.title) === titleKey(suggestion.title));
    if (existing) Object.assign(existing, { category: suggestion.category, rationale: suggestion.rationale, evidence: suggestion.evidence });
    else choices.push({ id: `suggested-${index}`, title: suggestion.title, selected: false, existing: false,
      category: suggestion.category, rationale: suggestion.rationale, evidence: suggestion.evidence });
  }
  return choices;
}
function choicesChanged(snapshot: ProfileSnapshot, packet: TitleDiscoveryPacket | null, choices: Choice[]): boolean {
  const baseline = choicesFor(snapshot, packet ?? undefined);
  return choices.length !== baseline.length || choices.some((choice, index) =>
    choice.id !== baseline[index]?.id || choice.title !== baseline[index]?.title || choice.selected !== baseline[index]?.selected);
}
function titlePatch(snapshot: ProfileSnapshot, titles: string[]): string {
  if (!writablePreferences(snapshot)) throw Error('Saved preferences have an unsupported shape. Resolve them before saving target titles.');
  const draft = copy(snapshot.profile);
  const current = get(draft, 'preferences');
  const preferences = current instanceof PythonObject ? copy(current) : new PythonObject<Value>();
  set(preferences, 'targetTitles', titles.map(text));
  set(draft, 'preferences', preferences);
  return patchBody(snapshot, draft);
}

export function TitleDiscovery({ client, onSaved, dirtyChanged }: { client: Client; onSaved: (snapshot: ProfileSnapshot) => void; dirtyChanged: (dirty: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<ProfileSnapshot | null>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [criteria, setCriteria] = useState(''), [packetText, setPacketText] = useState('');
  const [packet, setPacket] = useState<TitleDiscoveryPacket | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false), [fallback, setFallback] = useState('');
  const [canonicalChange, setCanonicalChange] = useState<{ before: string[]; now: string[] } | null>(null);
  const [reviewedChange, setReviewedChange] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const busyNow = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    void client.profile(active.signal).then(value => { setSnapshot(value); setChoices(choicesFor(value)); })
      .catch(failure => { if (!active.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load target titles.'); });
    return () => active.abort();
  }, [client]);
  useEffect(() => { dirtyChanged(open && (Boolean(packetText || criteria || packet) || busy || Boolean(snapshot && choicesChanged(snapshot, packet, choices)))); return () => dirtyChanged(false); }, [open, packetText, criteria, packet, choices, snapshot, busy, dirtyChanged]);
  function begin() { setOpen(true); setNotice(''); setError(''); requestAnimationFrame(() => heading.current?.focus()); }
  function cancel() {
    if (busyNow.current) return;
    setOpen(false); setPacket(null); setPacketText(''); setCriteria(''); setFallback(''); setConflict(false); setCanonicalChange(null); setReviewedChange(false); setError('');
    if (snapshot) setChoices(choicesFor(snapshot));
    setNotice('Discovery canceled. No titles were saved.');
    requestAnimationFrame(() => openButton.current?.focus());
  }
  function acceptPacket() {
    try { const parsed = parseTitleDiscoveryPacket(packetText); setPacket(parsed); if (snapshot) setChoices(choicesFor(snapshot, parsed)); setReviewedChange(false); setError(''); setConflict(false); setNotice(parsed.source.status === 'observed' ? 'Suggestions ready for your review.' : 'Source limitation recorded. You can retry research or edit titles manually.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Invalid discovery packet.'); }
  }
  async function copyInvocation(host: 'Codex' | 'Claude Code') {
    const command = host === 'Codex' ? '$job-apply:job-title-discovery' : '/job-apply:job-title-discovery';
    const value = `${command}\nMy title-discovery criteria: ${criteria.trim() || '(none supplied; ask me only for details needed)'}. Return the version 1 JSON result packet for Companion. Do not save preferences.`;
    try { await navigator.clipboard.writeText(value); setFallback(''); setNotice(`${host} invocation copied. Run it in ${host}, then paste its JSON result packet here.`); }
    catch { setFallback(value); setNotice('Clipboard unavailable. Select and copy the invocation below.'); }
  }
  function updateChoice(id: string, patch: Partial<Choice>) { setReviewedChange(false); setChoices(current => current.map(choice => choice.id === id ? { ...choice, ...patch } : choice)); }
  async function refreshForConflict() {
    if (busyNow.current) return;
    busyNow.current = true; setBusy(true); setError('');
    try {
      const latest = await client.profile();
      const before = snapshot ? savedTitles(snapshot) : [];
      const now = savedTitles(latest);
      const changed = before.length !== now.length || before.some((title, index) => titleKey(title) !== titleKey(now[index] ?? ''));
      setSnapshot(latest);
      setChoices(current => {
        if (!changed) return current;
        const merged = [...current];
        for (const [index, title] of now.entries()) {
          if (!merged.some(choice => titleKey(choice.title) === titleKey(title)))
            merged.push({ id: `concurrent-${latest.revision}-${index}`, title, selected: true, existing: true });
        }
        return merged;
      });
      setCanonicalChange(changed ? { before, now } : null);
      setReviewedChange(false);
      setConflict(false);
      setNotice(changed ? 'Saved target titles changed elsewhere. Review the changed set and exact preview before continuing.' : 'Latest profile revision loaded. Your title selections and edits are retained.');
      onSaved(latest);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to reload titles.'); }
    finally { busyNow.current = false; setBusy(false); }
  }
  async function save() {
    if (!snapshot || busyNow.current || conflict || (canonicalChange && !reviewedChange)) return;
    if (!writablePreferences(snapshot)) { setError('Saved preferences have an unsupported shape. Resolve them before saving target titles.'); return; }
    const titles = uniqueTitles(choices);
    if (titles.some(title => title.length > 200) || choices.some(choice => choice.selected && !choice.title.trim())) { setError('Selected titles must contain 1–200 characters.'); return; }
    busyNow.current = true; setBusy(true); setError(''); setNotice('Saving selected titles…');
    try {
      const latest = await client.profile();
      if (latest.revision !== snapshot.revision) {
        setConflict(true); setNotice(''); setError('Profile changed elsewhere. Reload saved titles and review before retrying.'); return;
      }
      if (savedTitlesExactlyMatch(snapshot, titles)) {
        setSnapshot(latest); setChoices(choicesFor(latest)); setPacket(null); setPacketText(''); setOpen(false); setCanonicalChange(null); setReviewedChange(false);
        setNotice('Target titles already match the saved set. No changes were made.'); onSaved(latest);
        requestAnimationFrame(() => openButton.current?.focus()); return;
      }
      const saved = await client.patchProfile(titlePatch(snapshot, titles));
      setSnapshot(saved); setChoices(choicesFor(saved)); setPacket(null); setPacketText(''); setOpen(false); setCanonicalChange(null); setReviewedChange(false);
      setNotice('Target titles saved. Job Search will use these approved titles.'); onSaved(saved);
      requestAnimationFrame(() => openButton.current?.focus());
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) { setConflict(true); setError('Profile changed elsewhere. Reload saved titles and review before retrying.'); }
      else setError(failure instanceof Error ? failure.message : 'Unable to save target titles. Retry when ready.');
      setNotice('');
    } finally { busyNow.current = false; setBusy(false); }
  }
  const preview = uniqueTitles(choices);
  const current = snapshot ? savedTitles(snapshot) : [];
  const invalidPreferences = Boolean(snapshot && !writablePreferences(snapshot));
  return <section className="workspace-panel title-discovery" id="title-discovery" aria-labelledby="title-discovery-title">
    <div className="workspace-panel-heading"><div><p className="eyebrow">Search preferences</p><h2 id="title-discovery-title">Target titles</h2></div>
      {!open && <button ref={openButton} className="secondary" type="button" onClick={begin} disabled={!snapshot}>Discover related titles</button>}</div>
    <p>These saved titles guide Job Search. You can edit them directly or research related roles with the Job Title Discovery skill.</p>
    {!snapshot && <p role="status">Loading saved target titles…</p>}
    {snapshot && <p>Saved now: {current.length ? current.join(' · ') : 'No target titles yet.'}</p>}
    {invalidPreferences && <p className="error" role="alert">Saved preferences have an unsupported shape. Resolve them before saving target titles.</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {!open && snapshot && <button className="secondary" type="button" onClick={begin}>Edit target titles</button>}
    {open && snapshot && <div className="title-discovery-review">
      <h3 tabIndex={-1} ref={heading}>Discover and review target titles</h3>
      <label>Role interests, constraints, exclusions, or seed titles to share with the skill
        <textarea value={criteria} onChange={event => setCriteria(event.target.value)} rows={3} placeholder="For example: adjacent engineering leadership roles; no director titles" /></label>
      <p>Copy an invocation, run it in your agent, then paste its JSON result packet. Research happens in the agent’s browser; this page does not launch the skill.</p>
      <div className="title-discovery-actions"><button type="button" className="secondary" onClick={() => void copyInvocation('Codex')}>Copy Codex invocation</button><button type="button" className="secondary" onClick={() => void copyInvocation('Claude Code')}>Copy Claude Code invocation</button></div>
      {fallback && <label>Invocation to copy<textarea readOnly value={fallback} onFocus={event => event.currentTarget.select()} rows={5} /></label>}
      <label>Title discovery JSON result packet<textarea value={packetText} onChange={event => { setPacketText(event.target.value); setPacket(null); setReviewedChange(false); setChoices(choicesFor(snapshot)); }} rows={5} /></label>
      <button type="button" className="secondary" disabled={!packetText.trim() || busy} onClick={acceptPacket}>Review packet</button>
      {packet && <div className="title-discovery-source" role="status"><strong>Research source: {packet.source.status.replace('_', ' ')}</strong><p>{packet.source.detail}</p>{packet.source.status !== 'observed' && <p>No browser evidence was available. Retry research in the agent when access is available; manual titles can still be reviewed here.</p>}</div>}
      <fieldset disabled={busy}><legend>Choose exact target titles</legend>
        {choices.map(choice => <div className="title-discovery-choice" key={choice.id}>
          <label><input type="checkbox" checked={choice.selected} onChange={event => updateChoice(choice.id, { selected: event.target.checked })} />{choice.existing ? 'Saved title' : 'Suggested title'}{choice.category ? ` · ${choice.category}` : ''}</label>
          <label>Title <input value={choice.title} onChange={event => updateChoice(choice.id, { title: event.target.value })} maxLength={200} /></label>
          {choice.rationale && <p>{choice.rationale}</p>}
          {choice.evidence?.map((evidence, index) => <p key={`${choice.id}-${index}`}>{evidence.source}: <a href={evidence.url} target="_blank" rel="noreferrer">{evidence.observedTitle}{evidence.company ? ` at ${evidence.company}` : ''}</a></p>)}
          <button type="button" className="text-action" onClick={() => { setReviewedChange(false); setChoices(value => value.filter(item => item.id !== choice.id)); }}>Remove {choice.title || 'title'}</button>
        </div>)}
        <button type="button" className="secondary" onClick={() => { setReviewedChange(false); setChoices(value => [...value, { id: `manual-${crypto.randomUUID()}`, title: '', selected: true, existing: false }]); }}>Add title manually</button>
      </fieldset>
      <div className="title-discovery-preview"><h4>Exact save preview</h4><p>Only preferences.targetTitles will change at profile revision {String(snapshot.revision)}.</p>{preview.length ? <ol>{preview.map(title => <li key={titleKey(title)}>{title}</li>)}</ol> : <p>No titles selected. Confirming will clear saved target titles.</p>}</div>
      {canonicalChange && <aside className="notice" role="alert"><strong>Saved target titles changed elsewhere.</strong>
        <p>Previously saved: {canonicalChange.before.length ? canonicalChange.before.join(' · ') : 'none'}.</p>
        <p>Now saved: {canonicalChange.now.length ? canonicalChange.now.join(' · ') : 'none'}.</p>
        <p>Selected titles in the exact preview will replace the current saved title set, including any title removed elsewhere that remains selected here.</p>
        <button type="button" className="secondary" disabled={busy} onClick={() => setReviewedChange(true)}>I reviewed the changed titles and exact preview</button>
      </aside>}
      {conflict && <button type="button" className="secondary" disabled={busy} onClick={() => void refreshForConflict()}>Reload saved titles for review</button>}
      <div className="title-discovery-actions"><button type="button" className="primary" disabled={busy || conflict || invalidPreferences || Boolean(canonicalChange && !reviewedChange) || choices.some(choice => choice.selected && (!choice.title.trim() || choice.title.length > 200))} onClick={() => void save()}>Confirm and save exact titles</button><button type="button" className="secondary" disabled={busy} onClick={cancel}>Cancel discovery</button></div>
    </div>}
  </section>;
}
