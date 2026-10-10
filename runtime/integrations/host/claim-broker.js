import { fromJSON, object, serialize } from '../../contracts/workspace/values.js';
import { exact, identifier, record, requireCondition, snapshot } from '../../harness/validation.js';
export class WorkflowBroker {
    workflow;
    failed;
    heartbeatMilliseconds;
    timer;
    constructor(workflow, failed, heartbeatMilliseconds = 60_000) {
        this.workflow = workflow;
        this.failed = failed;
        this.heartbeatMilliseconds = heartbeatMilliseconds;
    }
    async acquire(request) {
        const result = await this.dispatch(request);
        this.timer = setInterval(() => {
            void this.workflow.heartbeat().catch(() => { this.failed(); });
        }, this.heartbeatMilliseconds);
        return result.response;
    }
    async dispatch(request) {
        const value = record(snapshot(JSON.parse(serialize(request))), 'invalid_proposal');
        if (value.command === 'context') {
            exact(value, ['command', ...(Object.hasOwn(value, 'jobId') ? ['jobId'] : [])], 'invalid_proposal');
            const jobId = Object.hasOwn(value, 'jobId') ? identifier(value.jobId, 'invalid_proposal') : undefined;
            return { response: object(fromJSON({ ok: true, result: await this.workflow.inspect(jobId) }), 'response'), complete: false };
        }
        exact(value, ['command', 'event', 'hostUserEvent'], 'invalid_proposal');
        requireCondition(value.command === 'event' && typeof value.hostUserEvent === 'boolean', 'invalid_proposal');
        const result = await this.workflow.execute(value.event, value.hostUserEvent ? value.event : undefined);
        return { response: object(fromJSON({ ok: true, result }), 'response'), complete: false };
    }
    async close() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        await this.workflow.close();
    }
}
