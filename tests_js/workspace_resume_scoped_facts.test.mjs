import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { NativeJobsRepository, initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { ResumeFactsService } from '../runtime/workspace-core/resume-facts.js';
import { ExtractionRequests } from '../runtime/workspace-core/extraction-requests.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
import { WorkspaceProjectionsService } from '../runtime/workspace-core/workspace-projections.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { runJobsCli } from '../runtime/cli/native-jobs.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const plain = value => JSON.parse(serialize(value));

test('application runs lock one resume while their queue remains revision-updatable', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const root = join(await realpath(fixture.root), 'resume-facts');
    await initializeJobsFixture(root);
    const repository = new NativeJobsRepository(root, loadPosixFlockProvider(fixture.receipt.artifact));
    const resumes = new ResumeService(repository), requests = new ExtractionRequests(repository);
    const facts = new ResumeFactsService(repository), jobs = new JobsService(repository);
    const claims = new ClaimsService(repository), runs = new ApplicationRunsService(repository);
    const projections = new WorkspaceProjectionsService(repository);
    const a = plain(await resumes.import(fromJSON({ id: 'resume-a', label: 'Resume A' }), 'a.txt', Buffer.from('A synthetic resume')));
    const b = plain(await resumes.import(fromJSON({ id: 'resume-b', label: 'Resume B' }), 'b.txt', Buffer.from('B synthetic resume')));
    const job = plain(await jobs.create(fromJSON({ id: 'job-a', url: 'https://example.invalid/jobs/a' })));
    for (const [resume, name] of [[a, 'Alice A'], [b, 'Alice B']]) {
      const request = plain(await requests.createRequest(resume.id, BigInt(resume.revision), true));
      assert.equal(request.scope, 'resume');
      if (resume.id === 'resume-a') {
        assert.deepEqual(plain(await projections.preflight('job-a')).errors, ['application_run_missing', 'resume_facts_unconfirmed']);
        assert.equal(plain(await projections.overview()).targetWorkspace, 'resumes');
        assert.equal(plain(await projections.overview()).setup.factsWorkspace, 'resumes');
      }
      const draft = plain(await facts.completeRequest(request.requestId, fromJSON({ name }), 1n));
      assert.equal(draft.state, 'draft');
      assert.equal(plain(await requests.getRequest(request.requestId)).factRevision, 1);
      await facts.confirm(resume.id, 1n, draft.contentRevision);
    }
    assert.equal(plain(await facts.get('resume-a')).facts.name, 'Alice A');
    assert.equal(plain(await facts.get('resume-b')).facts.name, 'Alice B');
    assert.deepEqual(JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')).profile, {});
    assert.deepEqual(plain(await projections.preflight('job-a')).errors, ['application_run_missing', 'resume_facts_unconfirmed']);
    const firstRun = plain(await runs.start('resume-a', BigInt(a.revision), 2n, true, fromJSON({ jobIds:['job-a'] })));
    assert.equal(firstRun.selection.resumeId, 'resume-a');
    assert.equal(plain(await projections.preflight('job-a')).ready, true);
    const selected = plain(await claims.select('job-a', BigInt(job.revision), true));
    const acquired = plain(await claims.acquire('job-a', fromJSON('test-agent'), BigInt(selected.job.revision)));
    assert.equal(acquired.resume.id, 'resume-a');
    assert.equal(plain(await projections.preflight('job-a')).ready, true);
    await assert.rejects(runs.update(firstRun.runId, 1n, fromJSON({ jobIds:[] })),
      /active claimed job cannot be removed/);
    const draft = plain(await facts.createDraft('resume-a', fromJSON({ name: 'Revised A' }), BigInt(a.revision), 2n));
    assert.equal(draft.state, 'draft');
    assert.deepEqual(plain(await projections.preflight('job-a')).errors, ['resume_facts_unconfirmed']);
    await assert.rejects(claims.progress('job-a', fromJSON(acquired.token), fromJSON({ status: 'active' })),
      /confirmed application inputs changed/);
    const blocked = plain(await claims.handoff('job-a', fromJSON(acquired.token), 'needs_info',
      fromJSON({ status: 'active' }), BigInt(acquired.job.revision)));
    assert.equal(blocked.job.status, 'needs_info');
    assert.equal(plain(await claims.status()).claim, null);
    assert.equal(plain(await facts.get('resume-b')).facts.name, 'Alice B');

    const otherJob = plain(await jobs.create(fromJSON({ id: 'job-b', url: 'https://example.invalid/jobs/b' })));
    const updatedRun = plain(await runs.update(firstRun.runId, 1n, fromJSON({ jobIds:['job-a', 'job-b'] })));
    assert.equal(updatedRun.revision, 2);
    assert.deepEqual(updatedRun.queueVersions.at(-1).jobIds, ['job-a', 'job-b']);
    assert.equal(plain(await projections.preflight('job-b')).resumeId, 'resume-a');
    await runs.complete(firstRun.runId, 2n);
    const secondRun = plain(await runs.start('resume-b', BigInt(b.revision), 2n, true, fromJSON({ jobIds:['job-b'] })));
    assert.equal(secondRun.selection.resumeId, 'resume-b');
    assert.equal(plain(await projections.preflight('job-b')).ready, true);
    const editedJob = plain(await jobs.update('job-b', fromJSON({ role: 'New role' }), BigInt(otherJob.revision)));
    assert.equal(plain(await projections.preflight('job-b')).ready, true);
    const replaced = plain(await resumes.replace('resume-b', 'b-new.txt', Buffer.from('Replacement synthetic resume'), BigInt(b.revision)));
    assert.notEqual(replaced.contentRevision, b.contentRevision);
    assert.equal(plain(await facts.get('resume-b')).current, false);
    assert.deepEqual(plain(await projections.preflight('job-b')).errors, ['resume_facts_unconfirmed']);
  } finally { await fixture.cleanup(); }
});

test('Companion request and review routes pair with private scoped CLI completion', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const root = join(await realpath(fixture.root), 'resume-facts-http');
    await initializeJobsFixture(root);
    const repository = new NativeJobsRepository(root, loadPosixFlockProvider(fixture.receipt.artifact));
    const jobs = new JobsService(repository);
    const http = async (method, path, body) => {
      const response = await jobsHttp(jobs, repository, method, path, body === undefined ? '' : JSON.stringify(body));
      return { status: response.status, value: JSON.parse(response.body) };
    };
    const resume = plain(await new ResumeService(repository).import(fromJSON({ id: 'candidate', label: 'Candidate' }),
      'candidate.txt', Buffer.from('Synthetic candidate')));
    const request = await http('POST', '/api/resume-extraction-requests', {
      resumeId: resume.id, expectedResumeRevision: resume.revision, scope: 'resume'
    });
    assert.equal(request.status, 200);
    const completed = JSON.parse(await runJobsCli(['resume-extraction-request-complete-scoped', '--root', root,
      '--native-lock', fixture.receipt.artifact, '--id', request.value.requestId,
      '--expected-request-revision', '1', '--input', '-'], async () => JSON.stringify({ name: 'Scoped only' })));
    assert.equal(completed.state, 'draft');
    const detail = await http('GET', '/api/resume-facts/candidate');
    assert.equal(detail.value.facts.name, 'Scoped only');
    assert.equal(detail.value.current, true);
    assert.equal((await http('POST', '/api/resume-facts/candidate/confirm', {
      expectedFactRevision: 1, expectedContentRevision: detail.value.contentRevision
    })).value.state, 'confirmed');
    const job = plain(await jobs.create(fromJSON({ id: 'candidate-job', url: 'https://example.invalid/jobs/candidate' })));
    const confirmed = JSON.parse(await runJobsCli(['application-run-start', '--root', root,
      '--native-lock', fixture.receipt.artifact, '--resume-id', 'candidate',
      '--expected-resume-revision', String(resume.revision), '--expected-fact-revision', '2',
      '--owner-confirmed', '--input', '-'], async () => JSON.stringify({ jobIds:[job.id] })));
    assert.equal(confirmed.selection.factRevision, 2);
    assert.deepEqual(confirmed.queueVersions[0].jobIds, [job.id]);
    assert.equal(JSON.stringify(confirmed).includes('Scoped only'), false);
    const state = await http('GET', '/api/state');
    assert.equal(state.value.applicationRun.runId, confirmed.runId);
    assert.deepEqual(state.value.applicationRun.queueVersions[0].jobIds, [job.id]);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')).profile, {});
  } finally { await fixture.cleanup(); }
});
