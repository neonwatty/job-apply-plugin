import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaimWorkflow } from '../app/claim-workflow.js';
import { browserRecoveryGuidance } from '../app/browser-recovery-guidance.js';
import { createWorkflowBrowserHost } from '../integrations/host/workflow-browser-host.js';
import { BrowserWorkflowBroker } from '../integrations/host/browser-workflow-broker.js';
import { NativeClaimWorkflowTasks } from '../store/native-claim-workflow-tasks.js';
import { NativeBrowserOperations } from '../store/native-browser-operations.js';
import { NativeJobsRepository } from '../store/native-jobs.js';
import { ClaimsService } from '../workspace-core/claims.js';
import { loadPosixFlockProvider } from '../store/posix-flock.js';
import { nativeFixtureMarker, nativeFixtureMarkerName } from '../store/native-store-layout.js';
import { attemptProfile } from '../workflows/applications/attempt.js';
import { fromJSON, object, serialize } from '../contracts/workspace/values.js';
import { boundedFile } from './experimental-files.js';
import { runAttemptBroker, requestAttempt } from './attempt-broker.js';
/** Installed model client. Serving requires the separately held trusted embedding port. */
export async function experimentalBrowserWorkflow(args, host) {
    const [command, ...rest] = args;
    if (!['serve', 'context', 'event', 'observe', 'execute', 'reconcile'].includes(command ?? ''))
        throw new Error('invalid command');
    if (host ? command !== 'serve' : command === 'serve')
        throw new Error('trusted browser host required');
    const options = new Map();
    for (let index = 0; index < rest.length; index++) {
        const name = rest[index];
        if (!['--root', '--native-lock', '--input', ...(command === 'context' ? ['--job-id'] : [])].includes(name)
            || options.has(name) || !rest[index + 1])
            throw new Error('invalid options');
        options.set(name, rest[++index]);
    }
    const root = options.get('--root'), artifact = options.get('--native-lock');
    if (!root || !isAbsolute(root) || !artifact || !isAbsolute(artifact))
        throw new Error('explicit paths required');
    if (['event', 'observe', 'execute', 'reconcile'].includes(command) !== options.has('--input'))
        throw new Error('invalid input option');
    if (await boundedFile(join(root, nativeFixtureMarkerName), 256) !== nativeFixtureMarker)
        throw new Error('synthetic Store required');
    const provider = loadPosixFlockProvider(artifact), repository = new NativeJobsRepository(root, provider);
    await repository.transaction(async () => { });
    if (command === 'serve' && host) {
        const now = host.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
        const claims = new ClaimsService(repository, now);
        const operations = new NativeBrowserOperations(repository);
        const ports = createWorkflowBrowserHost({
            createWorkflow: verifier => new ClaimWorkflow(new NativeClaimWorkflowTasks(repository, now), claims, () => ({ enabled: [attemptProfile], authorized: [attemptProfile] }), now, verifier),
            adapter: host.adapter, grants: host.grants, controls: host.controls, operations,
            recovery: async () => browserRecoveryGuidance(await operations.inspect()),
        });
        host.ready(ports.host);
        try {
            await runAttemptBroker(root, claims, provider, { createAuthority: stop => new BrowserWorkflowBroker(ports, stop) });
        }
        finally {
            await ports.host.close();
        }
        return { ok: true };
    }
    const request = { command: `browser_${command}`,
        ...(options.has('--job-id') ? { jobId: options.get('--job-id') } : {}),
        ...(options.has('--input') ? { input: JSON.parse(await boundedFile(options.get('--input'), 131072)) } : {}),
    };
    return JSON.parse(serialize(await requestAttempt(root, object(fromJSON(request), 'browser request'))));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.stdout.write(JSON.stringify(await experimentalBrowserWorkflow(process.argv.slice(2))) + '\n');
    }
    catch {
        process.stdout.write(JSON.stringify({ ok: false, error: 'workflow_failed' }) + '\n');
        process.exitCode = 2;
    }
}
