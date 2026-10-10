import { createHash, randomUUID } from 'node:crypto';
import { activeApplicationJob } from '../contracts/workspace/application-policy.js';
import { requireClaim } from '../contracts/workspace/claims.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { fromJSON, get, int, object, string, JobsError } from '../contracts/workspace/values.js';
import type { Value } from '../contracts/workspace/values.js';
import type { ClaimWorkflowDomain } from '../contracts/workspace/claim-workflow-domain.js';
import { isJobWorkflowTask, TaskProtocolError, receiptLimit } from '../contracts/workspace/workflow-tasks.js';
import type { WorkflowTask, JobWorkflowTask, TaskOutcome } from '../contracts/workspace/workflow-tasks.js';
import { workflowHistory } from '../harness/task-store.js';
import type { WorkflowTaskStore } from '../harness/task-store.js';
import type { UserEventBinding, UserEventVerifier } from '../harness/user-events.js';
import type { ProfileAccess } from '../harness/contracts.js';
import type { ClaimsService } from '../workspace-core/claims.js';
import { runDurableOperation } from '../harness/run.js';
import { executeWorkflowTool } from '../harness/tool-gateway.js';
import { attemptIdentity, attemptProfile, attemptRegistry, claimEvent, safeExit } from '../workflows/applications/attempt.js';
import { claimSessionInput } from '../workflows/applications/attempt-session.js';
import { attemptGuidance } from './attempt-guidance.js';
import { identifier } from '../harness/validation.js';
import { preparationScope } from '../workflows/applications/prepare-scope.js';
const fingerprint = (value: unknown): string => createHash('sha256').update(canonicalJson(fromJSON(value))).digest('hex');
interface Capability {taskId:string; jobId:string; token:Value}
const needsUserEvent = (kind: string) => ['acquire','restart','recover','cancel'].includes(kind);
function requireAttemptTask(task: WorkflowTask): asserts task is JobWorkflowTask {
  if (!isJobWorkflowTask(task) || task.workflow.id !== attemptIdentity.id || task.workflow.version !== attemptIdentity.version) {
    throw new TaskProtocolError('task_conflict');
  }
}

/** Lives in the broker. No bearer enters the task ledger, response, or host proposal. */
export class ClaimWorkflow {
  #capability: Capability | null = null;
  #pending: Promise<unknown> = Promise.resolve();
  #closed = false;
  private readonly registry = attemptRegistry();
  constructor(private readonly store: WorkflowTaskStore<ClaimWorkflowDomain>,
    private readonly claims: Pick<ClaimsService, 'heartbeat'>,
    private readonly access: () => ProfileAccess,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    private readonly userEvents?: UserEventVerifier) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#pending.then(operation);
    this.#pending = next.then(() => {}, () => {});
    return next;
  }
  /** Read-only review for a trusted host. The returned binding alone grants no authority. */
  reviewUserEvent(raw: unknown) {
    const event = claimEvent(raw), digest = fingerprint(event);
    if (!needsUserEvent(event.kind)) throw new TaskProtocolError('action_unavailable');
    return this.serial(() => this.store.transaction(async tx => {
      if (this.#closed) throw new TaskProtocolError('broker_unavailable');
      const history = workflowHistory(tx), prior = history.receipt(event.operationId);
      if (prior) {
        if (prior.fingerprint !== digest) throw new TaskProtocolError('operation_conflict');
        requireAttemptTask(prior.receipt.task);
        // Historical retries use the accepted scope, even after the job is archived.
        return { event, binding: { eventFingerprint: digest, inputRevision: prior.receipt.task.subject.inputRevision } };
      }
      const task = event.taskId === null ? null : history.task(event.taskId);
      if (task) requireAttemptTask(task);
      if (event.taskId === null ? tx.ledger.activeTaskId !== null
        : !task || tx.ledger.activeTaskId !== event.taskId || task.revision !== event.expectedRevision
          || task.subject.jobId !== event.jobId || task.subject.jobRevision !== event.jobRevision) {
        throw new TaskProtocolError('task_conflict');
      }
      const job = activeApplicationJob(tx.domain.snapshot, event.jobId);
      if (int(get(job, 'revision'))!.toString() !== event.jobRevision) throw new TaskProtocolError('stale_revision');
      return { event, binding: { eventFingerprint: digest,
        inputRevision: task?.subject.inputRevision ?? preparationScope(tx.domain.snapshot, job) } };
    }));
  }
  /** Legacy attestation is ignored when a trusted-host verifier is composed into this instance. */
  execute(raw: unknown, hostEvent?: unknown) {
    const event = claimEvent(raw), digest = fingerprint(event);
    if (!this.userEvents && needsUserEvent(event.kind)
      && (hostEvent === undefined || fingerprint(claimEvent(hostEvent)) !== digest)) {
      return Promise.reject(new TaskProtocolError('user_event_required'));
    }
    return this.serial(async () => {
      if (this.#closed) throw new TaskProtocolError('broker_unavailable');
      let acquired: Capability | null = null;
      let binding: UserEventBinding | undefined;
      const requireApproval = () => {
        if (this.userEvents && needsUserEvent(event.kind)) {
          if (!binding) throw new TaskProtocolError('user_event_required');
          this.userEvents.require(binding);
        }
      };
      const guardedStore: WorkflowTaskStore<ClaimWorkflowDomain> = {
        transaction: callback => this.store.transaction(tx => callback({ ...tx,
          // Linearize approval immediately before the canonical commit begins.
          commit: next => { requireApproval(); return tx.commit(next); },
        })),
      };
      const result = await runDurableOperation(guardedStore, {...event,fingerprint:digest}, {
        authorize: (ledger, history) => {
          const prior = history.receipt(event.operationId);
          if (prior) {
            if (prior.fingerprint !== digest) throw new TaskProtocolError('operation_conflict');
            requireAttemptTask(prior.receipt.task);
            binding = { eventFingerprint: digest, inputRevision: prior.receipt.task.subject.inputRevision };
            requireApproval();
          }
          if (event.taskId !== null) {
            const task = history.task(event.taskId);
            if (!task) throw new TaskProtocolError('task_conflict');
            requireAttemptTask(task);
          }
          if (!safeExit(event)) this.registry.resolve(attemptIdentity, this.access());
          if (!prior && !['handoff','cancel'].includes(event.kind)) {
            const remaining = receiptLimit - Object.keys(ledger.receipts).length;
            // Keep room for a handoff and, for routine work, one explicit broker-loss recovery.
            if (remaining < (event.kind === 'recover' ? 2 : 3)) throw new TaskProtocolError('history_full');
          }
        },
        execute: async (current, domain) => {
          if (current) requireAttemptTask(current);
          if (current && current.subject.jobId !== event.jobId) throw new TaskProtocolError('task_conflict');
          const job = activeApplicationJob(domain.snapshot, event.jobId);
          if (current && current.subject.jobRevision !== event.jobRevision
            || int(get(job, 'revision'))!.toString() !== event.jobRevision) throw new TaskProtocolError('stale_revision');
          const scope = preparationScope(domain.snapshot, job);
          binding = { eventFingerprint: digest, inputRevision: current?.subject.inputRevision ?? scope };
          requireApproval();
          const continuesInputs = event.kind === 'progress' || event.kind === 'handoff' && !safeExit(event);
          if (current && continuesInputs && scope !== current.subject.inputRevision) throw new TaskProtocolError('stale_revision');
          const task: JobWorkflowTask = current ? {...current,revision:(BigInt(current.revision)+1n).toString()}
            : {taskId:randomUUID(),workflow:attemptIdentity,revision:'1',status:'active',pending:null,
              subject:{jobId:event.jobId,jobRevision:event.jobRevision,inputRevision:scope}};
          const needsToken = ['progress','handoff','cancel'].includes(event.kind);
          const capability = this.#capability;
          if (needsToken && (!capability || capability.taskId !== task.taskId || capability.jobId !== event.jobId)) {
            throw new TaskProtocolError('broker_unavailable');
          }
          const tool = `application.${event.kind}`;
          // Revocation must still permit a guarded needs-info handoff and claim release.
          const access = safeExit(event) ? {enabled:[attemptProfile],authorized:[attemptProfile]} : this.access();
          let value: Value = null;
          await executeWorkflowTool({kind:'callTool',operationId:event.operationId,taskId:task.taskId,
            expectedRevision:current?.revision ?? task.revision,actionId:tool,arguments:event},
          {taskId:task.taskId,revision:current?.revision ?? task.revision,workflow:attemptIdentity,canLeave:false,
            allowedActions:[{kind:'callTool',id:tool,toolId:tool}],complete:false,terminal:false,childDepth:0},
          this.registry, access, new Map([[tool, async () => {
            value = await domain.execute(event.kind,event.jobId,BigInt(event.jobRevision),capability?.token ?? null,
              event.session === undefined ? undefined : claimSessionInput(event.session),event.status,event.savedSessionFingerprint);
          }]]));
          if (!safeExit(event)) this.registry.resolve(attemptIdentity, this.access());
          const output = object(value, 'claim result');
          const terminal = event.kind === 'handoff' || event.kind === 'cancel';
          const revision = event.kind === 'progress' ? event.jobRevision : int(get(object(get(output, 'job'), 'job'), 'revision'))!.toString();
          if (['acquire','restart','recover'].includes(event.kind)) {
            const token = get(output, 'token');
            if (string(token) === null) throw new TaskProtocolError('invalid_task_state');
            acquired = {taskId:task.taskId,jobId:event.jobId,token};
          }
          const outcome: TaskOutcome = event.kind === 'cancel' ? 'cancelled' : event.kind === 'handoff' ? event.status!
            : event.kind === 'progress' ? 'progress_saved' : event.kind === 'recover' ? 'claim_recovered' : 'claim_acquired';
          // Recovery restores the claim capability; only a new task may bind new inputs.
          return {task:{...task,status:terminal ? event.kind === 'cancel' ? 'cancelled' : 'finished' : 'active',pending:null,
            subject:{jobId:event.jobId,jobRevision:revision,inputRevision:task.subject.inputRevision}},outcome};
        },
      });
      if (!result.replayed && acquired) this.#capability = acquired;
      // A committed terminal operation may have lost its response. Retire only its own
      // capability on replay; historical receipts must not clear a newer attempt.
      if (['finished','cancelled'].includes(result.receipt.task.status)
        && this.#capability?.taskId === result.receipt.task.taskId) this.#capability = null;
      return result;
    });
  }
  inspect(requestedJobId?: string) {
    if (requestedJobId !== undefined) identifier(requestedJobId, 'invalid_arguments');
    return this.serial(() => this.store.transaction(async tx => {
      const task = tx.ledger.activeTaskId === null ? null : tx.ledger.tasks[tx.ledger.activeTaskId]!;
      let brokerAvailable = false;
      if (task && isJobWorkflowTask(task) && this.#capability?.taskId === task.taskId && !this.#closed) {
        try { requireClaim(tx.domain.snapshot.coordinator,tx.domain.snapshot.jobs,task.subject.jobId,this.#capability.token,this.now()); brokerAvailable = true; }
        catch (error) { if (!(error instanceof JobsError)) throw error; }
      }
      const guidance = await attemptGuidance(tx.domain.snapshot, tx.ledger, task, brokerAvailable, !this.#closed,
        this.access, this.now, requestedJobId);
      if (this.userEvents) for (const action of guidance.actions) action.args = action.args.filter(arg => arg !== '--host-user-event');
      return {task:task ? structuredClone(task) : null,brokerAvailable,
        broker: { connected: !this.#closed, ownsClaim: brokerAvailable },
        ...(this.userEvents ? { userEventSource: 'trusted_host' as const } : {}), guidance };
    }));
  }
  heartbeat(): Promise<void> {
    return this.serial(async () => {
      if (this.#closed || !this.#capability) return;
      try { await this.claims.heartbeat(this.#capability.jobId,this.#capability.token); }
      catch (error) { this.#capability = null; throw error; }
    });
  }
  close(): Promise<void> {
    this.userEvents?.close();
    return this.serial(async () => { this.#closed = true; this.#capability = null; });
  }
}
