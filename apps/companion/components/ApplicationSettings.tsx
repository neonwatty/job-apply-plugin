import { useEffect,useRef,useState } from 'react';
import { ApiError,type Client } from './client';
import { applicationPreferencesPatch,readApplicationPreferences,type ApplicationPreferences } from './application-preferences-model';
import type { ProfileSnapshot } from './facts-model';

const equal=(a:ApplicationPreferences,b:ApplicationPreferences)=>a.preferredBrowser===b.preferredBrowser
  &&a.browserFallback===b.browserFallback&&a.progressionMode===b.progressionMode
  &&a.preferredAutomationMode===b.preferredAutomationMode;

export function ApplicationSettings({client,dirtyChanged}:{client:Client;dirtyChanged:(dirty:boolean)=>void}) {
  const [base,setBase]=useState<ProfileSnapshot|null>(null),[draft,setDraft]=useState<ApplicationPreferences|null>(null);
  const [complete,setComplete]=useState(false),[latest,setLatest]=useState<ProfileSnapshot|null>(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const alive=useRef(false),request=useRef<AbortController|null>(null),generation=useRef(0);
  const dirty=Boolean(base&&draft&&(!complete||!equal(readApplicationPreferences(base.profile).preferences,draft)));
  useEffect(()=>{dirtyChanged(dirty||busy);return()=>dirtyChanged(false);},[dirty,busy,dirtyChanged]);
  async function refresh(discard=false) {
    request.current?.abort();const controller=new AbortController();request.current=controller;const version=++generation.current;
    setLoading(true);setError('');
    try {
      const next=await client.profile(controller.signal);if(!alive.current||version!==generation.current)return;
      if(dirty&&!discard){setLatest(next.revision===base?.revision?null:next);setNotice('Latest setup loaded. Your choices are retained.');return;}
      const parsed=readApplicationPreferences(next.profile);setBase(next);setDraft(parsed.preferences);setComplete(parsed.complete);setLatest(null);
      setNotice(parsed.complete?'Saved application setup loaded.':'Choose and save your application defaults.');
    } catch(cause){if(alive.current&&version===generation.current&&!controller.signal.aborted)setError(cause instanceof Error?cause.message:'Unable to load setup');}
    finally{if(alive.current&&version===generation.current)setLoading(false);}
  }
  useEffect(()=>{alive.current=true;void refresh(true);return()=>{alive.current=false;generation.current++;request.current?.abort();};},[client]);
  async function save() {
    if(!base||!draft||!dirty)return;request.current?.abort();const controller=new AbortController();request.current=controller;const version=++generation.current;
    setBusy(true);setError('');setNotice('');
    try {
      const next=await client.patchProfile(applicationPreferencesPatch(base,draft),controller.signal);if(!alive.current||version!==generation.current)return;
      const parsed=readApplicationPreferences(next.profile);setBase(next);setDraft(parsed.preferences);setComplete(parsed.complete);setLatest(null);setNotice('Application setup saved.');
    } catch(cause){
      if(!alive.current||version!==generation.current)return;setError(cause instanceof Error?cause.message:'Unable to save setup');
      if(cause instanceof ApiError&&cause.status===409){try{const next=await client.profile(controller.signal);if(alive.current&&version===generation.current)setLatest(next);}catch{setError('Setup changed elsewhere. Refresh to load the current revision; your choices are retained.');}}
    } finally{if(alive.current&&version===generation.current)setBusy(false);}
  }
  return <section className="settings-workspace" aria-labelledby="settings-workspace-title">
    <header className="workspace-hero"><div className="workspace-hero-copy"><p className="eyebrow">Application setup</p><h1 id="settings-workspace-title">Choose how Job Apply works with you.</h1><p>These local defaults guide future application runs. A choice in your current request can still override them for one application.</p></div><div className="workspace-hero-actions"><button className="secondary" disabled={busy||loading} onClick={()=>void refresh()}>Refresh setup</button></div></header>
    <p className="workspace-status" role="status">{loading?'Loading setup…':notice||(base?`Canonical profile revision ${base.revision}.`:'')}</p>
    {error&&<p className="error" role="alert">{error} <button disabled={busy||loading} onClick={()=>void refresh()}>Retry loading setup</button></p>}
    {latest&&<aside className="notice facts-conflict" role="alert"><p><strong>Setup changed elsewhere.</strong> Your choices are retained.</p><button disabled={busy} onClick={()=>{setBase(latest);setLatest(null);setError('');setNotice('Your choices were reapplied to the latest revision. Review before saving.');}}>Reapply my setup choices</button><button disabled={busy} onClick={()=>{const parsed=readApplicationPreferences(latest.profile);setBase(latest);setDraft(parsed.preferences);setComplete(parsed.complete);setLatest(null);setError('');setNotice('Saved setup loaded.');}}>Load saved setup</button></aside>}
    {base&&draft&&<form className="workspace-panel settings-panel" onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={busy}><legend>Application defaults</legend>
      <label>Preferred Codex browser<select value={draft.preferredBrowser} onChange={event=>setDraft({...draft,preferredBrowser:event.target.value as ApplicationPreferences['preferredBrowser']})}><option value="codex_browser">Codex built-in browser</option><option value="chrome">Chrome</option></select><span className="field-help">Claude Code continues to use Claude in Chrome.</span></label>
      <label>If that browser is unavailable<select value={draft.browserFallback} onChange={event=>setDraft({...draft,browserFallback:event.target.value as ApplicationPreferences['browserFallback']})}><option value="ask">Ask before switching</option><option value="other_supported">Use the other supported browser</option></select></label>
      <label>Page transitions<select value={draft.progressionMode} onChange={event=>setDraft({...draft,progressionMode:event.target.value as ApplicationPreferences['progressionMode']})}><option value="standard">Standard — continue through clearly non-final steps</option><option value="guided">Pause before every page transition</option></select></label>
      <label>Preferred application mode<select value={draft.preferredAutomationMode} onChange={event=>setDraft({...draft,preferredAutomationMode:event.target.value as ApplicationPreferences['preferredAutomationMode']})}><option value="guided">Guided</option><option value="autofill_to_review">Autofill one application to review</option><option value="campaign_to_review">Process selected applications to review</option></select><span className="field-help">This chooses what the agent offers. Autofill and campaigns still require approval for the exact jobs and expiration.</span></label>
      <div className="settings-boundaries"><strong>Always manual</strong><p>Login, passwords, CAPTCHA, MFA, sensitive-answer approval, legal consent, and the final Submit or Send action are never enabled by these preferences.</p></div>
      <div className="button-row"><button className="primary" type="submit" disabled={!dirty||Boolean(latest)}>Save setup</button><button className="secondary" type="button" disabled={!dirty} onClick={()=>{const parsed=readApplicationPreferences(base.profile);setDraft(parsed.preferences);setComplete(parsed.complete);setLatest(null);setError('');setNotice('Unsaved setup changes discarded.');}}>Discard changes</button></div>
    </fieldset></form>}
  </section>;
}
