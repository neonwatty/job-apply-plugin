import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type Client } from './client';
import { FactValue } from './FactValue';
import { FactGroups } from './FactGroups';
import { copy,get,set,text,keys,same,parse,type Document } from '../../../src/contracts/workspace/values';
import { factProvenance,patchBody,reapplyDraft,type ProfileSnapshot } from './facts-model';
const sections=['firstName','lastName','email','phone','location','linkedInUrl','portfolioUrl','githubUrl','workHistory','education','skills','preferences'];
export function Facts({client,dirtyChanged}:{client:Client;dirtyChanged:(dirty:boolean)=>void}) {
  const [base,setBase]=useState<ProfileSnapshot|null>(null),[draft,setDraft]=useState<Document|null>(null);
  const [latest,setLatest]=useState<ProfileSnapshot|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[key,setKey]=useState('firstName'),[kind,setKind]=useState('text');
  const [invalid,setInvalid]=useState(false),[editorVersion,setEditorVersion]=useState(0);
  const [query,setQuery]=useState(''),[groupDirty,setGroupDirty]=useState(false);
  const alive=useRef(false), generation=useRef(0), request=useRef<AbortController|null>(null);
  const form=useRef<HTMLFormElement|null>(null);
  useEffect(()=>{setInvalid(form.current?!form.current.checkValidity():false);},[draft,editorVersion]);
  const state=useRef({base,draft});
  state.current={base,draft};
  const dirty=Boolean(base&&draft&&!same(base.profile,draft));
  const groupChanged=useCallback((value:boolean)=>setGroupDirty(value),[]);
  useEffect(()=>{dirtyChanged(dirty||busy||groupDirty||invalid);return()=>dirtyChanged(false);},[dirty,busy,groupDirty,invalid,dirtyChanged]);
  async function refresh() {
    request.current?.abort();const controller=new AbortController();request.current=controller;const version=++generation.current;
    setLoading(true);setError('');
    try {
      const next=await client.profile(controller.signal);
      if(!alive.current||version!==generation.current)return;
      const current=state.current;
      if(current.base&&current.draft&&!same(current.base.profile,current.draft)){setLatest(next.revision===current.base.revision?null:next);setNotice('Latest facts loaded. Your draft is retained.');}
      else{setBase(next);setDraft(next.profile);setLatest(null);}
    } catch(error){if(alive.current&&version===generation.current&&!controller.signal.aborted)setError(error instanceof Error?error.message:'Unable to load facts');}
    finally{if(alive.current&&version===generation.current)setLoading(false);}
  }
  useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;generation.current++;request.current?.abort();};},[client]);
  async function save() {
    if(!base||!draft||!dirty)return;
    request.current?.abort();const controller=new AbortController();request.current=controller;const version=++generation.current;
    setLoading(false);setBusy(true);setError('');setNotice('');
    try {
      const next=await client.patchProfile(patchBody(base,draft),controller.signal);
      if(!alive.current||version!==generation.current)return;
      setBase(next);setDraft(next.profile);setLatest(null);setNotice('Facts saved.');
    } catch(error){
      if(!alive.current||version!==generation.current)return;
      setError(error instanceof Error?error.message:'Unable to save facts');
      if(error instanceof ApiError&&error.status===409){
        try{const next=await client.profile(controller.signal);if(alive.current&&version===generation.current)setLatest(next);}
        catch{if(alive.current&&version===generation.current)setError('Facts changed elsewhere. Refresh to load the current revision; your draft is retained.');}
      }
    } finally{if(alive.current&&version===generation.current)setBusy(false);}
  }
  return <section className="facts-workspace" aria-labelledby="facts-workspace-title">
    <header className="workspace-hero">
      <div className="workspace-hero-copy"><p className="eyebrow">Facts workspace</p><h1 id="facts-workspace-title">Your canonical application facts.</h1><p>Review and selectively edit the same local profile used by Job Apply agents.</p></div>
      <div className="workspace-hero-actions">
        <button className="secondary" disabled={busy||loading||invalid} onClick={()=>void refresh()}>Refresh facts</button>
        <button className="primary" type="submit" form="facts-form" disabled={!dirty||Boolean(latest)||invalid||busy}>Save changes</button>
      </div>
    </header>
    <p className="workspace-status" role="status">{loading?'Loading facts…':notice||(base?`Canonical profile revision ${base.revision}.`:'')}</p>
    {error&&<p className="error" role="alert">{error} <button disabled={busy||loading||invalid} onClick={()=>void refresh()}>Retry loading facts</button></p>}
    {latest&&base&&draft&&<aside className="notice facts-conflict" role="alert"><p><strong>Facts changed elsewhere.</strong> Your draft is retained.</p>
      <button disabled={busy} onClick={()=>{setDraft(reapplyDraft(base.profile,draft,latest.profile));setBase(latest);setLatest(null);setError('');setNotice('Draft reapplied. Review it before saving.');}}>Reapply my facts draft</button>
      <button disabled={busy} onClick={()=>{if(confirm('Discard your facts draft and load saved facts?')){setBase(latest);setDraft(latest.profile);setLatest(null);setError('');}}}>Load saved facts</button>
    </aside>}
    <FactGroups client={client} dirtyChanged={groupChanged}/>
    {base&&draft&&<section className="workspace-panel facts-panel" aria-labelledby="facts-form-title">
      <div className="workspace-panel-heading">
        <div><p className="eyebrow">Canonical profile</p><h2 id="facts-form-title">Applicant facts</h2></div>
        <p className="facts-revision">Revision {base.revision}</p>
      </div>
      <form id="facts-form" ref={form} onChange={event=>setInvalid(!event.currentTarget.checkValidity())} onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={busy}>
        <legend className="visually-hidden">Profile facts</legend>
        <div className="facts-filter"><label>Find a fact<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search canonical facts"/></label><span>{keys(draft).filter(name=>name.toLowerCase().includes(query.toLowerCase())).length} shown</span></div>
        {!draft.size&&<div className="workspace-empty facts-empty"><span className="empty-check" aria-hidden="true">◇</span><strong>No profile facts yet.</strong><p>Add a field below to start your canonical profile.</p></div>}
        {draft.size>0&&!keys(draft).some(name=>name.toLowerCase().includes(query.toLowerCase()))&&<div className="workspace-empty facts-empty"><strong>No matching facts.</strong><p>Try another search or add a new fact below.</p></div>}
        <div className="facts-list">{keys(draft).map(name=><div key={name} hidden={!name.toLowerCase().includes(query.toLowerCase())} className="fact-card">
          <FactValue key={editorVersion} label={name} value={get(draft,name)} change={value=>setDraft(current=>current?set(copy(current),name,value):current)}/>
          <details><summary>Fact source</summary><pre>{factProvenance(base.provenance,name)}</pre></details>
          <button className="text-action" type="button" onClick={()=>{const next=copy(draft);next.delete(text(name));setDraft(next);}}>Remove fact {name}</button>
        </div>)}</div>
        <fieldset className="fact-add-panel"><legend>Add a fact</legend><p>Add a standard profile field or a custom value used during applications.</p>
          <div className="fact-add-grid"><label>Fact name<input list="fact-names" value={key} onChange={event=>setKey(event.target.value)}/><datalist id="fact-names">{sections.map(name=><option key={name} value={name}/>)}</datalist></label>
          <label>Value type<select value={kind} onChange={event=>setKind(event.target.value)}><option value="text">Text</option><option value="object">Fields</option><option value="array">List</option><option value="boolean">Yes / no</option><option value="number">Number</option><option value="null" disabled={sections.includes(key)}>No value (additional facts)</option></select></label>
          <button className="secondary" type="button" disabled={!key||draft.has(text(key))||(kind==='null'&&sections.includes(key))} onClick={()=>{
            const value=['workHistory','education','skills'].includes(key)?parse('[]'):key==='preferences'?parse('{}'):kind==='object'?parse('{}'):kind==='array'?parse('[]'):kind==='boolean'?true:kind==='number'?parse('0'):kind==='null'?null:text('');
            setDraft(set(copy(draft),key,value));setQuery('');
          }}>Add fact</button></div>
        </fieldset>
        <div className="facts-actions"><button className="primary" type="submit" disabled={!dirty||Boolean(latest)||invalid}>Save facts</button>
        <button className="secondary" type="button" disabled={!dirty&&!invalid} onClick={()=>{if(confirm('Discard unsaved facts changes?')){setDraft(base.profile);setEditorVersion(value=>value+1);setInvalid(false);setLatest(null);setError('');setNotice('Draft discarded.');}}}>Discard facts changes</button></div>
      </fieldset></form>
    </section>}
  </section>;
}
