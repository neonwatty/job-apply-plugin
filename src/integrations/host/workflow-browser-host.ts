import type { ClaimWorkflow } from '../../app/claim-workflow.js';
import type { browserRecoveryGuidance } from '../../app/browser-recovery-guidance.js';
import { browserBinding, browserMutation, sameBinding } from '../../contracts/workspace/browser-boundary.js';
import type { BrowserAdapter, BrowserBinding } from '../../contracts/workspace/browser-boundary.js';
import type { BrowserValueGrant } from '../../contracts/workspace/browser-authority.js';
import { TaskProtocolError } from '../../contracts/workspace/workflow-tasks.js';
import { createUserEventAuthority } from '../../harness/user-events.js';
import type { UserEventBinding, UserEventVerifier } from '../../harness/user-events.js';
import { DurableBrowserBoundary } from '../browser/durable-boundary.js';
import type { BrowserOperationStore } from '../browser/durable-contract.js';
import { createBrowserAuthority } from './browser-authority.js';
import type { WorkflowBrowserAuthorityPort } from './browser-authority.js';

type Workflow = Pick<ClaimWorkflow, 'inspect' | 'execute' | 'reviewUserEvent' | 'heartbeat' | 'close'>
  & WorkflowBrowserAuthorityPort;
export interface WorkflowBrowserHostOptions {
  createWorkflow(verifier: UserEventVerifier): Workflow;
  adapter: BrowserAdapter;
  operations: BrowserOperationStore;
  grants: ReadonlyMap<string, BrowserValueGrant>;
  controls: ReadonlyMap<string, string>;
  recovery?: () => Promise<ReturnType<typeof browserRecoveryGuidance>>;
}

/** In-process ports must be kept separate by the embedding. This does not authenticate humans. */
export function createWorkflowBrowserHost(options: WorkflowBrowserHostOptions) {
  const { approvals, verifier } = createUserEventAuthority();
  const workflow = options.createWorkflow(verifier);
  const authority = createBrowserAuthority(workflow, options.grants, options.controls);
  let current: { binding: BrowserBinding; browser: DurableBrowserBoundary } | undefined;
  let closed = false, pending: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(() => {
      if (closed) throw new TaskProtocolError('broker_unavailable');
      return operation();
    });
    pending = result.then(() => {}, () => {});
    return result;
  };
  const boundary = (raw: BrowserBinding) => {
    const binding = browserBinding(raw);
    if (!current || !sameBinding(current.binding, binding)) current = { binding,
      browser: new DurableBrowserBoundary(options.adapter, authority, binding, options.operations) };
    return current.browser;
  };
  const model = Object.freeze({
    context: (jobId?: string) => serial(async () => {
      const context = await workflow.inspect(jobId);
      for (const action of context.guidance.actions) action.args = action.args.map(arg => arg === 'attempt' ? 'browser' : arg);
      return { ...context, ...(options.recovery ? { browserRecovery: await options.recovery() } : {}) };
    }),
    // No host-event argument: a model cannot turn its own statement into a user event.
    event: (raw: unknown) => serial(() => workflow.execute(raw)),
    observe: (raw: BrowserBinding) => {
      const binding = browserBinding(raw);
      return serial(() => boundary(binding).observe());
    },
    execute: (raw: unknown) => {
      const request = browserMutation(raw), { taskId, taskRevision, jobId, attemptRevision, authorizationRevision } = request.scope;
      const binding = { taskId, taskRevision, jobId, attemptRevision, authorizationRevision };
      return serial(() => boundary(binding).execute(request));
    },
    reconcile: (raw: BrowserBinding, operationId: string) => {
      const binding = browserBinding(raw);
      return serial(() => boundary(binding).reconcile(operationId));
    },
  });
  const host = Object.freeze({
    approvals,
    review: (raw: unknown) => serial(() => workflow.reviewUserEvent(raw)),
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

export type WorkflowBrowserHost = ReturnType<typeof createWorkflowBrowserHost>;

/** Fixture-only executable host. The caller retains approval methods outside model transport. */
export function createTrustedBrowserWorkflowHost(root: string, nativeLock: string, adapter: BrowserAdapter,
  grants: ReadonlyMap<string, BrowserValueGrant>, options: { controls: ReadonlyMap<string, string>; now?: () => string }) {
  let started = false, active: WorkflowBrowserHost['host'] | undefined;
  const requireHost = () => {
    if (!active) throw new TaskProtocolError('broker_unavailable');
    return active;
  };
  return Object.freeze({
    async run(): Promise<unknown> {
      if (started) throw new TaskProtocolError('broker_unavailable');
      started = true;
      const { experimentalBrowserWorkflow } = await import('../../cli/experimental-browser-workflow.js');
      try {
        return await experimentalBrowserWorkflow(['serve', '--root', root, '--native-lock', nativeLock],
          { adapter, grants, ...options, ready: host => { active = host; } });
      } finally { active = undefined; }
    },
    review: (raw: unknown) => requireHost().review(raw),
    approvals: Object.freeze({
      approve: (binding: UserEventBinding, lifetime: number) =>
        requireHost().approvals.approve(binding, lifetime),
      revoke: (id: string) => requireHost().approvals.revoke(id),
      close: () => requireHost().approvals.close(),
    }),
  });
}
