import { fromJSON, object, serialize } from '../../contracts/workspace/values.js';
import { identifier, record, requireCondition } from '../../harness/validation.js';
import { WorkflowBroker } from './claim-broker.js';
/** One explicitly activated owner job; transport never starts another broker. */
export class OwnerClaimBroker {
    workflow;
    broker;
    scope;
    currentTaskId = null;
    constructor(workflow, scope, failed, heartbeatMilliseconds = 60_000) {
        this.workflow = workflow;
        this.scope = structuredClone(scope);
        this.broker = new WorkflowBroker(workflow, failed, heartbeatMilliseconds);
    }
    async acquire(request) {
        const value = record(JSON.parse(serialize(request)), 'invalid_proposal');
        requireCondition(value.command === 'context' || value.command === 'host-browser-context', 'invalid_proposal');
        const result = await this.broker.acquire(this.scopedRequest(request));
        return this.decorate(result);
    }
    async dispatch(request) {
        const scoped = this.scopedRequest(request);
        const before = await this.workflow.inspect(this.scope.jobId);
        // Keep identity across a durable commit whose response is lost.
        if (before.task)
            this.currentTaskId = before.task.taskId;
        const result = await this.broker.dispatch(scoped);
        const response = JSON.parse(serialize(result.response));
        const status = response.result?.receipt?.task?.status;
        return { response: this.decorate(result.response), complete: (status === 'finished' || status === 'cancelled')
                && this.currentTaskId !== null && this.currentTaskId === response.result?.receipt?.task?.taskId };
    }
    scopedRequest(request) {
        const value = record(JSON.parse(serialize(request)), 'invalid_proposal');
        requireCondition(value.ownerWorkflow === 1, 'invalid_proposal');
        delete value.ownerWorkflow;
        if (value.command === 'context' || value.command === 'host-browser-context') {
            if (Object.hasOwn(value, 'jobId'))
                requireCondition(identifier(value.jobId, 'invalid_proposal') === this.scope.jobId, 'invalid_proposal');
            return object(fromJSON({ ...value, jobId: this.scope.jobId }), 'request');
        }
        const event = record(value.command === 'host-browser-report' ? value.report : value.event, 'invalid_proposal');
        requireCondition(identifier(event.jobId, 'invalid_proposal') === this.scope.jobId, 'invalid_proposal');
        return object(fromJSON(value), 'request');
    }
    decorate(response) {
        const value = JSON.parse(serialize(response));
        if (value.ok && value.result) {
            value.ownerWorkflow = 1;
            value.result.ownerScope = structuredClone(this.scope);
            value.result.evidenceKind = 'agent_attested';
            value.result.browserAuthority = 'existing_host_tools';
            value.result.finalSubmission = 'manual';
            if (value.result.guidance)
                value.result.guidance.actions = value.result.guidance.actions.filter((action) => action.kind !== 'restart');
            if (value.result.hostBrowser) {
                value.result.hostBrowser.reports = (value.result.guidance?.actions ?? [])
                    .filter((action) => action.kind === 'progress'
                    || action.kind === 'handoff' && ['needs_info', 'awaiting_review'].includes(action.input.status ?? ''))
                    .map((action) => {
                    const { kind: _kind, status: _status, ...input } = action.input;
                    return { args: ['owner-workflow', 'host-browser-report'], requiredFields: [...action.requiredFields],
                        input: { ...input, evidenceKind: 'agent_attested', outcome: action.kind === 'progress' ? 'progress' : action.input.status } };
                });
            }
            for (const action of value.result.guidance?.actions ?? []) {
                action.args = ['owner-workflow', 'event', ...(action.requiresExplicitUserEvent ? ['--host-user-event'] : [])];
            }
        }
        return object(fromJSON(value), 'response');
    }
    close() { return this.broker.close(); }
}
