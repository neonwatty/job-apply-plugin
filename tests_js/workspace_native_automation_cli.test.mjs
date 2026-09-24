import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '../runtime/contracts/workspace/values.js';
import { nativeAutomationCapability } from '../runtime/workspace-core/automation.js';
import { fingerprint, operationFingerprint, syntheticProofs } from '../runtime/contracts/workspace/synthetic-account.js';
import { nativeAutomationCommandNames, runNativeAutomationCommand } from '../runtime/cli/native-automation-commands.js';
import { documents, fixture, normalized, plain, portal, python, pythonRaw } from './workspace_native_automation_cli_support.mjs';

const commands = [
  'automation-settings-get', 'automation-settings-update',
  'automation-settings-copy-profile-email', 'automation-capability',
  'account-realm-resolve', 'account-flow-classify', 'employer-account-list', 'employer-account-get',
  'employer-account-create', 'employer-account-update',
  'employer-account-execute-synthetic',
];

test('native account and automation command leaf matches Python public envelopes and durable revisions', async t => {
  const state = await fixture(t);
  const compare = async (command, args = [], input) => {
    const expected = python(state.pythonRoot, command, args, input);
    const actual = await state.native(command, args, input);
    assert.deepEqual(normalized(actual), normalized(expected), `${command} ${args.join(' ')}`);
    assert.doesNotMatch(JSON.stringify(actual), /profile-private|settings-private|account-private/);
    return actual.value;
  };

  await compare('automation-settings-get');
  await compare('automation-settings-update', ['--input', '-', '--expected-revision', '1'], {
    enabled: true, automaticAccountCreation: true,
    signupEmail: 'settings-private@example.invalid', passwordStrategy: 'unique_per_realm',
  });
  await compare('automation-settings-copy-profile-email', [
    '--expected-profile-revision', '1', '--expected-settings-revision', '2',
  ]);
  await compare('automation-settings-update', ['--input', '-', '--expected-revision', '3'], { enabled: true });
  const realm = await compare('account-realm-resolve', ['--url', portal]);
  const accountless = await compare('account-flow-classify', ['--url', 'https://boards.greenhouse.io/acme/jobs/12345']);
  assert.equal(accountless.accountRequired, false);
  const passwordless = await compare('account-flow-classify', ['--url', 'https://my.greenhouse.io/']);
  assert.equal(passwordless.flowKind, 'passwordless_email_code');
  assert.equal(passwordless.accountRequired, false);
  const created = await compare('employer-account-create', ['--url', portal, '--input', '-'], {
    signupEmailOverride: 'account-private@example.invalid',
  });
  assert.equal(Object.hasOwn(created, 'descriptor'), false);
  assert.equal(Object.hasOwn(created, 'signupEmailOverride'), false);
  await compare('employer-account-list');
  await compare('employer-account-get', ['--realm-ref', realm.realmRef]);
  await compare('employer-account-update', [
    '--realm-ref', realm.realmRef, '--input', '-', '--expected-revision', '1',
  ], { signupEmailOverride: null });
  await compare('employer-account-update', [
    '--realm-ref', realm.realmRef, '--input', '-', '--expected-revision', '2',
  ], { signupEmailOverride: null });
  await compare('employer-account-get', ['--realm-ref', 'missing']);
  await compare('account-realm-resolve', ['--url', '']);
  await compare('employer-account-get', ['--realm-ref', '']);

  for (const [command, args, input] of [
    ['automation-settings-update', ['--input', '-', '--expected-revision', '4'], []],
    ['automation-settings-update', ['--input', '-', '--expected-revision', '4'], {}],
    ['automation-settings-update', ['--input', '-', '--expected-revision', '1'], { enabled: false }],
    ['employer-account-create', ['--url', 'https://jobs.example.invalid/42', '--input', '-'], {}],
    ['employer-account-create', ['--url', portal, '--input', '-'], { unknown: true }],
    ['employer-account-create', ['--url', portal, '--input', '-'], {}],
    ['employer-account-update', ['--realm-ref', realm.realmRef, '--input', '-', '--expected-revision', '1'], { signupEmailOverride: null }],
    ['employer-account-update', ['--realm-ref', realm.realmRef, '--input', '-', '--expected-revision', '3'], { providerId: 'secret' }],
  ]) await compare(command, args, input);

  const persisted = await documents(state);
  assert.deepEqual(normalized(persisted.nativeSettings), normalized(persisted.pythonSettings));
  assert.deepEqual(normalized(persisted.nativeAccounts), normalized(persisted.pythonAccounts));
  assert.equal(persisted.nativeSettings.settings.revision, 4);
  assert.equal(persisted.nativeAccounts.accounts[realm.realmRef].revision, 3);
  for (const root of [state.nativeRoot, state.pythonRoot]) {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    for (const name of ['automation-settings.json', 'employer-accounts.json']) {
      assert.equal((await stat(join(root, name))).mode & 0o777, 0o600);
    }
  }
});

test('the leaf owns a closed argument grammar and rejects malformed calls before transactions', async () => {
  assert.deepEqual([...nativeAutomationCommandNames], commands);
  let transactions = 0;
  const context = {
    repository: {
      automationTransaction: async () => { transactions += 1; throw new Error('transaction entered'); },
      accountOperationTransaction: async () => { transactions += 1; throw new Error('transaction entered'); },
    },
    readInput: async () => { throw new Error('input read'); },
  };
  assert.equal(await runNativeAutomationCommand('job-list', [], context), null);
  for (const [command, args, pattern] of [
    ['automation-settings-get', ['extra'], /unexpected CLI argument/],
    ['automation-settings-get', ['--unknown', 'x'], /unsupported native account automation command or option/],
    ['automation-settings-update', ['--input', '-'], /required option: --expected-revision/],
    ['automation-settings-update', ['--input'], /missing CLI option value/],
    ['automation-settings-update', ['--input', '-', '--input', 'again', '--expected-revision', '1'], /duplicate CLI option/],
    ['automation-settings-update', ['--input', '-', '--expected-revision', '1.5'], /positive integer/],
    ['automation-settings-update', ['--input', '-', '--expected-revision', '1__0'], /positive integer/],
    ['automation-capability', ['--platform', 'freebsd'], /platform must be darwin, linux, or win32/],
    ['employer-account-create', [], /required option: --url/],
  ]) await assert.rejects(runNativeAutomationCommand(command, args, context), pattern);
  assert.equal(transactions, 0);
});

test('native capability is side-effect free and synthetic execution remains explicitly injected', async t => {
  const state = await fixture(t);
  const before = {
    settings: await readFile(join(state.nativeRoot, 'automation-settings.json'), 'utf8'),
    accounts: await readFile(join(state.nativeRoot, 'employer-accounts.json'), 'utf8'),
  };
  for (const args of [[], ['--platform', 'darwin'], ['--platform', 'linux'], ['--platform', 'win32']]) {
    const result = await state.native('automation-capability', args);
    assert.deepEqual(result, { value: plain(nativeAutomationCapability()) });
    assert.doesNotMatch(JSON.stringify(result), /private|credential_/);
    assert.deepEqual(result.value.providerId, null);
    assert.equal(result.value.reasonCode, 'native_provider_not_composed');
  }

  const realm = 'a'.repeat(64), control = fingerprint('native-secure-control:v1');
  const base = 'http://127.0.0.1:43123/synthetic-account';
  const operation = operationFingerprint(base, realm, control);
  const target = `${base}?operation=${operation.slice(7)}`;
  const packet = {
    jobId: 'job', expectedJobRevision: 1, expectedClaimId: 'claim', realmRef: realm,
    realmDescriptor: 'descriptor', expectedSettingsRevision: 1, expectedAccountRevision: 1,
    syntheticTargetUrl: target, syntheticTargetFingerprint: fingerprint(target),
    ...plain(syntheticProofs(target)),
  };
  const denied = await state.native('employer-account-execute-synthetic', ['--input', '-'], packet);
  assert.deepEqual(denied, { error: 'native protected provider injection is required' });
  assert.deepEqual(denied, python(state.pythonRoot, 'employer-account-execute-synthetic', ['--input', '-'], packet));
  const liveProvider = { providerId: 'macos-keychain', execute: async () => { throw new Error('must not execute'); } };
  assert.deepEqual(await state.native('employer-account-execute-synthetic', ['--input', '-'], packet,
    { syntheticExecutor: liveProvider }), { error: 'synthetic provider is test-only' });
  let syntheticCalled = false;
  const syntheticProvider = { providerId: 'synthetic-protected', execute: async () => {
    syntheticCalled = true;
    throw new Error('must not execute without a live claim');
  } };
  assert.deepEqual(await state.native('employer-account-execute-synthetic', ['--input', '-'], packet,
    { syntheticExecutor: syntheticProvider }), { error: 'account execution requires the exact live claimed job' });
  assert.equal(syntheticCalled, false);
  assert.equal(await readFile(join(state.nativeRoot, 'automation-settings.json'), 'utf8'), before.settings);
  assert.equal(await readFile(join(state.nativeRoot, 'employer-accounts.json'), 'utf8'), before.accounts);
});

test('signed and stale revision arguments preserve Python domain behavior', async t => {
  for (const revision of ['0_1', ' 1 ', '١']) {
    await t.test(`CPython 3.12 integer spelling ${JSON.stringify(revision)}`, async t => {
      const state = await fixture(t);
      const args = ['--input', '-', '--expected-revision', revision];
      const input = { enabled: true };
      const expected = python(state.pythonRoot, 'automation-settings-update', args, input);
      assert.equal(expected.value.revision, 2);
      assert.deepEqual(normalized(await state.native('automation-settings-update', args, input)), normalized(expected));
    });
  }

  await t.test('automation settings update', async t => {
    const state = await fixture(t);
    const args = revision => ['--input', '-', '--expected-revision', revision];
    for (const revision of ['0', '-1', '+1']) {
      const input = { enabled: true };
      assert.deepEqual(normalized(await state.native('automation-settings-update', args(revision), input)),
        normalized(python(state.pythonRoot, 'automation-settings-update', args(revision), input)));
    }
  });

  await t.test('profile email copy', async t => {
    const state = await fixture(t);
    for (const args of [
      ['--expected-profile-revision', '0', '--expected-settings-revision', '1'],
      ['--expected-profile-revision', '1', '--expected-settings-revision', '-1'],
      ['--expected-profile-revision', '+1', '--expected-settings-revision', '+1'],
    ]) assert.deepEqual(normalized(await state.native('automation-settings-copy-profile-email', args)),
      normalized(python(state.pythonRoot, 'automation-settings-copy-profile-email', args)));
  });

  await t.test('employer account update', async t => {
    const state = await fixture(t);
    const realm = (await state.native('account-realm-resolve', ['--url', portal])).value.realmRef;
    assert.deepEqual(normalized(await state.native('employer-account-create', ['--url', portal])),
      normalized(python(state.pythonRoot, 'employer-account-create', ['--url', portal])));
    for (const revision of ['0', '-1', '+1']) {
      const args = ['--realm-ref', realm, '--input', '-', '--expected-revision', revision];
      const input = { signupEmailOverride: null };
      assert.deepEqual(normalized(await state.native('employer-account-update', args, input)),
        normalized(python(state.pythonRoot, 'employer-account-update', args, input)));
    }
  });
});

test('unreadable input failures use the stable Python error envelope', async t => {
  const state = await fixture(t);
  const stdinArgs = ['--input', '-', '--expected-revision', '1'];
  const malformed = await state.native('automation-settings-update', stdinArgs, undefined, {
    readInput: async () => parse('{'),
  });
  assert.deepEqual(malformed, pythonRaw(state.pythonRoot, 'automation-settings-update', stdinArgs, '{'));
  assert.deepEqual(malformed, { error: 'input is not a readable JSON object' });

  const missing = join(state.nativeRoot, 'caller-private-missing.json');
  const fileArgs = ['--input', missing, '--expected-revision', '1'];
  const unreadable = await state.native('automation-settings-update', fileArgs);
  assert.deepEqual(unreadable, python(state.pythonRoot, 'automation-settings-update', fileArgs));
  assert.deepEqual(unreadable, { error: 'input is not a readable JSON object' });
  assert.doesNotMatch(JSON.stringify(unreadable), /caller-private-missing/);
});
