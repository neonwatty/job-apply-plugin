import assert from 'node:assert/strict';
import { cp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
export { setup, read, write, snapshot, plain } from './workspace_native_claims_support.mjs';
let serial = 0;
const execute = promisify(execFile);
export async function invoke(fixture, root, args, { python = false, cwd, globals = true, entry } = {}) {
  const command = python ? 'python3' : process.execPath;
  const script = entry ?? new URL(python ? '../scripts/job-apply-task.py' : '../runtime/cli/native-task.js', import.meta.url).pathname;
  const globalArgs = globals ? ['--root', root, ...python ? [] : ['--native-lock', fixture.receipt.artifact]] : [];
  let result;
  try {
    result = { ...await execute(command, [script, ...globalArgs, ...args], {
      cwd: cwd ?? new URL('../', import.meta.url), timeout: 15000,
      env: python ? process.env : { PATH: '' }, maxBuffer: 4 * 1024 * 1024,
    }), code: 0 };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    result = error;
  }
  assert.equal(result.stderr, '', 'task protocol never writes diagnostics to stderr');
  assert.ok([0, 2].includes(result.code), result.stdout);
  assert.doesNotMatch(result.stdout, /PRIVATE-|private\.invalid|tokenHash|PRIVATE RESUME/);
  return { code: result.code, value: JSON.parse(result.stdout), stdout: result.stdout };
}
export async function input(fixture, value) {
  const path = join(fixture.root, `task-input-${++serial}.json`);
  await writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  return ['--input', path];
}
function normalize(value, mutation) {
  if (Array.isArray(value)) return value.map(item => normalize(item, mutation));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (mutation && /^(createdAt|updatedAt|lastSeenAt|mergedAt)$/.test(key)) return [key, '<timestamp>'];
    // A session revision is a hash of its timestamp-bearing document. Preserve its safe integer contract.
    if (mutation && (key === 'sessionRevision' || key === 'revision' && value.pendingInformation)) {
      assert.ok(Number.isSafeInteger(item) && item > 0);
      return [key, '<session revision>'];
    }
    return [key, normalize(item, mutation)];
  }));
}
export async function parity(fixture, root, args, { mutation = false, ...options } = {}) {
  const oracleRoot = join(fixture.root, `task-python-${++serial}`);
  await cp(root, oracleRoot, { recursive: true, preserveTimestamps: true });
  const expected = await invoke(fixture, oracleRoot, args, { ...options, python: true });
  const actual = await invoke(fixture, root, args, options);
  assert.equal(actual.code, expected.code);
  assert.deepEqual(normalize(actual.value, mutation), normalize(expected.value, mutation), args[0]);
  return actual.value;
}
export function failure(value, code) {
  assert.equal(value.ok, false);
  assert.equal(value.error.code, code);
  assert.deepEqual(Object.keys(value).sort(), ['error', 'ok']);
  assert.deepEqual(Object.keys(value.error).sort(), ['code', 'message']);
}
