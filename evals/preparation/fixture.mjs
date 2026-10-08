import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const jobId = 'synthetic-preparation-job';
export async function prepareFixture(pluginRoot, workspace) {
  const moduleFrom = path => import(pathToFileURL(join(pluginRoot, path)).href);
  const [{ initializeJobsFixture, NativeJobsRepository }, { resolvePackagedNativeLock }, { loadPosixFlockProvider },
    { JobsService }, { ResumeService }, { ResumeFactsService }, { ApplicationRunsService }, values] = await Promise.all([
    moduleFrom('runtime/store/native-jobs.js'), moduleFrom('runtime/package/native-lock-artifact.js'),
    moduleFrom('runtime/store/posix-flock.js'), moduleFrom('runtime/workspace-core/jobs.js'),
    moduleFrom('runtime/workspace-core/resumes.js'), moduleFrom('runtime/workspace-core/resume-facts.js'),
    moduleFrom('runtime/workspace-core/application-runs.js'), moduleFrom('runtime/contracts/workspace/values.js'),
  ]);
  const { fromJSON, get, int, string } = values;
  const storeRoot = join(workspace, 'store');
  await initializeJobsFixture(storeRoot);
  const nativeLock = await resolvePackagedNativeLock(pluginRoot);
  const repository = new NativeJobsRepository(storeRoot, loadPosixFlockProvider(nativeLock));
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const applicant = { name: 'Synthetic Applicant', email: 'synthetic@example.invalid', phone: '000-000-0000', location: 'Local Fixture' };
  const profilePath = join(storeRoot, 'profile.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.profile = { ...applicant, applicationPreferences: { preferredBrowser: 'codex_browser', browserFallback: 'ask',
    progressionMode: 'standard', preferredAutomationMode: 'guided' } };
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`, { mode: 0o600 });
  const resumeId = 'synthetic-preparation-resume';
  const resume = await new ResumeService(repository, now).import(fromJSON({ id: resumeId, label: 'Synthetic Resume', default: true }),
    'resume.txt', Buffer.from('Synthetic Applicant\nFictional local preparation fixture.\n'));
  const facts = new ResumeFactsService(repository, now), resumeRevision = int(get(resume, 'revision'));
  const draft = await facts.createDraft(resumeId, fromJSON(applicant), resumeRevision, null);
  const confirmed = await facts.confirm(resumeId, int(get(draft, 'revision')), string(get(draft, 'contentRevision')));
  await new JobsService(repository, now).create(fromJSON({ id: jobId, role: 'Synthetic Application Tester',
    company: 'Fictional Local Systems', url: 'https://preparation.example.invalid/application', ats: 'greenhouse' }));
  await new ApplicationRunsService(repository, now).start(resumeId, resumeRevision, int(get(confirmed, 'revision')), true,
    fromJSON({ jobIds: [jobId] }));
  return { storeRoot, nativeLock, jobId };
}

export async function observeFixture(storeRoot) {
  const read = async name => JSON.parse(await readFile(join(storeRoot, name), 'utf8'));
  const jobs = await read('jobs.json'), coordinator = await read('coordinator.json');
  const files = (await readdir(storeRoot)).filter(name => name.endsWith('.json') || name.endsWith('.jsonl')).sort();
  const hashes = {};
  for (const name of files) hashes[name] = createHash('sha256').update(await readFile(join(storeRoot, name))).digest('hex');
  const metadata = jobs.metadata;
  return { job: jobs.jobs[jobId], claim: coordinator.claim, metadata, hashes,
    sessions: await readdir(join(storeRoot, 'sessions')) };
}
