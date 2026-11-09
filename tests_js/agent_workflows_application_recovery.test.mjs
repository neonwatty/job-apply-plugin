import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  applicationRecoveryHostPreflight,
  applicationRecoveryLayout,
} from '../.workflows/fixtures/job-apply.synthetic-application-recovery-v1/host-preflight.mjs';
import { initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { nativeStoreAllowedEntries } from '../runtime/store/native-store-layout.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { handoffSyntheticReview, probeFixtureControl } from '../.workflows/fixtures/job-apply.synthetic-application-recovery-v1/fixture-control.mjs';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { ResumeFactsService } from '../runtime/workspace-core/resume-facts.js';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { fromJSON, get, int, string } from '../runtime/contracts/workspace/values.js';

const execute = promisify(execFile);
const repository = resolve(new URL('..', import.meta.url).pathname);

test('application-recovery host preflight probes actual fixture control without mutation', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'application-recovery-preflight-')));
  await chmod(parent, 0o700);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const journeyRoot = join(parent, 'application-recovery-preflight-1234');
  const layout = applicationRecoveryLayout(journeyRoot);
  assert.deepEqual(layout, {
    journeyRoot,
    runnerStoreRoot: join(journeyRoot, 'runner-store'),
    productStoreRoot: join(journeyRoot, 'product-store'),
    productRollbackRoot: join(journeyRoot, 'product-store.python-rollback'),
    legacyProfilePath: join(journeyRoot, 'no-legacy-profile.json'),
  });
  const preflight = await applicationRecoveryHostPreflight({ journeyRoot, repositoryRoot: repository, localRoot: parent });
  assert.deepEqual(preflight.capabilityContract, await probeFixtureControl());
  assert.deepEqual(await readdir(parent), []);
  await assert.rejects(applicationRecoveryHostPreflight({ journeyRoot, repositoryRoot: parent, localRoot: parent }),
    /fixture-control is not committed/);
});

async function reviewStore(fixture, name) {
  const localRoot = join(await realpath(fixture.root), 'local');
  await mkdir(localRoot, { mode: 0o700 });
  const journeyRoot = join(localRoot, `application-recovery-${name}-1234`);
  const layout = applicationRecoveryLayout(journeyRoot);
  await mkdir(join(layout.runnerStoreRoot, 'runs'), { recursive: true, mode: 0o700 });
  await writeFile(join(layout.runnerStoreRoot, 'index.json'), '{}\n', { mode: 0o600 });
  await initializeJobsFixture(layout.productStoreRoot);
  const profilePath = join(layout.productStoreRoot, 'profile.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.profile = JSON.parse(await readFile(join(repository, 'qa/testdata/workflows/synthetic-application-recovery-profile.json')));
  await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  const native = new NativeJobsRepository(layout.productStoreRoot, loadPosixFlockProvider(fixture.receipt.artifact));
  const resumeFixture = JSON.parse(await readFile(join(repository, 'qa/testdata/workflows/synthetic-application-recovery-resume.json')));
  const resumeBytes = await readFile(join(repository, 'qa/testdata/workflows/synthetic-application-recovery-resume.txt'));
  const resume = await new ResumeService(native).import(fromJSON(resumeFixture), 'synthetic-application-recovery-resume.txt', resumeBytes);
  const jobFixture = JSON.parse(await readFile(join(repository, 'qa/testdata/workflows/synthetic-application-recovery-job.json')));
  const job = await new JobsService(native).create(fromJSON(jobFixture));
  const resumeId = resumeFixture.id;
  const facts = new ResumeFactsService(native);
  const draft = await facts.createDraft(resumeId, fromJSON(profile.profile), int(get(resume, 'revision')), null);
  const confirmed = await facts.confirm(resumeId, int(get(draft, 'revision')), string(get(draft, 'contentRevision')));
  await new ApplicationRunsService(native).start(resumeId, int(get(resume, 'revision')), int(get(confirmed, 'revision')), true,
    fromJSON({ jobIds:[jobFixture.id] }));
  const claims = new ClaimsService(native);
  await claims.select(jobFixture.id, 1n, true);
  return { journeyRoot, localRoot, layout };
}

test('fixture control performs one synthetic local handoff without a site, submission, or leaked bearer',
  { timeout: 60_000 }, async t => {
    const fixture = await nativeFixture();
    t.after(fixture.cleanup);
    const state = await reviewStore(fixture, 'handoff');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw Error('network must not be used'); };
    t.after(() => { globalThis.fetch = originalFetch; });
    const result = await handoffSyntheticReview({ journeyRoot: state.journeyRoot, localRoot: state.localRoot, expectedRevision: 2 });
    assert.equal(result.blockedStatus, 'needs_info');
    assert.equal(result.recoveredStatus, 'ready');
    assert.equal(result.status, 'awaiting_review');
    assert.equal(result.revision, 7);
    assert.equal(result.readiness, 'ready');
    assert.equal(result.assertionsPassed, 7);
    assert.equal(result.browserHandoff, 'ready_for_owner');
    assert.doesNotMatch(JSON.stringify(result), /claim_|token|private/i);
    const history = await readFile(join(state.layout.productStoreRoot, 'applications.jsonl'), 'utf8');
    assert.deepEqual(history.trim().split('\n').map(line => JSON.parse(line).event),
      ['job-started', 'job-blocked', 'job-started', 'reviewed']);
    assert.doesNotMatch(history, /applied|completed|claim_/i);
    assert.deepEqual((await readdir(state.layout.runnerStoreRoot)).sort(), ['index.json', 'runs']);
  });

test('fixture control rejects non-synthetic identity and foreign roots before mutation',
  { timeout: 60_000 }, async t => {
    const fixture = await nativeFixture();
    t.after(fixture.cleanup);
    const state = await reviewStore(fixture, 'reject');
    const path = join(state.layout.productStoreRoot, 'profile.json');
    const profile = JSON.parse(await readFile(path, 'utf8'));
    profile.profile.firstName = 'Private';
    await writeFile(path, JSON.stringify(profile), { mode: 0o600 });
    const before = await readFile(join(state.layout.productStoreRoot, 'coordinator.json'));
    await assert.rejects(handoffSyntheticReview({ journeyRoot: state.journeyRoot,
      localRoot: state.localRoot, expectedRevision: 2 }), /unavailable/);
    await assert.rejects(handoffSyntheticReview({ journeyRoot: state.layout.productStoreRoot,
      localRoot: state.localRoot, expectedRevision: 2 }), /unavailable/);
    await assert.rejects(handoffSyntheticReview({ journeyRoot: join(homedir(), '.job-apply'),
      localRoot: state.localRoot, expectedRevision: 2 }), /unavailable/);
    assert.deepEqual(await readFile(join(state.layout.productStoreRoot, 'coordinator.json')), before);
  });

test('runner metadata stays outside the native Store and a synthetic job save succeeds', { timeout: 60_000 }, async t => {
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  const fixtureRoot = await realpath(fixture.root);
  const journeyRoot = join(fixtureRoot, 'journey');
  const layout = applicationRecoveryLayout(journeyRoot);
  await mkdir(layout.runnerStoreRoot, { recursive: true, mode: 0o700 });
  await mkdir(join(layout.runnerStoreRoot, 'runs'), { mode: 0o700 });
  await writeFile(join(layout.runnerStoreRoot, 'index.json'), '{}\n', { mode: 0o600 });
  await initializeJobsFixture(layout.productStoreRoot);

  const cli = join(repository, 'runtime/cli/native-jobs.js');
  const job = join(fixtureRoot, 'job.json');
  await writeFile(job, JSON.stringify({
    id: 'synthetic-application-recovery-job',
    url: 'https://jobs.example.invalid/synthetic-application-recovery',
    role: 'Workflow Recovery Tester',
  }), { mode: 0o600 });
  const result = await execute(process.execPath, [
    cli, '--root', layout.productStoreRoot, '--native-lock', fixture.receipt.artifact,
    'job-create', '--input', job, '--origin', 'human',
  ], { env: { PATH: '' } });
  assert.equal(JSON.parse(result.stdout).role, 'Workflow Recovery Tester');

  const productEntries = await readdir(layout.productStoreRoot);
  assert.equal(productEntries.includes('index.json'), false);
  assert.equal(productEntries.includes('runs'), false);
  assert.equal(productEntries.every(name => nativeStoreAllowedEntries.has(name)), true);
  assert.deepEqual((await readdir(layout.runnerStoreRoot)).sort(), ['index.json', 'runs']);
  assert.ok(productEntries.includes('coordinator-journal.json'));
  assert.ok(productEntries.includes('resume-extraction-journal.json'));
});
