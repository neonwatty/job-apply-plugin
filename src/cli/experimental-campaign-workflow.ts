import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SequentialCampaignWorkflow } from '../app/sequential-campaign-workflow.js';
import { WorkflowBroker } from '../integrations/host/claim-broker.js';
import { NativeCampaignWorkflowTasks } from '../store/native-campaign-workflow-tasks.js';
import { NativeJobsRepository } from '../store/native-jobs.js';
import { ClaimsService } from '../workspace-core/claims.js';
import { ApplicationAuthorityService } from '../workspace-core/application-authority.js';
import { loadPosixFlockProvider } from '../store/posix-flock.js';
import { nativeFixtureMarker, nativeFixtureMarkerName } from '../store/native-store-layout.js';
import { attemptProfile } from '../workflows/applications/attempt.js';
import { copy, fromJSON, get, object, serialize, set, string, text } from '../contracts/workspace/values.js';
import type { Document } from '../contracts/workspace/values.js';
import { boundedFile } from './experimental-files.js';
import { runAttemptBroker, requestAttempt } from './attempt-broker.js';

/** Discriminated commands prevent a campaign client from reaching an ordinary attempt host. */
export function campaignBroker(workflow: SequentialCampaignWorkflow, failed: () => void) {
  const broker = new WorkflowBroker(workflow, failed);
  const translate = (request: Document) => {
    const command = string(get(request, 'command'));
    if (command !== 'campaign_context' && command !== 'campaign_event') throw new Error('campaign request required');
    return set(copy(request), 'command', text(command === 'campaign_context' ? 'context' : 'event'));
  };
  return {
    acquire: (request: Document) => broker.acquire(translate(request)),
    dispatch: (request: Document) => broker.dispatch(translate(request)),
    close: () => broker.close(),
  };
}

/** Synthetic Store only; acquisition/control flags are host attestations, not authenticated approvals. */
export async function experimentalCampaignWorkflow(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!['serve', 'context', 'event', 'pause', 'resume', 'stop'].includes(command ?? '')) throw new Error('invalid command');
  const control = ['pause', 'resume', 'stop'].includes(command!);
  const options = new Map<string, string>();
  let attested = false;
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index]!;
    if (name === '--host-user-event' && (control || command === 'event') && !attested) { attested = true; continue; }
    const allowed = ['--root', '--native-lock', ...(control ? ['--expected-revision'] : command === 'event' ? ['--input'] : [])];
    if (!allowed.includes(name) || options.has(name) || !rest[index + 1]) throw new Error('invalid options');
    options.set(name, rest[++index]!);
  }
  const root = options.get('--root'), artifact = options.get('--native-lock');
  if (!root || !isAbsolute(root) || !artifact || !isAbsolute(artifact)) throw new Error('explicit paths required');
  if (command === 'event' && !options.has('--input') || control && (!attested || !options.has('--expected-revision'))) throw new Error('input required');
  if (await boundedFile(join(root, nativeFixtureMarkerName), 256) !== nativeFixtureMarker) throw new Error('synthetic Store required');
  const provider = loadPosixFlockProvider(artifact), repository = new NativeJobsRepository(root, provider);
  await repository.transaction(async () => {});
  if (command === 'serve' || control) {
    const claims = new ClaimsService(repository);
    const workflow = new SequentialCampaignWorkflow(new NativeCampaignWorkflowTasks(repository), claims,
      new ApplicationAuthorityService(repository), () => ({enabled: [attemptProfile], authorized: [attemptProfile]}));
    if (control) {
      const action = command as 'pause' | 'resume' | 'stop', expectedRevision = options.get('--expected-revision')!;
      try { return {ok: true, result: JSON.parse(serialize(await workflow.control(action, expectedRevision, {action, expectedRevision}))) as unknown}; }
      finally { await workflow.close(); }
    }
    await runAttemptBroker(root, claims, provider, {createAuthority: stop => campaignBroker(workflow, stop)});
    return {ok: true};
  }
  const request = command === 'context' ? {command: 'campaign_context'} : {command: 'campaign_event',
    event: JSON.parse(await boundedFile(options.get('--input')!, 131072)), hostUserEvent: attested};
  return JSON.parse(serialize(await requestAttempt(root, object(fromJSON(request), 'request')))) as unknown;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await experimentalCampaignWorkflow(process.argv.slice(2))) + '\n'); }
  catch { process.stdout.write(JSON.stringify({ok: false, error: 'workflow_failed'}) + '\n'); process.exitCode = 2; }
}
