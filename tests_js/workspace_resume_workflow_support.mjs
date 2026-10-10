import assert from 'node:assert/strict';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeJobsRepository, initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { NativeResumeWorkflowTasks } from '../runtime/store/native-resume-workflow-tasks.js';
import { ResumeExtractionWorkflow } from '../runtime/app/resume-extraction-workflow.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { ResumeFactsService } from '../runtime/workspace-core/resume-facts.js';
import { ExtractionRequests } from '../runtime/workspace-core/extraction-requests.js';
import { extractionIdentity, extractionProfile } from '../runtime/workflows/resumes/extract.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
export const plain = value => JSON.parse(serialize(value));
export const read = async (root, name) => JSON.parse(await readFile(join(root, name), 'utf8'));
export async function snapshot(root) {
  const result = {};
  for (const name of (await readdir(root)).sort()) if (name.endsWith('.json')) result[name] = await readFile(join(root, name), 'utf8');
  return result;
}
export async function setup(fixture, name) {
  const root = join(await realpath(fixture.root), name);
  await initializeJobsFixture(root);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const repository = new NativeJobsRepository(root, provider);
  const resumes = new ResumeService(repository);
  await resumes.import(fromJSON({ id: 'source', label: 'PRIVATE LABEL' }), 'private.txt', Buffer.from('PRIVATE RESUME TEXT'));
  await resumes.import(fromJSON({ id: 'other', label: 'OTHER PRIVATE' }), 'other.txt', Buffer.from('OTHER RESUME'));
  const facts = new ResumeFactsService(repository);
  await facts.createDraft('other', fromJSON({ unrelated: 'PRIVATE OTHER FACT' }), 1n, null);
  return { root, provider, repository, resumes, facts, requests: new ExtractionRequests(repository) };
}
export function runtime(state, afterWrite) {
  const access = { enabled: [extractionProfile], authorized: [extractionProfile] };
  const repository = new NativeJobsRepository(state.root, state.provider, async (path, value, options) => {
    await atomicWritePointJson(path, value, options);
    await afterWrite?.(path, value);
  });
  return { workflow: new ResumeExtractionWorkflow(new NativeResumeWorkflowTasks(repository), () => access), access };
}
export const start = (operationId = 'start', input = { resumeId: 'source', resumeRevision: '1' }) =>
  ({ kind: 'newTask', operationId, taskId: null, expectedRevision: null, workflow: extractionIdentity, input });
export const propose = (task, operationId = 'propose') => ({ kind: 'callTool', operationId, taskId: task.taskId,
  expectedRevision: task.revision, actionId: 'resume.propose', arguments: { name: 'PRIVATE CANDIDATE', skills: ['Synthetic'] } });
export const ask = task => ({ kind: 'askUser', operationId: 'review', taskId: task.taskId, expectedRevision: task.revision, actionId: 'resume.review' });
export const cancel = task => ({ kind: 'cancel', operationId: 'cancel', taskId: task.taskId, expectedRevision: task.revision });
export async function pending(workflow) {
  const started = await workflow.route(start());
  const proposed = await workflow.action(propose(started.receipt.task));
  return (await workflow.action(ask(proposed.receipt.task))).receipt.task;
}
export async function reply(workflow, task, decision = 'accept') {
  const review = (await workflow.inspect()).review;
  const proposal = { kind: 'continue', operationId: 'reply', taskId: task.taskId, expectedRevision: task.revision,
    event: { ...review, decision } };
  return { proposal, attestation: { taskId: task.taskId, expectedRevision: task.revision, reply: proposal.event } };
}
export async function rejectedUnchanged(state, operation, pattern) {
  const before = await snapshot(state.root);
  await assert.rejects(operation, pattern);
  assert.deepEqual(await snapshot(state.root), before);
}
