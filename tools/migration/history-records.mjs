import { canonical } from './evidence-io.mjs';

export const recordKeys = items => new Set(items.map(canonical));
export const containsRecords = (container, items) => [...items].every(item => container.has(item));

// Check content before ancestry: a preserved record set cannot erase an ancestor.
// Deliberately accept arbitrary history order, including independent merge arms.
export function preservesHistory(rows, ancestor, { topological = false } = {}) {
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    // Git --reverse --topo-order guarantees ancestors precede descendants.
    // Only callers with that guarantee may omit the impossible reverse pairs.
    for (const earlier of topological ? rows.slice(0, index) : rows) {
      if (row.revision !== earlier.revision && !containsRecords(row.records, earlier.records)
        && ancestor(earlier.revision, row.revision)) return false;
    }
  }
  return true;
}

// Maintain the minimal (possibly incomparable) activation frontier. A descendant
// of any frontier member cannot be a first activation. No total-order assumption.
export function firstActivations(revisions, ancestor) {
  let first = [];
  for (const revision of new Set(revisions)) {
    if (first.some(other => ancestor(other, revision))) continue;
    first = first.filter(other => !ancestor(revision, other));
    first.push(revision);
  }
  return first;
}

// JSON is immutable within a single evidence load. Bound retained source bytes
// and entries; malformed or failed reads never enter the cache.
export function historicalJson(io) {
  const cache = new Map();
  let bytes = 0;
  return (path, revision) => {
    const key = `${revision}:${path}`;
    if (cache.has(key)) {
      const entry = cache.get(key);
      cache.delete(key); cache.set(key, entry);
      return entry.value;
    }
    const source = io.fileAt(revision, path);
    const value = source === null ? null : JSON.parse(source);
    const size = source?.length ?? 0;
    if (size <= 8 * 1024 * 1024) {
      while (cache.size >= 4096 || bytes + size > 8 * 1024 * 1024) {
        const oldest = cache.keys().next().value;
        bytes -= cache.get(oldest).size; cache.delete(oldest);
      }
      cache.set(key, { value, size }); bytes += size;
    }
    return value;
  };
}
