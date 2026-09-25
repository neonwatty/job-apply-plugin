import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../../runtime/contracts/workspace/canonical-json.js';
import { fromJSON, get, integer, object, serialize, string, text } from '../../../runtime/contracts/workspace/values.js';
import { recomputeClaimReadiness } from '../../../runtime/contracts/workspace/claim-session-readiness.js';
import { NativeJobsRepository } from '../../../runtime/store/native-jobs.js';
import { NativeResumeFiles } from '../../../runtime/store/native-resume-files.js';
import { loadPosixFlockProvider } from '../../../runtime/store/posix-flock.js';
import { resolvePackagedNativeLock } from '../../../runtime/package/native-lock-artifact.js';
import { ClaimsService } from '../../../runtime/workspace-core/claims.js';
import { applicationRecoveryLayout } from './host-preflight.mjs';
import { ingestFields } from '../../../runtime/contracts/workspace/jobs.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const defaultLocalRoot = join(repositoryRoot, '.workflows/local');
const fixtureRoot = join(repositoryRoot, 'qa/testdata/workflows');
const formPath = join(repositoryRoot, 'qa/fixtures/greenhouse-form-readiness-v1/fixture.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedFiles = new Map([
  ['synthetic-application-recovery-job.json', '4090877989997ae911796b43bd4e8de5eaf8d75eb25680570575895671399efc'],
  ['synthetic-application-recovery-profile.json', 'e7f68576a126f4a47a9187e4a50f45df121591dc10da33422e83503d7793fc0d'],
  ['synthetic-application-recovery-resume.json', '23bba329895aefa0b3f024c9beaab36ca2124a99e0f4b49bbc17aeaa88c0c601'],
  ['synthetic-application-recovery-resume.txt', 'f8d2276290949fac6ce28e53ee00dd8d6103e171200dec508aa33f9646515e7f'],
]);

const fail = () => { throw new Error('Synthetic application-recovery fixture control is unavailable'); };
const plain = value => JSON.parse(serialize(value));
const exact = (left, right) => canonicalJson(fromJSON(left)) === canonicalJson(fromJSON(right));

async function privateDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()
      || metadata.mode & 0o077 || await realpath(path) !== path) fail();
}

async function fixtures() {
  const data = {};
  for (const [name, digest] of expectedFiles) {
    const path = join(fixtureRoot, name), metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail();
    const bytes = await readFile(path);
    if (sha256(bytes) !== digest) fail();
    data[name] = name.endsWith('.json') ? JSON.parse(bytes) : bytes;
  }
  const formMetadata = await lstat(formPath);
  if (!formMetadata.isFile() || formMetadata.isSymbolicLink()) fail();
  const formBytes = await readFile(formPath);
  if (sha256(formBytes) !== '0c0396aaa93152f5a58ef592d0d18c1047ff9ca993789be86bc6cf1f916d1551') fail();
  const form = JSON.parse(formBytes);
  if (form.id !== 'greenhouse-form-readiness-v1' || form.platformFamily !== 'greenhouse') fail();
  return { ...data, form };
}

export async function probeFixtureControl() {
  await fixtures();
  const artifact = await resolvePackagedNativeLock(repositoryRoot);
  loadPosixFlockProvider(artifact);
  return {
    schema: 'agent-workflow-capability/v1', id: 'job-apply.fixture-control', contractVersion: '1.0',
    adapter: { id: 'job-apply.synthetic-application-recovery-v1', version: '1.0' },
    operations: ['synthetic-review-handoff'], evidenceTypes: [],
    constraints: { syntheticOnly: true, localStoreOnly: true, networkAccess: false, finalSubmission: false },
    probe: { safe: true, operation: 'probe-fixture-control' },
  };
}

function packet(form, attemptRevision) {
  const controls = form.steps.flatMap(step => step.controls);
  const requiredControlIds = controls.filter(control => control.required).map(control => control.id).sort();
  const fingerprint = `sha256:${sha256(canonicalJson(fromJSON({ platformFamily: form.platformFamily, requiredControlIds })))}`;
  const kinds = { textbox: 'text', combobox: 'selection', radiogroup: 'selection', checkbox: 'toggle', file: 'upload' };
  return {
    attemptRevision, evidenceKind: 'agent_attested_current_attempt', fixture: form,
    expectedObservationRevision: 1,
    formManifest: { schemaVersion: 1, platformFamily: form.platformFamily, observationRevision: 1,
      requiredControlIds, controlSetFingerprint: fingerprint, complete: true },
    observation: { schemaVersion: 1, platformFamily: form.platformFamily, observationRevision: 1,
      adapterState: 'accessible', uploadCapability: 'available',
      controls: controls.map(control => ({ controlId: control.id, kind: kinds[control.role],
        state: control.role === 'file' ? 'accepted' : 'complete', observationRevision: 1 })),
      validationErrorControlIds: [], finalControlState: 'available' },
  };
}

async function validateJourney(journeyRoot, localRoot) {
  if (!isAbsolute(journeyRoot) || resolve(journeyRoot) !== journeyRoot
      || dirname(journeyRoot) !== localRoot || !/^application-recovery-[a-z0-9-]{8,64}$/.test(basename(journeyRoot))) fail();
  const layout = applicationRecoveryLayout(journeyRoot);
  await privateDirectory(localRoot);
  await privateDirectory(layout.journeyRoot);
  await privateDirectory(layout.runnerStoreRoot);
  await privateDirectory(layout.productStoreRoot);
  if (await lstat(layout.legacyProfilePath).then(() => true, () => false)) fail();
  if (await lstat(layout.productRollbackRoot).then(() => true, () => false)) fail();
  const runnerEntries = await readdir(layout.runnerStoreRoot);
  if (!runnerEntries.includes('index.json') || !runnerEntries.includes('runs')) fail();
  return layout;
}

async function validateProduct(repository, data, expectedRevision) {
  await repository.validateRoot(true);
  const entries = await readdir(repository.root);
  if (!entries.includes('.native-jobs-fixture') || entries.includes('.native-store-clone')) fail();
  for (const name of entries.filter(name => name.endsWith('-journal.json') || name === 'resume-operation.json')) {
    const journal = JSON.parse(await repository.read(name));
    if (journal.operation !== null) fail();
  }
  const [jobs, profile, resumes, answers, coordinator, history] = await Promise.all([
    'jobs.json', 'profile.json', 'resumes.json', 'answers.json', 'coordinator.json', 'applications.jsonl',
  ].map(name => repository.read(name)));
  const jobValues = Object.values(JSON.parse(jobs).jobs);
  const job = jobValues[0], fixtureJob = data['synthetic-application-recovery-job.json'];
  if (jobValues.length !== 1 || !job || job.status !== 'ready' || job.revision !== expectedRevision
      || job.deletedAt !== null || job.url !== fixtureJob.url || job.role !== fixtureJob.role
      || job.resumeId != null && job.resumeId !== data['synthetic-application-recovery-resume.json'].id
      || job.ats != null && job.ats !== 'greenhouse'
      || job.id !== fixtureJob.id && !/^job-[0-9a-f-]{36}$/.test(job.id)
      || job.legacySources?.length) fail();
  for (const field of ingestFields) {
    if (['url', 'role', 'ats', 'priority'].includes(field)) continue;
    if (job[field] != null && job[field] !== fixtureJob[field]) fail();
  }
  if (![0, fixtureJob.priority].includes(job.priority)) fail();
  const facts = JSON.parse(profile).profile;
  if (!exact(facts, data['synthetic-application-recovery-profile.json'])) fail();
  const groups = JSON.parse(await repository.read('fact-groups.json')).groups;
  if (Object.keys(groups).length) fail();
  const records = Object.values(JSON.parse(resumes).resumes), resume = records[0];
  if (records.length !== 1 || !resume || resume.id !== data['synthetic-application-recovery-resume.json'].id
      || resume.label !== data['synthetic-application-recovery-resume.json'].label
      || resume.default !== true || resume.storageKind !== 'managed' || resume.deletedAt !== null) fail();
  const content = await new NativeResumeFiles(repository.root).content(fromJSON(resume));
  if (!content.equals(data['synthetic-application-recovery-resume.txt'])) fail();
  if (Object.keys(JSON.parse(answers).answers).length || JSON.parse(coordinator).claim !== null) fail();
  const sessions = await readdir(join(repository.root, 'sessions'));
  if (sessions.length || history.toString('utf8').trim()) fail();
  return job;
}

/** One synthetic Store-only mutation. The bearer never crosses the process boundary. */
export async function handoffSyntheticReview({ journeyRoot, expectedRevision, localRoot = defaultLocalRoot }) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail();
  const capability = await probeFixtureControl();
  const layout = await validateJourney(journeyRoot, localRoot);
  const data = await fixtures();
  const artifact = await resolvePackagedNativeLock(repositoryRoot);
  const repository = new NativeJobsRepository(layout.productStoreRoot, loadPosixFlockProvider(artifact));
  const job = await validateProduct(repository, data, expectedRevision);
  const claims = new ClaimsService(repository);
  const first = object(await claims.acquire(job.id, text('Synthetic fixture control'), BigInt(expectedRevision)), 'first acquired');
  const blocked = plain(await claims.handoff(job.id, get(first, 'token'), 'needs_info', fromJSON({
    status: 'active', blockers: [{ type: 'information', code: 'owner-input-required' }],
  }), BigInt(expectedRevision + 1)));
  if (blocked.job.status !== 'needs_info' || blocked.job.revision !== expectedRevision + 2) fail();
  const recovered = plain(await claims.select(job.id, BigInt(expectedRevision + 2), true));
  if (recovered.job.status !== 'ready' || recovered.job.revision !== expectedRevision + 3) fail();
  const readinessInput = packet(data.form, expectedRevision + 4);
  const report = plain(recomputeClaimReadiness(fromJSON(readinessInput), integer(BigInt(expectedRevision + 4)), null));
  if (report.status !== 'ready' || Object.values(report.assertions).some(value => value !== 'passed')) fail();
  const acquired = object(await claims.acquire(job.id, text('Synthetic fixture control'), BigInt(expectedRevision + 3)), 'acquired');
  const token = get(acquired, 'token');
  const attempt = object(get(acquired, 'job'), 'job');
  if (string(get(attempt, 'id')) !== job.id || plain(get(attempt, 'revision')) !== expectedRevision + 4) fail();
  const result = plain(await claims.handoff(job.id, token, 'awaiting_review', fromJSON({
    status: 'review', step: 'review', pendingFields: [], readinessInput,
  }), BigInt(expectedRevision + 4)));
  const storedEvents = (await repository.read('applications.jsonl')).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  const finalActionUntouched = result.session.readiness.assertions['final-action-untouched'] === 'passed'
    && !storedEvents.some(event => ['applied', 'completed'].includes(event.event));
  return { capabilityId: capability.id, event: 'synthetic_review_handoff', jobId: job.id,
    blockedStatus: blocked.job.status, recoveredStatus: recovered.job.status,
    status: result.job.status, revision: result.job.revision, readiness: result.session.readiness.status,
    assertionsPassed: Object.values(result.session.readiness.assertions).filter(value => value === 'passed').length,
    browserHandoff: result.session.browserHandoff.state, finalActionUntouched };
}

function invocation(args) {
  if (args[0] === 'probe' && args.length === 1) return { action: 'probe' };
  if (args[0] !== 'handoff' || args.length !== 5 || args[1] !== '--journey-root'
      || args[3] !== '--expected-revision' || !/^[1-9][0-9]*$/.test(args[4])) fail();
  return { action: 'handoff', journeyRoot: args[2], expectedRevision: Number(args[4]) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const request = invocation(process.argv.slice(2));
    const result = request.action === 'probe' ? await probeFixtureControl() : await handoffSyntheticReview(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Synthetic application-recovery fixture control is unavailable\n');
    process.exitCode = 1;
  }
}
