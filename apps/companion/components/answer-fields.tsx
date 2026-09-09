import { FactValue } from './FactValue';
import { copy, get, has, parse, set, string, text } from '../../../src/contracts/workspace/values';
import type { Document, Value } from '../../../src/contracts/workspace/values';

export function AnswerFields({ draft, change, remember, creating = false }: {
  draft: Document;
  change: (draft: Document) => void;
  remember: boolean;
  creating?: boolean;
}) {
  const update = (field: string, value: Value) => change(set(copy(draft), field, value));
  const retainedValue = has(draft, 'value');
  return <>
    <label>Question<input required={creating} value={string(get(draft, 'question')) ?? ''} onChange={event => update('question', text(event.target.value))} /></label>
    <FactValue label="Other ways to ask" value={has(draft, 'aliases') ? get(draft, 'aliases') : []} change={value => update('aliases', value)} />
    {retainedValue ? <>
      <FactValue label="Answer value" value={get(draft, 'value')} change={value => update('value', value)} />
      <label>{creating ? 'Answer value type' : 'Replace answer with'}<select aria-label={creating ? 'Answer value type' : 'Replace answer with'} value="" onChange={event => {
        const kind = event.target.value;
        if (!kind) return;
        const value = kind === 'text' ? text('') : kind === 'number' ? parse('0') : kind === 'boolean' ? false
          : kind === 'fields' ? parse('{}') : kind === 'list' ? [] : null;
        update('value', value);
      }}>
        <option value="">Choose a new value type…</option>
        <option value="text">Text</option><option value="number">Number</option>
        <option value="boolean">Yes / no</option><option value="fields">Fields</option>
        <option value="list">List</option><option value="none">No value</option>
      </select></label>
    </> : <div>
      <p>The retained answer is hidden. Reveal it to view or edit it.</p>
      <button type="button" disabled={!remember} onClick={() => update('value', text(''))}>Replace hidden answer</button>
      {!remember && <p>To replace it without revealing it, first enable remember consent below.</p>}
    </div>}
    <label>Answer state<select aria-label="Answer state" value={string(get(draft, 'state')) ?? 'missing'} onChange={event => update('state', text(event.target.value))}>
      <option value="confirmed">Confirmed</option><option value="inferred">Suggested</option>
      <option value="missing">Missing</option><option value="sensitive">Sensitive</option>
    </select></label>
    <label>Source<input value={string(get(draft, 'source')) ?? ''} onChange={event => update('source', text(event.target.value))} /></label>
    <FactValue label="Applies to" value={has(draft, 'scope') ? get(draft, 'scope') : parse('{}')} change={value => update('scope', value)} />
    <label>Answer category<input value={string(get(draft, 'fieldClass')) ?? 'general'} pattern="[a-z][a-z0-9_]{0,63}" onChange={event => update('fieldClass', text(event.target.value))} /></label>
    <label>Sensitivity<select aria-label="Sensitivity" value={string(get(draft, 'sensitivity')) ?? 'none'} onChange={event => update('sensitivity', text(event.target.value))}>
      <option value="none">None</option><option value="personal">Personal</option><option value="high">High</option>
    </select></label>
  </>;
}
