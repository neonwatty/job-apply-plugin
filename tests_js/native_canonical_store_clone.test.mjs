import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { prepareCanonicalStoreClone } from '../runtime/store/native-store-clone.js';
import { nativeFixtureMarker, nativeStoreRequiredEntries } from '../runtime/store/native-store-layout.js';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';

const execute = promisify(execFile), fixed = '2026-09-14T12:00:00Z';
const python = `
import sys,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('clone_reference','scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.utc_now=lambda:'${fixed}'
s=m.Store(Path(sys.argv[1]));s.initialize()
s.create_job({'id':'clone-job','url':'https://example.invalid/job','role':'Engineer'})
resume_source=Path(sys.argv[1]).parent/'clone-resume-source.txt'
resume_source.write_text('Managed resume bytes')
s.import_resume({'id':'clone-resume','label':'Clone resume','path':str(resume_source)})
resume_source.unlink()
`;

async function canonicalSource(root, name) {
  const source = join(root, name);
  await execute('python3', ['-c', python, source]);
  return source;
}

async function snapshot(root) {
  const result = {};
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), metadata = await stat(path);
    if (metadata.isDirectory()) {
      for (const child of (await readdir(path)).sort()) result[`${name}/${child}`] = await readFile(join(path, child), 'base64');
    } else result[name] = await readFile(path, 'base64');
  }
  return result;
}

test('canonical Store clone leaves Python source untouched and supports durable native edits', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const root = await realpath(fixture.root);
  const source = await canonicalSource(root, 'source'), target = join(root, 'clone');
  const before = await snapshot(source), provider = loadPosixFlockProvider(fixture.receipt.artifact);
  await prepareCanonicalStoreClone(source, target, provider, fixed);
  assert.deepEqual(await snapshot(source), before);
  assert.deepEqual((await readdir(target)).sort(), [...nativeStoreRequiredEntries, '.native-store-clone', 'resume-facts.json'].sort());
  const marker = JSON.parse(await readFile(join(target, '.native-store-clone'), 'utf8'));
  assert.equal(marker.mode, 'canonical-store-clone');
  assert.equal(marker.version, 2);
  assert.match(marker.sourceTree, /^sha256:[0-9a-f]{64}$/);
  assert.match(marker.candidateTree, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await stat(join(target, '.native-store-clone'))).mode & 0o777, 0o600);
  const jobs = new JobsService(new NativeJobsRepository(target, provider), () => fixed, () => 'native-job');
  assert.deepEqual(JSON.parse(serialize(await jobs.list())).map(job => job.id), ['clone-job']);
  const resumes = new ResumeService(new NativeJobsRepository(target, provider));
  assert.equal(JSON.parse(serialize(await resumes.check('clone-resume'))).changed, false);
  await jobs.create(fromJSON({ url: 'https://example.invalid/native', role: 'Native Engineer' }));
  const reopened = new JobsService(new NativeJobsRepository(target, provider));
  assert.deepEqual(JSON.parse(serialize(await reopened.list())).map(job => job.id).sort(), ['clone-job', 'native-job']);
  assert.deepEqual(await snapshot(source), before);
});

test('canonical Store clone rejects existing targets and unsupported source state without adoption', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const root = await realpath(fixture.root);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const existingSource = await canonicalSource(root, 'existing-source');
  const existingTarget = join(root, 'existing-target');
  await mkdir(existingTarget, { mode: 0o700 }); await writeFile(join(existingTarget, 'keep'), 'unchanged', { mode: 0o600 });
  await assert.rejects(prepareCanonicalStoreClone(existingSource, existingTarget, provider, fixed));
  assert.equal(await readFile(join(existingTarget, 'keep'), 'utf8'), 'unchanged');

  for (const kind of ['auto-submit', 'symlink']) await t.test(kind, async () => {
    const source = await canonicalSource(root, `${kind}-source`), target = join(root, `${kind}-target`);
    if (kind === 'auto-submit') await mkdir(join(source, 'auto-submit'), { mode: 0o700 });
    else await symlink(join(source, 'jobs.json'), join(source, 'resume-files', 'unsafe.pdf'));
    const before = await snapshot(source);
    await assert.rejects(prepareCanonicalStoreClone(source, target, provider, fixed), /unsupported|regular files/);
    await assert.rejects(stat(target), error => error.code === 'ENOENT');
    assert.deepEqual(await snapshot(source), before);
  });
});

test('native repository requires exactly one valid ownership marker', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const root = await realpath(fixture.root);
  const source = await canonicalSource(root, 'marker-source'), target = join(root, 'marker-target');
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  await prepareCanonicalStoreClone(source, target, provider, fixed);
  const markerPath = join(target, '.native-store-clone'), marker = await readFile(markerPath);
  const valid = JSON.parse(marker.toString('utf8'));
  for (const invalid of [
    { mode: valid.mode, version: 1, sourceTree: valid.sourceTree },
    { ...valid, sourceTree: 'fabricated' },
    { ...valid, candidateTree: 'fabricated' },
    { ...valid, candidateTree: undefined },
  ]) {
    await writeFile(markerPath, JSON.stringify(invalid));
    await assert.rejects(new NativeJobsRepository(target, provider).transaction(async () => {}), /clone marker is invalid/);
  }
  await writeFile(markerPath, marker);
  await writeFile(join(target, '.native-jobs-fixture'), nativeFixtureMarker, { mode: 0o600 });
  await assert.rejects(new NativeJobsRepository(target, provider).transaction(async () => {}), /unsupported state/);
  await unlink(join(target, '.native-jobs-fixture'));
  await new NativeJobsRepository(target, provider).transaction(async () => {});
});
