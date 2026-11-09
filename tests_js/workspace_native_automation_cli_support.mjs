import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { parse, serialize } from '../runtime/contracts/workspace/values.js';
import { runNativeAutomationCommand } from '../runtime/cli/native-automation-commands.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

const script = resolve('scripts/job-apply-store.py');
export const fixed = '2026-09-15T12:00:00Z';
export const portal = 'https://example.wd1.myworkdayjobs.com/en-US/careers/job/42';
export const plain = value => JSON.parse(serialize(value));

export function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, key === 'createdAt' || key === 'updatedAt' ? '<timestamp>' : normalized(item)]));
  return value;
}

export function python(root, command, args = [], input) {
  return pythonRaw(root, command, args, input === undefined ? undefined : JSON.stringify(input));
}

export function pythonRaw(root, command, args = [], input) {
  const result = spawnSync('python3.12', [script, '--root', root, command, ...args], {
    encoding: 'utf8', input,
  });
  if (result.status === 0) return { value: JSON.parse(result.stdout) };
  return { error: result.stderr.trim().replace(/^job-apply-store: /, '') };
}

export async function fixture(t) {
  const outer = await nativeFixture();
  t.after(() => outer.cleanup());
  const parent = await realpath(outer.root);
  const nativeRoot = join(parent, 'native');
  const pythonRoot = join(parent, 'python');
  await initializeJobsFixture(nativeRoot);
  assert.ok(python(pythonRoot, 'automation-settings-get').value);
  for (const root of [nativeRoot, pythonRoot]) {
    const path = join(root, 'profile.json');
    const document = JSON.parse(await readFile(path, 'utf8'));
    document.profile.email = 'profile-private@example.invalid';
    document.metadata.revision = 1;
    await writeFile(path, JSON.stringify(document));
  }
  const repository = new NativeJobsRepository(nativeRoot, loadPosixFlockProvider(outer.receipt.artifact));
  const native = async (command, args = [], input, extra = {}) => {
    try {
      const value = await runNativeAutomationCommand(command, args, {
        repository,
        readInput: async path => {
          if (path === '-') return parse(JSON.stringify(input));
          return parse(await readFile(path, 'utf8'));
        },
        now: () => fixed,
        ...extra,
      });
      return { value: value === null ? null : plain(value) };
    } catch (error) { return { error: error.message }; }
  };
  return { ...outer, nativeRoot, pythonRoot, repository, native };
}

export async function documents(state) {
  const read = async (root, name) => JSON.parse(await readFile(join(root, name), 'utf8'));
  return {
    nativeSettings: await read(state.nativeRoot, 'automation-settings.json'),
    pythonSettings: await read(state.pythonRoot, 'automation-settings.json'),
    nativeAccounts: await read(state.nativeRoot, 'employer-accounts.json'),
    pythonAccounts: await read(state.pythonRoot, 'employer-accounts.json'),
  };
}
