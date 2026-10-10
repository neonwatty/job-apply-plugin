import { WorkflowRegistry } from '../../harness/registry.js';
import { exact, identifier, record, requireCondition, revision, snapshot } from '../../harness/validation.js';
import { validatedCandidate } from '../../contracts/workspace/extraction-proposals.js';
import { fromJSON } from '../../contracts/workspace/values.js';
export const extractionIdentity = Object.freeze({ id: 'resume.extract', version: 1 });
export const extractionProfile = 'resume_extraction';
export const extractionQuestion = 'review_resume_facts';
export function extractionInput(raw) {
    const value = record(snapshot(raw), 'invalid_arguments');
    const resumeRevision = revision(value.resumeRevision, 'invalid_arguments');
    if (Object.hasOwn(value, 'requestId')) {
        exact(value, ['requestId', 'requestRevision', 'resumeRevision'], 'invalid_arguments');
        return { requestId: identifier(value.requestId, 'invalid_arguments'),
            requestRevision: revision(value.requestRevision, 'invalid_arguments'), resumeRevision };
    }
    exact(value, ['resumeId', 'resumeRevision'], 'invalid_arguments');
    return { resumeId: identifier(value.resumeId, 'invalid_arguments'), resumeRevision };
}
export function extractionReply(raw) {
    const value = record(snapshot(raw), 'invalid_event');
    exact(value, ['requestId', 'factRevision', 'contentRevision', 'decision'], 'invalid_event');
    requireCondition(value.decision === 'accept' || value.decision === 'reject', 'invalid_event');
    requireCondition(typeof value.contentRevision === 'string' && /^content_[A-Za-z0-9_-]{16,128}$/.test(value.contentRevision), 'invalid_event');
    return { requestId: identifier(value.requestId, 'invalid_event'), factRevision: revision(value.factRevision, 'invalid_event'),
        contentRevision: value.contentRevision, decision: value.decision };
}
export function extractionCandidate(raw) {
    const value = snapshot(raw);
    validatedCandidate(fromJSON(value));
    return value;
}
export function extractionRegistry() {
    return new WorkflowRegistry([{ id: extractionProfile, tools: [
                { id: 'resume.propose', inputSchema: { parse: extractionCandidate } },
                { id: 'resume.interrupt', inputSchema: { parse: raw => {
                            const value = record(snapshot(raw), 'invalid_arguments');
                            exact(value, [], 'invalid_arguments');
                            return value;
                        } } },
            ], limits: { maxSteps: 3, maxToolCalls: 1, maxChildDepth: 0 } }], [{ ...extractionIdentity,
            routeDescription: 'Extract facts for one exact managed resume into a draft, then await exact owner review.',
            requiredProfiles: [extractionProfile], startInputSchema: { parse: extractionInput }, userEventSchema: { parse: extractionReply } }]);
}
export function extractionActions(phase) {
    if (phase === 'requested')
        return [
            { kind: 'callTool', id: 'resume.propose', toolId: 'resume.propose' },
            { kind: 'callTool', id: 'resume.interrupt', toolId: 'resume.interrupt' },
        ];
    return phase === 'draft' ? [{ kind: 'askUser', id: 'resume.review', questionId: extractionQuestion }] : [];
}
