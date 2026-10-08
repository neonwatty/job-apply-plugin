import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaimWorkflow } from '../app/claim-workflow.js';
import { WorkflowBroker } from '../integrations/host/claim-broker.js';
import { NativeClaimWorkflowTasks } from '../store/native-claim-workflow-tasks.js';
import { NativeJobsRepository } from '../store/native-jobs.js';
import { ClaimsService } from '../workspace-core/claims.js';
import { loadPosixFlockProvider } from '../store/posix-flock.js';
import { nativeFixtureMarker, nativeFixtureMarkerName } from '../store/native-store-layout.js';
import { attemptProfile } from '../workflows/applications/attempt.js';
import { fromJSON, object, serialize } from '../contracts/workspace/values.js';
import { boundedFile } from './experimental-files.js';
import { runAttemptBroker, requestAttempt } from './attempt-broker.js';
/** Explicit fixture-only server/client. The caller owns the foreground broker lifecycle. */
export async function experimentalClaimWorkflow(args) {
    const [command, ...rest] = args;
    if (!['serve', 'context', 'event'].includes(command ?? ''))
        throw new Error('invalid command');
    const options = new Map();
    let attested = false;
    for (let index = 0; index < rest.length; index++) {
        const name = rest[index];
        if (name === '--host-user-event' && command === 'event' && !attested) {
            attested = true;
            continue;
        }
        if (!['--root', '--native-lock', '--input'].includes(name) || options.has(name) || !rest[index + 1])
            throw new Error('invalid options');
        options.set(name, rest[++index]);
    }
    const root = options.get('--root'), artifact = options.get('--native-lock');
    if (!root || !isAbsolute(root) || !artifact || !isAbsolute(artifact))
        throw new Error('explicit paths required');
    if ((command === 'event') !== options.has('--input'))
        throw new Error('invalid input option');
    if (await boundedFile(join(root, nativeFixtureMarkerName), 256) !== nativeFixtureMarker)
        throw new Error('synthetic Store required');
    const provider = loadPosixFlockProvider(artifact), repository = new NativeJobsRepository(root, provider);
    // Validate even client roots before connecting; canonical paths also give one broker identity.
    await repository.transaction(async () => { });
    if (command === 'serve') {
        const claims = new ClaimsService(repository);
        const workflow = new ClaimWorkflow(new NativeClaimWorkflowTasks(repository), claims, () => ({ enabled: [attemptProfile], authorized: [attemptProfile] }));
        await runAttemptBroker(root, claims, provider, { createAuthority: stop => new WorkflowBroker(workflow, stop) });
        return { ok: true };
    }
    const request = command === 'context' ? { command } : { command, event: JSON.parse(await boundedFile(options.get('--input'), 131072)), hostUserEvent: attested };
    return JSON.parse(serialize(await requestAttempt(root, object(fromJSON(request), 'request'))));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.stdout.write(JSON.stringify(await experimentalClaimWorkflow(process.argv.slice(2))) + '\n');
    }
    catch {
        process.stdout.write(JSON.stringify({ ok: false, error: 'workflow_failed' }) + '\n');
        process.exitCode = 2;
    }
}
