import { createHash } from 'node:crypto';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { fromJSON, get, has, int, object } from '../contracts/workspace/values.js';
import { decodeWorkflowLedger, TaskProtocolError, workflowMetadataKey } from '../contracts/workspace/workflow-tasks.js';
import { workflowHistory } from '../harness/task-store.js';
import { claimEvent, attemptIdentity } from '../workflows/applications/attempt.js';
import { hostBrowserReport } from '../workflows/applications/host-browser-report.js';
/** Exact historical lookup; never activates or acquires an application claim. */
export async function ownerWorkflowReceipt(repository, raw) {
    const event = raw && typeof raw === 'object' && Object.hasOwn(raw, 'outcome')
        ? hostBrowserReport(raw) : claimEvent(raw);
    const fingerprint = createHash('sha256').update(canonicalJson(fromJSON(event))).digest('hex');
    return repository.claimTransaction(async (tx) => {
        const metadata = object(get(tx.jobs, 'metadata'), 'metadata');
        if (!has(metadata, workflowMetadataKey))
            throw new TaskProtocolError('operation_conflict');
        const stored = object(get(metadata, workflowMetadataKey), 'workflow metadata');
        if (int(get(stored, 'schemaVersion')) !== 1n)
            throw new TaskProtocolError('action_unavailable');
        const found = workflowHistory({ ledger: decodeWorkflowLedger(stored) }).receipt(event.operationId);
        if (!found || found.fingerprint !== fingerprint
            || found.receipt.task.workflow.id !== attemptIdentity.id
            || found.receipt.task.workflow.version !== attemptIdentity.version)
            throw new TaskProtocolError('operation_conflict');
        return { ok: true, ownerWorkflow: 1, result: { receipt: structuredClone(found.receipt), replayed: true,
                evidenceKind: 'agent_attested', replayScope: 'report_recording_only' } };
    });
}
