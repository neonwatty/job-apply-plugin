/** Schemas must return validated values or throw; their errors are redacted at the boundary. */
export interface Schema<T> { parse(value: unknown): T }

export interface WorkflowIdentity {
  readonly id: string;
  readonly version: number;
}

export interface WorkflowRegistration extends WorkflowIdentity {
  readonly routeDescription: string;
  readonly requiredProfiles: readonly string[];
  readonly startInputSchema: Schema<unknown>;
  readonly userEventSchema: Schema<unknown>;
}

export interface ExecutionLimits {
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  /** Absolute nesting depth for a run whose root is depth zero. */
  readonly maxChildDepth: number;
}

/** Registration describes argument contracts. Execution handlers belong to the future gateway. */
export interface ToolRegistration {
  readonly id: string;
  readonly inputSchema: Schema<unknown>;
}

export interface ExecutionProfile {
  readonly id: string;
  readonly tools: readonly ToolRegistration[];
  readonly limits: ExecutionLimits;
}

/** Supplied by trusted dispatch, never taken from a model proposal. */
export interface ProfileAccess {
  readonly enabled: readonly string[];
  readonly authorized: readonly string[];
}

export type AllowedAction =
  | { readonly kind: 'callTool'; readonly id: string; readonly toolId: string }
  | { readonly kind: 'invokeWorkflow'; readonly id: string; readonly workflow: WorkflowIdentity }
  | { readonly kind: 'askUser'; readonly id: string; readonly questionId: string }
  | { readonly kind: 'finish'; readonly id: string };

export type WorkflowEvent<UserEvent, ToolEvent, ChildOutcome> =
  | { readonly kind: 'user'; readonly value: UserEvent }
  | { readonly kind: 'tool'; readonly actionId: string; readonly value: ToolEvent }
  | { readonly kind: 'child'; readonly actionId: string; readonly value: ChildOutcome };

/** Domain code owns state. Host proposals cannot supply the state or transition it directly. */
export interface WorkflowDefinition<State, Input, UserEvent, ToolEvent, ChildOutcome, Context>
  extends WorkflowRegistration {
  readonly startInputSchema: Schema<Input>;
  readonly userEventSchema: Schema<UserEvent>;
  start(input: Input, context: Context): State;
  allowedActions(state: State, context: Context): readonly AllowedAction[];
  transition(state: State, event: WorkflowEvent<UserEvent, ToolEvent, ChildOutcome>, context: Context): State;
  isComplete(state: State): boolean;
  isTerminal(state: State): boolean;
}

export interface ActiveTask {
  readonly taskId: string;
  readonly revision: string;
  readonly workflow: WorkflowIdentity;
  /** False while a safe handoff or claim release is still required. */
  readonly canLeave: boolean;
}

/** A fresh projection from canonical state, not a durable duplicate of that state. */
export interface ActionContext extends ActiveTask {
  readonly allowedActions: readonly AllowedAction[];
  readonly complete: boolean;
  readonly terminal: boolean;
  readonly childDepth: number;
}

interface ProposalTarget {
  readonly operationId: string;
  readonly taskId: string;
  /** Decimal text preserves exact revisions beyond JavaScript's safe integer range. */
  readonly expectedRevision: string;
}

export type ActionProposal = ProposalTarget & (
  | { readonly kind: 'callTool'; readonly actionId: string; readonly arguments: unknown }
  | { readonly kind: 'invokeWorkflow'; readonly actionId: string; readonly input: unknown }
  | { readonly kind: 'askUser'; readonly actionId: string }
  | { readonly kind: 'finish'; readonly actionId: string }
);

interface RouteTarget {
  readonly operationId: string;
  readonly taskId: string | null;
  readonly expectedRevision: string | null;
}

export type RouteProposal = RouteTarget & (
  | { readonly kind: 'newTask' | 'change'; readonly workflow: WorkflowIdentity; readonly input: unknown }
  | { readonly kind: 'continue'; readonly event: unknown }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'clarify'; readonly questionId: string }
);

export type WorkflowErrorCode = 'invalid_proposal' | 'invalid_registration' | 'workflow_unavailable'
  | 'profile_unavailable' | 'task_conflict' | 'stale_revision' | 'handoff_required'
  | 'action_unavailable' | 'invalid_arguments' | 'invalid_event' | 'finish_not_allowed' | 'child_limit';

/** Never include model arguments, applicant values, schema diagnostics, or causes in public errors. */
export class WorkflowError extends Error {
  constructor(readonly code: WorkflowErrorCode) { super(code); this.name = 'WorkflowError'; }
}
