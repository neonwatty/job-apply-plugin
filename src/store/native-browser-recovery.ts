import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { browserRecoveryGuidance } from '../app/browser-recovery-guidance.js';
import type { BrowserRecoveryProjection } from '../contracts/workspace/browser-recovery.js';
import { browserOperationsMetadataKey, decodeBrowserOperationLedger, emptyBrowserOperationLedger } from '../contracts/workspace/browser-operations.js';
import { parsePythonPointJsonBytes } from '../contracts/raw-json/point-parser.js';
import { validateJobsDocument } from '../contracts/workspace/jobs.js';
import { get, has, int, object, JobsError } from '../contracts/workspace/values.js';
import { NativeBrowserArchive } from './native-browser-archive.js';
import { validateNativeJobsRoot } from './native-root-validation.js';
import { nativeStoreAllowedEntries, workflowTemporaryPattern } from './native-store-layout.js';
import type { PosixFlockProvider } from './posix-flock.js';

/** Refresh never runs journal recovery, cleans temporaries, or publishes an archive. */
export class NativeBrowserRecovery {
  constructor(private readonly root: string, private readonly provider: PosixFlockProvider) {}

  private async read(name: string): Promise<Buffer> {
    const path = join(this.root, name);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat(), current = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()
        || (info.mode & 0o777) !== 0o600 || info.size > 32 * 1024 * 1024
        || current.dev !== info.dev || current.ino !== info.ino || current.isSymbolicLink()) {
        throw new JobsError('browser recovery state is unavailable');
      }
      return await handle.readFile();
    } finally { await handle.close(); }
  }

  private async snapshot(): Promise<BrowserRecoveryProjection> {
    await validateNativeJobsRoot(this.root, name => this.read(name));
    const entries = await readdir(this.root);
    if (entries.some(name => !nativeStoreAllowedEntries.has(name) && !workflowTemporaryPattern.test(name))) {
      throw new JobsError('browser recovery state is unavailable');
    }
    // A pending cross-document commit may replace jobs; report unavailable without repairing it.
    for (const name of ['resume-operation', 'resume-extraction-journal', 'coordinator-journal']) {
      const journal = object(parsePythonPointJsonBytes(await this.read(`${name}.json`), {
        diagnosticProfile: '3.12', intMaxStrDigits: 4300,
      }), 'recovery journal');
      if (int(get(journal, 'schemaVersion')) !== 1n || !has(journal, 'operation') || get(journal, 'operation') !== null) {
        throw new JobsError('browser recovery state requires Store recovery');
      }
    }
    const jobs = validateJobsDocument(parsePythonPointJsonBytes(await this.read('jobs.json'), {
      diagnosticProfile: '3.12', intMaxStrDigits: 4300,
    }));
    const metadata = object(get(jobs, 'metadata'), 'jobs metadata');
    const ledger = has(metadata, browserOperationsMetadataKey)
      ? decodeBrowserOperationLedger(get(metadata, browserOperationsMetadataKey)) : emptyBrowserOperationLedger();
    await new NativeBrowserArchive(this.root).validate(ledger);
    const { unresolvedOperationId: _id, ...guidance } = browserRecoveryGuidance(ledger);
    return { available: true, guidance };
  }

  async inspect(): Promise<BrowserRecoveryProjection> {
    await validateNativeJobsRoot(this.root, name => this.read(name));
    // Use the existing lock inode without creating a file or changing permissions on refresh.
    const path = join(this.root, '.store.lock');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let locked = false;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) {
        throw new JobsError('browser recovery lock is unavailable');
      }
      const signal = AbortSignal.timeout(30_000);
      while (!(locked = this.provider.tryLock(handle.fd))) await delay(10, undefined, { signal });
      const current = await lstat(path);
      if (current.dev !== info.dev || current.ino !== info.ino || current.isSymbolicLink()) {
        throw new JobsError('browser recovery lock changed');
      }
      return await this.snapshot();
    } finally {
      try { if (locked) this.provider.unlock(handle.fd); } finally { await handle.close(); }
    }
  }
}
