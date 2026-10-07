import { validateAction } from './planner.js';
import type { ActionContext, ProfileAccess } from './contracts.js';
import type { WorkflowRegistry } from './registry.js';
import { requireCondition } from './validation.js';

/** Invoke only inside the transaction staging both the domain effect and durable receipt.
 * Handlers remain responsible for rechecking canonical domain guards before staging a write.
 */
export async function executeWorkflowTool<Result>(raw: unknown, context: ActionContext,
  registry: WorkflowRegistry, access: ProfileAccess,
  handlers: ReadonlyMap<string, (input: unknown) => Promise<Result>>): Promise<Result> {
  const validated = validateAction(raw, context, registry, access);
  requireCondition(validated.action.kind === 'callTool', 'action_unavailable');
  requireCondition(registry.limits(context.workflow, access).maxToolCalls >= 1, 'action_unavailable');
  const handler = handlers.get(validated.action.toolId);
  requireCondition(handler, 'action_unavailable');
  return handler(validated.input);
}
