import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { parseTaskTap } from '../tools/migration/tap-evidence.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const pins = new Map(JSON.parse(readFileSync(join(root, 'docs/migration/evidence/s04/S04.R.json'))).inputs.map(row => [row.path, row.sha256]));
const hash = value => createHash('sha256').update(value).digest('hex');
function baseline(t, filename, directory, prefix, refusal) {
  for (const path of [filename, `tools/contracts/${directory}/reference.py`,
    `tools/contracts/${directory}/support.py`, 'tools/migration/tap-evidence.mjs']) {
    assert.equal(hash(readFileSync(join(root, path))), pins.get(path), path);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', filename], {
    cwd: root, env, encoding: 'utf8', timeout: 110000, maxBuffer: 900000,
  });
  t.diagnostic(JSON.stringify({ command: ['node', '--test', filename], stdoutSha256: hash(run.stdout ?? ''),
    stdout: run.stdout, stderr: run.stderr, status: run.status }));
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const parsed = parseTaskTap(run.stdout);
  assert.ok(parsed, 'complete successful flat child TAP required');
  assert.deepEqual(parsed.names, ['python3', 'python3.12', 'python3.13', 'python3.14'].map(name => `${prefix}${name}`).concat(refusal));
  assert.equal(parsed.tests, 5);
  assert.equal(parsed.passed, 5);
  assert.equal(parsed.failures + parsed.cancelled + parsed.skips, 0);
}
test('S04 reference preserves all unchanged atomic baseline witnesses', t => baseline(t,
  'tests_js/atomic_write_json_reference.test.mjs', 'atomic-write-json', 'atomic JSON reference: ',
  'atomic JSON reference rejects caller paths, arguments and stdin'));
test('S04 reference preserves all unchanged JSONL baseline witnesses', t => baseline(t,
  'tests_js/jsonl_append_reference.test.mjs', 'jsonl-append', 'JSONL append and pending tail reference: ',
  'JSONL reference rejects caller arguments and input'));
