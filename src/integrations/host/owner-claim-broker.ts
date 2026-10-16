import type { ApplicationAuthorityService } from '../../workspace-core/application-authority.js';
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
    heartbeatMilliseconds = 60_000, private readonly application?: ApplicationAuthorityService) {
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
    const value = record(JSON.parse(serialize(scoped)), 'invalid_proposal');
    if (value.command === 'authority-evaluate') {
      requireCondition(Boolean(this.application && this.workflow.evaluateApplicationAuthority), 'action_unavailable');
      const decision = await this.workflow.evaluateApplicationAuthority!(value.evaluation, this.application!);
      return {response: await this.decorate(object(fromJSON({ok:true,result:{decision}}), 'response')), complete:false};
    }
    const before = await this.workflow.inspect(this.scope.jobId);
    // Keep identity across a durable commit whose response is lost.
    if (before.task) this.currentTaskId = before.task.taskId;
    const result = await this.broker.dispatch(scoped);
    const response = JSON.parse(serialize(result.response));
    const status = response.result?.receipt?.task?.status;
    return { response: await this.decorate(result.response), complete: (status === 'finished' || status === 'cancelled')
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
    if (value.command === 'authority-evaluate') {
      requireCondition(Object.keys(value).length === 2 && Object.hasOwn(value, 'evaluation'), 'invalid_proposal');
      return object(fromJSON(value), 'request');
    }
    const event = record(value.command === 'host-browser-report' ? value.report : value.event, 'invalid_proposal');
    requireCondition(identifier(event.jobId, 'invalid_proposal') === this.scope.jobId, 'invalid_proposal');
    return object(fromJSON(value), 'request');
  }
  private async decorate(response: Document): Promise<Document> {
    const value = JSON.parse(serialize(response));
    if (value.ok && value.result) {
      value.ownerWorkflow = 1;
      value.result.ownerScope = structuredClone(this.scope);
      value.result.evidenceKind = 'agent_attested';
      value.result.browserAuthority = 'existing_host_tools';
      value.result.finalSubmission = 'manual';
      if (this.application) value.result.applicationAuthority = {
        status: JSON.parse(serialize(await this.application.status())),
        evaluationArgs: ['owner-workflow','authority-evaluate'], demographics: 'leave_blank',
        statusIsPermission: false,
      };
      if (value.result.hostBrowser) {
        const progress = (value.result.guidance?.actions ?? []).find((action: {kind:string}) => action.kind === 'progress');
        value.result.hostBrowser.recovery = {
          state:value.result.recovery ?? null, args:['owner-workflow','recovery'],
          approvalRequiredFor:['fresh_draft','refresh_once'],
          input:progress ? {operationId:null, taskId:progress.input.taskId,
            expectedRevision:progress.input.expectedRevision, jobId:progress.input.jobId,
            jobRevision:progress.input.jobRevision, recoveryRevision:value.result.recovery?.revision ?? null,
            draftId:value.result.recovery?.draftId ?? null} : null,
          requiredFields:['operationId','mode','evidence'],
        };
        value.result.hostBrowser.reports = (value.result.guidance?.actions ?? [])
          .filter((action: {kind:string;input:{status?:string}}) => action.kind === 'progress'
            || action.kind === 'handoff' && ['needs_info', 'awaiting_review'].includes(action.input.status ?? ''))
          .map((action: {kind:string;input:Record<string,unknown>;requiredFields:string[]}) => {
            const {kind: _kind, status: _status, ...input} = action.input;
            return {args: ['owner-workflow', 'host-browser-report'], requiredFields: [...action.requiredFields],
              input: {...input, evidenceKind: 'agent_attested', outcome: action.kind === 'progress' ? 'progress' : action.input.status}};
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
