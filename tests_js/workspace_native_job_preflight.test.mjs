import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, utimes, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
import { NativeResumeFiles } from '../runtime/store/native-resume-files.js';
import { preflightJobRecord } from '../runtime/workspace-core/job-preflight.js';

const plain = value => JSON.parse(serialize(value));
const job = { id: 'job-one', revision: 2, role: 'Engineer', company: 'Fixture', resumeId: null };
const observation = { exists: true, size: 5, modifiedAt: '2026-01-01T00:00:00Z', digest: 'a'.repeat(64) };
const resume = { id: 'resume-one', default: true, deletedAt: null, storageKind: 'managed',
  managedFile: 'resume-one.txt', path: '/synthetic/resume.txt', observedSize: 5,
  observedModifiedAt: observation.modifiedAt, digest: observation.digest };
async function run(input, files) {
  return plain(await preflightJobRecord(fromJSON(input.job), fromJSON({ profile: input.profile }),
    fromJSON({ resumes: input.resumes }), files));
}

test('job preflight agrees with Python for profile facts, resume selection and observation policy', async () => {
  const fixtures = [];
  for (const profile of [{}, { preferences: { title: 'Engineer' } }, { name: '' }, { preferences: {}, identity: {} }]) {
    for (const storageKind of ['managed', 'external']) {
      for (const changed of [{}, { exists: false, size: null, modifiedAt: null, digest: null },
        { size: 8 }, { modifiedAt: '2026-01-02T00:00:00Z' }, { digest: 'b'.repeat(64) }]) {
        fixtures.push({ job, profile, resumes: { 'resume-one': { ...resume, storageKind } },
          observation: { ...observation, ...changed } });
      }
    }
  }
  for (const selectedJob of [{ ...job, resumeId: 'unknown' }, { ...job, role: '', company: '' }, job]) {
    for (const resumes of [{}, { 'resume-one': { ...resume, default: false } },
      { 'resume-one': { ...resume, deletedAt: '2026-01-01T00:00:00Z' } },
      { 'resume-one': resume }]) {
      fixtures.push({ job: selectedJob, profile: { name: 'Fixture' }, resumes, observation });
    }
  }
  fixtures.push({ job: { ...job, resumeId: 'resume-two' }, profile: { name: 'Fixture' },
    resumes: { 'resume-one': resume, 'resume-two': { ...resume, id: 'resume-two', default: false } }, observation });
  const oracle = spawnSync('python3', ['-c', String.raw`
import json,sys
sys.path.insert(0, 'scripts')
from job_apply_store.domains.jobs.overview import JobOverviewMixin
from job_apply_store.domains.profile import ProfileStoreMixin
class Oracle(JobOverviewMixin, ProfileStoreMixin):
    pass
oracle=Oracle()
results=[]
for item in json.load(sys.stdin):
    results.append(oracle._preflight_job_record(item['job'], profile=item['profile'],
        resumes=item['resumes'], resume_observations={key:item['observation'] for key in item['resumes']}))
print(json.dumps(results))
`], { cwd: new URL('..', import.meta.url), input: JSON.stringify(fixtures), encoding: 'utf8' });
  assert.equal(oracle.status, 0, oracle.stderr);
  const actual = [];
  for (const input of fixtures) {
    let calls = 0;
    const files = { observation: async () => { calls++; return input.observation; },
      externalObservation: async () => { calls++; return input.observation; } };
    actual.push(await run(input, files));
    assert.ok(calls <= 1, 'one observation per preflight');
  }
  assert.deepEqual(actual, JSON.parse(oracle.stdout));
});

test('real managed bytes, legacy changes and missing files independently gate readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-preflight-'));
  try {
    await mkdir(join(root, 'resume-files'), { mode: 0o700 });
    const path = join(root, 'resume-files', 'resume-one.txt');
    await writeFile(path, 'alpha', { mode: 0o600 });
    const stamp = new Date('2026-01-01T00:00:00Z');
    await utimes(path, stamp, stamp);
    const record = { ...resume, path, digest: createHash('sha256').update('alpha').digest('hex') };
    const input = { job, profile: { name: 'Fixture' }, resumes: { 'resume-one': record } };
    const files = new NativeResumeFiles(root);
    assert.equal((await run(input, files)).ready, true);
    await writeFile(path, 'bravo');
    await utimes(path, stamp, stamp);
    assert.deepEqual((await run(input, files)).errors, ['resume_file_changed'], 'same-size same-mtime digest change');
    record.storageKind = 'external';
    assert.equal((await run(input, files)).ready, true, 'legacy files do not have a managed digest contract');
    await writeFile(path, 'larger fixture');
    const legacy = await run(input, files);
    assert.equal(legacy.ready, true);
    assert.deepEqual(legacy.warnings, ['resume_file_changed']);
    await unlink(path);
    assert.deepEqual((await run(input, files)).errors, ['resume_file_missing']);
    record.storageKind = 'managed';
    assert.deepEqual((await run(input, files)).errors, ['resume_file_missing']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('observation failures propagate instead of reporting readiness', async () => {
  const input = { job, profile: { name: 'Fixture' }, resumes: { 'resume-one': resume } };
  const failure = new Error('observation unavailable');
  await assert.rejects(run(input, { observation: async () => { throw failure; } }), error => error === failure);
});
