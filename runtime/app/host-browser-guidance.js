/** Advisory host-tool projection from current canonical guidance, never a browser grant. */
export function hostBrowserGuidance(context) {
    const owned = context.broker.connected && context.broker.ownsClaim;
    const progress = owned && context.guidance.actions.some(action => action.kind === 'progress');
    const handoff = owned && context.guidance.actions.some(action => action.kind === 'handoff'
        && action.input.status === 'needs_info');
    const reportOutcomes = [];
    if (progress)
        reportOutcomes.push('progress');
    if (handoff)
        reportOutcomes.push('needs_info');
    return { toolSource: 'host_existing', evidenceKind: 'agent_attested',
        nextStep: progress ? 'observe_and_act' : handoff ? 'inspect_and_handoff' : 'resolve_workflow',
        reportOutcomes, replayScope: 'report_recording_only' };
}
