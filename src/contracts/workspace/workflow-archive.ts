/** Finite experimental archive: no eviction or expiration of accepted receipts. */
export const archiveSegmentLimit = 32;
export const archiveSegmentCodeUnitLimit = 1024 * 1024 + 128;
export interface WorkflowArchiveSegmentReference {
  digest: string;
  taskCount: number;
  receiptCount: number;
}
export interface WorkflowArchiveRoot {
  schemaVersion: 1;
  segments: WorkflowArchiveSegmentReference[];
}
export class WorkflowArchiveError extends Error {
  constructor() { super('workflow_archive_corrupt'); this.name = 'WorkflowArchiveError'; }
}
export function archiveCheck(value: unknown): asserts value {
  if (!value) throw new WorkflowArchiveError();
}
export function validateWorkflowArchiveRoot(value: unknown): WorkflowArchiveRoot {
  archiveCheck(value !== null && typeof value === 'object' && !Array.isArray(value));
  const root = value as Record<string, unknown>;
  archiveCheck(Object.keys(root).sort().join(',') === 'schemaVersion,segments' && root.schemaVersion === 1
    && Array.isArray(root.segments) && root.segments.length <= archiveSegmentLimit);
  const seen = new Set<string>();
  for (const raw of root.segments) {
    archiveCheck(raw !== null && typeof raw === 'object' && !Array.isArray(raw));
    const item = raw as Record<string, unknown>;
    archiveCheck(Object.keys(item).sort().join(',') === 'digest,receiptCount,taskCount'
      && typeof item.digest === 'string' && /^[a-f0-9]{64}$/.test(item.digest)
      && !seen.has(item.digest)
      && Number.isInteger(item.taskCount) && (item.taskCount as number) >= 1 && (item.taskCount as number) <= 64
      && Number.isInteger(item.receiptCount) && (item.receiptCount as number) >= 0 && (item.receiptCount as number) <= 256);
    seen.add(item.digest);
  }
  return root as unknown as WorkflowArchiveRoot;
}
