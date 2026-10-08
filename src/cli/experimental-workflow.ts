import { atomicWorkflowJobsWrite } from '../store/workflow-atomic-write.js';
import { atomicWritePointJson } from '../store/point-persistence.js';
import { boundedFile } from './experimental-files.js';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PreparationWorkflow } from '../app/preparation-workflow.js';
import type { HostUserEvent } from '../app/preparation-workflow.js';
import { NativeJobsRepository } from '../store/native-jobs.js';
import { NativeWorkflowTasks } from '../store/native-workflow-tasks.js';
import { nativeFixtureMarker, nativeFixtureMarkerName } from '../store/native-store-layout.js';
import { loadPosixFlockProvider } from '../store/posix-flock.js';
import { preparationProfile, preparationReply } from '../workflows/applications/prepare.js';
import { parseRouteProposal } from '../harness/proposals.js';
import { WorkflowError } from '../harness/contracts.js';
import { TaskProtocolError } from '../contracts/workspace/workflow-tasks.js';

/** Isolated preparation entry point: explicit fixture paths, no bootstrap or browser access. */
export async function experimentalWorkflow(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!['context', 'select', 'route', 'action', 'reply'].includes(command ?? '')) throw new Error('invalid command');
  const options = new Map<string, string>();
  let hostUserEvent = false;
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index]!;
    if (name === '--host-user-event' && command === 'reply' && !hostUserEvent) { hostUserEvent = true; continue; }
    if (!['--root', '--native-lock', '--input', ...(command === 'context' ? ['--job-id'] : [])].includes(name) || options.has(name) || !rest[index + 1]) throw new Error('invalid option');
    options.set(name, rest[++index]!);
  }
  const root = options.get('--root'), nativeLock = options.get('--native-lock');
  if (!root || !isAbsolute(root) || !nativeLock || !isAbsolute(nativeLock)) throw new Error('explicit paths required');
  if (command === 'context' ? options.has('--input') : !options.has('--input')) throw new Error('invalid input option');
  if (command === 'reply' && !hostUserEvent) throw new TaskProtocolError('user_event_required');
  if (await boundedFile(join(root, nativeFixtureMarkerName), 256) !== nativeFixtureMarker) throw new Error('synthetic Store required');
  const repository = new NativeJobsRepository(root, loadPosixFlockProvider(nativeLock), (path, value, options) =>
    path === join(root, 'jobs.json') ? atomicWorkflowJobsWrite(path, value, options) : atomicWritePointJson(path, value, options));
  const workflow = new PreparationWorkflow(new NativeWorkflowTasks(repository), () => ({
    enabled: [preparationProfile], authorized: [preparationProfile] }));
  if (command === 'context') return workflow.inspect(options.get('--job-id'));
  const raw: unknown = JSON.parse(await boundedFile(options.get('--input')!, 131072));
  if (command === 'select') return workflow.select(raw);
  if (command === 'action') return workflow.action(raw);
  let attestation: HostUserEvent | undefined;
  if (command === 'reply') {
    const proposal = parseRouteProposal(raw);
    if (proposal.kind !== 'continue' || proposal.taskId === null || proposal.expectedRevision === null) throw new Error('reply required');
    // Explicit CLI flag attests the entire supplied event. It is not independent human authentication.
    attestation = { taskId: proposal.taskId, expectedRevision: proposal.expectedRevision, reply: preparationReply(proposal.event) };
  }
  return workflow.route(raw, attestation);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify({ ok: true, result: await experimentalWorkflow(process.argv.slice(2)) }) + '\n'); }
  catch (error) {
    const code = error instanceof WorkflowError || error instanceof TaskProtocolError ? error.code : 'workflow_failed';
    process.stdout.write(JSON.stringify({ ok: false, error: code }) + '\n');
    process.exitCode = 2;
  }
}
