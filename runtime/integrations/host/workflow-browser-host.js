import { browserBinding, browserMutation, sameBinding } from '../../contracts/workspace/browser-boundary.js';
import { TaskProtocolError } from '../../contracts/workspace/workflow-tasks.js';
import { createUserEventAuthority } from '../../harness/user-events.js';
import { DurableBrowserBoundary } from '../browser/durable-boundary.js';
import { createBrowserAuthority } from './browser-authority.js';
/** In-process ports must be kept separate by the embedding. This does not authenticate humans. */
export function createWorkflowBrowserHost(options) {
    const { approvals, verifier } = createUserEventAuthority();
    const workflow = options.createWorkflow(verifier);
    const authority = createBrowserAuthority(workflow, options.grants, options.controls);
    let current;
    let closed = false, pending = Promise.resolve();
    const serial = (operation) => {
        const result = pending.then(() => {
            if (closed)
                throw new TaskProtocolError('broker_unavailable');
            return operation();
        });
        pending = result.then(() => { }, () => { });
        return result;
    };
    const boundary = (raw) => {
        const binding = browserBinding(raw);
        if (!current || !sameBinding(current.binding, binding))
            current = { binding,
                browser: new DurableBrowserBoundary(options.adapter, authority, binding, options.operations) };
        return current.browser;
    };
    const model = Object.freeze({
        context: (jobId) => serial(async () => {
            const context = await workflow.inspect(jobId);
            for (const action of context.guidance.actions)
                action.args = action.args.map(arg => arg === 'attempt' ? 'browser' : arg);
            return { ...context, ...(options.recovery ? { browserRecovery: await options.recovery() } : {}) };
        }),
        // No host-event argument: a model cannot turn its own statement into a user event.
        event: (raw) => serial(() => workflow.execute(raw)),
        observe: (raw) => {
            const binding = browserBinding(raw);
            return serial(() => boundary(binding).observe());
        },
        execute: (raw) => {
            const request = browserMutation(raw), { taskId, taskRevision, jobId, attemptRevision, authorizationRevision } = request.scope;
            const binding = { taskId, taskRevision, jobId, attemptRevision, authorizationRevision };
            return serial(() => boundary(binding).execute(authority.bind(request)));
        },
        reconcile: (raw, operationId) => {
            const binding = browserBinding(raw);
            return serial(() => boundary(binding).reconcile(operationId));
        },
    });
    const host = Object.freeze({
        approvals,
        review: (raw) => serial(() => workflow.reviewUserEvent(raw)),
        heartbeat: () => serial(() => workflow.heartbeat()),
        async close() {
            closed = true;
            approvals.close();
            await pending;
            current = undefined;
            await workflow.close();
        },
    });
    return Object.freeze({ model, host });
}
/** Fixture-only executable host. The caller retains approval methods outside model transport. */
export function createTrustedBrowserWorkflowHost(root, nativeLock, adapter, grants, options) {
    let started = false, active;
    const requireHost = () => {
        if (!active)
            throw new TaskProtocolError('broker_unavailable');
        return active;
    };
    return Object.freeze({
        async run() {
            if (started)
                throw new TaskProtocolError('broker_unavailable');
            started = true;
            const { experimentalBrowserWorkflow } = await import('../../cli/experimental-browser-workflow.js');
            try {
                return await experimentalBrowserWorkflow(['serve', '--root', root, '--native-lock', nativeLock], { adapter, grants, ...options, ready: host => { active = host; } });
            }
            finally {
                active = undefined;
            }
        },
        review: (raw) => requireHost().review(raw),
        approvals: Object.freeze({
            approve: (binding, lifetime) => requireHost().approvals.approve(binding, lifetime),
            revoke: (id) => requireHost().approvals.revoke(id),
            close: () => requireHost().approvals.close(),
        }),
    });
}
