import { fromJSON, object, serialize } from '../../contracts/workspace/values.js';
import type { Document } from '../../contracts/workspace/values.js';
import { browserBinding } from '../../contracts/workspace/browser-boundary.js';
import { exact, identifier, record, snapshot } from '../../harness/validation.js';
import type { WorkflowBrowserHost } from './workflow-browser-host.js';

/** Dedicated discriminators prevent ordinary attempt/campaign clients bypassing this facade. */
export class BrowserWorkflowBroker {
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly ports: WorkflowBrowserHost, private readonly failed: () => void,
    private readonly heartbeatMilliseconds = 60_000) {}
  async acquire(request: Document): Promise<Document> {
    const result = await this.dispatch(request);
    this.timer = setInterval(() => { void this.ports.host.heartbeat().catch(this.failed); }, this.heartbeatMilliseconds);
    return result.response;
  }
  async dispatch(request: Document): Promise<{ response: Document; complete: boolean }> {
    const value = record(snapshot(JSON.parse(serialize(request)) as unknown), 'invalid_proposal');
    let result: unknown;
    switch (value.command) {
      case 'browser_context': {
        exact(value, ['command', ...(Object.hasOwn(value, 'jobId') ? ['jobId'] : [])], 'invalid_proposal');
        result = await this.ports.model.context(Object.hasOwn(value, 'jobId') ? identifier(value.jobId, 'invalid_proposal') : undefined);
        break;
      }
      case 'browser_event':
        exact(value, ['command', 'input'], 'invalid_proposal');
        result = await this.ports.model.event(value.input);
        break;
      case 'browser_observe':
        exact(value, ['command', 'input'], 'invalid_proposal');
        result = await this.ports.model.observe(browserBinding(value.input));
        break;
      case 'browser_execute':
        exact(value, ['command', 'input'], 'invalid_proposal');
        result = await this.ports.model.execute(value.input);
        break;
      case 'browser_reconcile': {
        exact(value, ['command', 'input'], 'invalid_proposal');
        const input = record(value.input, 'invalid_proposal');
        exact(input, ['binding', 'operationId'], 'invalid_proposal');
        result = await this.ports.model.reconcile(browserBinding(input.binding), identifier(input.operationId, 'invalid_proposal'));
        break;
      }
      default: throw new Error('invalid browser command');
    }
    return { response: object(fromJSON({ ok: true, result }), 'browser response'), complete: false };
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ports.host.close();
  }
}
