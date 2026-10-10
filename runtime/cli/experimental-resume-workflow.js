import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResumeExtractionWorkflow } from '../app/resume-extraction-workflow.js';
import { NativeResumeWorkflowTasks } from '../store/native-resume-workflow-tasks.js';
import { NativeJobsRepository } from '../store/native-jobs.js';
import { nativeFixtureMarker, nativeFixtureMarkerName } from '../store/native-store-layout.js';
import { loadPosixFlockProvider } from '../store/posix-flock.js';
import { extractionProfile, extractionReply } from '../workflows/resumes/extract.js';
import { parseRouteProposal } from '../harness/proposals.js';
import { WorkflowError } from '../harness/contracts.js';
import { TaskProtocolError } from '../contracts/workspace/workflow-tasks.js';
import { WorkflowArchiveError } from '../contracts/workspace/workflow-archive.js';
import { boundedFile } from './experimental-files.js';
/** Fixture-only host entry. The flag attests an event; it does not authenticate human approval. */
export async function experimentalResumeWorkflow(args) {
    const [command, ...rest] = args;
    if (!['context', 'route', 'action', 'reply'].includes(command ?? ''))
        throw new Error('invalid command');
    const options = new Map();
    let attested = false;
    for (let index = 0; index < rest.length; index++) {
        const name = rest[index];
        if (name === '--host-user-event' && command === 'reply' && !attested) {
            attested = true;
            continue;
        }
        if (!['--root', '--native-lock', '--input'].includes(name) || options.has(name) || !rest[index + 1])
            throw new Error('invalid option');
        options.set(name, rest[++index]);
    }
    const root = options.get('--root'), nativeLock = options.get('--native-lock');
    if (!root || !isAbsolute(root) || !nativeLock || !isAbsolute(nativeLock))
        throw new Error('explicit paths required');
    if ((command !== 'context') !== options.has('--input'))
        throw new Error('invalid input option');
    if (command === 'reply' && !attested)
        throw new TaskProtocolError('user_event_required');
    if (await boundedFile(join(root, nativeFixtureMarkerName), 256) !== nativeFixtureMarker)
        throw new Error('synthetic Store required');
    const repository = new NativeJobsRepository(root, loadPosixFlockProvider(nativeLock));
    const workflow = new ResumeExtractionWorkflow(new NativeResumeWorkflowTasks(repository), () => ({ enabled: [extractionProfile], authorized: [extractionProfile] }));
    if (command === 'context')
        return workflow.inspect();
    const raw = JSON.parse(await boundedFile(options.get('--input'), 131072));
    if (command === 'action')
        return workflow.action(raw);
    let attestation;
    if (command === 'reply') {
        const proposal = parseRouteProposal(raw);
        if (proposal.kind !== 'continue' || proposal.taskId === null || proposal.expectedRevision === null)
            throw new Error('reply required');
        attestation = { taskId: proposal.taskId, expectedRevision: proposal.expectedRevision, reply: extractionReply(proposal.event) };
    }
    return workflow.route(raw, attestation);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.stdout.write(JSON.stringify({ ok: true, result: await experimentalResumeWorkflow(process.argv.slice(2)) }) + '\n');
    }
    catch (error) {
        const code = error instanceof WorkflowArchiveError ? 'workflow_archive_corrupt'
            : error instanceof WorkflowError || error instanceof TaskProtocolError ? error.code : 'workflow_failed';
        process.stdout.write(JSON.stringify({ ok: false, error: code }) + '\n');
        process.exitCode = 2;
    }
}
