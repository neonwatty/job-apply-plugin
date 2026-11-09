import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const driver = fileURLToPath(new URL('../tools/contracts/python-text/reference.py', import.meta.url));
const cases = [
  ['empty', [], ''], ['ascii', [65, 0, 127], '41007f'],
  ['scalar', [0x10000], 'f0908080'], ['literal-pair', [0xd800, 0xdc00], [0, 2]],
  ['high', [0xd800], [0, 1]], ['low', [0xdc00], [0, 1]],
  ['scalar-before-error', [0x1f600, 0xd800, 65], [1, 2]],
  ['surrogate-run', [65, 0xd800, 0xdc00, 0xdfff, 66], [1, 4]],
  ['separate-errors', [0xd800, 65, 0xdc00], [0, 1]],
  ['unicode', [0x3bb, 0xe000, 0x10ffff], 'cebbee8080f48fbfbf'],
  ['below-surrogate', [0xd7ff], 'ed9fbf'], ['above-surrogate', [0xe000], 'ee8080'],
];
function utf8(points, expected) {
  if (typeof expected === 'string') return { hex: expected };
  const [start, end] = expected;
  const detail = end === start + 1
    ? `character '\\u${points[start].toString(16).padStart(4, '0')}' in position ${start}`
    : `characters in position ${start}-${end - 1}`;
  return { error: { name: 'UnicodeEncodeError', encoding: 'utf-8', start, end,
    reason: 'surrogates not allowed', message: `'utf-8' codec can't encode ${detail}: surrogates not allowed` } };
}
for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`codepoint text reference: ${executable}`, t => {
    const run = spawnSync(executable, ['-I', driver], { input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter alias unavailable');
    assert.ifError(run.error); assert.equal(run.status, 0, run.stderr); assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(receipt).sort(), ['cases', 'comparisons', 'joins', 'profile', 'schemaVersion']);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.profile.implementation, 'CPython');
    assert.equal(receipt.profile.platform, process.platform);
    assert.match(receipt.profile.python, /^3\.(12|13|14)\.\d+$/);
    if (executable !== 'python3') assert.ok(receipt.profile.python.startsWith(executable.slice(6) + '.'));
    assert.match(receipt.profile.executableSha256, /^[a-f0-9]{64}$/);
    const executableProbe = spawnSync(executable, ['-I', '-c', 'import pathlib,sys;print(pathlib.Path(sys.executable).resolve())'],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 });
    assert.ifError(executableProbe.error); assert.equal(executableProbe.status, 0, executableProbe.stderr);
    assert.equal(receipt.profile.executablePath, executableProbe.stdout.trim());
    assert.equal(receipt.profile.executableSha256, createHash('sha256').update(readFileSync(receipt.profile.executablePath)).digest('hex'));
    assert.deepEqual(receipt.cases, cases.map(([id, points, encoded]) =>
      ({ id, points, length: points.length, utf8: utf8(points, encoded) })));
    // Python's lexicographic codepoint order, independently fixed by case index.
    const order = [0, 1, 7, 9, 10, 4, 8, 3, 5, 11, 2, 6];
    assert.deepEqual([...order].sort((a, b) => a - b), cases.map((_, index) => index));
    assert.deepEqual(receipt.comparisons, cases.map((_, left) => cases.map((_, right) =>
      Math.sign(order.indexOf(left) - order.indexOf(right)))));
    assert.deepEqual(receipt.joins, [
      { left: 'high', right: 'low', points: [0xd800, 0xdc00], utf8: utf8([0xd800, 0xdc00], [0, 2]) },
      { left: 'scalar', right: 'low', points: [0x10000, 0xdc00], utf8: utf8([0x10000, 0xdc00], [1, 2]) },
      { left: 'empty', right: 'literal-pair', points: [0xd800, 0xdc00], utf8: utf8([0xd800, 0xdc00], [0, 2]) },
    ]);
  });
}
test('codepoint reference rejects caller input', () => {
  for (const [args, input] of [[['--external'], ''], [[], 'external']]) {
    const run = spawnSync('python3', ['-I', driver, ...args], { input, encoding: 'utf8', timeout: 10000 });
    assert.ifError(run.error); assert.equal(run.status, 2); assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'python_text_reference_input_rejected\n');
  }
});
