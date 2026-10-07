import { preparationScope } from '../workflows/applications/prepare-scope.js';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { activeApplicationJob, inspectSelection } from '../contracts/workspace/application-policy.js';
import { fromJSON, get, int, object, string, JobsError } from '../contracts/workspace/values.js';
import { TaskProtocolError } from '../contracts/workspace/workflow-tasks.js';
import { WorkflowError } from '../harness/contracts.js';
import { parseActionProposal, parseRouteProposal } from '../harness/proposals.js';
import { validateAction } from '../harness/planner.js';
import { runDurableOperation } from '../harness/run.js';
import { executeWorkflowTool } from '../harness/tool-gateway.js';
import { preparationIdentity, preparationActions, preparationInput, preparationReply, preparationRegistry, confirmationQuestion } from '../workflows/applications/prepare.js';
const fingerprint = (value) => createHash('sha256').update(canonicalJson(fromJSON(value))).digest('hex');
const active = (task) => task.status === 'active' || task.status === 'waiting';
function sameWorkflow(task) {
    if (task.workflow.id !== preparationIdentity.id || task.workflow.version !== preparationIdentity.version) {
        throw new WorkflowError('workflow_unavailable');
    }
}
function subject(domain, task) {
    const value = get(object(get(domain.snapshot.jobs, 'jobs'), 'jobs'), task.subject.jobId);
    const job = value === null ? null : object(value, 'job');
    const available = job !== null && get(job, 'deletedAt') === null;
    const claim = get(domain.snapshot.coordinator, 'claim');
    return { revision: available ? int(get(job, 'revision')).toString() : null,
        status: available ? string(get(job, 'status')) : 'unavailable',
        inputRevision: available ? preparationScope(domain.snapshot, job) : null,
        canLeave: (!available || string(get(job, 'status')) !== 'in_progress')
            && (claim === null || string(get(object(claim, 'claim'), 'jobId')) !== task.subject.jobId) };
}
async function context(domain, task) {
    const canonical = subject(domain, task);
    let allowedActions = preparationActions(task, canonical.canLeave, canonical.revision, canonical.inputRevision);
    if (allowedActions.length) {
        try {
            await inspectSelection(domain.snapshot, task.subject.jobId, BigInt(task.subject.jobRevision));
        }
        catch (error) {
            if (!(error instanceof JobsError))
                throw error;
            allowedActions = [];
        }
    }
    return { taskId: task.taskId, revision: task.revision, workflow: task.workflow, canLeave: canonical.canLeave,
        allowedActions,
        complete: task.status === 'finished', terminal: !active(task), childDepth: 0 };
}
function requireSafe(domain, task) {
    if (!subject(domain, task).canLeave)
        throw new TaskProtocolError('handoff_required');
}
function nextTask(task) {
    return { ...task, revision: (BigInt(task.revision) + 1n).toString() };
}
export class PreparationWorkflow {
    store;
    currentAccess;
    registry = preparationRegistry();
    constructor(store, currentAccess) {
        this.store = store;
        this.currentAccess = currentAccess;
    }
    authorize(ledger, proposal) {
        if ('kind' in proposal && proposal.kind === 'newTask') {
            this.registry.resolve(proposal.workflow, this.currentAccess());
            return;
        }
        const task = proposal.taskId !== null && Object.hasOwn(ledger.tasks, proposal.taskId) ? ledger.tasks[proposal.taskId] : null;
        if (!task)
            throw new TaskProtocolError('task_conflict');
        sameWorkflow(task);
        // Safe cancellation remains possible after profile revocation. Execution rechecks the claim.
        if (!('kind' in proposal && proposal.kind === 'cancel'))
            this.registry.resolve(task.workflow, this.currentAccess());
    }
    async route(raw, attestation) {
        const proposal = parseRouteProposal(raw);
        if (!['newTask', 'continue', 'cancel'].includes(proposal.kind))
            throw new WorkflowError('action_unavailable');
        const reply = proposal.kind === 'continue' ? preparationReply(proposal.event) : null;
        if (reply && (!attestation || attestation.taskId !== proposal.taskId
            || attestation.expectedRevision !== proposal.expectedRevision
            || fingerprint(preparationReply(attestation.reply)) !== fingerprint(reply)))
            throw new TaskProtocolError('user_event_required');
        return runDurableOperation(this.store, { ...proposal, fingerprint: fingerprint(proposal) }, {
            authorize: ledger => this.authorize(ledger, proposal),
            execute: async (current, domain) => {
                if (proposal.kind === 'newTask') {
                    const input = preparationInput(proposal.input);
                    const task = { taskId: randomUUID(), workflow: preparationIdentity, revision: '1',
                        subject: { ...input, inputRevision: preparationScope(domain.snapshot, activeApplicationJob(domain.snapshot, input.jobId)) }, status: 'active', pending: null };
                    activeApplicationJob(domain.snapshot, input.jobId);
                    requireSafe(domain, task);
                    if (subject(domain, task).revision !== input.jobRevision)
                        throw new TaskProtocolError('stale_revision');
                    await inspectSelection(domain.snapshot, input.jobId, BigInt(input.jobRevision));
                    this.registry.resolve(task.workflow, this.currentAccess());
                    return { task, outcome: 'started' };
                }
                if (!current)
                    throw new TaskProtocolError('task_conflict');
                const task = nextTask(current);
                requireSafe(domain, task);
                if (proposal.kind === 'cancel')
                    return { task: { ...task, status: 'cancelled', pending: null }, outcome: 'cancelled' };
                if (!reply || current.status !== 'waiting' || current.pending?.requestId !== reply.requestId
                    || current.pending.questionId !== confirmationQuestion || current.subject.jobRevision !== reply.jobRevision) {
                    throw new TaskProtocolError('user_event_required');
                }
                if (reply.decision === 'decline')
                    return { task: { ...task, status: 'cancelled', pending: null }, outcome: 'declined' };
                const fresh = subject(domain, task);
                if (fresh.revision !== reply.jobRevision || fresh.inputRevision !== current.subject.inputRevision)
                    throw new TaskProtocolError('stale_revision');
                const allowed = { ...await context(domain, current), allowedActions: [
                        { kind: 'callTool', id: 'application.select', toolId: 'application.select' }
                    ] };
                await executeWorkflowTool({ kind: 'callTool', operationId: proposal.operationId, taskId: current.taskId,
                    expectedRevision: current.revision, actionId: 'application.select', arguments: { jobId: current.subject.jobId, jobRevision: current.subject.jobRevision } }, allowed, this.registry, this.currentAccess(), new Map([['application.select', async (value) => {
                            const input = value;
                            await domain.select(input.jobId, BigInt(input.jobRevision));
                        }]]));
                this.registry.resolve(current.workflow, this.currentAccess());
                const selected = subject(domain, task);
                if (selected.revision === null || selected.status !== 'ready')
                    throw new TaskProtocolError('invalid_task_state');
                return { task: { ...task, subject: { ...task.subject, jobRevision: selected.revision }, status: 'finished', pending: null },
                    outcome: 'job_ready' };
            },
        });
    }
    async action(raw) {
        const proposal = parseActionProposal(raw);
        return runDurableOperation(this.store, { ...proposal, fingerprint: fingerprint(proposal) }, {
            authorize: ledger => this.authorize(ledger, proposal),
            execute: async (current, domain) => {
                if (!current)
                    throw new TaskProtocolError('task_conflict');
                const validated = validateAction(proposal, await context(domain, current), this.registry, this.currentAccess());
                if (validated.action.kind !== 'askUser')
                    throw new WorkflowError('action_unavailable');
                requireSafe(domain, current);
                return { task: { ...nextTask(current), status: 'waiting',
                        pending: { requestId: randomUUID(), questionId: validated.action.questionId } }, outcome: 'question_pending' };
            },
        });
    }
    async inspect() {
        return this.store.transaction(async (tx) => {
            const task = tx.ledger.activeTaskId === null ? null : tx.ledger.tasks[tx.ledger.activeTaskId];
            if (!task)
                return { task: null, context: null };
            sameWorkflow(task);
            const projection = await context(tx.domain, task), access = this.currentAccess();
            const enabled = this.registry.eligible(access).some(item => item.id === task.workflow.id && item.version === task.workflow.version);
            return { task: structuredClone(task), context: { ...projection, allowedActions: enabled ? projection.allowedActions : [] },
                subject: subject(tx.domain, task) };
        });
    }
}
