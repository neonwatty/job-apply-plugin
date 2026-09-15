import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { prepareCanonicalStoreClone } from '../runtime/store/native-store-clone.js';
import { activateNativeWriter, recoverNativeWriterSwitch, rollbackNativeWriter } from '../runtime/store/native-writer-switch.js';
import { withExclusiveFileLock } from '../runtime/store/exclusive-file-lock.js';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';

const execute = promisify(execFile), fixed = '2026-09-14T12:00:00Z';
const python = `
import sys,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('switch_reference','scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.utc_now=lambda:'${fixed}'
s=m.Store(Path(sys.argv[1]));s.initialize()
s.create_job({'id':'python-job','url':'https://example.invalid/python','role':'Python Engineer'})
`;

async function setup(t) {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const root = await realpath(fixture.root), active = join(root, 'store'), candidate = `${active}.native-candidate`;
  await execute('python3', ['-c', python, active]);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  await prepareCanonicalStoreClone(active, candidate, provider, fixed);
  return { root, active, candidate, provider };
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

test('writer switch activates a prepared clone and restores exact Python bytes after native writes', { timeout: 60000 }, async t => {
  const { active, candidate, provider } = await setup(t), before = await snapshot(active);
  await activateNativeWriter(active, candidate, { provider });
  assert.equal(await recoverNativeWriterSwitch(active, { provider }), 'native');
  const jobs = new JobsService(new NativeJobsRepository(active, provider), () => fixed, () => 'native-job');
  await jobs.create(fromJSON({ url: 'https://example.invalid/native', role: 'Native Engineer' }));
  assert.deepEqual(JSON.parse(serialize(await jobs.list())).map(job => job.id).sort(), ['native-job', 'python-job']);
  await rollbackNativeWriter(active, { provider });
  assert.equal(await recoverNativeWriterSwitch(active, { provider }), 'python');
  assert.deepEqual(await snapshot(active), before);
  const retained = new JobsService(new NativeJobsRepository(`${active}.native-retained`, provider));
  assert.deepEqual(JSON.parse(serialize(await retained.list())).map(job => job.id).sort(), ['native-job', 'python-job']);
});

for (const [boundary, expected] of [
  ['before-source-rename', 'python'], ['after-source-rename', 'python'], ['after-candidate-rename', 'native'],
  ['before-native-rename', 'native'], ['after-native-rename', 'python'], ['after-python-rename', 'python'],
]) {
  test(`writer switch recovery resolves interruption at ${boundary}`, { timeout: 60000 }, async t => {
    const { active, candidate, provider } = await setup(t), before = await snapshot(active);
    const fail = { provider, boundary: point => { if (point === boundary) throw new Error(`fault:${point}`); } };
    if (boundary.includes('source') || boundary.includes('candidate')) {
      await assert.rejects(activateNativeWriter(active, candidate, fail), new RegExp(`fault:${boundary}`));
    } else {
      await activateNativeWriter(active, candidate, { provider });
      await assert.rejects(rollbackNativeWriter(active, fail), new RegExp(`fault:${boundary}`));
    }
    assert.equal(await recoverNativeWriterSwitch(active, { provider }), expected);
    if (expected === 'python') assert.deepEqual(await snapshot(active), before);
  });
}

test('writer switch rejects ambiguous or adopted paths', { timeout: 60000 }, async t => {
  const { active, candidate, provider } = await setup(t);
  await assert.rejects(activateNativeWriter(active, `${candidate}-other`, { provider }), /paths are invalid/);
  const jobs = JSON.parse(await readFile(join(active, 'jobs.json'), 'utf8'));
  jobs.jobs['post-clone-job'] = { id: 'post-clone-job', url: 'https://example.invalid/later', role: 'Later' };
  await writeFile(join(active, 'jobs.json'), JSON.stringify(jobs), { mode: 0o600 });
  await assert.rejects(activateNativeWriter(active, candidate, { provider }), /does not match/);
  await writeFile(`${active}.python-rollback`, 'ambiguous', { mode: 0o600 });
  await assert.rejects(recoverNativeWriterSwitch(active, { provider }), /invalid|ambiguous/);
});

test('writer switch waits for active Store transactions and leaves both roots unmoved on cancellation', { timeout: 60000 }, async t => {
  const { active, candidate, provider } = await setup(t), before = await snapshot(active);
  let release, entered;
  const ready = new Promise(done => { entered = done; });
  const held = new Promise(done => { release = done; });
  const transaction = withExclusiveFileLock(join(active, '.store.lock'), async () => { entered(); await held; }, {
    provider, pathProfile: '3.12', signal: AbortSignal.timeout(5000),
  });
  await ready;
  await assert.rejects(activateNativeWriter(active, candidate, {
    provider, signal: AbortSignal.timeout(50),
  }), error => error?.name === 'AbortError' || error?.name === 'TimeoutError');
  assert.deepEqual(await snapshot(active), before);
  assert.equal(JSON.parse(await readFile(join(candidate, '.native-store-clone'), 'utf8')).mode, 'canonical-store-clone');
  release(); await transaction;
});
