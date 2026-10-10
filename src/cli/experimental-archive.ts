import { isAbsolute, join } from 'node:path';
import { boundedFile } from './experimental-files.js';
import { NativeJobsRepository } from '../store/native-jobs.js';
import { NativeWorkflowArchive } from '../store/native-workflow-archive.js';
import { atomicWorkflowJobsWrite } from '../store/workflow-atomic-write.js';
import { atomicWritePointJson } from '../store/point-persistence.js';
import { nativeFixtureMarker, nativeFixtureMarkerName } from '../store/native-store-layout.js';
import { loadPosixFlockProvider } from '../store/posix-flock.js';
import { decodeWorkflowLedger, emptyWorkflowLedger, encodeWorkflowLedger, workflowMetadataKey } from '../contracts/workspace/workflow-tasks.js';
import { archiveSegmentLimit } from '../contracts/workspace/workflow-archive.js';
import { get, has, object, set } from '../contracts/workspace/values.js';

/** Deliberate fixture-only v2 activation. Ordinary reads never migrate a v1 ledger. */
export async function experimentalArchive(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!['activate', 'inspect', 'compact'].includes(command ?? '')) throw new Error('invalid archive command');
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index]!;
    if (!['--root', '--native-lock'].includes(name) || options.has(name) || !rest[index + 1]) throw new Error('invalid option');
    options.set(name, rest[++index]!);
  }
  const root = options.get('--root'), nativeLock = options.get('--native-lock');
  if (!root || !isAbsolute(root) || !nativeLock || !isAbsolute(nativeLock)) throw new Error('explicit paths required');
  if (await boundedFile(join(root, nativeFixtureMarkerName), 256) !== nativeFixtureMarker) throw new Error('synthetic Store required');
  const repository = new NativeJobsRepository(root, loadPosixFlockProvider(nativeLock), (path, value, config) =>
    path === join(root, 'jobs.json') ? atomicWorkflowJobsWrite(path, value, config) : atomicWritePointJson(path, value, config));
  return repository.claimTransaction(async tx => {
    // Repeat fixture ownership under the lock, after ordinary coordinator/extraction recovery.
    if (await boundedFile(join(root, nativeFixtureMarkerName), 256) !== nativeFixtureMarker) throw new Error('synthetic Store required');
    const metadata = object(get(tx.jobs, 'metadata'), 'metadata');
    const stored = has(metadata, workflowMetadataKey) ? decodeWorkflowLedger(get(metadata, workflowMetadataKey)) : emptyWorkflowLedger();
    const archive = new NativeWorkflowArchive(root);
    await archive.validate(stored);
    let ledger = stored;
    if (command === 'activate') ledger = archive.migrate(stored);
    if (command === 'compact') {
      if (stored.schemaVersion !== 2) throw new Error('archive activation required');
      const prepared = await archive.prepare(stored);
      await prepared.flush(); ledger = prepared.ledger;
    }
    if (JSON.stringify(ledger) !== JSON.stringify(stored)) {
      set(metadata, workflowMetadataKey, encodeWorkflowLedger(ledger));
      await tx.saveJobs(tx.jobs);
    }
    return { schemaVersion: ledger.schemaVersion, archiveEnabled: ledger.schemaVersion === 2,
      hotTasks: Object.keys(ledger.tasks).length, hotReceipts: Object.keys(ledger.receipts).length,
      archiveSegments: ledger.archive?.segments.length ?? 0, archiveSegmentLimit,
      archivedTaskSnapshots: (ledger.archive?.segments ?? []).reduce((count, item) => count + item.taskCount, 0),
      archivedReceipts: (ledger.archive?.segments ?? []).reduce((count, item) => count + item.receiptCount, 0),
      finiteCapacity: true };
  });
}
