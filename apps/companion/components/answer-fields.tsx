import { FactValue } from './FactValue';
import { selectVeteranStatus } from './answer-model';
import { PythonObject } from '../../../src/contracts/python-object';
import { copy, get, has, object, parse, set, string, text } from '../../../src/contracts/workspace/values';
import type { Document, Value } from '../../../src/contracts/workspace/values';

function valueType(value: Value): string {
  if (string(value) !== null) return 'text';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof PythonObject) return 'fields';
  if (Array.isArray(value)) return 'list';
  return value === null ? 'none' : 'number';
}

function consentChoice(value: Value, retained: boolean): string {
  if (!retained) return 'hidden';
  if (value === null) return 'unset';
  if (typeof value === 'boolean') return value ? 'agree' : 'decline';
  const answer = string(value)?.trim().toLowerCase();
  if (answer && /^(yes|i agree|agree)$/.test(answer)) return 'agree';
  if (answer && /^(no|decline|i decline)$/.test(answer)) return 'decline';
  if (answer && /^(acknowledged|i acknowledge)$/.test(answer)) return 'acknowledge';
  return 'custom';
}

export function AnswerFields({ draft, change, remember, creating = false, structuredHidden = false }: {
  draft: Document;
  change: (draft: Document) => void;
  remember: boolean;
  creating?: boolean;
  structuredHidden?: boolean;
}) {
  const update = (field: string, value: Value) => change(set(copy(draft), field, value));
  const retainedValue = has(draft, 'value');
  const consent = get(draft, 'consentIntent');
  const intent = consent instanceof PythonObject ? consent : null;
  const answerIntent = get(draft, 'answerIntent');
  const veteranIntent = answerIntent instanceof PythonObject && string(get(answerIntent, 'kind')) === 'veteran_status' ? answerIntent : null;
  const updateIntent = (field: string, value: Value) => {
    const next = intent ? copy(intent) : object(parse('{"kind":"opt_in","purpose":""}'), 'consent intent');
    set(next, field, value);
    update('consentIntent', next);
  };
  return <>
    <label>Question<input required={creating} value={string(get(draft, 'question')) ?? ''} onChange={event => update('question', text(event.target.value))} /></label>
    <FactValue label="Other ways to ask" value={has(draft, 'aliases') ? get(draft, 'aliases') : []} change={value => update('aliases', value)} />
    {intent && <label>Saved decision<select aria-label="Saved consent decision" value={consentChoice(get(draft, 'value'), retainedValue)} onChange={event => {
      const choice = event.target.value;
      if (choice === 'agree') update('value', text('Yes'));
      else if (choice === 'decline') update('value', text('No'));
      else if (choice === 'acknowledge') update('value', text('Acknowledged'));
      else if (choice === 'custom' && get(draft, 'value') === null) update('value', text(''));
      else if (choice === 'unset') update('value', null);
    }}>
      {!retainedValue && <option value="hidden">Saved decision hidden</option>}
      <option value="unset">No saved decision</option>
      <option value="agree">Yes / agree</option><option value="decline">No / decline</option>
      <option value="acknowledge">Acknowledge</option><option value="custom">Custom wording</option>
    </select></label>}
    {retainedValue && veteranIntent ? <label>Veteran status<select aria-label="Veteran status" value={string(get(veteranIntent, 'status')) ?? ''}
      onChange={event => change(selectVeteranStatus(draft, event.target.value))}>
      <option value="not_a_veteran">Not a veteran</option>
      <option value="veteran_not_protected">Veteran, not protected</option>
      <option value="protected_veteran">Protected veteran</option>
      <option value="decline_to_identify">Decline to identify</option>
    </select></label> : retainedValue ? <>
      <FactValue label="Answer value" value={get(draft, 'value')} change={value => update('value', value)} />
      <label>Answer value type<select aria-label="Answer value type" value={valueType(get(draft, 'value'))} onChange={event => {
        const kind = event.target.value;
        const value = kind === 'text' ? text('') : kind === 'number' ? parse('0') : kind === 'boolean' ? false
          : kind === 'fields' ? parse('{}') : kind === 'list' ? [] : null;
        update('value', value);
      }}>
        <option value="text">Text</option><option value="number">Number</option>
        <option value="boolean">Yes / no</option><option value="fields">Fields</option>
        <option value="list">List</option><option value="none">No value</option>
      </select></label>
    </> : !retainedValue ? <div>
      <p>The retained answer is hidden. Reveal it to view or edit it.</p>
      {structuredHidden ? <p>Reveal this answer to change its veteran status.</p> : <>
        <button type="button" disabled={!remember} onClick={() => update('value', text(''))}>Replace hidden answer</button>
        {!remember && <p>To replace it without revealing it, first enable remember consent below.</p>}
      </>}
    </div> : null}
    <label>Answer state<select aria-label="Answer state" disabled={Boolean(intent || veteranIntent)} value={string(get(draft, 'state')) ?? 'missing'} onChange={event => update('state', text(event.target.value))}>
      <option value="confirmed">Confirmed</option><option value="inferred">Suggested</option>
      <option value="missing">Missing</option><option value="sensitive">Sensitive</option>
    </select></label>
    <label>Source<input value={string(get(draft, 'source')) ?? ''} onChange={event => update('source', text(event.target.value))} /></label>
    <fieldset disabled={Boolean(veteranIntent)}><FactValue label="Applies to" value={has(draft, 'scope') ? get(draft, 'scope') : parse('{}')} change={value => update('scope', value)} /></fieldset>
    <label>Answer category<input disabled={Boolean(veteranIntent)} value={string(get(draft, 'fieldClass')) ?? 'general'} pattern="[a-z][a-z0-9_]{0,63}" onChange={event => update('fieldClass', text(event.target.value))} /></label>
    <label>Reusable consent decision<select aria-label="Reusable consent decision" value={intent ? 'consent' : 'ordinary'} onChange={event => {
      if (event.target.value === 'consent') {
        const next = copy(draft);
        set(next, 'consentIntent', object(parse('{"kind":"opt_in","purpose":""}'), 'consent intent'));
        set(next, 'state', text('sensitive'));
        set(next, 'sensitivity', text('high'));
        change(next);
      }
      else update('consentIntent', null);
    }}><option value="ordinary">Ordinary answer</option><option value="consent">Consent default</option></select></label>
    {intent && <>
      <label>Consent type<select aria-label="Consent type" value={string(get(intent, 'kind')) ?? 'opt_in'} onChange={event => updateIntent('kind', text(event.target.value))}>
        <option value="opt_in">Optional opt-in</option><option value="acknowledgment">Acknowledgment</option><option value="agreement">Agreement</option>
      </select></label>
      <label>Purpose ID<input required pattern="[a-z][a-z0-9_]{0,63}" value={string(get(intent, 'purpose')) ?? ''} onChange={event => updateIntent('purpose', text(event.target.value))} /></label>
      <p>A saved choice identifies a purpose. The agent must still review the live notice and get current-form approval before acting.</p>
    </>}
    <label>Sensitivity<select aria-label="Sensitivity" disabled={Boolean(intent || veteranIntent)} value={string(get(draft, 'sensitivity')) ?? 'none'} onChange={event => update('sensitivity', text(event.target.value))}>
      <option value="none">None</option><option value="personal">Personal</option><option value="high">High</option>
    </select></label>
  </>;
}
