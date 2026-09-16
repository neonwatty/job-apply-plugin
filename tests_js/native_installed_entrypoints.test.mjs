import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { initializeJobsFixture } from '../runtime/store/native-jobs.js';

async function installed(t) {
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  const plugin = join(fixture.root, 'plugin');
  await cp(new URL('../runtime/', import.meta.url), join(plugin, 'runtime'), { recursive: true });
  await mkdir(join(plugin, 'native', 'posix'), { recursive: true });
  await cp(new URL('../native/posix/flock.c', import.meta.url), join(plugin, 'native/posix/flock.c'));
  const platform = `${process.platform}-${process.arch}-napi8`;
  const lock = join(plugin, 'native', 'packaged-lock', platform);
  await mkdir(lock, { recursive: true });
  await cp(fixture.receipt.artifact, join(lock, 'flock.node'));
  const { schemaVersion, arch, platform: receiptPlatform, nodeApiVersion, sourceSha256, artifactSha256 } = fixture.receipt;
  await writeFile(join(lock, 'receipt.json'), JSON.stringify({ schemaVersion, arch, platform: receiptPlatform, nodeApiVersion, sourceSha256, artifactSha256 }));
  await writeFile(join(plugin, 'package.json'), '{"type":"module"}');
  const root = join(fixture.root, '.job-apply');
  await initializeJobsFixture(root);
  return { plugin, root };
}

function run(plugin, command, args = []) {
  return spawnSync(process.execPath, [join(plugin, 'runtime/cli', command), ...args], {
    cwd: plugin,
    encoding: 'utf8',
    env: { HOME: plugin.slice(0, plugin.lastIndexOf('/plugin')), PATH: '' },
  });
}

test('installed native Jobs CLI resolves the default root and packaged lock without Python', async t => {
  const { plugin } = await installed(t);
  const result = run(plugin, 'native-jobs.js', ['profile-get']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('installed native task CLI resolves the default root and packaged lock without Python', async t => {
  const { plugin } = await installed(t);
  const result = run(plugin, 'native-task.js', ['snapshot']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).ok, true);
});
