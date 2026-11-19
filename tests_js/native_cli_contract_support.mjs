import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { snapshotFiles } from './legacy_store_migration_support.mjs';

const execute = promisify(execFile);
const repo = new URL('../', import.meta.url);

export async function invokeCli(home, entrypoint, args, cwd = repo) {
  try {
    const { stdout, stderr } = await execute(process.execPath, [entrypoint, ...args], {
      cwd, env: { HOME: home, PATH: '' }, timeout: 15_000,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    if (error.code !== 2 || error.signal) throw error;
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

export function assertSuccess(result, command) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', command);
  return JSON.parse(result.stdout);
}

export async function cliStore(t) {
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  const home = await realpath(fixture.root);
  const root = join(home, 'store');
  await initializeJobsFixture(root);
  const args = ['runtime/cli/native-jobs.js', '--root', root, '--native-lock', fixture.receipt.artifact];
  const invoke = (command, options = []) => invokeCli(home, args[0], [...args.slice(1), command, ...options]);
  const call = async (command, args) => assertSuccess(await invoke(command, args), command);
  return { root, home, args, invoke, call, lock: fixture.receipt.artifact };
}

export async function assertRejections(store, cases) {
  const before = await snapshotFiles(store.root);
  for (const [command, args, diagnostic] of cases) {
    const result = await store.invoke(command, args);
    assert.equal(result.status, 2, command);
    assert.equal(result.stdout, '', command);
    assert.match(result.stderr, diagnostic, command);
    assert.deepEqual(await snapshotFiles(store.root), before, command);
  }
}
