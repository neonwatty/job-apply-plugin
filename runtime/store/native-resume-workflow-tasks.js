import { get, has, object, parse, serialize, set, text } from '../contracts/workspace/values.js';
import { decodeWorkflowLedger, emptyWorkflowLedger, encodeWorkflowLedger, upgradeWorkflowLedger, TaskProtocolError, workflowMetadataKey } from '../contracts/workspace/workflow-tasks.js';
import { ExtractionRequests } from '../workspace-core/extraction-requests.js';
import { ResumeFactsService } from '../workspace-core/resume-facts.js';
const clone = (value) => object(parse(serialize(value)), 'staged document');
/** Existing canonical extraction services stage one journal with the workflow ledger. */
export class NativeResumeWorkflowTasks {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    transaction(operation) {
        return this.repository.extractionTransaction(async (original) => {
            if (!original.jobs)
                throw new TaskProtocolError('action_unavailable');
            const jobs = clone(original.jobs), updates = {};
            let committed = false;
            const buffered = { ...original, jobs,
                profile: clone(original.profile), resumes: clone(original.resumes), requests: clone(original.requests),
                proposals: clone(original.proposals), facts: clone(original.facts),
                commit: async (_kind, next) => { Object.assign(updates, next); Object.assign(buffered, next); } };
            const repository = { extractionTransaction: callback => callback(buffered) };
            const requests = new ExtractionRequests(repository, this.now), facts = new ResumeFactsService(repository, this.now);
            const metadata = object(get(jobs, 'metadata'), 'jobs metadata');
            const ledger = has(metadata, workflowMetadataKey) ? decodeWorkflowLedger(get(metadata, workflowMetadataKey)) : emptyWorkflowLedger();
            // Upgrade is staged only. Read-only inspection and replay never persist migration.
            const upgraded = upgradeWorkflowLedger(ledger);
            const prepared = await original.workflowArchive?.prepare(upgraded);
            return operation({ ledger: prepared?.ledger ?? upgraded, ...(prepared ? { history: prepared.history } : {}),
                domain: { snapshot: buffered,
                    create: (id, revision) => requests.createRequest(id, revision, true),
                    propose: (id, revision, candidate) => facts.completeRequest(id, candidate, revision),
                    confirm: (id, revision, content) => facts.confirm(id, revision, content),
                    close: (id, revision, interrupted) => interrupted ? requests.failRequest(id, 'interrupted', revision) : requests.cancelRequest(id, revision),
                }, commit: async (next) => {
                    if (committed)
                        throw new TaskProtocolError('invalid_task_state');
                    set(metadata, workflowMetadataKey, encodeWorkflowLedger(next));
                    set(metadata, 'updatedAt', text(this.now()));
                    committed = true;
                    await prepared?.flush();
                    await original.commit('workflow-extraction', { ...updates, jobs });
                },
            });
        });
    }
}
