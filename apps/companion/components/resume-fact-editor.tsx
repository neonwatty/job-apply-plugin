import { object } from './contracts';

type Facts = Record<string, unknown>;
type FactGroup = { title: string; keys: string[] };

const groups: FactGroup[] = [
  { title: 'Contact', keys: ['firstName', 'lastName', 'email', 'phone', 'location', 'linkedInUrl', 'githubUrl', 'portfolioUrl'] },
  { title: 'Professional summary', keys: ['summary'] },
  { title: 'Skills', keys: ['skills'] },
  { title: 'Experience', keys: ['workHistory'] },
  { title: 'Education', keys: ['education'] }
];

export function factLabel(key: string) {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
  return spaced.replace(/\burl\b/gi, 'URL').replace(/\blinked in\b/i, 'LinkedIn')
    .replace(/^./, character => character.toUpperCase());
}

function replace(value: unknown, path: Array<string | number>, next: unknown): unknown {
  if (!path.length) return next;
  const [part, ...rest] = path;
  if (Array.isArray(value) && typeof part === 'number') {
    const copy = [...value]; copy[part] = replace(copy[part], rest, next); return copy;
  }
  if (object(value) && typeof part === 'string') return { ...value, [part]: replace(value[part], rest, next) };
  return value;
}

function recordTitle(value: Record<string, unknown>, index: number) {
  for (const key of ['company', 'school', 'title', 'degree']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key] as string;
  }
  return `Entry ${index + 1}`;
}

function PrimitiveEditor({ label, value, disabled, change }: { label: string; value: unknown; disabled: boolean;
  change: (value: unknown) => void }) {
  if (typeof value === 'boolean') return <label>{label}<select value={value ? 'true' : 'false'} disabled={disabled}
    onChange={event => change(event.target.value === 'true')}><option value="true">Yes</option><option value="false">No</option></select></label>;
  if (typeof value === 'number') return <label>{label}<input type="number" value={value} disabled={disabled}
    onChange={event => change(Number(event.target.value))} /></label>;
  const text = value == null ? '' : String(value);
  if (text.length > 100 || text.includes('\n')) return <label className="resume-fact-wide">{label}<textarea rows={4} value={text}
    disabled={disabled} onChange={event => change(event.target.value)} /></label>;
  const type = /email/i.test(label) ? 'email' : /url|linkedin|github|portfolio/i.test(label) ? 'url' : 'text';
  return <label>{label}<input type={type} value={text} disabled={disabled} onChange={event => change(event.target.value)} /></label>;
}

function ValueEditor({ label, value, disabled, change }: { label: string; value: unknown; disabled: boolean;
  change: (value: unknown) => void }) {
  if (Array.isArray(value)) return <div className="resume-fact-array">
    {!value.length && <p className="resume-fact-empty">No items extracted.</p>}
    {value.map((item, index) => object(item)
      ? <fieldset className="resume-fact-record" key={index}><legend>{recordTitle(item, index)}</legend>
        <div className="resume-fact-fields">{Object.entries(item).map(([key, child]) => <ValueEditor key={key} label={factLabel(key)}
          value={child} disabled={disabled} change={next => change(replace(value, [index, key], next))} />)}</div></fieldset>
      : <PrimitiveEditor key={index} label={`${label} ${index + 1}`} value={item} disabled={disabled}
        change={next => change(replace(value, [index], next))} />)}
  </div>;
  if (object(value)) return <fieldset className="resume-fact-record"><legend>{label}</legend>
    <div className="resume-fact-fields">{Object.entries(value).map(([key, child]) => <ValueEditor key={key} label={factLabel(key)}
      value={child} disabled={disabled} change={next => change(replace(value, [key], next))} />)}</div></fieldset>;
  return <PrimitiveEditor label={label} value={value} disabled={disabled} change={change} />;
}

export function ResumeFactEditor({ facts, disabled, change }: { facts: Facts; disabled: boolean; change: (facts: Facts) => void }) {
  const assigned = new Set(groups.flatMap(group => group.keys));
  const visible = groups.map(group => ({ ...group, keys: group.keys.filter(key => key in facts) })).filter(group => group.keys.length);
  const additional = Object.keys(facts).filter(key => !assigned.has(key));
  if (additional.length) visible.push({ title: 'Additional facts', keys: additional });
  return <div className="resume-fact-sections">{visible.map(group => <section className="resume-fact-section" key={group.title}>
    <h4>{group.title}</h4><div className="resume-fact-fields">{group.keys.map(key => <ValueEditor key={key} label={factLabel(key)}
      value={facts[key]} disabled={disabled} change={next => change({ ...facts, [key]: next })} />)}</div>
  </section>)}</div>;
}
