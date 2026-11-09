import assert from 'node:assert/strict';
import { lstat, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createManagedResumeNativeIO } from '../runtime/store/managed-resume-native.js';
import { managedResumeObservation } from '../runtime/store/managed-resume-observation.js';
import { StoreValidationError } from '../runtime/store/validation.js';
import { setup, snapshot, nowMicroseconds } from './managed_observation_ts_support.mjs';

const reference = fileURLToPath(new URL('../tools/contracts/managed-observation/native.py', import.meta.url));
const cases = ['normal', 'missing', 'directory', 'symlink', 'oversized', 'traversal', 'nul-leaf', 'surrogate-leaf'];

for (const version of ['3.12', '3.13', '3.14']) {
  test(`native managed observation matches Python ${version} on independent trees`, async (t) => {
    if (process.platform === 'win32') { t.skip('POSIX adapter; Windows native lane remains required'); return; }
    const executable = `python${version}`;
    const probe = spawnSync(executable, ['-I', '-c', 'import platform; print(platform.python_version())'], {
      encoding: 'utf8', timeout: 10000,
    });
    if (probe.error?.code === 'ENOENT') { t.skip('Required interpreter unavailable'); return; }
    assert.equal(probe.status, 0, probe.stderr);
    assert.ok(probe.stdout.startsWith(version + '.'));
    for (const id of cases) await t.test(id, async () => {
      const python = await setup(id);
      const native = await setup(id);
      try {
        const name = { traversal: '../synthetic.bin', 'nul-leaf': 'bad\0file', 'surrogate-leaf': 'bad\ud800file' }[id] ?? 'synthetic.bin';
        const record = { id: 'synthetic', storageKind: 'managed', managedFile: name };
        const beforePython = await snapshot(python.root);
        const beforeNative = await snapshot(native.root);
        const run = spawnSync(executable, ['-I', reference], {
          input: JSON.stringify({ root: python.root, record }), encoding: 'utf8', timeout: 10000,
        });
        assert.equal(run.status, 0, run.stderr);
        const expected = JSON.parse(run.stdout);
        const io = createManagedResumeNativeIO(native.root, {
          pathProfile: version, statTimeMode: 'fused', nowMicroseconds: () => nowMicroseconds,
        });
        const cache = new Map();
        const outcomes = [];
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const value = await managedResumeObservation(new Map(Object.entries(record)), io, cache);
            outcomes.push({ kind: 'value', value: { ...value, size: value.size === null ? null : Number(value.size) } });
          } catch (error) {
            // Existing typed Store errors represent Python StoreError; preserve its exact message.
            const outcome = { kind: 'error', name: error instanceof StoreValidationError ? 'StoreError' : error.name };
            if (error instanceof StoreValidationError) outcome.message = error.message;
            outcomes.push(outcome);
          }
        }
        assert.deepEqual(outcomes, expected.outcomes);
        const view = {};
        for (const [key, entry] of cache) {
          const info = await lstat(native.path, { bigint: true });
          view[key] = { digest: entry.digest, checkedAt: '2026-01-02T00:00:00+00:00',
            identityMatchesFile: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs]
              .every((value, index) => value === entry.identity[index]) };
          assert.equal(entry.checkedAt, nowMicroseconds);
        }
        assert.deepEqual(view, expected.cache);
        assert.deepEqual(await snapshot(python.root), beforePython);
        assert.deepEqual(await snapshot(native.root), beforeNative);
      } finally {
        await rm(python.root, { recursive: true, force: true });
        await rm(native.root, { recursive: true, force: true });
      }
    });
  });
}
