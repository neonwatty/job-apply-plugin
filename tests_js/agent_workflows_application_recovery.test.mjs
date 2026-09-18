import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  applicationRecoveryHostPreflight,
  applicationRecoveryLayout,
} from '../.workflows/fixtures/job-apply.synthetic-application-recovery-v1/host-preflight.mjs';
import { initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { nativeStoreAllowedEntries } from '../runtime/store/native-store-layout.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

const execute = promisify(execFile);
const repository = resolve(new URL('..', import.meta.url).pathname);

test('application-recovery host preflight separates roots and stops before mutation without fixture control', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'application-recovery-preflight-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const journeyRoot = join(parent, 'journey');
  const layout = applicationRecoveryLayout(journeyRoot);
  assert.deepEqual(layout, {
    journeyRoot,
    runnerStoreRoot: join(journeyRoot, 'runner-store'),
    productStoreRoot: join(journeyRoot, 'product-store'),
    productRollbackRoot: join(journeyRoot, 'product-store.python-rollback'),
    legacyProfilePath: join(journeyRoot, 'no-legacy-profile.json'),
  });
  await assert.rejects(
    applicationRecoveryHostPreflight({ journeyRoot, repositoryRoot: repository }),
    /fixture-control is not committed/,
  );
  assert.deepEqual(await readdir(parent), []);
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
