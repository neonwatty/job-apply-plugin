import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const driver = fileURLToPath(new URL('../tools/contracts/resume-modified-at/reference.py', import.meta.url));
const source = new URL('../scripts/job_apply_store/normalization.py', import.meta.url);
const fixtures = [
  ['zero', '0000000000000000', '1970-01-01T00:00:00Z'],
  ['negative-zero', '8000000000000000', '1970-01-01T00:00:00Z'],
  ['one', '3ff0000000000000', '1970-01-01T00:00:01Z'],
  ['negative-one', 'bff0000000000000', '1969-12-31T23:59:59Z'],
  ['below-carry', '3feffffebde0a0bf', '1970-01-01T00:00:00Z'],
  ['half-carry', '3feffffef39085f5', '1970-01-01T00:00:01Z'],
  ['above-carry', '3fefffff29406b2a', '1970-01-01T00:00:01Z'],
  ['negative-small', 'be9ad7f29abcaf48', '1970-01-01T00:00:00Z'],
  ['negative-half', 'bea0c6f7a0b5ed8d', '1970-01-01T00:00:00Z'],
  ['negative-round', 'bea421f5f40d8376', '1969-12-31T23:59:59Z'],
  ['negative-below-second', 'bff000006b5fca6b', '1969-12-31T23:59:59Z'],
  ['negative-past-second', 'bff00000a10fafa0', '1969-12-31T23:59:58Z'],
  ['recent-below-carry', '41da556e403ffffd', '2026-01-01T00:00:00Z'],
  ['recent-half-carry', '41da556e403ffffe', '2026-01-01T00:00:01Z'],
  ['recent-above-carry', '41da556e403ffffe', '2026-01-01T00:00:01Z'],
  ['minimum-year', 'c22cef23ee000000', '0001-01-01T00:00:00Z'],
  ['before-minimum-year', 'c22cef23ee020000', 'ValueError'],
  ['last-second', '424d7ffa20bf8000', '9999-12-31T23:59:59Z'],
  ['after-maximum-year', '424d7ffa20c00000', 'ValueError'],
  ['large-positive', '46293e5939a08cea', 'OverflowError'],
  ['large-negative', 'c6293e5939a08cea', 'OverflowError'],
  ['nan', '7ff8000000000000', 'ValueError'],
  ['positive-infinity', '7ff0000000000000', 'OverflowError'],
  ['negative-infinity', 'fff0000000000000', 'OverflowError'],
];
const native = [
  ['1767225600999999400', '41da556e403ffffd', '2026-01-01T00:00:00Z'],
  ['1767225600999999500', '41da556e403ffffe', '2026-01-01T00:00:01Z'],
  ['1767225600999999600', '41da556e403ffffe', '2026-01-01T00:00:01Z'],
  ['-600', 'bea421f5f40489ae', '1969-12-31T23:59:59Z'],
];
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), expected.sort());
for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`resume timestamp reference: ${executable}`, (t) => {
    if (process.platform === 'win32') return t.skip('Native Windows timestamp profile remains unverified');
    const run = spawnSync(executable, ['-I', driver], { input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter executable alias unavailable; profile not observed');
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    keys(receipt, ['schemaVersion', 'profile', 'sourceSha256', 'cases', 'nativeCases']);
    assert.equal(receipt.schemaVersion, 1);
    keys(receipt.profile, ['python', 'implementation', 'platform']);
    assert.equal(receipt.profile.implementation, 'CPython');
    assert.equal(receipt.profile.platform, process.platform);
    assert.match(receipt.profile.python, /^3\.(12|13|14)\.\d+$/);
    if (executable !== 'python3') assert.ok(receipt.profile.python.startsWith(executable.slice(6) + '.'));
    assert.equal(receipt.sourceSha256, createHash('sha256').update(readFileSync(source)).digest('hex'));
    assert.deepEqual(receipt.cases, fixtures.map(([id, secondsHex, result]) => ({ id, secondsHex,
      outcome: result.endsWith('Error') ? { kind: 'error', name: result } : { kind: 'value', value: result },
    })));
    assert.deepEqual(receipt.nativeCases, native.map(([requestedNs, secondsHex, value]) => ({
      requestedNs, actualNs: requestedNs, secondsHex, value, unchanged: true,
    })));
    t.diagnostic(`${receipt.profile.python}: 24 exact binary64 cases, four native stat conversions; no live Store`);
  });
}

test('resume timestamp reference rejects caller arguments and input', () => {
  const executable = process.platform === 'win32' ? 'python' : 'python3';
  for (const [args, input] of [[['synthetic'], ''], [[], 'synthetic']]) {
    const run = spawnSync(executable, ['-I', driver, ...args], { input, encoding: 'utf8', timeout: 3000 });
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'resume_modified_at_reference_input_rejected\n');
  }
});
