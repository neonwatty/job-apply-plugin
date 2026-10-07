import { atomicWritePointJson, createNativePointAtomicWriteIO } from './point-persistence.js';
/** Preserve the existing atomic write implementation and codec; give its disposable staging
 * files an exact namespace that can be recovered after a process dies before rename.
 */
export async function atomicWorkflowJobsWrite(path, value, options, io = createNativePointAtomicWriteIO(options.pathProfile)) {
    await atomicWritePointJson(path, value, options, { ...io,
        createTemporary: input => io.createTemporary({ ...input, prefix: '.workflow-jobs.' }) });
}
