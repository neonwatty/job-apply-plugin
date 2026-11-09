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

test('full supported fact candidates cross the authenticated proxy and native HTTP boundaries', { timeout: 30000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { writeFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const { default: ts } = await import('typescript');
  const fixture = await nativeFixture();
  let child;
  try {
    const root = join(await realpath(fixture.root), 'facts-http');
    await initializeJobsFixture(root);
    const repository = new NativeJobsRepository(root, loadPosixFlockProvider(fixture.receipt.artifact));
    await new ResumeService(repository).import(fromJSON({ id: 'source', label: 'Source' }), 'source.txt', Buffer.from('Synthetic source'));
    for (const name of ['config', 'routes', 'assets', 'forward']) {
      const source = await readFile(new URL(`../apps/companion/server/${name}.ts`, import.meta.url), 'utf8');
      const emitted = ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
      } }).outputText.replace(/from "\.\/(config|routes|assets)"/g, 'from "./$1.mjs"');
      await writeFile(join(fixture.root, `${name}.mjs`), emitted);
    }
    const { forward } = await import(pathToFileURL(join(fixture.root, 'forward.mjs')));
    child = spawn(process.execPath, ['runtime/cli/native-jobs-server.js', '--root', root,
      '--native-lock', fixture.receipt.artifact], { env: { PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const startup = await new Promise((resolve, reject) => {
      let output = '', errors = '';
      const timer = setTimeout(() => reject(Error(`Native startup timed out: ${errors}`)), 5000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', () => fail(Error(`Native startup exited: ${errors}`)));
      child.stderr.on('data', bytes => { errors += bytes; });
      child.stdout.on('data', bytes => {
        output += bytes;
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
      });
    });
    const token = new URLSearchParams(new URL(startup.url).hash.slice(1)).get('token');
    const config = { origin: 'http://127.0.0.1:41001', upstream: startup.origin, token };
    const send = (path, payload, direct = false) => {
      const body = JSON.stringify(payload), origin = direct ? config.upstream : config.origin;
      const options = { method: 'POST', body, headers: { Host: new URL(origin).host, Origin: origin,
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } };
      return direct ? fetch(origin + path, options) : forward(new Request(origin + path, options), 'api', config);
    };
    const facts = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`section${i}`, 'a'.repeat(32000)]));
    const payload = { facts, expectedResumeRevision: 1, expectedFactRevision: null };
    const saved = await send('/api/resume-facts/source', payload);
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal((await saved.json()).revision, 1);
    const persisted = await fetch(config.upstream + '/api/resume-facts/source', { headers: { Authorization: `Bearer ${token}` } });
    assert.deepEqual((await persisted.json()).facts, facts);
    assert.equal((await send('/api/resume-facts/source', payload)).status, 409, 'stale revisions still conflict');
    payload.expectedFactRevision = 1;
    assert.equal((await send('/api/resume-facts/source', payload, true)).status, 200);
    const invalid = { ...payload, expectedFactRevision: 2, facts: { ...facts, extra: 'a'.repeat(16000) } };
    assert.equal((await send('/api/resume-facts/source', invalid)).status, 400, 'domain 256 KiB limit remains enforced');
    const excessive = { ...payload, facts: { huge: 'x'.repeat(321 * 1024) } };
    for (const direct of [false, true]) {
      assert.equal((await send('/api/resume-facts/source', excessive, direct)).status, 413);
      assert.equal((await send('/api/jobs', payload, direct)).status, 413, 'unrelated routes retain 64 KiB bound');
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await fixture.cleanup();
  }
});
