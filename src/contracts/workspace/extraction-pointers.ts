import { PythonObject } from '../python-object.js';
import { get, has, set, object, string, text, fromJSON, same, JobsError } from './values.js';
import type { Document, Value } from './values.js';
import { emptyObject } from './jobs.js';

export const segment = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');
export function decodePointer(path: string): string[] {
  if (!path.startsWith('/') || path === '/') throw new JobsError('proposal path is invalid');
  return path.slice(1).split('/').map(part => {
    if (!part || /~(?![01])/.test(part)) throw new JobsError('proposal path is invalid');
    return part.replaceAll('~1', '/').replaceAll('~0', '~');
  });
}
export function lookup(value: Value, path: string): [boolean, Value] {
  for (const key of decodePointer(path)) {
    if (!(value instanceof PythonObject) || !has(value, key)) return [false, null];
    value = get(value, key);
  }
  return [true, value];
}
export function baseline(document: Document, path: string): Document {
  const segments = decodePointer(path), ancestors: Value[] = [];
  let current: Value = document, encoded = '';
  for (const key of segments.slice(0, -1)) {
    encoded += `/${segment(key)}`;
    const exists: boolean = current instanceof PythonObject && has(current, key);
    const value: Value = exists ? get(current as Document, key) : null;
    const item = object(fromJSON({ path: encoded, exists }), 'ancestor');
    if (exists && value instanceof PythonObject) {
      set(item, 'container', true);
      set(item, 'empty', value.size === 0);
    } else if (exists) set(item, 'value', value);
    ancestors.push(item);
    current = value;
  }
  const [exists, value] = lookup(document, path);
  const result = set(set(emptyObject(), 'exists', exists), 'ancestors', ancestors);
  if (exists) set(result, 'value', value);
  return result;
}
export function setPointer(document: Document, path: string, value: Value, replace: boolean): void {
  const segments = decodePointer(path);
  let current = document;
  for (const key of segments.slice(0, -1)) {
    let child = get(current, key);
    if (!(child instanceof PythonObject)) {
      if (child !== null && !replace) throw new JobsError('proposal path conflicts with an existing fact');
      child = emptyObject();
      set(current, key, child);
    }
    current = child;
  }
  set(current, segments.at(-1)!, value);
}
export function replacementScope(item: Document): string | null {
  for (const value of get(item, 'ancestors') as Value[]) {
    const ancestor = object(value, 'ancestor');
    if (get(ancestor, 'exists') === true && get(ancestor, 'container') !== true) return string(get(ancestor, 'path'));
  }
  return null;
}
export function equal(left: Value, right: Value): boolean {
  if (typeof left === 'boolean' || typeof right === 'boolean') return left === right;
  if (left instanceof PythonObject || right instanceof PythonObject) {
    return left instanceof PythonObject && right instanceof PythonObject && left.size === right.size
      && left.entries().every(([key, value]) => right.has(key) && equal(value, right.get(key)!));
  }
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => equal(value, right[index]!));
  return same(left, right);
}
export function compareText(a: string, b: string): number { return text(a).compare(text(b)); }
