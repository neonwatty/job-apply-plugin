type TrashItem = { type?: unknown };
type Filterable = {
  filter(predicate: (item: TrashItem) => unknown): unknown;
};
type BlockerItem = { blockerCounts?: object | null };
type LifecycleError = { code?: unknown; counts?: object | null; message?: unknown };

// Structural views preserve the existing helpers' property access and coercion.
// These presentation functions do not validate incoming records or authorize IO.
export function typedDeletePhrase(type: unknown): string {
  return `DELETE ${String(type || "").toUpperCase()}`;
}

export function filterTrashItems(items: unknown, type: unknown = ""): unknown {
  return ((items || []) as Filterable).filter((item) => !type || item.type === type);
}

export function trashBlockerText(item: unknown): string {
  const record = item as BlockerItem | null | undefined;
  const counts = record?.blockerCounts || {};
  const total = (Object.values(counts) as unknown[]).reduce<number>(
    (sum, value) => sum + (Number.isInteger(value) ? value as number : 0), 0,
  );
  return total ? `${total} protected reference${total === 1 ? "" : "s"}` : "No known references";
}

export function lifecycleErrorText(error: unknown): string {
  const record = error as LifecycleError | null | undefined;
  if (record?.code === "revision_conflict") {
    return "This record changed elsewhere. Nothing was retried; refresh Trash and review the latest revision.";
  }
  const protectedCount = (Object.values(record?.counts || {}) as unknown[]).reduce<number>(
    (sum, value) => sum + (Number.isInteger(value) ? value as number : 0), 0,
  );
  const suffix = protectedCount
    ? ` (${protectedCount} protected reference${protectedCount === 1 ? "" : "s"}.)`
    : "";
  return `${record?.message || "The lifecycle operation was rejected."}${suffix}`;
}
