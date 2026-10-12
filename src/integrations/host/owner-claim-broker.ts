import type { OwnerWorkflowScope } from '../../contracts/workspace/owner-workflow.js';
import { fromJSON, object, serialize, type Document } from '../../contracts/workspace/values.js';
import { identifier, record, requireCondition } from '../../harness/validation.js';
import { WorkflowBroker, type ClaimWorkflowBrokerPort } from './claim-broker.js';

/** One explicitly activated owner job; transport never starts another broker. */
export class OwnerClaimBroker {
  private readonly broker: WorkflowBroker;
  private readonly scope: OwnerWorkflowScope;
  private currentTaskId: string | null = null;
  constructor(private readonly workflow: ClaimWorkflowBrokerPort, scope: OwnerWorkflowScope, failed: () => void,
    heartbeatMilliseconds = 60_000) {
    this.scope = structuredClone(scope);
    this.broker = new WorkflowBroker(workflow, failed, heartbeatMilliseconds);
  }
  async acquire(request: Document): Promise<Document> {
    const value = record(JSON.parse(serialize(request)), 'invalid_proposal');
    requireCondition(value.command === 'context' || value.command === 'host-browser-context', 'invalid_proposal');
    const result = await this.broker.acquire(this.scopedRequest(request));
    return this.decorate(result);
  }
  async dispatch(request: Document): Promise<{response: Document; complete: boolean}> {
    const scoped = this.scopedRequest(request);
    const before = await this.workflow.inspect(this.scope.jobId);
    // Keep identity across a durable commit whose response is lost.
    if (before.task) this.currentTaskId = before.task.taskId;
    const result = await this.broker.dispatch(scoped);
    const response = JSON.parse(serialize(result.response));
    const status = response.result?.receipt?.task?.status;
    return { response: this.decorate(result.response), complete: (status === 'finished' || status === 'cancelled')
      && this.currentTaskId !== null && this.currentTaskId === response.result?.receipt?.task?.taskId };
  }
  private scopedRequest(request: Document): Document {
    const value = record(JSON.parse(serialize(request)), 'invalid_proposal');
    requireCondition(value.ownerWorkflow === 1, 'invalid_proposal');
    delete value.ownerWorkflow;
    if (value.command === 'context' || value.command === 'host-browser-context') {
      if (Object.hasOwn(value, 'jobId')) requireCondition(identifier(value.jobId, 'invalid_proposal') === this.scope.jobId, 'invalid_proposal');
      return object(fromJSON({...value, jobId: this.scope.jobId}), 'request');
    }
    const event = record(value.command === 'host-browser-report' ? value.report : value.event, 'invalid_proposal');
    requireCondition(identifier(event.jobId, 'invalid_proposal') === this.scope.jobId, 'invalid_proposal');
    return object(fromJSON(value), 'request');
  }
  private decorate(response: Document): Document {
    const value = JSON.parse(serialize(response));
    if (value.ok && value.result) {
      value.ownerWorkflow = 1;
      value.result.ownerScope = structuredClone(this.scope);
      value.result.evidenceKind = 'agent_attested';
      value.result.browserAuthority = 'existing_host_tools';
      value.result.finalSubmission = 'manual';
      if (value.result.guidance) value.result.guidance.actions = value.result.guidance.actions.filter((action: {kind:string}) => action.kind !== 'restart');
      if (value.result.hostBrowser) {
        value.result.hostBrowser.reports = (value.result.guidance?.actions ?? [])
          .filter((action: {kind:string;input:{status?:string}}) => action.kind === 'progress'
            || action.kind === 'handoff' && action.input.status === 'needs_info')
          .map((action: {kind:string;input:Record<string,unknown>;requiredFields:string[]}) => {
            const {kind: _kind, status: _status, ...input} = action.input;
            return {args: ['owner-workflow', 'host-browser-report'], requiredFields: [...action.requiredFields],
              input: {...input, evidenceKind: 'agent_attested', outcome: action.kind === 'progress' ? 'progress' : 'needs_info'}};
          });
      }
      for (const action of value.result.guidance?.actions ?? []) {
        action.args = ['owner-workflow', 'event', ...(action.requiresExplicitUserEvent ? ['--host-user-event'] : [])];
      }
    }
    return object(fromJSON(value), 'response');
  }
  close(): Promise<void> { return this.broker.close(); }
}
