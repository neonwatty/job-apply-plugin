import { fromJSON, object, serialize } from '../../contracts/workspace/values.js';
import { browserBinding } from '../../contracts/workspace/browser-boundary.js';
import { exact, identifier, record, snapshot } from '../../harness/validation.js';
/** Dedicated discriminators prevent ordinary attempt/campaign clients bypassing this facade. */
export class BrowserWorkflowBroker {
    ports;
    failed;
    heartbeatMilliseconds;
    timer;
    constructor(ports, failed, heartbeatMilliseconds = 60_000) {
        this.ports = ports;
        this.failed = failed;
        this.heartbeatMilliseconds = heartbeatMilliseconds;
    }
    async acquire(request) {
        const result = await this.dispatch(request);
        this.timer = setInterval(() => { void this.ports.host.heartbeat().catch(this.failed); }, this.heartbeatMilliseconds);
        return result.response;
    }
    async dispatch(request) {
        const value = record(snapshot(JSON.parse(serialize(request))), 'invalid_proposal');
        let result;
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
    async close() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        await this.ports.host.close();
    }
}
