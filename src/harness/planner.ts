import type { ActionContext, ActionProposal, AllowedAction, ProfileAccess } from './contracts.js';
import type { WorkflowRegistry } from './registry.js';
import { parseActionProposal } from './proposals.js';
import { parseSchema, requireCondition } from './validation.js';

export interface ValidatedAction {
  readonly proposal: ActionProposal;
  readonly action: AllowedAction;
  /** Schema-decoded tool arguments or child input; never a tool result. */
  readonly input: unknown;
}

/** Validation is not an execution permit: the gateway must recheck current state at mutation time. */
export function validateAction(raw: unknown, context: ActionContext, registry: WorkflowRegistry, access: ProfileAccess): ValidatedAction {
  const proposal = parseActionProposal(raw);
  requireCondition(proposal.taskId === context.taskId, 'task_conflict');
  requireCondition(proposal.expectedRevision === context.revision, 'stale_revision');
  const workflow = registry.resolve(context.workflow, access);
  requireCondition(new Set(context.allowedActions.map(action => action.id)).size === context.allowedActions.length,
    'action_unavailable');
  const action = context.allowedActions.find(candidate => candidate.id === proposal.actionId);
  requireCondition(action && action.kind === proposal.kind, 'action_unavailable');
  let input: unknown = null;
  let selected: AllowedAction;
  switch (action.kind) {
    case 'callTool': {
      requireCondition(proposal.kind === 'callTool', 'action_unavailable');
      const tool = registry.tool(context.workflow, action.toolId, access);
      input = parseSchema(tool.inputSchema, proposal.arguments, 'invalid_arguments');
      selected = Object.freeze({ ...action });
      break;
    }
    case 'invokeWorkflow': {
      requireCondition(proposal.kind === 'invokeWorkflow', 'action_unavailable');
      const child = registry.resolve(action.workflow, access);
      requireCondition(child.requiredProfiles.every(profile => workflow.requiredProfiles.includes(profile)), 'profile_unavailable');
      const maxDepth = Math.min(registry.limits(context.workflow, access).maxChildDepth,
        registry.limits(action.workflow, access).maxChildDepth);
      requireCondition(Number.isSafeInteger(context.childDepth) && context.childDepth >= 0 && context.childDepth < maxDepth,
        'child_limit');
      input = parseSchema(child.startInputSchema, proposal.input, 'invalid_arguments');
      selected = Object.freeze({ ...action, workflow: Object.freeze({ ...action.workflow }) });
      break;
    }
    case 'finish':
      requireCondition(context.complete || context.terminal, 'finish_not_allowed');
      selected = Object.freeze({ ...action });
      break;
    case 'askUser':
      selected = Object.freeze({ ...action });
      break;
  }
  return Object.freeze({ proposal, action: selected, input });
}
