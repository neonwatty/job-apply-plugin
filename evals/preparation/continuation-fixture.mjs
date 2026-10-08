import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareFixture, observeFixture } from './fixture.mjs';

export const alternateResumeId = 'synthetic-alternate-resume';
async function services(pluginRoot, fixture) {
  const load = path => import(pathToFileURL(join(pluginRoot, `runtime/${path}.js`)).href);
  const [{ NativeJobsRepository }, { loadPosixFlockProvider }, { ResumeService }, { ResumeFactsService },
    { ApplicationRunsService }, { WorkspaceProjectionsService }, values] = await Promise.all([
    load('store/native-jobs'), load('store/posix-flock'), load('workspace-core/resumes'),
    load('workspace-core/resume-facts'), load('workspace-core/application-runs'),
    load('workspace-core/workspace-projections'), load('contracts/workspace/values'),
  ]);
  const repository = new NativeJobsRepository(fixture.storeRoot, loadPosixFlockProvider(fixture.nativeLock));
  return { repository, resumes: new ResumeService(repository), facts: new ResumeFactsService(repository),
    runs: new ApplicationRunsService(repository), projections: new WorkspaceProjectionsService(repository), values };
}

export async function prepareContinuationFixture(pluginRoot, workspace, scenario) {
  const fixture = await prepareFixture(pluginRoot, workspace);
  if (scenario === 'unresolved-resume') {
    const { resumes, facts, runs, values: { fromJSON, get, int, string } } = await services(pluginRoot, fixture);
    const active = await runs.status();
    await runs.complete(string(get(active, 'runId')), int(get(active, 'revision')));
    const resume = await resumes.import(fromJSON({ id: alternateResumeId, label: 'Synthetic Alternate Resume', default: false }),
      'alternate.txt', Buffer.from('Synthetic Applicant\nFictional alternate resume for selection evaluation.\n'));
    const draft = await facts.createDraft(alternateResumeId, fromJSON({ name: 'Synthetic Applicant', email: 'synthetic@example.invalid' }),
      int(get(resume, 'revision')), null);
    await facts.confirm(alternateResumeId, int(get(draft, 'revision')), string(get(draft, 'contentRevision')));
  }
  return fixture;
}

/** Simulate an independent edit through canonical services, between model turns. */
export async function introduceStaleFacts(pluginRoot, fixture) {
  const { facts, values: { fromJSON, get, int } } = await services(pluginRoot, fixture);
  const resumeId = 'synthetic-preparation-resume';
  const document = JSON.parse(await readFile(join(fixture.storeRoot, 'resumes.json'), 'utf8'));
  const current = await facts.get(resumeId);
  await facts.createDraft(resumeId, fromJSON({ name: 'Synthetic Applicant', email: 'changed@example.invalid' }),
    BigInt(document.resumes[resumeId].revision), int(get(current, 'revision')));
}

export async function observeContinuation(pluginRoot, fixture) {
  const state = await observeFixture(fixture.storeRoot);
  const { runs, facts, projections, values: { get, serialize } } = await services(pluginRoot, fixture);
  const ready = get(await projections.preflight(fixture.jobId), 'ready') === true;
  const activeRun = await runs.status();
  return { ...state, preflightReady: ready, activeRun: activeRun === null ? null : JSON.parse(serialize(activeRun)),
    factSummaries: JSON.parse(serialize(await facts.list())) };
}
