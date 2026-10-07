import type { ActiveTask, ProfileAccess, RouteProposal } from './contracts.js';
import type { WorkflowRegistry } from './registry.js';
import { parseRouteProposal } from './proposals.js';
import { parseSchema, requireCondition } from './validation.js';

export interface RouteContext {
  readonly activeTask: ActiveTask | null;
  readonly clarificationIds: readonly string[];
}

/** Validate only. Applying user events, safe handoff, and persistence belong to the app layer. */
export function validateRoute(raw: unknown, context: RouteContext, registry: WorkflowRegistry, access: ProfileAccess): RouteProposal {
  const proposal = parseRouteProposal(raw), active = context.activeTask;
  requireCondition(proposal.taskId === (active?.taskId ?? null), 'task_conflict');
  requireCondition(proposal.expectedRevision === (active?.revision ?? null), 'stale_revision');
  if (active) registry.resolve(active.workflow, access);
  switch (proposal.kind) {
    case 'newTask':
    case 'change': {
      requireCondition(!active || active.canLeave, 'handoff_required');
      const workflow = registry.resolve(proposal.workflow, access);
      const input = parseSchema(workflow.startInputSchema, proposal.input, 'invalid_arguments');
      return Object.freeze({ ...proposal, input });
    }
    case 'continue': {
      requireCondition(active, 'task_conflict');
      const workflow = registry.resolve(active.workflow, access);
      const event = parseSchema(workflow.userEventSchema, proposal.event, 'invalid_event');
      return Object.freeze({ ...proposal, event });
    }
    case 'cancel':
      requireCondition(active?.canLeave, 'handoff_required');
      return proposal;
    case 'clarify':
      requireCondition(context.clarificationIds.includes(proposal.questionId), 'action_unavailable');
      return proposal;
  }
}
