import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertSuccess, invokeCli } from './native_cli_contract_support.mjs';

const helpContract = JSON.parse(await readFile(new URL('../test/fixtures/native-cli-help/options.json', import.meta.url), 'utf8'));
const store = 'runtime/cli/native-jobs.js';
const policy = 'runtime/cli/native-final-action-policy.js';

async function absentStore(t) {
  const home = await mkdtemp(join(tmpdir(), 'native-cli-parser-'));
  t.after(() => rm(home, { force: true, recursive: true }));
  return { home, root: join(home, 'absent') };
}

async function checkHelp(t, entrypoint, contract) {
  const { home, root } = await absentStore(t);
  for (const [command, expected] of Object.entries(contract)) {
    const args = command === '<root>' ? [] : [command];
    const result = await invokeCli(home, entrypoint, ['--root', root, ...args, '--help']);
    assert.equal(result.status, 0, command + ' help: ' + result.stderr);
    assert.equal(result.stderr, '', command);
    assert.match(result.stdout, /^usage:/i, command);
    const options = new Set(result.stdout.match(/--[a-z][a-z-]*/g));
    for (const option of expected) assert.ok(options.has(option), command + ' omits ' + option);
    if (command === '<root>') {
      const commands = result.stdout.match(/\{([^}]+)\}/)?.[1].split(',') ?? [];
      for (const expectedCommand of Object.keys(contract).filter(name => name !== '<root>')) {
        assert.ok(commands.includes(expectedCommand), 'root help omits ' + expectedCommand);
      }
    }
  }
  assert.deepEqual(await readdir(home), []);
}

test('Store help preserves the pinned command and long option inventory without creating a Store', async t => {
  assert.equal(Object.keys(helpContract.store).length, 100);
  await checkHelp(t, store, helpContract.store);
});

test('Policy help preserves root and subcommand usage without creating a Store', async t => {
  assert.equal(Object.keys(helpContract.policy).length, 8);
  await checkHelp(t, policy, helpContract.policy);
});

test('Store parser reports all missing required options without creating a Store', async t => {
  const { home, root } = await absentStore(t);
  const result = await invokeCli(home, store, ['--root', root, 'profile-patch']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage:/i);
  assert.match(result.stderr, /arguments are required: --input, --expected-revision, --source/);
  assert.deepEqual(await readdir(home), []);
});

test('Store parser uses the last occurrence of a repeated scalar option', async t => {
  const { home, root } = await absentStore(t);
  const result = await invokeCli(home, store, ['--root', root, 'answer-key', '--question', 'first', '--question', 'second']);
  assert.deepEqual(assertSuccess(result, 'answer-key'), {
    key: 'question.891773573b9badd710e1064d54147fe20906eb840abcc989b51833af0a0dd3fb',
  });
  assert.deepEqual(await readdir(home), []);
});
