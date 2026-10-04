import { useEffect,useRef,useState } from 'react';
import { ApiError,type Client } from './client';
import { applicationPreferencesPatch,readApplicationPreferences,type ApplicationPreferences } from './application-preferences-model';
import { readAgentModelPreferences, validAgentModelId, validCodexReasoningEffort, type AgentModelPreferences } from './agent-model-preferences-model';
import type { ProfileSnapshot } from './facts-model';

const equal=(a:ApplicationPreferences,b:ApplicationPreferences)=>a.preferredBrowser===b.preferredBrowser
  &&a.browserFallback===b.browserFallback&&a.progressionMode===b.progressionMode
  &&a.preferredAutomationMode===b.preferredAutomationMode;
const preferenceKeys=['preferredBrowser','browserFallback','progressionMode','preferredAutomationMode'] as const;
const modelKeys=['codexSearch','codexApplication','claudeCodeSearch','claudeCodeApplication'] as const;
const effortKeys=['codexSearchEffort','codexApplicationEffort'] as const;
const settingKeys=[...modelKeys,...effortKeys] as const;
const equalModels=(a:AgentModelPreferences,b:AgentModelPreferences)=>settingKeys.every(key=>a[key].trim()===b[key]);
function reapplyPreferences(before:ProfileSnapshot,draft:ApplicationPreferences,latest:ProfileSnapshot):ApplicationPreferences {
  const previous=readApplicationPreferences(before.profile).preferences;
  const result={...readApplicationPreferences(latest.profile).preferences};
  for(const key of preferenceKeys)if(draft[key]!==previous[key])Object.assign(result,{[key]:draft[key]});
  return result;
}
function reapplyModels(before:ProfileSnapshot,draft:AgentModelPreferences,latest:ProfileSnapshot):AgentModelPreferences {
  const previous=readAgentModelPreferences(before.profile),result=readAgentModelPreferences(latest.profile);
  for(const key of settingKeys)if(draft[key].trim()!==previous[key])result[key]=draft[key];
  return result;
}

export function ApplicationSettings({client,dirtyChanged}:{client:Client;dirtyChanged:(dirty:boolean)=>void}) {
  const [base,setBase]=useState<ProfileSnapshot|null>(null),[draft,setDraft]=useState<ApplicationPreferences|null>(null);
  const [models,setModels]=useState<AgentModelPreferences|null>(null);
  const [complete,setComplete]=useState(false),[latest,setLatest]=useState<ProfileSnapshot|null>(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const alive=useRef(false),request=useRef<AbortController|null>(null),generation=useRef(0),dirtyRef=useRef(false);
  const dirty=Boolean(base&&draft&&models&&(!complete||!equal(readApplicationPreferences(base.profile).preferences,draft)
    ||!equalModels(readAgentModelPreferences(base.profile),models)));
  const invalidModel=Boolean(models&&modelKeys.some(key=>!validAgentModelId(models[key].trim())));
  const invalidEffort=Boolean(models&&effortKeys.some(key=>!validCodexReasoningEffort(models[key].trim())));
  dirtyRef.current=dirty;
  useEffect(()=>{dirtyChanged(dirty||busy);return()=>dirtyChanged(false);},[dirty,busy,dirtyChanged]);
  async function refresh(discard=false) {
    request.current?.abort();const controller=new AbortController();request.current=controller;const version=++generation.current;
    setLoading(true);setError('');
    try {
      const next=await client.profile(controller.signal);if(!alive.current||version!==generation.current)return;
      if(dirtyRef.current&&!discard){setLatest(next.revision===base?.revision?null:next);setNotice('Latest setup loaded. Your choices are retained.');return;}
      const parsed=readApplicationPreferences(next.profile);setBase(next);setDraft(parsed.preferences);
      setModels(readAgentModelPreferences(next.profile));setComplete(parsed.complete);setLatest(null);
      setNotice(parsed.complete?'Saved application setup loaded.':'Choose and save your application defaults.');
    } catch(cause){if(alive.current&&version===generation.current&&!controller.signal.aborted)setError(cause instanceof Error?cause.message:'Unable to load setup');}
    finally{if(alive.current&&version===generation.current)setLoading(false);}
  }
  useEffect(()=>{alive.current=true;void refresh(true);return()=>{alive.current=false;generation.current++;request.current?.abort();};},[client]);
  async function save() {
    if(!base||!draft||!models||!dirty||invalidModel||invalidEffort)return;request.current?.abort();const controller=new AbortController();request.current=controller;const version=++generation.current;
    setBusy(true);setError('');setNotice('');
    try {
      const next=await client.patchProfile(applicationPreferencesPatch(base,draft,models),controller.signal);if(!alive.current||version!==generation.current)return;
      const parsed=readApplicationPreferences(next.profile);setBase(next);setDraft(parsed.preferences);
      setModels(readAgentModelPreferences(next.profile));setComplete(parsed.complete);setLatest(null);setNotice('Application setup saved.');
    } catch(cause){
      if(!alive.current||version!==generation.current)return;setError(cause instanceof Error?cause.message:'Unable to save setup');
      if(cause instanceof ApiError&&cause.status===409){try{const next=await client.profile(controller.signal);if(alive.current&&version===generation.current)setLatest(next);}catch{setError('Setup changed elsewhere. Refresh to load the current revision; your choices are retained.');}}
    } finally{if(alive.current&&version===generation.current)setBusy(false);}
  }
  return <section className="settings-workspace" aria-labelledby="settings-workspace-title">
    <header className="workspace-hero"><div className="workspace-hero-copy"><p className="eyebrow">Controls</p><h1 id="settings-workspace-title">Settings</h1><p>Set defaults for Codex and Claude Code. You can choose differently for an individual task.</p></div><div className="workspace-hero-actions"><button className="secondary" disabled={busy||loading} onClick={()=>void refresh()}>Refresh setup</button></div></header>
    <p className="workspace-status" role="status">{loading?'Loading setup…':notice||(base?`Canonical profile revision ${base.revision}.`:'')}</p>
    {error&&<p className="error" role="alert">{error} <button disabled={busy||loading} onClick={()=>void refresh()}>Retry loading setup</button></p>}
    {latest&&base&&draft&&models&&<aside className="notice facts-conflict" role="alert"><p><strong>Setup changed elsewhere.</strong> Your choices are retained.</p><button disabled={busy} onClick={()=>{setDraft(reapplyPreferences(base,draft,latest));setModels(reapplyModels(base,models,latest));setBase(latest);setComplete(readApplicationPreferences(latest.profile).complete);setLatest(null);setError('');setNotice('Only your changed choices were reapplied to the latest revision. Review before saving.');}}>Reapply my setup choices</button><button disabled={busy} onClick={()=>{const parsed=readApplicationPreferences(latest.profile);setBase(latest);setDraft(parsed.preferences);setModels(readAgentModelPreferences(latest.profile));setComplete(parsed.complete);setLatest(null);setError('');setNotice('Saved setup loaded.');}}>Load saved setup</button></aside>}
    {base&&draft&&models&&<form className="workspace-panel settings-panel" onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={busy||loading}><legend>Application and agent defaults</legend>
      <label>Preferred Codex browser<select value={draft.preferredBrowser} onChange={event=>setDraft({...draft,preferredBrowser:event.target.value as ApplicationPreferences['preferredBrowser']})}><option value="codex_browser">Codex built-in browser</option><option value="chrome">Chrome</option></select><span className="field-help">Claude Code continues to use Claude in Chrome.</span></label>
      <label>If that browser is unavailable<select value={draft.browserFallback} onChange={event=>setDraft({...draft,browserFallback:event.target.value as ApplicationPreferences['browserFallback']})}><option value="ask">Ask before switching</option><option value="other_supported">Use the other supported browser</option></select></label>
      <label>Page transitions<select value={draft.progressionMode} onChange={event=>setDraft({...draft,progressionMode:event.target.value as ApplicationPreferences['progressionMode']})}><option value="standard">Standard — continue through clearly non-final steps</option><option value="guided">Pause before every page transition</option></select></label>
      <label>Preferred application mode<select value={draft.preferredAutomationMode} onChange={event=>setDraft({...draft,preferredAutomationMode:event.target.value as ApplicationPreferences['preferredAutomationMode']})}><option value="guided">Guided</option><option value="autofill_to_review">Autofill one application to review</option><option value="campaign_to_review">Process selected applications to review</option></select><span className="field-help">This chooses what the agent offers. Autofill and campaigns still require approval for the exact jobs and expiration.</span></label>
      <h2>Model defaults by task</h2>
      <p>Enter an exact model ID supported by that host, or leave it blank to use its default. Choose Codex reasoning effort separately. The agent checks the model and effort together before launch; Settings cannot check live availability. Saved choices apply to new dedicated tasks, not this task.</p>
      <h3>Find jobs</h3>
      <p>Codex can use this model for a separate job search task when you request one. Claude Code uses its model for source research workers. Research in the current task uses that task's model.</p>
      <label>Codex job search task model<input value={models.codexSearch} maxLength={120} placeholder="Host default" onChange={event=>setModels({...models,codexSearch:event.target.value})}/></label>
      <label>Codex job search reasoning effort<select value={models.codexSearchEffort} onChange={event=>setModels({...models,codexSearchEffort:event.target.value})}><option value="">Host default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>{!validCodexReasoningEffort(models.codexSearchEffort)&&<option value={models.codexSearchEffort}>Unsupported saved value</option>}</select></label>
      <label>Claude Code job search worker model<input value={models.claudeCodeSearch} maxLength={120} placeholder="Host default" onChange={event=>setModels({...models,claudeCodeSearch:event.target.value})}/></label>
      <h3>Fill an application</h3>
      <p>Codex can use this model for a separate exact-job application task when you request one. Claude Code uses its model for one filling worker.</p>
      <label>Codex application task model<input value={models.codexApplication} maxLength={120} placeholder="Host default" onChange={event=>setModels({...models,codexApplication:event.target.value})}/></label>
      <label>Codex application reasoning effort<select value={models.codexApplicationEffort} onChange={event=>setModels({...models,codexApplicationEffort:event.target.value})}><option value="">Host default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>{!validCodexReasoningEffort(models.codexApplicationEffort)&&<option value={models.codexApplicationEffort}>Unsupported saved value</option>}</select></label>
      <label>Claude Code application filling worker model<input value={models.claudeCodeApplication} maxLength={120} placeholder="Host default" onChange={event=>setModels({...models,claudeCodeApplication:event.target.value})}/></label>
      <p>Job Title Discovery and resume fact extraction currently run in the active task and use its model.</p>
      {invalidModel&&<p role="alert" className="error">Use a model ID with letters, numbers, . _ : / + or -.</p>}
      {invalidEffort&&<p role="alert" className="error">Choose Host default, Low, Medium, or High for Codex reasoning effort.</p>}
      <div className="settings-boundaries"><strong>Always manual</strong><p>Login, passwords, CAPTCHA, MFA, sensitive-answer approval, legal consent, and the final Submit or Send action are never enabled by these preferences.</p></div>
      <div className="button-row"><button className="primary" type="submit" disabled={!dirty||Boolean(latest)||invalidModel||invalidEffort}>Save setup</button><button className="secondary" type="button" disabled={!dirty} onClick={()=>{const parsed=readApplicationPreferences(base.profile);setDraft(parsed.preferences);setModels(readAgentModelPreferences(base.profile));setComplete(parsed.complete);setLatest(null);setError('');setNotice('Unsaved setup changes discarded.');}}>Discard changes</button></div>
    </fieldset></form>}
  </section>;
}
