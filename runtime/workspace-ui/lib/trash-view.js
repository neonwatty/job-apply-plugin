// Structural views preserve the existing helpers' property access and coercion.
// These presentation functions do not validate incoming records or authorize IO.
export function typedDeletePhrase(type) {
    return `DELETE ${String(type || "").toUpperCase()}`;
}
export function filterTrashItems(items, type = "") {
    return (items || []).filter((item) => !type || item.type === type);
}
export function trashBlockerText(item) {
    const record = item;
    const counts = record?.blockerCounts || {};
    const total = Object.values(counts).reduce((sum, value) => sum + (Number.isInteger(value) ? value : 0), 0);
    return total ? `${total} protected reference${total === 1 ? "" : "s"}` : "No known references";
}
export function lifecycleErrorText(error) {
    const record = error;
    if (record?.code === "revision_conflict") {
        return "This record changed elsewhere. Nothing was retried; refresh Trash and review the latest revision.";
    }
    const protectedCount = Object.values(record?.counts || {}).reduce((sum, value) => sum + (Number.isInteger(value) ? value : 0), 0);
    const suffix = protectedCount
        ? ` (${protectedCount} protected reference${protectedCount === 1 ? "" : "s"}.)`
        : "";
    return `${record?.message || "The lifecycle operation was rejected."}${suffix}`;
}
