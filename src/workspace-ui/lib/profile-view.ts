type Fields = Record<string, unknown>;
type Entry = [string, unknown];
type Provenance = { source?: unknown; updatedAt?: unknown };

export function formPatch(values: unknown): Fields {
  const fields = values as Fields;
  const patch: Fields = {};
  for (const field of ["url", "role", "company", "location", "workplaceType", "employmentType", "compensation", "notes", "description", "resumeId"]) {
    const value = fields[field];
    patch[field] = value === "" && field === "resumeId" ? null : value;
  }
  patch.priority = Number(fields.priority || 0);
  return patch;
}

export function pointerValue(value: unknown, pointer: string): unknown {
  return pointer.split("/").slice(1).reduce<unknown>((item, segment) => {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    return item != null && Object.hasOwn(Object(item), key) ? (item as Fields)[key] : undefined;
  }, value);
}

export function patchForPaths(entries: Iterable<Entry>): Fields {
  const patch: Fields = {};
  for (const [pointer, value] of entries) {
    const parts = pointer.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    let target = patch;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) Object.defineProperty(target, part, { value, enumerable: true, configurable: true, writable: true });
      else {
        if (!Object.hasOwn(target, part)) Object.defineProperty(target, part, { value: {}, enumerable: true, configurable: true, writable: true });
        target = target[part] as Fields;
      }
    });
  }
  return patch;
}

export function conflictingPaths(
  base: unknown, latest: unknown, drafts: Iterable<Entry>, atomicPaths: Pick<Set<string>, "has"> = new Set(),
): string[] {
  return [...drafts].filter(([path, mine]) => {
    const before: unknown = base instanceof Map ? base.get(path) : pointerValue(base, path);
    const now = pointerValue(latest, path);
    const structured = atomicPaths.has(path) || typeof mine === "object" || typeof before === "object" || typeof now === "object";
    return JSON.stringify(before) !== JSON.stringify(now) && (structured || JSON.stringify(mine) !== JSON.stringify(now));
  }).map(([path]) => path);
}

export function summarizeProvenance(records: unknown, path: string): unknown {
  const ancestors = Object.entries((records || {}) as Record<string, Provenance>)
    .filter(([candidate]) => path === candidate || path.startsWith(`${candidate}/`));
  ancestors.sort((left, right) => right[0].length - left[0].length);
  if (ancestors.length) return ancestors[0]![1];
  const descendants = Object.entries((records || {}) as Record<string, Provenance>)
    .filter(([candidate]) => candidate.startsWith(`${path}/`));
  if (!descendants.length) return null;
  const sources = [...new Set(descendants.map(([, record]) => record.source))].sort();
  const updatedAt = descendants.map(([, record]) => record.updatedAt).filter(Boolean).sort().at(-1);
  return { source: sources.length === 1 ? sources[0] : `mixed: ${sources.join(", ")}`, updatedAt };
}

export function tagsFromInput(value: unknown): string[] {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}
