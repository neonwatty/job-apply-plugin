import { PythonObject } from '../contracts/python-object.js';
import { copy, get, has, set, keys, same, string, text, fromJSON, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';

export const segment = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');
export function topKey(path: string): string {
  if (!path.startsWith('/') || path.slice(1).includes('/')) throw new JobsError('atomic profile paths must identify one top-level fact');
  if (path.length === 1 || /~(?![01])/.test(path)) throw new JobsError('atomic profile path is invalid');
  return path.slice(1).replaceAll('~1', '/').replaceAll('~0', '~');
}
function merge(target: Document, patch: Document, prefix = ''): [Document, string[]] {
  const updated = copy(target), changed: string[] = [];
  for (const [key, value] of patch.entries()) {
    const name = string(key)!;
    if (!name) throw new JobsError('profile patch keys must be non-empty strings');
    const path = `${prefix}/${segment(name)}`, current = updated.get(key, null);
    if (value === null) {
      if (updated.delete(key)) changed.push(path);
    } else if (value instanceof PythonObject) {
      const [nested, paths] = merge(current instanceof PythonObject ? current : new PythonObject(), value, path);
      if (paths.length || !(current instanceof PythonObject)) {
        updated.set(key, nested);
        changed.push(...(paths.length ? paths : [path]));
      }
    } else if (!same(current, value)) {
      updated.set(key, value);
      changed.push(path);
    }
  }
  return [updated, changed];
}
export function applyPatch(target: Document, patch: Document, atomic: string[], deleted: string[]): [Document, string[]] {
  const atomicKeys = new Map(atomic.map(path => [topKey(path), path]));
  if (atomicKeys.size !== atomic.length || new Set(deleted).size !== deleted.length) throw new JobsError('atomic profile paths must be unique');
  if (deleted.some(path => !atomic.includes(path))) throw new JobsError('deleted profile paths must also be atomic');
  if ([...atomicKeys.keys()].some(key => !has(patch, key))) throw new JobsError('atomic profile paths must be present in the patch');
  const ordinary = copy(patch);
  for (const key of atomicKeys.keys()) ordinary.delete(text(key));
  const [updated, changed] = merge(target, ordinary);
  for (const [key, path] of atomicKeys) {
    if (deleted.includes(path)) {
      if (updated.delete(text(key))) changed.push(path);
    } else if (!has(updated, key) || !same(get(updated, key), get(patch, key))) {
      set(updated, key, get(patch, key));
      changed.push(path);
    }
  }
  return [updated, changed];
}
export function changedPaths(current: Value, next: Value, prefix = ''): string[] {
  if (current instanceof PythonObject && next instanceof PythonObject) {
    return [...new Set([...keys(current), ...keys(next)])].sort((a,b) => text(a).compare(text(b))).flatMap(key => {
      const path = `${prefix}/${segment(key)}`;
      return !has(current, key) || !has(next, key) ? [path] : changedPaths(get(current, key), get(next, key), path);
    });
  }
  return same(current, next) ? [] : [prefix || '/'];
}
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
function leaves(value: Value, prefix: string): string[] {
  return value instanceof PythonObject && value.size ? value.entries().flatMap(([key, child]) => leaves(child, `${prefix}/${segment(string(key)!)}`)) : [prefix];
}
function at(value: Value, path: string): Value {
  for (const key of path.split('/').slice(1)) {
    if (!(value instanceof PythonObject)) return null;
    value = get(value, key.replaceAll('~1', '/').replaceAll('~0', '~'));
  }
  return value;
}
export function provenanceAfter(provenance: Document, changed: string[], source: string, now: string, current: Document): Document {
  if (source !== 'user' && provenance.entries().some(([key, record]) => record instanceof PythonObject
    && string(get(record, 'source')) === 'user' && changed.some(path => overlaps(path, string(key)!)))) {
    throw new JobsError('profile change conflicts with user-provenanced facts');
  }
  const stamped = copy(provenance);
  for (const [key, record] of provenance.entries()) {
    const path = string(key)!;
    if (changed.some(item => item.startsWith(`${path}/`))) {
      for (const leaf of leaves(at(current, path), path)) if (!has(stamped, leaf)) set(stamped, leaf, record);
    }
  }
  for (const path of changed) {
    for (const key of keys(stamped)) if (key.startsWith(`${path}/`) || path.startsWith(`${key}/`)) stamped.delete(text(key));
    set(stamped, path, fromJSON({ source, updatedAt: now }));
  }
  return stamped;
}
