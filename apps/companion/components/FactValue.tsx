import { useEffect, useRef, useState } from 'react';
import { PythonObject } from '../../../src/contracts/python-object';
import { copy, get, set, text, keys, parse, serialize, type Value } from '../../../src/contracts/workspace/values';
import { string } from '../../../src/contracts/workspace/values';

/** Edits retain the rich JSON values of every untouched child, including numeric tokens. */
export function FactValue({ value, label, change, depth = 0 }: {
  value: Value; label: string; change: (value: Value) => void; depth?: number;
}) {
  const [newKey, setNewKey] = useState('');
  const [newKind, setNewKind] = useState('text');
  const [error, setError] = useState('');
  const [numeric, setNumeric] = useState<string | null>(null);
  const numberInput=useRef<HTMLInputElement|null>(null);
  useEffect(()=>{setNumeric(null);setError('');numberInput.current?.setCustomValidity('');},[value]);
  const update = (next: Value) => { setError(''); change(next); };
  if (depth > 12) return <p>Nested value retained. Edit this deeply nested fact through the CLI.</p>;
  if (value instanceof PythonObject) return <fieldset><legend>{label}</legend>
    {keys(value).map(key => <div className="fact-entry" key={key}>
      <FactValue value={get(value,key)} label={key} depth={depth+1} change={next => update(set(copy(value),key,next))}/>
      <button type="button" onClick={() => { const next=copy(value); next.delete(text(key)); update(next); }}>Remove {key}</button>
    </div>)}
    <label>New field in {label}<input value={newKey} onChange={event=>setNewKey(event.target.value)}/></label>
    <label>Type for new field in {label}<select aria-label={`Type for new field in ${label}`} value={newKind} onChange={event=>setNewKind(event.target.value)}>
      <option value="text">Text</option><option value="boolean">Yes / no</option><option value="number">Number</option><option value="object">Fields</option><option value="array">List</option>
    </select></label>
    <button type="button" disabled={!newKey || value.has(text(newKey))} onClick={()=>{ update(set(copy(value),newKey,newKind==='boolean'?true:newKind==='number'?parse('0'):newKind==='object'?parse('{}'):newKind==='array'?parse('[]'):text(''))); setNewKey(''); }}>Add field to {label}</button>
  </fieldset>;
  if (Array.isArray(value)) return <fieldset><legend>{label}</legend>
    {value.map((item,index)=><div className="fact-entry" key={index}>
      <FactValue value={item} label={`${label} ${index+1}`} depth={depth+1} change={next=>update(value.map((entry,i)=>i===index?next:entry))}/>
      <button type="button" onClick={()=>update(value.filter((_,i)=>i!==index))}>Remove {label} {index+1}</button>
    </div>)}
    <button type="button" onClick={()=>update([...value, label==='workHistory'?parse('{"company":"","title":"","startDate":"","endDate":""}'):label==='education'?parse('{"school":"","degree":"","field":""}'):text('')])}>Add {label} entry</button>
  </fieldset>;
  if (typeof value === 'boolean') return <label>{label}<select value={String(value)} onChange={event=>update(event.target.value==='true')}><option value="true">Yes</option><option value="false">No</option></select></label>;
  const content=string(value);
  if (content!==null) return <label>{label}<input value={content} onChange={event=>update(text(event.target.value))}/></label>;
  if (value===null) return <div>{label}: no value <button type="button" onClick={()=>update(text(''))}>Set {label}</button></div>;
  return <label>{label}<input ref={numberInput} value={numeric ?? serialize(value)} onChange={event=>{
    const raw=event.target.value;
    setNumeric(raw);
    try {
      const next=parse(raw);
      if (next===null || typeof next!=='object' || !('kind' in next)) throw Error();
      event.target.setCustomValidity('');
      update(next);
    } catch { event.target.setCustomValidity('Enter a valid number before saving.'); setError('Enter a valid number before saving.'); }
  }}/>{error&&<span role="alert">{error}</span>}</label>;
}
