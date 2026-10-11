import type { ClaimWorkflow } from './claim-workflow.js';

/** Advisory host-tool projection from current canonical guidance, never a browser grant. */
export function hostBrowserGuidance(context: Awaited<ReturnType<ClaimWorkflow['inspect']>>) {
  const owned = context.broker.connected && context.broker.ownsClaim;
  const progress = owned && context.guidance.actions.some(action => action.kind === 'progress');
  const handoff = owned && context.guidance.actions.some(action => action.kind === 'handoff'
    && action.input.status === 'needs_info');
  const reportOutcomes: ('progress' | 'needs_info')[] = [];
  if (progress) reportOutcomes.push('progress');
  if (handoff) reportOutcomes.push('needs_info');
  return { toolSource: 'host_existing' as const, evidenceKind: 'agent_attested' as const,
    nextStep: progress ? 'observe_and_act' as const : handoff ? 'inspect_and_handoff' as const : 'resolve_workflow' as const,
    reportOutcomes, replayScope: 'report_recording_only' as const };
}
