import { useEffect, useRef, useState } from 'react';
import { PythonObject } from '../../../src/contracts/python-object';
import { copy, get, has, keys, parse, serialize, set, string, text, type Document, type Value } from '../../../src/contracts/workspace/values';

type Facts = Document;
type FactGroup = { title: string; keys: string[] };

const groups: FactGroup[] = [
  { title: 'Contact', keys: ['firstName', 'lastName', 'email', 'phone', 'location', 'linkedInUrl', 'githubUrl', 'portfolioUrl'] },
  { title: 'Professional summary', keys: ['summary'] },
  { title: 'Skills', keys: ['skills'] },
  { title: 'Experience', keys: ['workHistory'] },
  { title: 'Education', keys: ['education'] }
];

function factLabel(key: string) {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
  return spaced.replace(/\burl\b/gi, 'URL').replace(/\blinked in\b/i, 'LinkedIn')
    .replace(/^./, character => character.toUpperCase());
}

function replace(value: Value, path: Array<string | number>, next: Value): Value {
  if (!path.length) return next;
  const [part, ...rest] = path;
  if (Array.isArray(value) && typeof part === 'number') {
    const copy = [...value]; copy[part] = replace(copy[part]!, rest, next); return copy;
  }
  if (value instanceof PythonObject && typeof part === 'string') return set(copy(value), part, replace(get(value, part), rest, next));
  return value;
}

function recordTitle(value: Document, index: number) {
  for (const key of ['company', 'school', 'title', 'degree']) {
    const content = string(get(value, key));
    if (content?.trim()) return content;
  }
  return `Entry ${index + 1}`;
}

function PrimitiveEditor({ label, value, disabled, change }: { label: string; value: Value; disabled: boolean;
  change: (value: Value) => void }) {
  const [numeric, setNumeric] = useState<string | null>(null), [error, setError] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  const localValue = useRef(value);
  useEffect(() => {
    if (value === localValue.current) return;
    localValue.current = value;
    setNumeric(null); setError(''); input.current?.setCustomValidity('');
  }, [value]);
  if (typeof value === 'boolean') return <label>{label}<select value={value ? 'true' : 'false'} disabled={disabled}
    onChange={event => change(event.target.value === 'true')}><option value="true">Yes</option><option value="false">No</option></select></label>;
  if (value !== null && typeof value === 'object' && 'kind' in value) return <label>{label}
    <input ref={input} aria-label={label} aria-invalid={Boolean(error)} inputMode="decimal" value={numeric ?? serialize(value)} disabled={disabled} onChange={event => {
      const raw = event.target.value;
      setNumeric(raw);
      try {
        const next = parse(raw);
        if (next === null || typeof next !== 'object' || !('kind' in next)
          || next.kind === 'float' && !Number.isFinite(next.value)) throw Error();
        event.target.setCustomValidity(''); setError('');
        // Keep typed prefixes until a saved or reloaded value replaces this draft.
        localValue.current = next;
        change(next);
      } catch {
        event.target.setCustomValidity('Enter a valid number before saving.');
        setError('Enter a valid number before saving.');
      }
    }} />{error && <span role="alert">{error}</span>}</label>;
  const content = value === null ? '' : string(value) ?? '';
  if (content.length > 100 || content.includes('\n')) return <label className="resume-fact-wide">{label}<textarea rows={4} value={content}
    disabled={disabled} onChange={event => change(text(event.target.value))} /></label>;
  const type = /email/i.test(label) ? 'email' : /url|linkedin|github|portfolio/i.test(label) ? 'url' : 'text';
  return <label>{label}<input type={type} value={content} disabled={disabled} onChange={event => change(text(event.target.value))} /></label>;
}

function ValueEditor({ label, value, disabled, change }: { label: string; value: Value; disabled: boolean;
  change: (value: Value) => void }) {
  if (Array.isArray(value)) return <div className="resume-fact-array">
    {!value.length && <p className="resume-fact-empty">No items extracted.</p>}
    {value.map((item, index) => item instanceof PythonObject
      ? <fieldset className="resume-fact-record" key={index}><legend>{recordTitle(item, index)}</legend>
        <div className="resume-fact-fields">{keys(item).map(key => [key, get(item, key)] as const).map(([key, child]) => <ValueEditor key={key} label={factLabel(key)}
          value={child} disabled={disabled} change={next => change(replace(value, [index, key], next))} />)}</div></fieldset>
      : <ValueEditor key={index} label={`${label} ${index + 1}`} value={item} disabled={disabled}
        change={next => change(replace(value, [index], next))} />)}
  </div>;
  if (value instanceof PythonObject) return <fieldset className="resume-fact-record"><legend>{label}</legend>
    <div className="resume-fact-fields">{keys(value).map(key => [key, get(value, key)] as const).map(([key, child]) => <ValueEditor key={key} label={factLabel(key)}
      value={child} disabled={disabled} change={next => change(replace(value, [key], next))} />)}</div></fieldset>;
  return <PrimitiveEditor label={label} value={value} disabled={disabled} change={change} />;
}

export function ResumeFactEditor({ facts, disabled, change }: { facts: Facts; disabled: boolean; change: (facts: Facts) => void }) {
  const assigned = new Set(groups.flatMap(group => group.keys));
  const visible = groups.map(group => ({ ...group, keys: group.keys.filter(key => has(facts, key)) })).filter(group => group.keys.length);
  const additional = keys(facts).filter(key => !assigned.has(key));
  if (additional.length) visible.push({ title: 'Additional facts', keys: additional });
  return <div className="resume-fact-sections">{visible.map(group => <section className="resume-fact-section" key={group.title}>
    <h4>{group.title}</h4><div className="resume-fact-fields">{group.keys.map(key => <ValueEditor key={key} label={factLabel(key)}
      value={get(facts, key)} disabled={disabled} change={next => change(set(copy(facts), key, next))} />)}</div>
  </section>)}</div>;
}
