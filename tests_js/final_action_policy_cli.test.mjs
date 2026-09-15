import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { root, campaignInput, authorization, capability } from './final_action_policy_support.mjs';

async function packaged(t) {
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  const plugin = join(fixture.root, 'plugin');
  await mkdir(plugin);
  await cp(join(root, 'runtime'), join(plugin, 'runtime'), { recursive: true });
  await writeFile(join(plugin, 'package.json'), '{"type":"module"}');
  const native = join(plugin, 'native', 'packaged-lock', `${process.platform}-${process.arch}-napi8`);
  await mkdir(native, { recursive: true });
  await cp(fixture.receipt.artifact, join(native, 'flock.node'));
  await mkdir(join(plugin, 'native', 'posix'), { recursive: true });
  await cp(join(root, 'native/posix/flock.c'), join(plugin, 'native/posix/flock.c'));
  const { schemaVersion, arch, platform, nodeApiVersion, sourceSha256, artifactSha256 } = fixture.receipt;
  await writeFile(join(native, 'receipt.json'), JSON.stringify({ schemaVersion, arch, platform, nodeApiVersion, sourceSha256, artifactSha256 }));
  const cli = join(plugin, 'runtime/cli/native-final-action-policy.js');
  return { fixture, plugin, cli, run: (args, input, env = {}) => spawnSync(process.execPath, [cli, ...args], {
    cwd: plugin, encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input), env: { PATH: '', HOME: fixture.root, ...env },
  }) };
}
function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(result.stdout, JSON.stringify(value, Object.keys(value).sort(), 2) + '\n');
  return value;
}
test('all seven packaged CLI commands work without Python or browser authority', async t => {
  const source = await readFile(join(root, 'runtime/cli/native-final-action-policy.js'), 'utf8').catch(() => null);
  assert.ok(source, 'native policy CLI is not implemented');
  assert.doesNotMatch(source, /(?:browser|qa\/|job_apply_policy\.py)/i);
  const { fixture, run } = await packaged(t);
  const store = join(fixture.root, 'store');
  const prefix = ['--root', store];
  assert.equal(success(run([...prefix, 'status'])).reason, 'policy_unavailable');
  // Nested keys require full canonical serialization; validate activation separately.
  const activation = run([...prefix, 'activate', '--input', '-'], campaignInput);
  assert.equal(activation.status, 0, activation.stderr);
  const campaign = JSON.parse(activation.stdout);
  assert.equal(campaign.status, 'active');
  const inputPath = join(fixture.root, 'authorization.json');
  await writeFile(inputPath, JSON.stringify(authorization));
  const lease = success(run([...prefix, 'authorize', '--input', inputPath]));
  const claim = success(run([...prefix, 'claim-final-action', '--input', '-', '--application-ref', authorization.applicationRef,
    '--lease-id', lease.leaseId, '--attempt', '1', '--action-capability', capability], authorization));
  const receipt = success(run([...prefix, 'record-outcome', '--campaign-id', campaign.campaignId,
    '--application-ref', authorization.applicationRef, '--lease-id', lease.leaseId, '--claim-id', claim.claimId, '--outcome', 'uncertain']));
  assert.equal(receipt.status, 'retry_available');
  assert.equal(success(run([...prefix, 'revoke'])).reason, 'revoked');
  assert.equal(success(run([...prefix, 'kill'])).reason, 'killed');
  assert.equal(success(run(['status'], undefined, { JOB_APPLY_STORE_DIR: store })).reason, 'kill_switch');
  assert.equal(success(run(['status'])).reason, 'policy_unavailable');
  assert.equal(success(run(['--root', store, 'status'], undefined, { JOB_APPLY_STORE_DIR: '/nonexistent' })).reason, 'kill_switch');
  for (const [args, input] of [
    [[...prefix, 'activate', '--input', '-'], { ...campaignInput, raw: 'private-marker' }],
    [[...prefix, 'claim-final-action', '--input', '-'], authorization],
    [[...prefix, 'record-outcome', '--outcome', 'private-marker'], undefined],
    [[...prefix, 'unknown-private-marker'], undefined],
    [[...prefix, 'status', '--private-marker', 'secret'], undefined],
    [[...prefix, 'activate', '--input', '/private-marker'], undefined],
  ]) {
    const result = run(args, input);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^job-apply-policy: /);
    assert.doesNotMatch(result.stderr, /private-marker|secret|at file:/);
  }
});

test('raw JSON decimal and boolean authority integers are denied without normalizing the Store', async t => {
  const { fixture, cli, plugin } = await packaged(t);
  for (const token of ['1.0', '1e0', 'true']) {
    const input = JSON.stringify({ ...campaignInput, maxApplications: 'TOKEN' }).replace('"TOKEN"', token);
    const result = spawnSync(process.execPath, [cli, '--root', join(fixture.root, 'strict'), 'activate', '--input', '-'], {
      cwd: plugin, encoding: 'utf8', input, env: { PATH: '' },
    });
    assert.equal(result.status, 2, token);
    assert.equal(result.stdout, '');
  }
});

test('packaged activation rejects uppercase IPvFuture introducers without persisting campaigns', async t => {
  const { fixture, run } = await packaged(t);
  for (const [index, introducer] of ['VF', 'Vf', 'vF', 'vf'].entries()) {
    const store = join(fixture.root, `ipvfuture-${index}`);
    const input = { ...campaignInput, applicationRules: [{ ...campaignInput.applicationRules[0], origin: `https://[${introducer}.abc]` }] };
    const result = run(['--root', store, 'activate', '--input', '-'], input);
    if (introducer.startsWith('V')) {
      assert.equal(result.status, 2, introducer);
      assert.equal(result.stdout, '');
      assert.equal(success(run(['--root', store, 'status'])).reason, 'policy_unavailable');
      await assert.rejects(readFile(join(store, 'auto-submit/campaign.json')), { code: 'ENOENT' });
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).applicationRules[0].origin, input.applicationRules[0].origin);
      assert.equal(success(run(['--root', store, 'status'])).mode, 'auto_submit');
    }
  }
});
