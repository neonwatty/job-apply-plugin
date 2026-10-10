import { archiveCheck, archiveSegmentCodeUnitLimit, archiveSegmentLimit, validateWorkflowArchiveRoot, WorkflowArchiveError } from '../contracts/workspace/workflow-archive.js';
import type { WorkflowArchiveRoot } from '../contracts/workspace/workflow-archive.js';
import { validateWorkflowLedger, workflowSubjectIdentity, taskLimit, receiptLimit } from '../contracts/workspace/workflow-tasks.js';
import type { WorkflowLedger, WorkflowTask } from '../contracts/workspace/workflow-tasks.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { fromJSON } from '../contracts/workspace/values.js';
import { NativeWorkflowArchiveFiles, archiveDigest } from './native-workflow-archive-files.js';

type StoredReceipt = WorkflowLedger['receipts'][string];
export interface ArchiveHistory {
  task(id: string): WorkflowTask | null;
  receipt(id: string): StoredReceipt | null;
}
export interface PreparedWorkflowArchive {
  ledger: WorkflowLedger;
  history: ArchiveHistory;
  flush(): Promise<void>;
}
const copy = <T>(value: T): T => structuredClone(value);
function root(ledger: WorkflowLedger): WorkflowArchiveRoot | null {
  return ledger.schemaVersion === 2 ? validateWorkflowArchiveRoot(ledger.archive) : null;
}
function history(tasks: Map<string, WorkflowTask>, receipts: Map<string, StoredReceipt>): ArchiveHistory {
  return { task: id => copy(tasks.get(id) ?? null), receipt: id => copy(receipts.get(id) ?? null) };
}
function mergeTask(tasks: Map<string, WorkflowTask>, next: WorkflowTask): void {
  const prior = tasks.get(next.taskId);
  if (prior) {
    archiveCheck(workflowSubjectIdentity(prior.subject) === workflowSubjectIdentity(next.subject)
      && prior.workflow.id === next.workflow.id && prior.workflow.version === next.workflow.version
      && BigInt(next.revision) >= BigInt(prior.revision));
    if (prior.revision === next.revision) archiveCheck(canonicalJson(fromJSON(prior)) === canonicalJson(fromJSON(next)));
    else archiveCheck(prior.status === 'active' || prior.status === 'waiting');
  }
  tasks.set(next.taskId, copy(next));
}
function mergeLedger(tasks: Map<string, WorkflowTask>, receipts: Map<string, StoredReceipt>, ledger: WorkflowLedger): void {
  for (const item of Object.values(ledger.tasks)) mergeTask(tasks, item);
  for (const [id, item] of Object.entries(ledger.receipts)) {
    archiveCheck(!receipts.has(id)); receipts.set(id, copy(item));
  }
}

/** Bounded immutable storage. The caller owns the canonical Store lock and publication. */
export class NativeWorkflowArchive {
  private readonly files: NativeWorkflowArchiveFiles;
  constructor(rootPath: string, checkpoint: (stage: string) => Promise<void> = async () => {}) {
    this.files = new NativeWorkflowArchiveFiles(rootPath, checkpoint);
  }
  /** Explicit fixture activation publishes this value atomically under the Store lock. */
  migrate(value: WorkflowLedger): WorkflowLedger {
    const ledger = validateWorkflowLedger(copy(value));
    if (ledger.schemaVersion === 2) return ledger;
    return validateWorkflowLedger({ ...ledger, schemaVersion: 2, archive: { schemaVersion: 1, segments: [] } });
  }
  private async load(value: WorkflowLedger): Promise<ArchiveHistory> {
    try {
      const ledger = validateWorkflowLedger(value), archive = root(ledger);
      await this.files.inventory(Boolean(archive?.segments.length));
      // First migration can publish data before its v2 root/journal. Validate the
      // private namespace, but only committed references grant replay authority.
      // Unreferenced files remain disposable for both v1 and v2 roots.
      const tasks = new Map<string, WorkflowTask>(), receipts = new Map<string, StoredReceipt>();
      for (const reference of archive?.segments ?? []) {
        const bytes = await this.files.read(reference.digest), text = bytes.toString('utf8');
        archiveCheck(text.length <= archiveSegmentCodeUnitLimit && Buffer.from(text).equals(bytes));
        const segment = JSON.parse(text) as Record<string, unknown>;
        archiveCheck(segment !== null && typeof segment === 'object' && !Array.isArray(segment)
          && Object.keys(segment).sort().join(',') === 'ledger,schemaVersion' && segment.schemaVersion === 1);
        const stored = validateWorkflowLedger(segment.ledger);
        archiveCheck(stored.schemaVersion === 2 && root(stored)!.segments.length === 0
          && Object.keys(stored.tasks).length === reference.taskCount
          && Object.keys(stored.receipts).length === reference.receiptCount);
        mergeLedger(tasks, receipts, stored);
      }
      mergeLedger(tasks, receipts, ledger);
      // Each archived active snapshot must have a later or equal retained current identity.
      for (const task of tasks.values()) if (task.status === 'active' || task.status === 'waiting') {
        archiveCheck(task.taskId === ledger.activeTaskId && Object.hasOwn(ledger.tasks, task.taskId));
      }
      return history(tasks, receipts);
    } catch { throw new WorkflowArchiveError(); }
  }
  async validate(ledger: WorkflowLedger): Promise<void> { await this.load(ledger); }
  async prepare(value: WorkflowLedger): Promise<PreparedWorkflowArchive> {
    const ledger = copy(value), union = await this.load(ledger), archive = root(ledger);
    const result = { ledger, history: union, flush: async () => {} };
    if (!archive || archive.segments.length >= archiveSegmentLimit) return result;
    const taskCount = Object.keys(ledger.tasks).length, receiptCount = Object.keys(ledger.receipts).length;
    const pressure = taskCount >= taskLimit - 1 || receiptCount >= receiptLimit - 3
      || JSON.stringify(ledger).length > 768 * 1024;
    if (!pressure || taskCount === 0) return result;
    const segmentLedger = validateWorkflowLedger({ ...copy(ledger), archive: { schemaVersion: 1, segments: [] } });
    const bytes = JSON.stringify({ schemaVersion: 1, ledger: segmentLedger });
    archiveCheck(bytes.length <= archiveSegmentCodeUnitLimit);
    const digest = archiveDigest(bytes);
    const current = ledger.activeTaskId === null ? null : ledger.tasks[ledger.activeTaskId]!;
    const next = validateWorkflowLedger({ ...ledger,
      tasks: current === null ? {} : { [current.taskId]: current }, receipts: {},
      archive: { schemaVersion: 1, segments: [...archive.segments, { digest, taskCount, receiptCount }] } });
    let flushed = false;
    return { ledger: next, history: union, flush: async () => {
      if (flushed) return;
      const actual = await this.files.publish(bytes, archive.segments.map(item => item.digest));
      archiveCheck(actual === digest); flushed = true;
    } };
  }
}
