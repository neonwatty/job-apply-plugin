import { fromJSON, serialize } from './values.js';
export class TaskProtocolError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'TaskProtocolError';
    }
}
export const workflowMetadataKey = 'agentWorkflows';
export const taskLimit = 64, receiptLimit = 256;
const statuses = ['active', 'waiting', 'finished', 'cancelled'];
const outcomes = ['started', 'question_pending', 'job_ready', 'cancelled', 'declined', 'claim_acquired', 'claim_recovered', 'progress_saved', 'needs_info', 'awaiting_review'];
function check(value) { if (!value)
    throw new TaskProtocolError('invalid_task_state'); }
function record(value, fields) {
    check(value !== null && typeof value === 'object' && !Array.isArray(value));
    const input = value;
    check(Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null);
    if (fields)
        check(Object.keys(input).length === fields.length && fields.every(key => Object.hasOwn(input, key)));
    return input;
}
function id(value) {
    check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes('..'));
}
function revision(value) { check(typeof value === 'string' && value.length <= 4300 && /^[1-9][0-9]*$/.test(value)); }
function task(value) {
    const input = record(value, ['taskId', 'workflow', 'revision', 'subject', 'status', 'pending']);
    id(input.taskId);
    revision(input.revision);
    const workflow = record(input.workflow, ['id', 'version']);
    id(workflow.id);
    check(typeof workflow.version === 'number' && Number.isSafeInteger(workflow.version) && workflow.version > 0);
    const subject = record(input.subject, ['jobId', 'jobRevision', 'inputRevision']);
    id(subject.jobId);
    revision(subject.jobRevision);
    check(typeof subject.inputRevision === 'string' && /^[a-f0-9]{64}$/.test(subject.inputRevision));
    check(statuses.includes(input.status));
    if (input.pending !== null) {
        const pending = record(input.pending, ['requestId', 'questionId']);
        id(pending.requestId);
        id(pending.questionId);
    }
    check((input.status === 'waiting') === (input.pending !== null));
    return input;
}
/** Closed, bounded, value-free metadata. Unsupported versions and malformed history fail closed. */
export function validateWorkflowLedger(value) {
    const input = record(value, ['schemaVersion', 'activeTaskId', 'tasks', 'receipts']);
    check(input.schemaVersion === 1);
    const tasks = record(input.tasks), receipts = record(input.receipts);
    check(Object.keys(tasks).length <= taskLimit && Object.keys(receipts).length <= receiptLimit);
    const active = [];
    for (const [key, raw] of Object.entries(tasks)) {
        id(key);
        const item = task(raw);
        check(item.taskId === key);
        if (item.status === 'active' || item.status === 'waiting')
            active.push(key);
    }
    if (input.activeTaskId !== null)
        id(input.activeTaskId);
    check(active.length <= 1 && (active[0] ?? null) === input.activeTaskId);
    for (const [key, raw] of Object.entries(receipts)) {
        id(key);
        const item = record(raw, ['fingerprint', 'receipt']);
        check(typeof item.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.fingerprint));
        const receipt = record(item.receipt, ['operationId', 'task', 'outcome']);
        check(receipt.operationId === key && outcomes.includes(receipt.outcome));
        const historical = task(receipt.task), current = tasks[historical.taskId];
        check(current !== undefined);
        const latest = task(current);
        check(historical.subject.jobId === latest.subject.jobId && historical.workflow.id === latest.workflow.id
            && historical.workflow.version === latest.workflow.version && BigInt(historical.revision) <= BigInt(latest.revision));
    }
    check(JSON.stringify(input).length <= 1024 * 1024);
    return input;
}
export function emptyWorkflowLedger() {
    return { schemaVersion: 1, activeTaskId: null, tasks: Object.create(null),
        receipts: Object.create(null) };
}
export function decodeWorkflowLedger(value) {
    try {
        return validateWorkflowLedger(JSON.parse(serialize(value)));
    }
    catch {
        throw new TaskProtocolError('invalid_task_state');
    }
}
export function encodeWorkflowLedger(ledger) {
    return fromJSON(validateWorkflowLedger(ledger));
}
