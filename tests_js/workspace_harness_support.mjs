import { WorkflowRegistry } from '../runtime/harness/registry.js';

export const inputSchema = {
  parse(value) {
    if (!value || Object.keys(value).join() !== 'jobId' || value.jobId !== 'job-fixture') {
      throw new Error(`PRIVATE invalid job ${JSON.stringify(value)}`);
    }
    return Object.freeze({ jobId: value.jobId });
  },
};
export const eventSchema = {
  parse(value) {
    if (!value || Object.keys(value).sort().join() !== 'choice,questionId'
      || value.questionId !== 'choose-job' || value.choice !== 'job-fixture') throw Error('PRIVATE invalid event');
    return Object.freeze({ questionId: value.questionId, choice: value.choice });
  },
};
export const limits = { maxSteps: 8, maxToolCalls: 4, maxChildDepth: 2 };
export const identity = { id: 'applications.prepare', version: 1 };
export const access = { enabled: ['job-apply', 'resume'], authorized: ['job-apply', 'resume'] };
export const active = { taskId: 'task-fixture', revision: '9007199254740993', workflow: identity, canLeave: false };

export function setup() {
  const profiles = [
    { id: 'job-apply', limits: { ...limits }, tools: [{ id: 'jobs.inspect', inputSchema }] },
    { id: 'resume', limits: { ...limits, maxSteps: 6, maxToolCalls: 2 }, tools: [{ id: 'resumes.inspect', inputSchema }] },
  ];
  const workflows = [
    { ...identity, routeDescription: 'Prepare one exact job', requiredProfiles: ['job-apply'], startInputSchema: inputSchema, userEventSchema: eventSchema },
    { id: 'resumes.extract', version: 1, routeDescription: 'Extract resume facts', requiredProfiles: ['resume'], startInputSchema: inputSchema, userEventSchema: eventSchema },
    { id: 'applications.campaign', version: 1, routeDescription: 'Prepare inputs then fill queued jobs', requiredProfiles: ['job-apply', 'resume'], startInputSchema: inputSchema, userEventSchema: eventSchema },
  ];
  return { profiles, workflows, registry: new WorkflowRegistry(profiles, workflows) };
}

export const action = (kind = 'callTool', patch = {}) => ({
  kind, operationId: 'operation-fixture', taskId: active.taskId, expectedRevision: active.revision,
  actionId: kind === 'callTool' ? 'inspect' : kind,
  ...(kind === 'callTool' ? { arguments: { jobId: 'job-fixture' } } : {}),
  ...(kind === 'invokeWorkflow' ? { input: { jobId: 'job-fixture' } } : {}),
  ...patch,
});

export const frame = (patch = {}) => ({
  ...active, complete: false, terminal: false, childDepth: 0,
  allowedActions: [
    { id: 'inspect', kind: 'callTool', toolId: 'jobs.inspect' },
    { id: 'askUser', kind: 'askUser', questionId: 'choose-job' },
    { id: 'finish', kind: 'finish' },
  ], ...patch,
});

export const route = (kind = 'continue', patch = {}) => ({
  kind, operationId: 'route-fixture', taskId: kind === 'newTask' ? null : active.taskId,
  expectedRevision: kind === 'newTask' ? null : active.revision,
  ...(kind === 'newTask' || kind === 'change' ? { workflow: identity, input: { jobId: 'job-fixture' } } : {}),
  ...(kind === 'continue' ? { event: { questionId: 'choose-job', choice: 'job-fixture' } } : {}),
  ...(kind === 'clarify' ? { questionId: 'choose-job' } : {}),
  ...patch,
});
