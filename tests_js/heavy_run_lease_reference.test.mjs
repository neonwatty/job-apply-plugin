import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { captureHeavyRunLeaseReference } from '../tools/contracts/heavy-run-lease/reference.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let capture;
async function receipt(t) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.skip('Native darwin arm64 reference only; this platform remains unaccepted'); return null;
  }
  capture ??= captureHeavyRunLeaseReference();
  return capture;
}
function expected(id, inherited, whileGrandchildAlive, boundary) {
  return { id, inherited, initiallyAcquired: false, whileGrandchildAlive, afterCompletion: true,
    events: ['holder-locked', 'grandchild-ready', 'initial-contender-observed', boundary,
      'grandchild-before', 'live-contender-observed', 'grandchild-after', 'grandchild-stopped',
      'owned-output-closed', 'final-contender-observed'] };
}
async function verifyCase(t, row) {
  const result = await receipt(t);
  if (result) assert.deepEqual(result.cases.find(item => item.id === row.id), row);
}

test('P04.R inherited flock remains held after parent descriptor close', t => verifyCase(t,
  expected('parent-close', true, false, 'holder-closed')));
test('P04.R inherited flock remains held after parent SIGKILL', t => verifyCase(t,
  expected('parent-death', true, false, 'holder-killed')));
test('P04.R dropped descriptor does not protect a surviving grandchild', t => verifyCase(t,
  expected('dropped-descriptor', false, true, 'holder-killed')));
test('P04.R shared explicit unlock releases despite retained descriptors', t => verifyCase(t,
  expected('explicit-unlock', true, true, 'holder-unlocked')));
test('P04.R native inheritance reference binds provenance and completes cleanup', async t => {
  const result = await receipt(t);
  if (!result) return;
  assert.deepEqual(Object.keys(result).sort(), ['artifactObservedSha256', 'build', 'cases', 'cleanup', 'profile', 'schemaVersion', 'scope']);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.scope, 'disposable-flock-descriptor-inheritance-only');
  const executablePath = realpathSync(process.execPath);
  assert.deepEqual(result.profile, { platform: 'darwin', arch: 'arm64', nodeVersion: process.versions.node,
    executablePath, executableSha256: hash(readFileSync(executablePath)) });
  assert.deepEqual(result.cases.map(row => row.id), ['parent-close', 'parent-death', 'dropped-descriptor', 'explicit-unlock']);
  const build = result.build;
  assert.deepEqual(Object.keys(build).sort(), ['arch', 'artifact', 'artifactSha256', 'headerHashes',
    'nodeApiVersion', 'nodeVersion', 'platform', 'schemaVersion', 'sourceSha256']);
  assert.equal(build.schemaVersion, 1); assert.equal(build.platform, 'darwin'); assert.equal(build.arch, 'arm64');
  assert.equal(build.nodeApiVersion, 8); assert.equal(build.nodeVersion, process.versions.node);
  const source = fileURLToPath(new URL('../native/posix/flock.c', import.meta.url));
  assert.equal(build.sourceSha256, hash(readFileSync(source)));
  const headerRoot = join(dirname(dirname(executablePath)), 'include/node');
  const headers = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h'];
  assert.deepEqual(Object.keys(build.headerHashes).sort(), [...headers].sort());
  for (const name of headers) assert.equal(build.headerHashes[name], hash(readFileSync(join(headerRoot, name))));
  assert.match(build.artifactSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.artifactObservedSha256, build.artifactSha256);
  assert.equal(build.artifact, join(result.cleanup.temporaryRoot, 'addon', 'flock.node'));
  assert.equal(result.cleanup.descendantsCompleted, true); assert.equal(result.cleanup.removed, true);
  assert.equal(existsSync(result.cleanup.temporaryRoot), false);
  t.diagnostic(`Native ${result.profile.platform}/${result.profile.arch}, Node ${result.profile.nodeVersion}; Linux and Windows unobserved`);
});
