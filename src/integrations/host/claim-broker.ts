import type { ClaimWorkflow } from '../../app/claim-workflow.js';
import { fromJSON, object, serialize } from '../../contracts/workspace/values.js';
import type { Document } from '../../contracts/workspace/values.js';
import { exact, identifier, record, requireCondition, snapshot } from '../../harness/validation.js';

/** Adapter for the existing private broker transport. The bearer stays inside ClaimWorkflow. */
export type ClaimWorkflowBrokerPort = Pick<ClaimWorkflow, 'inspect' | 'execute' | 'heartbeat' | 'close'>;
export class WorkflowBroker {
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly workflow: ClaimWorkflowBrokerPort, private readonly failed: () => void,
    private readonly heartbeatMilliseconds = 60_000) {}
  async acquire(request: Document): Promise<Document> {
    const result = await this.dispatch(request);
    this.timer = setInterval(() => {
      void this.workflow.heartbeat().catch(() => { this.failed(); });
    }, this.heartbeatMilliseconds);
    return result.response;
  }
  async dispatch(request: Document): Promise<{response:Document;complete:boolean}> {
    const value = record(snapshot(JSON.parse(serialize(request)) as unknown), 'invalid_proposal');
    if (value.command === 'context') {
      exact(value,['command', ...(Object.hasOwn(value, 'jobId') ? ['jobId'] : [])],'invalid_proposal');
      const jobId = Object.hasOwn(value, 'jobId') ? identifier(value.jobId, 'invalid_proposal') : undefined;
      return {response:object(fromJSON({ok:true,result:await this.workflow.inspect(jobId)}),'response'),complete:false};
    }
    exact(value,['command','event','hostUserEvent'],'invalid_proposal');
    requireCondition(value.command === 'event' && typeof value.hostUserEvent === 'boolean','invalid_proposal');
    const result = await this.workflow.execute(value.event,value.hostUserEvent ? value.event : undefined);
    return {response:object(fromJSON({ok:true,result}),'response'),complete:false};
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.workflow.close();
  }
}
