import { ApplicationAuthorityService } from '../workspace-core/application-authority.js';
import { isAbsolute, join } from 'node:path';
import { nativeRecoveryContextReader } from '../store/native-recovery-context.js';
import { ownerRecoveryContext } from '../app/owner-recovery-context.js';
import { ownerWorkflowReceipt } from '../app/owner-workflow-receipt.js';
import { ClaimWorkflow } from '../app/claim-workflow.js';
import { createOwnerWorkflowStore } from '../app/owner-workflow-policy.js';
import { OwnerClaimBroker } from '../integrations/host/owner-claim-broker.js';
import { NativeJobsRepository } from '../store/native-jobs.js';
import { ClaimsService } from '../workspace-core/claims.js';
import { loadPosixFlockProvider } from '../store/posix-flock.js';
import { nativeCloneMarkerName, nativeCloneTrees } from '../store/native-store-layout.js';
import { attemptProfile } from '../workflows/applications/attempt.js';
import { fromJSON, object, serialize } from '../contracts/workspace/values.js';
import { identifier } from '../harness/validation.js';
import { boundedFile } from './experimental-files.js';
import { runAttemptBroker, requestAttempt } from './attempt-broker.js';

/** Foreground explicit owner activation; clients only contact the existing endpoint. */
export function parseOwnerClaimOptions(args: string[]) {
  const [command, ...rest] = args;
  if (!['serve', 'recovery-context', 'context', 'event', 'receipt', 'host-browser-context', 'host-browser-report', 'recovery', 'authority-evaluate'].includes(command ?? '')) throw new Error('invalid command');
  const context = command === 'recovery-context' || command === 'context' || command === 'host-browser-context';
  const report = command === 'host-browser-report';
  const options = new Map<string, string>();
  let attested = false;
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index]!;
    if (name === '--host-user-event' && ['serve', 'event', 'recovery'].includes(command!) && !attested) { attested = true; continue; }
    const allowed = ['--root', '--native-lock', ...(context || command === 'serve' ? ['--job-id'] : []), ...(command === 'event' || command === 'receipt' || command === 'recovery' || command === 'authority-evaluate' || report ? ['--input'] : [])];
    if (!allowed.includes(name) || options.has(name) || !rest[index + 1]) throw new Error('invalid options');
    options.set(name, rest[++index]!);
  }
  const root = options.get('--root'), artifact = options.get('--native-lock');
  if (!root || !isAbsolute(root) || !artifact || !isAbsolute(artifact)) throw new Error('explicit paths required');
  if ((command === 'event' || command === 'receipt' || command === 'recovery' || command === 'authority-evaluate' || report) !== options.has('--input')) throw new Error('invalid input option');
  if (options.has('--input') && !isAbsolute(options.get('--input')!)) throw new Error('explicit input path required');
  if (command === 'serve' && (!attested || !options.get('--job-id'))) throw new Error('explicit owner activation required');
  if (command === 'recovery-context' && !options.has('--job-id')) throw new Error('exact job required');
  if (options.has('--job-id')) identifier(options.get('--job-id'), 'invalid_arguments');
  return { command: command!, root, nativeLock: artifact, jobId: options.get('--job-id'), input: options.get('--input'), hostUserEvent: attested };
}
export async function ownerClaimWorkflow(args: string[]): Promise<unknown> {
  const { command, root, nativeLock: artifact, jobId, input, hostUserEvent: attested } = parseOwnerClaimOptions(args);
  const context = command === 'recovery-context' || command === 'context' || command === 'host-browser-context';
  const report = command === 'host-browser-report';
  nativeCloneTrees(Buffer.from(await boundedFile(join(root, nativeCloneMarkerName), 1024)));
  const provider = loadPosixFlockProvider(artifact), repository = new NativeJobsRepository(root, provider);
  if (command === 'recovery-context') return ownerRecoveryContext(nativeRecoveryContextReader(root, provider, jobId!), jobId!);
  await repository.transaction(async () => {});
  if (command === 'receipt') {
    return ownerWorkflowReceipt(repository, JSON.parse(await boundedFile(input!, 131072)));
  }
  if (command === 'serve') {
    const { store, scope } = await createOwnerWorkflowStore(repository, jobId!);
    const claims = new ClaimsService(repository);
    const workflow = new ClaimWorkflow(store, claims, () => ({ enabled: [attemptProfile], authorized: [attemptProfile] }));
    await runAttemptBroker(root, claims, provider, { createAuthority: stop => new OwnerClaimBroker(workflow, scope, stop, 60_000, new ApplicationAuthorityService(repository)) });
    return { ok: true };
  }
  const request = context ? { command, ...(jobId !== undefined ? { jobId } : {}) }
    : command === 'authority-evaluate' ? {command, evaluation: JSON.parse(await boundedFile(input!, 131072))}
    : report ? { command, report: JSON.parse(await boundedFile(input!, 131072)) }
      : { command, event: JSON.parse(await boundedFile(input!, 131072)), hostUserEvent: attested };
  const response = JSON.parse(serialize(await requestAttempt(root, object(fromJSON({...request, ownerWorkflow: 1}), 'request'))));
  if (response.ok !== true || response.ownerWorkflow !== 1 || !response.result?.ownerScope
    || typeof response.result.ownerScope.jobId !== 'string'
    || (jobId !== undefined && response.result.ownerScope.jobId !== jobId)) {
    return { ok: false, error: 'request_rejected' };
  }
  return response;
}
