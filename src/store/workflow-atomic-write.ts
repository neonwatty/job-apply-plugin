import type { PointAtomicWriteIO } from './point-persistence.js';
import { atomicWritePointJson, createNativePointAtomicWriteIO } from './point-persistence.js';
import type { PersistenceOptions } from '../contracts/persisted-json-core.js';
import type { Value } from '../contracts/workspace/values.js';

/** Preserve the existing atomic write implementation and codec; give its disposable staging
 * files an exact namespace that can be recovered after a process dies before rename.
 */
export async function atomicWorkflowJobsWrite(path: string, value: Value, options: PersistenceOptions,
  io: PointAtomicWriteIO = createNativePointAtomicWriteIO(options.pathProfile)): Promise<void> {
  await atomicWritePointJson(path, value, options, { ...io,
    createTemporary: input => io.createTemporary({ ...input, prefix: '.workflow-jobs.' }) });
}
