import { PythonObject } from '../../../src/contracts/python-object';
import { copy, get, has, set, object, int, integer, text, string, keys, same, parse, serialize } from '../../../src/contracts/workspace/values';
import type { Document, Value } from '../../../src/contracts/workspace/values';
export type { Document, Value };
export type ProfileSnapshot = { profile: Document; revision: bigint; provenance: Document };
export function snapshot(raw: string): ProfileSnapshot {
  const doc = object(parse(raw), 'profile response'), revision = int(get(doc, 'revision'));
  if (revision === null || revision < 1n) throw Error('Invalid profile revision');
  return { profile: object(get(doc, 'profile'), 'profile'), revision, provenance: object(get(doc, 'factProvenance'), 'provenance') };
}
const named = new Set(['firstName','lastName','email','phone','location','linkedInUrl','portfolioUrl','githubUrl','workHistory','education','skills','preferences']);
export const pointer = (key: string) => '/' + key.replaceAll('~','~0').replaceAll('/','~1');
function mergeDiff(before: Document, after: Document): Document {
  const patch = new PythonObject<Value>();
  for (const key of new Set([...keys(before), ...keys(after)])) {
    if (!has(after,key)) set(patch,key,null);
    else if (!has(before,key) || !same(get(before,key),get(after,key))) {
      const old = get(before,key), next = get(after,key);
      set(patch,key,old instanceof PythonObject && next instanceof PythonObject ? mergeDiff(old,next) : next);
    }
  }
  return patch;
}
export function patchBody(base: ProfileSnapshot, draft: Document): string {
  const patch = new PythonObject<Value>(), atomic: string[] = [], deleted: string[] = [];
  for (const key of new Set([...keys(base.profile), ...keys(draft)])) {
    if (has(base.profile,key) === has(draft,key) && same(get(base.profile,key),get(draft,key))) continue;
    const old = get(base.profile,key), next = get(draft,key);
    set(patch,key,named.has(key) && old instanceof PythonObject && next instanceof PythonObject ? mergeDiff(old,next) : next);
    if (!named.has(key)) {
      atomic.push(pointer(key));
      if (!has(draft,key)) deleted.push(pointer(key));
    }
  }
  const result = new PythonObject<Value>();
  set(result,'patch',patch);
  set(result,'expectedRevision',integer(base.revision));
  set(result,'atomicPaths',atomic.map(text));
  set(result,'deletedPaths',deleted.map(text));
  return serialize(result);
}
/** Keep only local differences when rebasing a draft onto a fresh revision. */
export function reapplyDraft(before: Document, draft: Document, latest: Document): Document {
  const result = copy(latest);
  for (const key of new Set([...keys(before),...keys(draft)])) {
    if (has(before,key) === has(draft,key) && same(get(before,key),get(draft,key))) continue;
    if (!has(draft,key)) result.delete(text(key));
    else {
      const a=get(before,key),b=get(draft,key),c=get(latest,key);
      set(result,key,a instanceof PythonObject && b instanceof PythonObject && c instanceof PythonObject ? reapplyDraft(a,b,c) : b);
    }
  }
  return result;
}

export function factProvenance(provenance: Document, key: string): string {
  const result = new PythonObject<Value>(), path = pointer(key);
  for (const [item, value] of provenance.entries()) {
    const name = string(item)!;
    if (name === path || name.startsWith(path + '/') || path.startsWith(name + '/')) result.set(item,value);
  }
  return serialize(result);
}
