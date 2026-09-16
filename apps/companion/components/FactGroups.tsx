import { useEffect, useRef, useState } from 'react';
import type { Client } from './client';
import { object } from './contracts';
type Group = { id: string; label: string; paths: string[]; order: number; revision: number };
function groupsResult(value: unknown): Group[] {
  if (!object(value) || !Array.isArray(value.groups)) throw Error('Invalid fact groups response');
  return value.groups.map(item=>{
    if (!object(item) || typeof item.id!=='string' || typeof item.label!=='string' || !Array.isArray(item.paths)
      || item.paths.some(path=>typeof path!=='string') || !Number.isSafeInteger(item.order) || !Number.isSafeInteger(item.revision) || Number(item.revision)<1) throw Error('Invalid fact group record');
    return item as Group;
  });
}
export function FactGroups({client,dirtyChanged}:{client:Client;dirtyChanged:(dirty:boolean)=>void}) {
  const [groups,setGroups]=useState<Group[]|null>(null);
  const [edit,setEdit]=useState<Group|null>(null);
  const [label,setLabel]=useState(''),[paths,setPaths]=useState('');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [notice,setNotice]=useState(''),[editorOpen,setEditorOpen]=useState(false);
  const alive=useRef(false), request=useRef<AbortController|null>(null);
  const dirty=Boolean(label||paths||edit);
  useEffect(()=>{dirtyChanged(dirty||busy);return()=>dirtyChanged(false);},[dirty,busy,dirtyChanged]);
  async function refresh() {
    request.current?.abort(); const controller=new AbortController();request.current=controller;
    try {const value=groupsResult(await client.groups(controller.signal));if(alive.current&&!controller.signal.aborted){setGroups(value);setError('');}}
    catch(error){if(alive.current&&!controller.signal.aborted)setError(error instanceof Error?error.message:'Unable to load groups');}
  }
  useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;request.current?.abort();};},[client]);
  function reset(){setEdit(null);setLabel('');setPaths('');setEditorOpen(false);}
  async function mutate(remove?:Group) {
    setBusy(true);setError('');setNotice('');
    request.current?.abort();const controller=new AbortController();request.current=controller;
    try {
      if(remove) await client.deleteGroup(remove.id,remove.revision,controller.signal);
      else {
        const patch={label,paths:paths.split('\n').filter(path=>path.length>0)};
        if(edit) await client.updateGroup(edit.id,edit.revision,patch,controller.signal);
        else await client.createGroup(patch,controller.signal);
      }
      if(alive.current){if(!remove)reset();setNotice(remove?'Group deleted. Facts are retained.':'Group saved.');await refresh();}
    } catch(error){if(alive.current)setError(`${error instanceof Error?error.message:'Group save failed'}. Your draft is retained. Refresh groups before retrying a conflict.`);}
    finally{if(alive.current)setBusy(false);}
  }
  return <section className="facts-organizer" aria-label="Fact groups"><div className="facts-organizer-heading"><div><p className="eyebrow">Saved views</p><h2>Focus the facts you need</h2><p>Custom groups organize canonical paths without moving or copying the facts themselves.</p></div><div className="button-row"><button className="secondary" type="button" disabled={busy} onClick={()=>void refresh()}>Refresh groups</button><button className="primary" type="button" disabled={busy||editorOpen} onClick={()=>setEditorOpen(true)}>New group</button></div></div>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {groups===null?<p className="workspace-status">Loading groups…</p>:!groups.length?<div className="facts-groups-empty"><p>No saved views yet. Create a group when you want to review a set of facts together.</p></div>:<ul className="fact-group-list">{groups.map(group=><li key={group.id}>
      <div><strong>{group.label}</strong><span>{group.paths.join(', ')}</span></div>
      <div className="button-row"><button className="secondary" type="button" disabled={busy} onClick={()=>{if(dirty&&!confirm('Discard unsaved group changes?'))return;setEdit(group);setLabel(group.label);setPaths(group.paths.join('\n'));setEditorOpen(true);}}>Edit {group.label}</button>
      <button className="text-action" type="button" disabled={busy||dirty} onClick={()=>{if(confirm(`Delete group ${group.label}? The facts will be retained.`))void mutate(group);}}>Delete {group.label}</button></div>
    </li>)}</ul>}
    {editorOpen&&<form className="fact-group-editor" onSubmit={event=>{event.preventDefault();void mutate();}}><fieldset disabled={busy}>
      <legend>{edit?'Edit group':'New group'}</legend>
      <p>Organize facts using their paths, for example /email or /preferences/remote.</p>
      <div className="fact-group-fields"><label>Group label<input required maxLength={80} value={label} onChange={event=>setLabel(event.target.value)}/></label>
      <label>Fact paths, one per line<textarea required value={paths} onChange={event=>setPaths(event.target.value)}/></label></div>
      <div className="button-row"><button className="primary" type="submit">Save group</button><button className="secondary" type="button" onClick={reset}>Cancel group changes</button></div>
      {edit&&groups?.some(group=>group.id===edit.id&&group.revision!==edit.revision)&&<button type="button" onClick={()=>{const latest=groups.find(group=>group.id===edit.id);if(latest){if(label===edit.label)setLabel(latest.label);if(paths===edit.paths.join('\n'))setPaths(latest.paths.join('\n'));setEdit(latest);}}}>Reapply group draft</button>}
      {edit&&groups&&!groups.some(group=>group.id===edit.id)&&<p role="alert">This group was deleted. Cancel these changes or save it as a new group.</p>}
      {edit&&groups&&!groups.some(group=>group.id===edit.id)&&<button type="button" onClick={()=>setEdit(null)}>Keep draft as new group</button>}
    </fieldset></form>}
  </section>;
}
