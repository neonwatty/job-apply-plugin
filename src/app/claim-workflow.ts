import { createHash, randomUUID } from 'node:crypto';
import { activeApplicationJob } from '../contracts/workspace/application-policy.js';
import { requireClaim } from '../contracts/workspace/claims.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { fromJSON, get, int, object, string, JobsError } from '../contracts/workspace/values.js';
import type { Value } from '../contracts/workspace/values.js';
import type { ClaimWorkflowDomain } from '../contracts/workspace/claim-workflow-domain.js';
import { TaskProtocolError, receiptLimit } from '../contracts/workspace/workflow-tasks.js';
import type { WorkflowTask, TaskOutcome } from '../contracts/workspace/workflow-tasks.js';
import type { WorkflowTaskStore } from '../harness/task-store.js';
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

/** Lives in the broker. No bearer enters the task ledger, response, or host proposal. */
export class ClaimWorkflow {
  #capability: Capability | null = null;
  #pending: Promise<unknown> = Promise.resolve();
  #closed = false;
  private readonly registry = attemptRegistry();
  constructor(private readonly store: WorkflowTaskStore<ClaimWorkflowDomain>,
    private readonly claims: Pick<ClaimsService, 'heartbeat'>,
    private readonly access: () => ProfileAccess,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#pending.then(operation);
    this.#pending = next.then(() => {}, () => {});
    return next;
  }
  /** The separate argument attests the exact host event; it is not human authentication. */
  execute(raw: unknown, hostEvent?: unknown) {
    const event = claimEvent(raw), digest = fingerprint(event);
    if (['acquire','restart','recover','cancel'].includes(event.kind)
      && (hostEvent === undefined || fingerprint(claimEvent(hostEvent)) !== digest)) {
      return Promise.reject(new TaskProtocolError('user_event_required'));
    }
    return this.serial(async () => {
      if (this.#closed) throw new TaskProtocolError('broker_unavailable');
      let acquired: Capability | null = null;
      const result = await runDurableOperation(this.store, {...event,fingerprint:digest}, {
        authorize: ledger => {
          if (event.taskId !== null) {
            const task = ledger.tasks[event.taskId];
            if (!task || task.workflow.id !== attemptIdentity.id || task.workflow.version !== attemptIdentity.version) {
              throw new TaskProtocolError('task_conflict');
            }
          }
          if (!safeExit(event)) this.registry.resolve(attemptIdentity, this.access());
          if (!Object.hasOwn(ledger.receipts, event.operationId) && !['handoff','cancel'].includes(event.kind)) {
            const remaining = receiptLimit - Object.keys(ledger.receipts).length;
            // Keep room for a handoff and, for routine work, one explicit broker-loss recovery.
            if (remaining < (event.kind === 'recover' ? 2 : 3)) throw new TaskProtocolError('history_full');
          }
        },
        execute: async (current, domain) => {
          if (current && current.subject.jobId !== event.jobId) throw new TaskProtocolError('task_conflict');
          const job = activeApplicationJob(domain.snapshot, event.jobId);
          if (current && current.subject.jobRevision !== event.jobRevision
            || int(get(job, 'revision'))!.toString() !== event.jobRevision) throw new TaskProtocolError('stale_revision');
          const scope = preparationScope(domain.snapshot, job);
          const continuesInputs = event.kind === 'progress' || event.kind === 'handoff' && !safeExit(event);
          if (current && continuesInputs && scope !== current.subject.inputRevision) throw new TaskProtocolError('stale_revision');
          const task: WorkflowTask = current ? {...current,revision:(BigInt(current.revision)+1n).toString()}
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
              event.session === undefined ? undefined : claimSessionInput(event.session),event.status);
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
      if (task && this.#capability?.taskId === task.taskId && !this.#closed) {
        try { requireClaim(tx.domain.snapshot.coordinator,tx.domain.snapshot.jobs,task.subject.jobId,this.#capability.token,this.now()); brokerAvailable = true; }
        catch (error) { if (!(error instanceof JobsError)) throw error; }
      }
      return {task:task ? structuredClone(task) : null,brokerAvailable,
        broker: { connected: !this.#closed, ownsClaim: brokerAvailable },
        guidance: await attemptGuidance(tx.domain.snapshot, tx.ledger, task, brokerAvailable, !this.#closed,
          this.access, this.now, requestedJobId)};
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
    return this.serial(async () => { this.#closed = true; this.#capability = null; });
  }
}
