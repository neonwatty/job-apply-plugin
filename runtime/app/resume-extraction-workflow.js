import { randomUUID } from 'node:crypto';
import { fromJSON, get, int, string } from '../contracts/workspace/values.js';
import { TaskProtocolError } from '../contracts/workspace/workflow-tasks.js';
import { WorkflowError } from '../harness/contracts.js';
import { parseActionProposal, parseRouteProposal } from '../harness/proposals.js';
import { validateAction } from '../harness/planner.js';
import { runDurableOperation } from '../harness/run.js';
import { executeWorkflowTool } from '../harness/tool-gateway.js';
import { readyResume } from '../workspace-core/extraction-context.js';
import { extractionIdentity, extractionInput, extractionReply, extractionRegistry, extractionQuestion } from '../workflows/resumes/extract.js';
import { extractionContext, extractionFingerprint, extractionScope, requestRecord, requireFresh, resumeTask } from './resume-extraction-state.js';
const nextTask = (task) => ({ ...task, revision: (BigInt(task.revision) + 1n).toString() });
export class ResumeExtractionWorkflow {
    store;
    access;
    registry = extractionRegistry();
    constructor(store, access) {
        this.store = store;
        this.access = access;
    }
    authorize(ledger, proposal, history) {
        if ('kind' in proposal && proposal.kind === 'newTask') {
            this.registry.resolve(proposal.workflow, this.access());
            return;
        }
        const task = proposal.taskId === null ? null : history?.task(proposal.taskId) ?? ledger.tasks[proposal.taskId];
        if (!task)
            throw new TaskProtocolError('task_conflict');
        resumeTask(task);
        if (!('kind' in proposal && proposal.kind === 'cancel'))
            this.registry.resolve(task.workflow, this.access());
    }
    async route(raw, attestation) {
        const proposal = parseRouteProposal(raw);
        if (!['newTask', 'continue', 'cancel'].includes(proposal.kind))
            throw new WorkflowError('action_unavailable');
        const reply = proposal.kind === 'continue' ? extractionReply(proposal.event) : null;
        if (reply && (!attestation || attestation.taskId !== proposal.taskId || attestation.expectedRevision !== proposal.expectedRevision
            || extractionFingerprint(extractionReply(attestation.reply)) !== extractionFingerprint(reply)))
            throw new TaskProtocolError('user_event_required');
        return runDurableOperation(this.store, { ...proposal, fingerprint: extractionFingerprint(proposal) }, {
            authorize: (ledger, history) => this.authorize(ledger, proposal, history),
            execute: async (current, domain) => {
                if (proposal.kind === 'newTask') {
                    const input = extractionInput(proposal.input);
                    let resumeId;
                    let request;
                    if ('requestId' in input) {
                        request = requestRecord(domain, input.requestId);
                        if (int(get(request, 'revision')).toString() !== input.requestRevision || string(get(request, 'scope')) !== 'resume'
                            || string(get(request, 'status')) !== 'requested')
                            throw new TaskProtocolError('stale_revision');
                        resumeId = string(get(request, 'resumeId'));
                        const resume = await readyResume(domain.snapshot, resumeId, BigInt(input.resumeRevision));
                        if (string(get(resume, 'contentRevision')) !== string(get(request, 'resumeContentRevision')))
                            throw new TaskProtocolError('stale_revision');
                    }
                    else {
                        resumeId = input.resumeId;
                        request = await domain.create(resumeId, BigInt(input.resumeRevision));
                    }
                    const task = { taskId: randomUUID(), workflow: extractionIdentity, revision: '1', status: 'active', pending: null,
                        subject: { kind: 'resume', resumeId, resumeRevision: input.resumeRevision, inputRevision: '',
                            requestId: string(get(request, 'requestId')), requestRevision: int(get(request, 'revision')).toString(), factRevision: null } };
                    // Legacy managed resumes acquire a content revision when the request is created.
                    const resume = await readyResume(domain.snapshot, resumeId);
                    task.subject.resumeRevision = int(get(resume, 'revision')).toString();
                    task.subject.inputRevision = extractionScope(domain, task);
                    this.registry.resolve(task.workflow, this.access());
                    return { task, outcome: 'extraction_requested' };
                }
                if (!current)
                    throw new TaskProtocolError('task_conflict');
                resumeTask(current);
                const task = nextTask(current);
                if (proposal.kind === 'cancel') {
                    const request = requestRecord(domain, current.subject.requestId);
                    if (string(get(request, 'status')) === 'requested') {
                        await domain.close(current.subject.requestId, int(get(request, 'revision')), false);
                    }
                    return { task: { ...task, status: 'cancelled', pending: null }, outcome: 'cancelled' };
                }
                if (!reply || current.status !== 'waiting' || current.pending?.requestId !== reply.requestId
                    || current.pending.questionId !== extractionQuestion || current.subject.factRevision !== reply.factRevision)
                    throw new TaskProtocolError('user_event_required');
                // Rejecting a stale draft is safe, but the event must still name the originally reviewed content.
                const request = requestRecord(domain, current.subject.requestId);
                if (string(get(request, 'resumeContentRevision')) !== reply.contentRevision)
                    throw new TaskProtocolError('user_event_required');
                if (reply.decision === 'reject')
                    return { task: { ...task, status: 'finished', pending: null }, outcome: 'extraction_rejected' };
                await requireFresh(domain, current);
                await domain.confirm(current.subject.resumeId, BigInt(reply.factRevision), reply.contentRevision);
                this.registry.resolve(current.workflow, this.access());
                return { task: { ...task, status: 'finished', pending: null }, outcome: 'extraction_accepted' };
            },
        });
    }
    async action(raw) {
        const proposal = parseActionProposal(raw);
        return runDurableOperation(this.store, { ...proposal, fingerprint: extractionFingerprint(proposal) }, {
            authorize: (ledger, history) => this.authorize(ledger, proposal, history),
            execute: async (current, domain) => {
                if (!current)
                    throw new TaskProtocolError('task_conflict');
                resumeTask(current);
                const context = await extractionContext(domain, current);
                const action = validateAction(proposal, context, this.registry, this.access()).action;
                await requireFresh(domain, current);
                const task = nextTask(current);
                this.registry.resolve(current.workflow, this.access());
                if (action.kind === 'askUser')
                    return { task: { ...task, status: 'waiting',
                            pending: { requestId: randomUUID(), questionId: extractionQuestion } }, outcome: 'extraction_review_pending' };
                const result = await executeWorkflowTool(proposal, context, this.registry, this.access(), new Map([
                    ['resume.propose', async (candidate) => domain.propose(current.subject.requestId, BigInt(current.subject.requestRevision), fromJSON(candidate))],
                    ['resume.interrupt', async () => domain.close(current.subject.requestId, BigInt(current.subject.requestRevision), true)],
                ]));
                this.registry.resolve(current.workflow, this.access());
                if (action.id === 'resume.interrupt')
                    return { task: { ...task, status: 'cancelled', pending: null }, outcome: 'extraction_interrupted' };
                const request = requestRecord(domain, current.subject.requestId);
                task.subject = { ...current.subject, requestRevision: int(get(request, 'revision')).toString(),
                    factRevision: int(get(result, 'revision')).toString() };
                task.subject.inputRevision = extractionScope(domain, task);
                return { task, outcome: 'extraction_proposed' };
            },
        });
    }
    async inspect() {
        return this.store.transaction(async (tx) => {
            const task = tx.ledger.activeTaskId === null ? null : tx.ledger.tasks[tx.ledger.activeTaskId];
            if (!task)
                return { task: null, context: null, approvalEvidence: 'host_attestation' };
            resumeTask(task);
            const context = await extractionContext(tx.domain, task);
            const enabled = this.registry.eligible(this.access()).some(item => item.id === task.workflow.id);
            return { task: structuredClone(task), context: { ...context, allowedActions: enabled ? context.allowedActions : [] },
                review: task.pending ? { requestId: task.pending.requestId, factRevision: task.subject.factRevision,
                    contentRevision: string(get(requestRecord(tx.domain, task.subject.requestId), 'resumeContentRevision')) } : null,
                approvalEvidence: 'host_attestation' };
        });
    }
}
