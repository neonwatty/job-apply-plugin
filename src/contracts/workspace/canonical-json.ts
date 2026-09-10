import { PythonObject } from '../python-object.js';
import { PythonText } from '../python-text.js';
import { serializeJsonGraph } from '../raw-json/json-serialization-core.js';
import { serialize, string, JobsError } from './values.js';
import type { Value } from './values.js';

/** Python compact, sorted, ensure_ascii=False JSON, without losing integer precision. */
export function canonicalJson(value: Value, errorMessage = 'canonical JSON is invalid'): string {
  const quote = (item: PythonText): string => {
    if (item.codePoints.some(point => point >= 0xd800 && point <= 0xdfff)) {
      throw new JobsError(errorMessage);
    }
    return JSON.stringify(string(item));
  };
  return serializeJsonGraph<Value>(value, current => {
    if (current instanceof PythonText) return { kind: 'scalar', text: quote(current) };
    if (Array.isArray(current)) return { kind: 'array', identity: current, items: current };
    if (current instanceof PythonObject) return { kind: 'object', identity: current,
      entries: [...current.entries()].sort(([left], [right]) => left.compare(right))
        .map(([key, item]) => [quote(key), item] as const) };
    return { kind: 'scalar', text: serialize(current) };
  }, () => new JobsError(errorMessage));
}
