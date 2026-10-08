import { createHash, randomUUID } from 'node:crypto';
import { activeApplicationJob, inspectSelection } from '../contracts/workspace/application-policy.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { fromJSON, get, int, string, JobsError } from '../contracts/workspace/values.js';
import { TaskProtocolError } from '../contracts/workspace/workflow-tasks.js';
import { runDurableOperation } from '../harness/run.js';
import { executeWorkflowTool } from '../harness/tool-gateway.js';
import { exact, identifier, record, requireCondition, revision, snapshot } from '../harness/validation.js';
import { preparationIdentity, preparationRegistry } from '../workflows/applications/prepare.js';
import { preparationScope } from '../workflows/applications/prepare-scope.js';
function selectionRequest(raw) {
    const value = record(snapshot(raw), 'invalid_arguments');
    exact(value, ['operationId', 'jobId', 'jobRevision', 'inputRevision'], 'invalid_arguments');
    requireCondition(typeof value.inputRevision === 'string' && /^[a-f0-9]{64}$/.test(value.inputRevision), 'invalid_arguments');
    return Object.freeze({ operationId: identifier(value.operationId, 'invalid_arguments'),
        jobId: identifier(value.jobId, 'invalid_arguments'), jobRevision: revision(value.jobRevision, 'invalid_arguments'),
        inputRevision: value.inputRevision });
}
/** Compact canonical projection for an exact user-selected job. No mutation or authority grant. */
export async function inspectExplicitSelection(domain, jobId, activeTaskId, access) {
    identifier(jobId, 'invalid_arguments');
    const job = activeApplicationJob(domain.snapshot, jobId);
    const jobRevision = int(get(job, 'revision')).toString();
    let available = activeTaskId === null && preparationRegistry().eligible(access).some(item => item.id === preparationIdentity.id);
    if (available) {
        try {
            await inspectSelection(domain.snapshot, jobId, BigInt(jobRevision));
        }
        catch (error) {
            if (!(error instanceof JobsError))
                throw error;
            available = false;
        }
    }
    return { jobId, jobRevision, inputRevision: preparationScope(domain.snapshot, job), status: string(get(job, 'status')),
        ready: available && string(get(job, 'status')) === 'ready', allowedActions: available ? ['select'] : [] };
}
/** An explicit selection request is one guarded transaction, with no synthetic question/reply.
 * The caller interprets user intent; this API does not authenticate a human or grant browser scope.
 */
export function selectExplicitJob(store, currentAccess, raw) {
    const request = selectionRequest(raw), registry = preparationRegistry();
    const fingerprint = createHash('sha256').update(canonicalJson(fromJSON({ kind: 'explicit_selection', ...request }))).digest('hex');
    return runDurableOperation(store, { operationId: request.operationId, fingerprint, taskId: null, expectedRevision: null }, {
        authorize: () => { registry.resolve(preparationIdentity, currentAccess()); },
        execute: async (_current, domain) => {
            const job = activeApplicationJob(domain.snapshot, request.jobId);
            if (int(get(job, 'revision')).toString() !== request.jobRevision
                || preparationScope(domain.snapshot, job) !== request.inputRevision)
                throw new TaskProtocolError('stale_revision');
            await inspectSelection(domain.snapshot, request.jobId, BigInt(request.jobRevision));
            const task = { taskId: randomUUID(), workflow: preparationIdentity, revision: '1',
                subject: { jobId: request.jobId, jobRevision: request.jobRevision, inputRevision: request.inputRevision }, status: 'active', pending: null };
            await executeWorkflowTool({ kind: 'callTool', operationId: request.operationId, taskId: task.taskId,
                expectedRevision: task.revision, actionId: 'application.select',
                arguments: { jobId: request.jobId, jobRevision: request.jobRevision } }, { taskId: task.taskId, revision: task.revision, workflow: task.workflow, canLeave: true, complete: false, terminal: false,
                childDepth: 0, allowedActions: [{ kind: 'callTool', id: 'application.select', toolId: 'application.select' }] }, registry, currentAccess(), new Map([['application.select', async (value) => {
                        const input = value;
                        await domain.select(input.jobId, BigInt(input.jobRevision));
                    }]]));
            registry.resolve(preparationIdentity, currentAccess());
            const selected = activeApplicationJob(domain.snapshot, request.jobId);
            if (string(get(selected, 'status')) !== 'ready')
                throw new TaskProtocolError('invalid_task_state');
            return { task: { ...task, subject: { ...task.subject, jobRevision: int(get(selected, 'revision')).toString() },
                    status: 'finished', pending: null }, outcome: 'job_ready' };
        },
    });
}
