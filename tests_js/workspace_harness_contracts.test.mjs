import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowRegistry } from '../runtime/harness/registry.js';
import { WorkflowError } from '../runtime/harness/contracts.js';
import { parseActionProposal, parseRouteProposal } from '../runtime/harness/proposals.js';
import { validateAction } from '../runtime/harness/planner.js';
import { validateRoute } from '../runtime/harness/router.js';
import { setup, access, active, identity, action, frame, route } from './workspace_harness_support.mjs';

const rejects = (operation, code) => assert.throws(operation, error => {
  assert.ok(error instanceof WorkflowError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  return true;
});

test('registration intersects enabled and authorized profiles, including composites and resumed tasks', () => {
  const { registry } = setup();
  for (const permissions of [
    { enabled: ['job-apply'], authorized: ['job-apply', 'resume'] },
    { enabled: ['job-apply', 'resume'], authorized: ['job-apply'] },
  ]) {
    assert.deepEqual(registry.eligible(permissions).map(item => item.id), [identity.id]);
    rejects(() => registry.resolve({ id: 'applications.campaign', version: 1 }, permissions), 'profile_unavailable');
  }
  const revoked = { enabled: ['job-apply'], authorized: [] };
  assert.deepEqual(registry.eligible(revoked), []);
  rejects(() => validateRoute(route(), { activeTask: active, clarificationIds: [] }, registry, revoked), 'profile_unavailable');
  rejects(() => validateAction(action(), frame(), registry, revoked), 'profile_unavailable');
  assert.deepEqual(registry.limits({ id: 'applications.campaign', version: 1 }, access),
    { maxSteps: 6, maxToolCalls: 2, maxChildDepth: 2 });
});

test('registry rejects ambiguous identities and never silently substitutes a workflow version', () => {
  const { profiles, workflows, registry } = setup();
  rejects(() => new WorkflowRegistry([...profiles, profiles[0]], workflows), 'invalid_registration');
  rejects(() => new WorkflowRegistry(profiles, [...workflows, workflows[0]]), 'invalid_registration');
  rejects(() => new WorkflowRegistry([{ ...profiles[0], tools: [...profiles[0].tools, profiles[0].tools[0]] }], []), 'invalid_registration');
  rejects(() => new WorkflowRegistry(profiles, [{ ...workflows[0], requiredProfiles: ['missing'] }]), 'invalid_registration');
  rejects(() => new WorkflowRegistry(profiles, [{ ...workflows[0], requiredProfiles: [] }]), 'invalid_registration');
  rejects(() => new WorkflowRegistry(profiles, [{ ...workflows[0], requiredProfiles: ['job-apply', 'job-apply'] }]), 'invalid_registration');
  for (const maxSteps of [0, -1, 1.5, Infinity]) {
    rejects(() => new WorkflowRegistry([{ ...profiles[0], limits: { ...profiles[0].limits, maxSteps } }], []), 'invalid_registration');
  }
  rejects(() => registry.resolve({ ...identity, version: 2 }, access), 'workflow_unavailable');
  rejects(() => registry.resolve({ id: 'unregistered', version: 1 }, access), 'workflow_unavailable');
  const twoVersions = new WorkflowRegistry(profiles, [...workflows, { ...workflows[0], version: 2 }]);
  assert.equal(twoVersions.resolve(identity, access).version, 1);
  assert.equal(twoVersions.resolve({ ...identity, version: 2 }, access).version, 2);
});

test('registration copies capability metadata so later array changes cannot expand a workflow', () => {
  const { profiles, workflows, registry } = setup();
  profiles[0].limits.maxChildDepth = 500;
  profiles[0].tools.push({ id: 'jobs.submit', inputSchema: { parse: value => value } });
  workflows[0].requiredProfiles.push('resume');
  assert.equal(registry.limits(identity, access).maxChildDepth, 2);
  assert.deepEqual(registry.resolve(identity, access).requiredProfiles, ['job-apply']);
  rejects(() => registry.tool(identity, 'jobs.submit', access), 'action_unavailable');
  assert.throws(() => registry.resolve(identity, access).requiredProfiles.push('resume'), TypeError);
});

test('closed proposals cannot supply state, grant authority, tool results or alternate tool IDs', () => {
  for (const field of ['state', 'toolId', 'claimToken', 'ownerConfirmed', 'result', 'authorized', 'complete']) {
    rejects(() => parseActionProposal(action('callTool', { [field]: 'PRIVATE' })), 'invalid_proposal');
    rejects(() => parseRouteProposal(route('continue', { [field]: 'PRIVATE' })), 'invalid_proposal');
  }
  for (const invalid of [null, [], 'PRIVATE', {}, { ...action(), kind: 'submit' }]) {
    rejects(() => parseActionProposal(invalid), 'invalid_proposal');
  }
  for (const expectedRevision of [9007199254740992, 1, '01', '-1', '0', '1.0', ' 1', '1e2']) {
    rejects(() => parseActionProposal(action('callTool', { expectedRevision })), 'invalid_proposal');
  }
  assert.equal(parseActionProposal(action()).expectedRevision, '9007199254740993');
  rejects(() => parseRouteProposal(route('newTask', { taskId: 'task-fixture' })), 'invalid_proposal');
  rejects(() => parseRouteProposal(route('continue', { taskId: null, expectedRevision: null })), 'invalid_proposal');
});

test('only registered tools owned by the selected workflow and currently exposed actions validate', () => {
  const { registry } = setup();
  const accepted = validateAction(action(), frame(), registry, access);
  assert.equal(accepted.action.toolId, 'jobs.inspect');
  assert.deepEqual(accepted.input, { jobId: 'job-fixture' });
  rejects(() => validateAction(action('callTool', { actionId: 'submit' }), frame(), registry, access), 'action_unavailable');
  rejects(() => validateAction(action(), frame({ allowedActions: [] }), registry, access), 'action_unavailable');
  for (const toolId of ['resumes.inspect', 'jobs.submit']) {
    rejects(() => validateAction(action(), frame({ allowedActions: [{ id: 'inspect', kind: 'callTool', toolId }] }), registry, access), 'action_unavailable');
  }
  rejects(() => validateAction(action(), frame({ allowedActions: [{ id: 'inspect', kind: 'askUser', questionId: 'choose-job' }] }), registry, access), 'action_unavailable');
  rejects(() => validateAction(action(), frame({ allowedActions: [...frame().allowedActions, frame().allowedActions[0]] }), registry, access), 'action_unavailable');
  rejects(() => validateAction(action('callTool', { arguments: { jobId: 'PRIVATE' } }), frame(), registry, access), 'invalid_arguments');
});

test('exact task identity and revision are checked again on every action and continuation', () => {
  const { registry } = setup();
  for (const taskId of ['other-task']) {
    rejects(() => validateAction(action('callTool', { taskId }), frame(), registry, access), 'task_conflict');
    rejects(() => validateRoute(route('continue', { taskId }), { activeTask: active, clarificationIds: [] }, registry, access), 'task_conflict');
  }
  const newer = { ...active, revision: '9007199254740994' };
  rejects(() => validateAction(action(), frame(newer), registry, access), 'stale_revision');
  rejects(() => validateRoute(route(), { activeTask: newer, clarificationIds: [] }, registry, access), 'stale_revision');
});

test('finish requires code-owned terminal state; asking exposes only the configured question', () => {
  const { registry } = setup();
  rejects(() => validateAction(action('finish'), frame(), registry, access), 'finish_not_allowed');
  for (const state of [{ complete: true }, { terminal: true }]) {
    assert.equal(validateAction(action('finish'), frame(state), registry, access).action.kind, 'finish');
  }
  assert.equal(validateAction(action('askUser'), frame(), registry, access).action.questionId, 'choose-job');
  rejects(() => validateAction(action('askUser', { questionId: 'unapproved-question' }), frame(), registry, access), 'invalid_proposal');
});

test('child invocation requires parent scope, child access, exact version and remaining depth', () => {
  const { registry } = setup();
  const context = frame({ workflow: { id: 'applications.campaign', version: 1 },
    allowedActions: [{ kind: 'invokeWorkflow', id: 'invokeWorkflow', workflow: { id: 'resumes.extract', version: 1 } }] });
  const accepted = validateAction(action('invokeWorkflow'), context, registry, access);
  assert.equal(accepted.action.workflow.id, 'resumes.extract');
  rejects(() => validateAction(action('invokeWorkflow'), { ...context, workflow: identity }, registry, access), 'profile_unavailable');
  rejects(() => validateAction(action('invokeWorkflow'), context, registry, { enabled: ['job-apply', 'resume'], authorized: ['job-apply'] }), 'profile_unavailable');
  for (const childDepth of [2, -1, 0.5, Infinity]) {
    rejects(() => validateAction(action('invokeWorkflow'), { ...context, childDepth }, registry, access), 'child_limit');
  }
  assert.equal(validateAction(action('invokeWorkflow'), { ...context, childDepth: 1 }, registry, access).action.kind, 'invokeWorkflow');
  const wrongVersion = { ...context, allowedActions: [{ ...context.allowedActions[0], workflow: { id: 'resumes.extract', version: 2 } }] };
  rejects(() => validateAction(action('invokeWorkflow'), wrongVersion, registry, access), 'workflow_unavailable');
  rejects(() => validateAction(action('invokeWorkflow', { workflow: identity }), context, registry, access), 'invalid_proposal');
});

test('routing respects safe handoff and validates user events without applying transitions', () => {
  const { registry } = setup();
  const context = { activeTask: active, clarificationIds: ['choose-job'] };
  assert.equal(validateRoute(route(), context, registry, access).kind, 'continue');
  rejects(() => validateRoute(route('continue', { event: { kind: 'tool', result: 'success' } }), context, registry, access), 'invalid_event');
  rejects(() => validateRoute(route('newTask'), context, registry, access), 'task_conflict');
  for (const kind of ['cancel', 'change']) {
    rejects(() => validateRoute(route(kind), context, registry, access), 'handoff_required');
    assert.equal(validateRoute(route(kind), { ...context, activeTask: { ...active, canLeave: true } }, registry, access).kind, kind);
  }
  const fresh = { activeTask: null, clarificationIds: ['choose-job'] };
  assert.equal(validateRoute(route('newTask'), fresh, registry, access).kind, 'newTask');
  assert.equal(validateRoute(route('clarify', { taskId: null, expectedRevision: null }), fresh, registry, access).kind, 'clarify');
  rejects(() => validateRoute(route('clarify', { questionId: 'unknown' }), context, registry, access), 'action_unavailable');
  assert.equal(active.canLeave, false);
  assert.equal(active.revision, '9007199254740993');
});

test('revocation blocks continuation but allows safe cancellation or an authorized task switch', () => {
  const { registry } = setup();
  const revoked = { enabled: ['job-apply', 'resume'], authorized: ['resume'] };
  const context = { activeTask: { ...active, canLeave: true }, clarificationIds: ['choose-job'] };
  assert.equal(validateRoute(route('cancel'), context, registry, revoked).kind, 'cancel');
  const change = route('change', { workflow: { id: 'resumes.extract', version: 1 } });
  assert.equal(validateRoute(change, context, registry, revoked).workflow.id, 'resumes.extract');
  assert.equal(validateRoute(route('clarify'), context, registry, revoked).kind, 'clarify');
  rejects(() => validateRoute(route(), context, registry, revoked), 'profile_unavailable');
  rejects(() => validateRoute(route('change'), context, registry, revoked), 'profile_unavailable');
  for (const proposal of [route('cancel'), change]) {
    rejects(() => validateRoute(proposal, { ...context, activeTask: active }, registry, revoked), 'handoff_required');
    rejects(() => validateRoute({ ...proposal, expectedRevision: '1' }, context, registry, revoked), 'stale_revision');
  }
});

test('proposal snapshots reject non-JSON values, accessors, oversized and cyclic payloads', () => {
  const source = action();
  const parsed = parseActionProposal(source);
  source.arguments.jobId = 'changed';
  assert.equal(parsed.arguments.jobId, 'job-fixture');
  assert.throws(() => { parsed.arguments.jobId = 'changed'; }, TypeError);
  for (const argumentsValue of [undefined, NaN, Infinity, 1n, () => {}, new Date(), Array(2), 'x'.repeat(65537)]) {
    rejects(() => parseActionProposal(action('callTool', { arguments: argumentsValue })), 'invalid_proposal');
  }
  rejects(() => parseActionProposal(action('callTool', { arguments: ['x'.repeat(65536), 'x'.repeat(65536)] })), 'invalid_proposal');
  const cyclic = {}; cyclic.self = cyclic;
  rejects(() => parseActionProposal(action('callTool', { arguments: cyclic })), 'invalid_proposal');
  let read = false;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { read = true; return 'PRIVATE'; } });
  rejects(() => parseActionProposal(action('callTool', { arguments: getter })), 'invalid_proposal');
  assert.equal(read, false);
  const prototype = JSON.parse('{"__proto__":{"authorized":true}}');
  const copied = parseActionProposal(action('callTool', { arguments: prototype })).arguments;
  assert.equal(Object.getPrototypeOf(copied), null);
  assert.equal(copied.authorized, undefined);
  assert.equal({}.authorized, undefined);
});
