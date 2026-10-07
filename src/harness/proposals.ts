import type { ActionProposal, RouteProposal, WorkflowIdentity } from './contracts.js';
import { WorkflowError } from './contracts.js';
import { exact, identifier, record, requireCondition, revision, snapshot, version } from './validation.js';

export function parseWorkflowIdentity(value: unknown): WorkflowIdentity {
  const input = record(value, 'invalid_proposal');
  exact(input, ['id', 'version'], 'invalid_proposal');
  return Object.freeze({ id: identifier(input.id, 'invalid_proposal'), version: version(input.version, 'invalid_proposal') });
}

/** Proposals carry references and input only. Tool IDs, state, grants and outcomes are code-owned. */
export function parseActionProposal(value: unknown): ActionProposal {
  const input = record(snapshot(value), 'invalid_proposal');
  const common = ['kind', 'operationId', 'taskId', 'expectedRevision', 'actionId'];
  const target = {
    operationId: identifier(input.operationId, 'invalid_proposal'),
    taskId: identifier(input.taskId, 'invalid_proposal'),
    expectedRevision: revision(input.expectedRevision, 'invalid_proposal'),
    actionId: identifier(input.actionId, 'invalid_proposal'),
  };
  switch (input.kind) {
    case 'callTool':
      exact(input, [...common, 'arguments'], 'invalid_proposal');
      return Object.freeze({ ...target, kind: input.kind, arguments: input.arguments });
    case 'invokeWorkflow':
      exact(input, [...common, 'input'], 'invalid_proposal');
      return Object.freeze({ ...target, kind: input.kind, input: input.input });
    case 'askUser':
    case 'finish':
      exact(input, common, 'invalid_proposal');
      return Object.freeze({ ...target, kind: input.kind });
    default: throw new WorkflowError('invalid_proposal');
  }
}

export function parseRouteProposal(value: unknown): RouteProposal {
  const input = record(snapshot(value), 'invalid_proposal');
  const common = ['kind', 'operationId', 'taskId', 'expectedRevision'];
  const target = {
    operationId: identifier(input.operationId, 'invalid_proposal'),
    taskId: input.taskId === null ? null : identifier(input.taskId, 'invalid_proposal'),
    expectedRevision: input.expectedRevision === null ? null : revision(input.expectedRevision, 'invalid_proposal'),
  };
  requireCondition((target.taskId === null) === (target.expectedRevision === null), 'invalid_proposal');
  switch (input.kind) {
    case 'newTask':
    case 'change':
      exact(input, [...common, 'workflow', 'input'], 'invalid_proposal');
      requireCondition(input.kind === 'newTask' ? target.taskId === null : target.taskId !== null, 'invalid_proposal');
      return Object.freeze({ ...target, kind: input.kind, workflow: parseWorkflowIdentity(input.workflow), input: input.input });
    case 'continue':
      exact(input, [...common, 'event'], 'invalid_proposal');
      requireCondition(target.taskId !== null, 'invalid_proposal');
      return Object.freeze({ ...target, kind: input.kind, event: input.event });
    case 'cancel':
      exact(input, common, 'invalid_proposal');
      requireCondition(target.taskId !== null, 'invalid_proposal');
      return Object.freeze({ ...target, kind: input.kind });
    case 'clarify':
      exact(input, [...common, 'questionId'], 'invalid_proposal');
      return Object.freeze({ ...target, kind: input.kind, questionId: identifier(input.questionId, 'invalid_proposal') });
    default: throw new WorkflowError('invalid_proposal');
  }
}
