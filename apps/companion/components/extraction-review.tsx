import { PythonObject } from '../../../src/contracts/python-object';
import { get, keys, object, serialize, string } from '../../../src/contracts/workspace/values';
import type { Value } from '../../../src/contracts/workspace/values';
import { candidateValue, pendingPaths, replacementScope } from './extraction-model';
import type { Choices, Decision, Document } from './extraction-model';

function ValueDisplay({ value }: { value: Value }) {
  if (value instanceof PythonObject) return <dl>{keys(value).map(key => <div key={key}>
    <dt>{key}</dt><dd><ValueDisplay value={get(value, key)} /></dd>
  </div>)}</dl>;
  if (Array.isArray(value)) return value.length ? <ul>{value.map((item, index) => <li key={index}><ValueDisplay value={item} /></li>)}</ul> : <span>Empty list</span>;
  return <span style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{string(value) ?? (value === null ? 'No value' : serialize(value))}</span>;
}
export function ExtractionReview({ proposal, choices, confirmed, disabled, change, confirmReplacement }: {
  proposal: Document; choices: Choices; confirmed: string[]; disabled: boolean;
  change: (pointer: string, decision: Decision | '') => void;
  confirmReplacement: (pointer: string, checked: boolean) => void;
}) {
  const current = object(get(proposal, 'currentValues'), 'current values');
  return <fieldset disabled={disabled}><legend>Review extracted facts</legend>
    {pendingPaths(proposal).map(pointer => {
      const existing = object(get(current, pointer), 'current fact');
      const scope = replacementScope(proposal, pointer);
      return <fieldset key={pointer} style={{ minWidth: 0 }}><legend style={{ overflowWrap: 'anywhere' }}>{pointer}</legend>
        <p>Current fact</p>{get(existing, 'exists') === true ? <ValueDisplay value={get(existing, 'value')} /> : <p>Not set</p>}
        <p>Extracted fact</p><ValueDisplay value={candidateValue(proposal, pointer)} />
        <label>Decision for {pointer}<select aria-label={`Decision for ${pointer}`} value={choices[pointer] ?? ''} onChange={event => change(pointer, event.target.value as Decision | '')}>
          <option value="">Choose a decision</option><option value="keep_current">Keep current</option><option value="use_extracted">Use extracted</option>
        </select></label>
        {scope && choices[pointer] === 'use_extracted' && <div>
          <p>This replaces the existing value at {string(get(scope, 'path'))}:</p><ValueDisplay value={get(scope, 'value')} />
          <label><input type="checkbox" aria-label={`I confirm replacing ${string(get(scope, 'path'))} for ${pointer}.`} checked={confirmed.includes(pointer)} onChange={event => confirmReplacement(pointer, event.target.checked)} />
            I confirm replacing {string(get(scope, 'path'))} for {pointer}.</label>
        </div>}
      </fieldset>;
    })}
  </fieldset>;
}
