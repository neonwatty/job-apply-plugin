import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePackagedNativeLock } from '../runtime/package/native-lock-artifact.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { rollbackNativeWriter } from '../runtime/store/native-writer-switch.js';

const execute = promisify(execFile);
export async function snapshotFiles(root, prefix = '') {
  const entries = {};
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw Error('Migration fixture contains a symlink');
    if (item.isDirectory()) Object.assign(entries, await snapshotFiles(root, name));
    else entries[name] = await readFile(join(root, name));
  }
  return entries;
}
async function privatize(root) {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await privatize(join(root, entry.name));
    else await chmod(join(root, entry.name), 0o600);
  }
}
export async function verifyLegacyMigration(source, work, plugin) {
  const root = join(work, 'store');
  await cp(source, root, { recursive: true }); await privatize(root);
  const before = await snapshotFiles(root);
  const call = async args => JSON.parse((await execute(process.execPath,
    [join(plugin, 'apps/companion/command.mjs'), 'store', '--root', root, ...args],
    { cwd: plugin, env: { HOME: work, PATH: '' }, timeout: 30_000 })).stdout);
  const profile = await call(['profile-get']);
  assert.equal(profile.name, 'Synthetic Migration Applicant');
  for (const [name, bytes] of Object.entries(before)) {
    assert.deepEqual(await readFile(join(`${root}.python-rollback`, name)), bytes, `retained ${name}`);
    assert.deepEqual(await readFile(join(root, name)), bytes, `active ${name}`);
  }
  const input = join(work, 'job.json');
  await writeFile(input, JSON.stringify({ id: 'migration-job', role: 'Synthetic Engineer', url: 'https://example.invalid/migration' }), { mode: 0o600 });
  await call(['job-create', '--input', input]);
  assert.equal((await call(['job-list']))[0].id, 'migration-job');
  assert.equal((await call(['profile-get'])).name, profile.name, 'independent CLI restart preserves profile');
  const provider = loadPosixFlockProvider(await resolvePackagedNativeLock(plugin));
  await rollbackNativeWriter(root, { provider });
  for (const [name, bytes] of Object.entries(before)) assert.deepEqual(await readFile(join(root, name)), bytes, `restored ${name}`);
  assert.equal(JSON.parse(await readFile(join(`${root}.native-retained`, 'jobs.json'), 'utf8')).jobs['migration-job'].id, 'migration-job');
  return { originalFiles: Object.keys(before).length, backupBytesPreserved: true, restart: true, rollback: true };
}
