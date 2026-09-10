import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { NativeJobsRepository, initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { runJobsCli } from '../runtime/cli/native-jobs.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

test('HTTP review and CLI extraction share durable revisions and browser-safe projections', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const root = join(await realpath(fixture.root), 'extraction-http');
    await initializeJobsFixture(root);
    const repository = new NativeJobsRepository(root, loadPosixFlockProvider(fixture.receipt.artifact));
    const jobs = new JobsService(repository);
    const http = async (method, path, body) => {
      const result = await jobsHttp(jobs, repository, method, path, body === undefined ? '' : JSON.stringify(body));
      return { status: result.status, value: JSON.parse(result.body) };
    };
    const cli = async (command, options = [], input = {}) => JSON.parse(await runJobsCli([
      command, '--root', root, '--native-lock', fixture.receipt.artifact, ...options,
    ], async () => JSON.stringify(input)));
    const resume = JSON.parse(serialize(await new ResumeService(repository).import(fromJSON({ id: 'source', label: 'Source' }), 'source.txt', Buffer.from('Synthetic resume'))));
    await http('PATCH', '/api/profile', { expectedRevision: 1, patch: { name: 'Current', employer: ['Existing employer'] } });
    const created = await http('POST', '/api/resume-extraction-requests', { resumeId: 'source', expectedResumeRevision: resume.revision });
    assert.equal(created.status, 200);
    assert.equal(created.value.resumeContentRevision, undefined);
    const requestId = created.value.requestId;
    const completed = await cli('resume-extraction-request-complete', ['--id', requestId, '--expected-request-revision', '1', '--expected-profile-revision', '2', '--input', '-'], { name: 'Extracted', location: 'Remote', employer: { title: 'Engineer' } });
    assert.equal(completed.request.status, 'completed');
    const proposalId = completed.proposalSummary.id;
    const detail = await http('GET', `/api/resume-proposals/${proposalId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.value.resumeDigest, undefined);
    assert.equal(detail.value.resumeContentRevision, undefined);
    assert.equal(detail.value.autoFilledCount, 1);
    assert.deepEqual(detail.value.currentValues['/name'], { exists: true, value: 'Current' });
    assert.deepEqual(detail.value.replacementScopes['/employer/title'], { path: '/employer', value: ['Existing employer'] });
    const body = { expectedRevision: detail.value.revision, expectedProfileRevision: detail.value.liveProfileRevision,
      decisions: { '/name': 'keep_current', '/employer/title': 'use_extracted' } };
    assert.equal((await http('POST', `/api/resume-proposals/${proposalId}/review`, body)).status, 400);
    const accepted = await http('POST', `/api/resume-proposals/${proposalId}/review`, { ...body, replacementConfirmations: { '/employer/title': '/employer' } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.value.status, 'completed');
    assert.equal((await http('POST', `/api/resume-proposals/${proposalId}/review`, body)).status, 409);
    const profile = JSON.parse(await readFile(join(root, 'profile.json'), 'utf8'));
    assert.equal(profile.profile.name, 'Current');
    assert.equal(profile.profile.employer.title, 'Engineer');
    assert.equal(profile.metadata.factProvenance['/location'].source, 'resume');
    assert.equal(profile.metadata.factProvenance['/employer/title'].source, 'user');
    assert.equal((await http('GET', '/api/resume-proposals/missing')).status, 404);
    assert.equal((await http('POST', '/api/resume-extraction-requests', { resumeId: 'source', expectedResumeRevision: true })).status, 400);
    await assert.rejects(cli('resume-extraction-request-complete', ['--id', requestId, '--expected-request-revision', '1', '--expected-profile-revision', '4', '--input', '-'], { value: 'duplicate' }), /revision conflict|not open/);
    const restarted = await cli('resume-proposal-get', ['--id', proposalId]);
    assert.equal(restarted.status, 'completed');
    const request2 = await cli('resume-extraction-request-create', ['--resume-id', 'source', '--expected-resume-revision', String(resume.revision)]);
    await new ResumeService(repository).replace('source', 'new.txt', Buffer.from('Changed synthetic resume'), BigInt(resume.revision));
    assert.equal((await cli('resume-extraction-request-get', ['--id', request2.requestId])).status, 'stale');
    assert.equal((await cli('resume-proposal-get', ['--id', proposalId])).stale, true);
    const conflict = await cli('resume-proposal-create', ['--resume-id', 'source', '--expected-resume-revision', '2', '--expected-profile-revision', '4', '--input', '-'], { name: 'Next name' });
    assert.equal((await http('PATCH', '/api/profile', { expectedRevision: 4, patch: { name: 'New current name' } })).status, 200);
    const review = { expectedRevision: conflict.revision, expectedProfileRevision: 5, decisions: { '/name': 'use_extracted' } };
    const baselineConflict = await http('POST', `/api/resume-proposals/${conflict.id}/review`, review);
    assert.equal(baselineConflict.status, 409);
    assert.equal(baselineConflict.value.error.code, 'baseline_conflict');
    await new ResumeService(repository).replace('source', 'again.txt', Buffer.from('Another synthetic resume'), 2n);
    const staleConflict = await http('POST', `/api/resume-proposals/${conflict.id}/review`, review);
    assert.equal(staleConflict.status, 409);
    assert.equal(staleConflict.value.error.code, 'stale_conflict');
    await new ResumeService(repository).import(fromJSON({ id: 'large', label: 'Large candidate' }), 'large.txt', Buffer.from('Large candidate synthetic source'));
    const largeInput = JSON.stringify({ largeA: 'a'.repeat(30000), largeB: 'b'.repeat(30000), largeC: 'c'.repeat(30000) });
    const stdin = args => {
      const result = spawnSync(process.execPath, ['runtime/cli/native-jobs.js', '--root', root,
        '--native-lock', fixture.receipt.artifact, ...args, '--input', '-'], { input: largeInput, encoding: 'utf8', env: { PATH: '' } });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.equal(stdin(['resume-proposal-create', '--resume-id', 'large', '--expected-resume-revision', '1', '--expected-profile-revision', '5']).status, 'completed');
    const largeRequest = await cli('resume-extraction-request-create', ['--resume-id', 'large', '--expected-resume-revision', '1']);
    assert.equal(stdin(['resume-extraction-request-complete', '--id', largeRequest.requestId, '--expected-request-revision', '1', '--expected-profile-revision', '6']).request.status, 'completed');
  } finally { await fixture.cleanup(); }
});
