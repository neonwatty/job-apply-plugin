import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePythonPointJsonBytes } from '../contracts/raw-json/point-parser.js';
import { validateJobsDocument, safeId } from '../contracts/workspace/jobs.js';
import { validateCoordinator } from '../contracts/workspace/claims.js';
import { validateAnswerSession } from '../contracts/workspace/answer-session-validation.js';
import { get, has, int, object, JobsError } from '../contracts/workspace/values.js';
import type { RecoveryContextReader } from '../app/owner-recovery-context.js';
import type { PosixFlockProvider } from './posix-flock.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import { validateNativeJobsRoot } from './native-root-validation.js';

/** Fail closed on unfinished recovery; never invoke normal writer transactions. */
export function nativeRecoveryContextReader(root: string, provider: PosixFlockProvider, jobId: string): RecoveryContextReader {
  const read = async (name: string) => {
    const handle = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
        || stat.uid !== process.getuid?.() || stat.size > 32 * 1024 * 1024) throw new JobsError('invalid recovery context file');
      return await handle.readFile();
    } finally { await handle.close(); }
  };
  const document = async (name: string) => object(parsePythonPointJsonBytes(await read(name),
    { diagnosticProfile: '3.12', intMaxStrDigits: 4300 }), 'recovery context');
  return { inspect: async callback => {
    await validateNativeJobsRoot(root, read);
    return withExclusiveFileLock(join(root, '.store.lock'), async () => {
      await validateNativeJobsRoot(root, read, true, false, true);
      for (const name of ['resume-operation', 'resume-extraction-journal', 'coordinator-journal']) {
        const journal = await document(`${name}.json`);
        if (int(get(journal, 'schemaVersion')) !== 1n || !has(journal, 'operation') || get(journal, 'operation') !== null) {
          throw new JobsError('read-only inspection requires completed Store recovery');
        }
      }
      const jobs = validateJobsDocument(await document('jobs.json'));
      const sessions = [];
      for (const id of [jobId]) {
        try { sessions.push(validateAnswerSession(await document(`sessions/${safeId(id)}.json`))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return callback({ jobs, coordinator: validateCoordinator(await document('coordinator.json')), sessions });
    }, { provider, pathProfile: '3.12', signal: AbortSignal.timeout(30_000) });
  } };
}
