import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { NativeMacOSEmailOnlyExecutor } from '../runtime/native/macos/account-flow-adapter.js';
import { buildReviewedOracleHelper } from '../runtime/native/macos/build.js';
import { ReviewedMacOSHelperIdentity } from '../runtime/native/macos/identity.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const darwin = process.platform === 'darwin';
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

async function compileFixture(root) {
  const source = join(root, 'fixture.swift'), binary = join(root, 'fixture');
  await writeFile(source, `import Foundation\nimport Darwin\nlet a = CommandLine.arguments\nguard a.count == 18, a[1] == "oracle-email-only-inherited", let pid = Int(a[2]),\n  let attest = Int32(a[16]), let secret = Int32(a[17]) else { exit(91) }\nif pid == 125 { exit(23) }\nif pid == 126 { sleep(10) }\nvar bytes = [UInt8](repeating: 0, count: 255)\nlet count = Darwin.read(secret, &bytes, bytes.count)\nguard count > 2, String(bytes: bytes[0..<count], encoding: .utf8)?.contains("@") == true else { exit(22) }\nbytes = [UInt8](repeating: 0, count: 255)\nlet payload: [String: Any] = pid == 124 ? [:] : [\n  "operationFingerprint": pid == 127 ? "sha256:" + String(repeating: "a", count: 64) : a[15], "nativeOriginAttested": true,\n  "signedBrowserIdentityAttested": true, "emailFilledAttested": true,\n  "termsAcceptedAttested": true, "nextActivatedExactlyOnce": true,\n  "emailRemovedAttested": true, "finalActionActivated": false,\n  "credentialProviderInvocations": 0, "outcome": "active"]\nvar data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]); data.append(10)\n_ = data.withUnsafeBytes { Darwin.send(attest, $0.baseAddress, data.count, 0) }\nvar ack: UInt8 = 0\nguard Darwin.recv(attest, &ack, 1, 0) == 1, ack == 1 else { exit(92) }\n`);
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/xcrun', ['swiftc', '-O', '-o', binary, source], { stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`swiftc ${code}`)));
  });
  await chmod(binary, 0o700);
  return binary;
}

function request() {
  const descriptor = 'oracle-recruiting:v1:tenant.fa.us2.oraclecloud.com:jobsearch';
  const controls = ['form', 'email', 'terms', 'document', 'next'].map(digest);
  return fromJSON({
    jobId: 'oracle-job', jobRevision: 4, expectedClaimId: 'claim-id',
    realmRef: createHash('sha256').update(descriptor).digest('hex'), realmDescriptor: descriptor,
    flowKind: 'email_only_candidate_profile', accountRevision: 2, settingsRevision: 3,
    portalUrl: 'https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/7/apply/email',
    accountFormFingerprint: controls[0], emailControlFingerprint: controls[1],
    termsControlFingerprint: controls[2], termsDocumentFingerprint: controls[3],
    nextControlFingerprint: controls[4], passwordControlFingerprint: null,
    createAccountControlFingerprint: null, accountCreationControlsFingerprint: digest(controls.join(':')),
    operationFingerprint: digest('operation'),
  });
}

test('native macOS email adapter uses pinned binary and inherited value-free channels', { skip: !darwin, timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'job-apply-native-ts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = await compileFixture(root);

  await t.test('accepts one exact attestation without exposing the email', async () => {
    const identity = await ReviewedMacOSHelperIdentity.pin(binary);
    const result = await new NativeMacOSEmailOnlyExecutor(identity, 123).execute(request(), () => 'private@example.invalid');
    assert.deepEqual(JSON.parse(serialize(result)), {
      credentialProviderInvocations: 0, emailRemoved: true, finalActionAuthorized: false,
      nextActivations: 1, outcome: 'active', providerId: 'macos-accessibility',
      retryAllowed: false, termsAccepted: true,
    });
  });

  await t.test('rejects malformed attestation and process loss', async () => {
    const identity = await ReviewedMacOSHelperIdentity.pin(binary);
    await assert.rejects(new NativeMacOSEmailOnlyExecutor(identity, 124, 3000)
      .execute(request(), () => 'private@example.invalid'), /attestation is invalid/);
    await assert.rejects(new NativeMacOSEmailOnlyExecutor(identity, 125, 3000)
      .execute(request(), () => 'private@example.invalid'), /failed closed \(effect\)/);
    await assert.rejects(new NativeMacOSEmailOnlyExecutor(identity, 126, 50)
      .execute(request(), () => 'private@example.invalid'), /execution timed out/);
    await assert.rejects(new NativeMacOSEmailOnlyExecutor(identity, 127, 3000)
      .execute(request(), () => 'private@example.invalid'), /attestation is invalid/);
  });

  await t.test('rejects changed execution permissions before requesting private identity', async () => {
    const identity = await ReviewedMacOSHelperIdentity.pin(binary);
    await chmod(binary, 0o600);
    let requested = false;
    await assert.rejects(new NativeMacOSEmailOnlyExecutor(identity, 123)
      .execute(request(), () => { requested = true; return 'private@example.invalid'; }), /identity is invalid/);
    assert.equal(requested, false);
    await chmod(binary, 0o700);
  });

  await t.test('rejects substitution before requesting private identity', async () => {
    const identity = await ReviewedMacOSHelperIdentity.pin(binary);
    await writeFile(binary, Buffer.concat([await readFile(binary), Buffer.of(0)]));
    let requested = false;
    await assert.rejects(new NativeMacOSEmailOnlyExecutor(identity, 123)
      .execute(request(), () => { requested = true; return 'private@example.invalid'; }), /identity is invalid/);
    assert.equal(requested, false);
  });
});

test('TypeScript builder compiles and pins the exact reviewed Swift set', { skip: !darwin, timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'job-apply-reviewed-ts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = await buildReviewedOracleHelper(root);
  assert.equal(await identity.verifiedPath(), await realpath(join(root, 'job-apply-reviewed-oracle-helper')));
});
