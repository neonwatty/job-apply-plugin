import { unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { resolvePackagedNativeLock } from '../runtime/package/native-lock-artifact.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';

// Synthetic legacy-format state for recurring tests. Actual historical Python
// generation is tested separately by the one-time migration acceptance command.
export async function legacyStoreFixture(root, { job, resume, now = '2026-09-14T12:00:00Z' } = {}) {
  await initializeJobsFixture(root, now);
  const plugin = await import('node:fs/promises').then(fs => fs.realpath(fileURLToPath(new URL('../', import.meta.url))));
  const provider = loadPosixFlockProvider(await resolvePackagedNativeLock(plugin));
  const repository = new NativeJobsRepository(root, provider);
  if (job) await new JobsService(repository, () => now).create(fromJSON(job));
  if (resume) {
    await new ResumeService(repository, () => now).import(fromJSON(resume), 'synthetic-resume.txt', Buffer.from('Managed resume bytes'));
  }
  await unlink(join(root, '.native-jobs-fixture'));
  await unlink(join(root, 'resume-operation.json')); // Empty native journal is initialized by clone preparation.
  return root;
}
