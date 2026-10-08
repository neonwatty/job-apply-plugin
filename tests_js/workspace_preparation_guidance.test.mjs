import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { snapshot, plain } from './workspace_native_claims_support.mjs';
import { prepareContinuationFixture, introduceStaleFacts, alternateResumeId } from '../evals/preparation/continuation-fixture.mjs';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { NativeWorkflowTasks } from '../runtime/store/native-workflow-tasks.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { PreparationWorkflow } from '../runtime/app/preparation-workflow.js';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
import { ResumeFactsService } from '../runtime/workspace-core/resume-facts.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { preparationProfile } from '../runtime/workflows/applications/prepare.js';

const pluginRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
async function setup(t, scenario) {
  const container = await nativeFixture();
  t.after(() => container.cleanup());
  const workspace = join(await realpath(container.root), 'workspace');
  await mkdir(workspace);
  const fixture = await prepareContinuationFixture(pluginRoot, workspace, scenario);
  const repository = new NativeJobsRepository(fixture.storeRoot, loadPosixFlockProvider(fixture.nativeLock));
  const access = { enabled: [preparationProfile], authorized: [preparationProfile] };
  const workflow = new PreparationWorkflow(new NativeWorkflowTasks(repository), () => access);
  return { fixture, repository, workflow, access, runs: new ApplicationRunsService(repository) };
}

test('missing-run guidance supplies exact canonical input references without choosing or writing', async t => {
  const { fixture, repository, workflow, runs, access } = await setup(t, 'unresolved-resume');
  const before = await snapshot(fixture.storeRoot);
  const { guidance, selection } = await workflow.inspect(fixture.jobId);
  assert.equal(guidance.nextOperation, 'choose_resume_then_start_run');
  assert.ok(guidance.blockers.includes('application_run_missing'));
  assert.deepEqual(selection.allowedActions, []);
  assert.equal(guidance.resumeChoices.length, 2);
  assert.ok(guidance.resumeChoices.every(choice => choice.available));
  const choice = guidance.resumeChoices.find(choice => choice.resumeId === alternateResumeId);
  assert.equal(choice.resumeRevision, '1');
  assert.equal(choice.factRevision, '2');
  assert.deepEqual(choice.runStart.input, { jobIds: [fixture.jobId] });
  assert.equal(choice.runStart.requiresExplicitInputConfirmation, true);
  assert.doesNotMatch(JSON.stringify(guidance), /synthetic@example|Fictional alternate resume|storagePath|digest/);
  assert.deepEqual(await snapshot(fixture.storeRoot), before);
  // Scope metadata never substitutes for explicit confirmation, even with exact returned revisions.
  assert.throws(() => runs.start(choice.resumeId, 1n, 2n, false, fromJSON(choice.runStart.input)), /owner confirmation/);
  assert.deepEqual(await snapshot(fixture.storeRoot), before);
  await runs.start(choice.resumeId, BigInt(choice.resumeRevision), BigInt(choice.factRevision), true, fromJSON(choice.runStart.input));
  const readyToSelect = await workflow.inspect(fixture.jobId);
  assert.equal(readyToSelect.guidance.nextOperation, 'select');
  const { jobId, jobRevision, inputRevision } = readyToSelect.selection;
  await workflow.select({ operationId: 'select', jobId, jobRevision, inputRevision });
  const selected = await snapshot(fixture.storeRoot);
  const resumed = await new PreparationWorkflow(new NativeWorkflowTasks(repository), () => access).inspect();
  assert.equal(resumed.selection.jobId, jobId);
  assert.equal(resumed.selection.ready, true);
  assert.equal(resumed.guidance.nextOperation, 'report_ready');
  assert.deepEqual(await snapshot(fixture.storeRoot), selected);
});

test('new facts invalidate advertised run arguments and refreshed guidance does not offer a repair', async t => {
  const { fixture, repository, workflow, runs } = await setup(t, 'unresolved-resume');
  const choice = (await workflow.inspect(fixture.jobId)).guidance.resumeChoices.find(item => item.resumeId === alternateResumeId);
  await new ResumeFactsService(repository).createDraft(choice.resumeId, fromJSON({ name: 'Changed fictional name' }), 1n, 2n);
  const before = await snapshot(fixture.storeRoot);
  await assert.rejects(runs.start(choice.resumeId, 1n, 2n, true, fromJSON(choice.runStart.input)), /unavailable or stale/);
  const refreshed = (await workflow.inspect(fixture.jobId)).guidance.resumeChoices.find(item => item.resumeId === alternateResumeId);
  assert.equal(refreshed.factRevision, '3');
  assert.equal(refreshed.factState, 'draft');
  assert.equal(refreshed.available, false);
  assert.equal(refreshed.runStart, null);
  assert.deepEqual(refreshed.blockers, ['resume_facts_unconfirmed']);
  assert.deepEqual(await snapshot(fixture.storeRoot), before);
});

test('discovery does not infer a choice between multiple Ready jobs or grant revoked run setup', async t => {
  const { fixture, repository, workflow, runs, access } = await setup(t, 'fresh-context');
  await new JobsService(repository).create(fromJSON({ id: 'second-job', role: 'Second', company: 'Synthetic', url: 'https://second.example.invalid' }));
  const run = plain(await runs.status());
  await runs.update(run.runId, BigInt(run.revision), fromJSON({ jobIds: [fixture.jobId, 'second-job'] }));
  const claims = new ClaimsService(repository);
  await claims.select(fixture.jobId, 1n, true);
  await claims.select('second-job', 1n, true);
  const before = await snapshot(fixture.storeRoot);
  const discovery = await workflow.inspect();
  assert.equal(discovery.selection, undefined);
  assert.equal(discovery.guidance.nextOperation, 'choose_job');
  assert.equal(discovery.guidance.jobs.length, 2);
  access.authorized = [];
  const denied = await workflow.inspect(fixture.jobId);
  assert.equal(denied.guidance.nextOperation, 'profile_unavailable');
  assert.equal(denied.guidance.resumeChoices, undefined);
  assert.deepEqual(denied.selection.allowedActions, []);
  assert.deepEqual(await snapshot(fixture.storeRoot), before);
});

test('stale pending confirmation exposes a blocker instead of an executable confirmation promise', async t => {
  const { fixture, workflow } = await setup(t, 'stale-facts');
  const started = await workflow.route({ kind: 'newTask', operationId: 'start', taskId: null, expectedRevision: null,
    workflow: { id: 'application.prepare', version: 1 }, input: { jobId: fixture.jobId, jobRevision: '1' } });
  const task = started.receipt.task;
  await workflow.action({ kind: 'askUser', operationId: 'ask', taskId: task.taskId, expectedRevision: task.revision,
    actionId: 'application.confirm_selection' });
  const waiting = await workflow.inspect();
  assert.equal(waiting.guidance.confirmation.confirmOutcome, 'job_ready');
  await introduceStaleFacts(pluginRoot, fixture);
  const before = await snapshot(fixture.storeRoot), stale = await workflow.inspect();
  assert.equal(stale.guidance.nextOperation, 'cancel_stale_preparation');
  assert.ok(stale.guidance.blockers.includes('resume_facts_unconfirmed'));
  assert.equal(stale.guidance.confirmation, null);
  assert.deepEqual(stale.task, waiting.task);
  assert.deepEqual(await snapshot(fixture.storeRoot), before);
});

test('an explicit second-job inspection never borrows or invalidates the active task confirmation', async t => {
  const { fixture, repository, workflow, runs } = await setup(t, 'fresh-context');
  const jobs = new JobsService(repository);
  await jobs.create(fromJSON({ id: 'second-job', role: 'Second', company: 'Synthetic', url: 'https://second.example.invalid' }));
  const run = plain(await runs.status());
  await runs.update(run.runId, BigInt(run.revision), fromJSON({ jobIds: [fixture.jobId, 'second-job'] }));
  const started = await workflow.route({ kind: 'newTask', operationId: 'start', taskId: null, expectedRevision: null,
    workflow: { id: 'application.prepare', version: 1 }, input: { jobId: fixture.jobId, jobRevision: '1' } });
  const task = started.receipt.task;
  await workflow.action({ kind: 'askUser', operationId: 'ask', taskId: task.taskId, expectedRevision: task.revision,
    actionId: 'application.confirm_selection' });
  for (const change of ['same-revisions', 'inspected-job-changed', 'task-job-changed']) {
    if (change === 'inspected-job-changed') await jobs.update('second-job', fromJSON({ notes: 'changed' }), 1n);
    if (change === 'task-job-changed') await jobs.update(fixture.jobId, fromJSON({ notes: 'changed' }), 1n);
    const before = await snapshot(fixture.storeRoot);
    const other = await workflow.inspect('second-job');
    assert.equal(other.selection.jobId, 'second-job');
    assert.equal(other.task.subject.jobId, fixture.jobId);
    assert.equal(other.guidance.nextOperation, 'continue_task');
    assert.ok(other.guidance.blockers.includes('different_active_preparation'));
    assert.equal(other.guidance.confirmation, null);
    const actual = await workflow.inspect();
    assert.equal(actual.guidance.nextOperation, change === 'task-job-changed' ? 'cancel_stale_preparation' : 'await_reply_or_cancel');
    assert.deepEqual(await snapshot(fixture.storeRoot), before);
  }
});


test('unreadable alternate resume reports a file blocker while confirmed facts remain confirmed', async t => {
  const { fixture, workflow } = await setup(t, 'unresolved-resume');
  await writeFile(join(fixture.storeRoot, 'resume-files', `${alternateResumeId}.txt`), Buffer.alloc(10 * 1024 * 1024 + 1));
  const before = await snapshot(fixture.storeRoot);
  const choices = (await workflow.inspect(fixture.jobId)).guidance.resumeChoices;
  const unavailable = choices.find(choice => choice.resumeId === alternateResumeId);
  assert.equal(unavailable.factState, 'confirmed');
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.runStart, null);
  assert.deepEqual(unavailable.blockers, ['resume_file_unavailable']);
  assert.equal(choices.find(choice => choice.resumeId !== alternateResumeId).available, true);
  assert.deepEqual(await snapshot(fixture.storeRoot), before);
});


test('unreadable default resume keeps healthy alternate input guidance available', async t => {
  const { fixture, workflow } = await setup(t, 'unresolved-resume');
  await writeFile(join(fixture.storeRoot, 'resume-files', 'synthetic-preparation-resume.txt'), Buffer.alloc(10 * 1024 * 1024 + 1));
  const before = await snapshot(fixture.storeRoot);
  const { selection, guidance } = await workflow.inspect(fixture.jobId);
  assert.equal(selection.ready, false);
  assert.deepEqual(selection.allowedActions, []);
  assert.equal(guidance.nextOperation, 'choose_resume_then_start_run');
  assert.deepEqual(guidance.blockers, ['resume_file_unavailable', 'application_run_missing']);
  const healthy = guidance.resumeChoices.find(choice => choice.resumeId === alternateResumeId);
  assert.equal(healthy.available, true);
  assert.equal(healthy.runStart.requiresExplicitInputConfirmation, true);
  const unavailable = guidance.resumeChoices.find(choice => choice.resumeId !== alternateResumeId);
  assert.equal(unavailable.factState, 'confirmed');
  assert.deepEqual(unavailable.blockers, ['resume_file_unavailable']);
  assert.equal(unavailable.runStart, null);
  assert.deepEqual(await snapshot(fixture.storeRoot), before);
});
