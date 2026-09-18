import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeJobsCommandFields, storeRequiredOptions } from '../runtime/cli/native-jobs.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.JOB_APPLY_REFERENCE_PYTHON || 'python3.12';
const invoke = (executable, path, args) => spawnSync(executable, [join(root, path), ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, JOB_APPLY_STORE_DIR: join(tmpdir(), 'job-apply-cli-parity-never-create') },
});
const storePython = args => invoke(python, 'scripts/job-apply-store.py', args);
const storeNative = args => invoke(process.execPath, 'runtime/cli/native-jobs.js', args);
const policyPython = args => invoke(python, 'scripts/job_apply_policy.py', args);
const policyNative = args => invoke(process.execPath, 'runtime/cli/native-final-action-policy.js', args);

function help(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.equal(result.stderr, '', label);
  assert.match(result.stdout, /usage:/i, label);
}

test('Store help covers every Python command and its long options without a Store', () => {
  const reference = storePython(['--help']);
  const native = storeNative(['--help']);
  help(reference, 'Python Store'); help(native, 'native Store');
  const commands = reference.stdout.match(/\{([^}]+)\}/)?.[1].split(',') ?? [];
  assert.equal(commands.length, 98);
  assert.deepEqual(commands.filter(name => !Object.hasOwn(nativeJobsCommandFields, name)), []);
  for (const command of commands) {
    const source = storePython([command, '--help']);
    const candidate = storeNative([command, '--help']);
    help(source, `Python ${command}`); help(candidate, `native ${command}`);
    for (const option of source.stdout.match(/--[a-z][a-z-]*/g) ?? []) {
      assert.ok(candidate.stdout.includes(option), `${command} help omits ${option}`);
    }
  }
});

test('Store parse errors match Python exit status and do not create a Store', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'store-cli-parity-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = join(parent, 'absent');
  const args = ['--root', target, 'profile-patch'];
  const source = storePython(args), candidate = storeNative(args);
  assert.equal(source.status, 2);
  assert.equal(candidate.status, 2);
  assert.equal(candidate.stdout, '');
  assert.match(candidate.stderr, /usage:/i);
  for (const option of ['--input', '--expected-revision', '--source']) {
    assert.ok(candidate.stderr.includes(option), `missing ${option} in diagnostic`);
  }
  assert.deepEqual(await readdir(parent), []);
});

test('Store required-option metadata remains aligned with the Python parser', () => {
  const script = `import argparse, importlib.util, json
spec=importlib.util.spec_from_file_location('store_cli_oracle','scripts/job-apply-store.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
sub=next(action for action in module.build_parser()._actions if isinstance(action,argparse._SubParsersAction))
print(json.dumps({name:[action.option_strings[-1] for action in parser._actions if action.required and action.option_strings] for name,parser in sub.choices.items()}))`;
  const result = spawnSync(python, ['-c', script], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const reference = JSON.parse(result.stdout);
  for (const [command, required] of Object.entries(reference)) {
    assert.deepEqual(storeRequiredOptions[command] ?? [], required, command);
  }
});

test('Store repeated scalar options use the last value as Python does', () => {
  const args = ['answer-key', '--question', 'first', '--question', 'second'];
  const source = storePython(args), candidate = storeNative(args);
  assert.equal(source.status, 0, source.stderr);
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.deepEqual(JSON.parse(candidate.stdout), JSON.parse(source.stdout));
});

test('policy global and subcommand help match Python success protocol', () => {
  for (const args of [[], ...['status', 'activate', 'authorize', 'claim-final-action', 'record-outcome', 'kill', 'revoke'].map(name => [name])]) {
    const invocation = [...args, '--help'];
    const source = policyPython(invocation), candidate = policyNative(invocation);
    help(source, `Python policy ${invocation}`); help(candidate, `native policy ${invocation}`);
    for (const option of source.stdout.match(/--[a-z][a-z-]*/g) ?? []) {
      assert.ok(candidate.stdout.includes(option), `${invocation} help omits ${option}`);
    }
  }
});

test('installed command router forwards Store and policy help without activation', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'router-cli-parity-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = join(parent, 'absent');
  for (const surface of ['store', 'policy']) {
    const result = invoke(process.execPath, 'apps/companion/command.mjs', [surface, '--root', target, '--help']);
    help(result, `router ${surface}`);
  }
  help(invoke(process.execPath, 'apps/companion/command.mjs',
    ['store', '--root', join(parent, 'first'), '--root', target, '--help']), 'repeated router root');
  assert.deepEqual(await readdir(parent), []);
});
