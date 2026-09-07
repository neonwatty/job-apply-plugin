import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const driver = fileURLToPath(new URL('../tools/contracts/python-object/reference.py', import.meta.url));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const text = points => ({ type: 'text', points: typeof points === 'string'
  ? Array.from(points, char => char.codePointAt(0)) : points });
const integer = value => ({ type: 'int', decimal: String(value) });
const float = repr => ({ type: 'float', repr });
const bool = value => ({ type: 'bool', value });
const nil = { type: 'null' };
const list = items => ({ type: 'list', items });
const dict = entries => ({ type: 'dict', entries: entries.map(([key, value]) => [text(key), value]) });
const pair = [0xd800, 0xdc00], scalar = [0x10000];
const points = [scalar, pair, [], [0xe000], [0xd800], [0xdc00], [0], [97]];
const expected = [
  { id: 'equal-overwrite', value: dict([['alpha', integer(3)], ['middle', integer(2)]]),
    distinctInputs: true, retainsFirstKey: true, lookup: integer(3) },
  { id: 'pair-scalar-coexist', value: dict([[pair, text('pair')], [scalar, text('scalar')], [[0xd800], text('high')]]),
    lookups: [text('pair'), text('scalar'), text('high')], size: 3 },
  { id: 'delete-reinsert', value: dict([['a', integer(5)], ['c', integer(3)], ['b', integer(4)]]) },
  { id: 'missing-delete', before: dict([['a', integer(1)]]), after: dict([['a', integer(1)]]),
    error: { name: 'KeyError', args: list([text('missing')]), message: "'missing'" } },
  { id: 'insertion-and-sort', value: dict(points.map((key, index) => [key, integer(index)])),
    sortedKeys: [[], [0], [97], [0xd800], pair, [0xdc00], [0xe000], scalar] },
  { id: 'typed-values', value: dict([['', nil], ['false', bool(false)], ['true', bool(true)],
    ['integer', integer(1)], ['float', float('1.0')], ['negative-zero', float('-0.0')],
    ['large', integer('9007199254740993')], ['empty-text', text('')], ['empty-list', list([])], ['empty-object', dict([])]]) },
  { id: 'shared-values', value: dict([['first', list([integer(7)])], ['second', list([integer(7)])]]), sameValue: true },
  { id: 'self-cycle', keys: ['self', 'alias'], size: 2, selfIdentity: true, aliasIdentity: true,
    jsonError: { name: 'ValueError', message: 'Circular reference detected' } },
  { id: 'ascii-reload-pair-first', before: dict([[pair, text('pair')], [scalar, text('scalar')]]),
    json: String.raw`{"\ud800\udc00":"pair","\ud800\udc00":"scalar"}`,
    after: dict([[scalar, text('scalar')]]) },
  { id: 'ascii-reload-scalar-first', before: dict([[scalar, text('scalar')], [pair, text('pair')]]),
    json: String.raw`{"\ud800\udc00":"scalar","\ud800\udc00":"pair"}`,
    after: dict([[scalar, text('pair')]]) },
  { id: 'lookup-presence', missing: false, present: true, missingDefault: bool(false),
    presentValue: nil, value: dict([['present', nil]]) },
];

function capture(executable, args, input = '') {
  return spawnSync(executable, ['-I', '-B', ...args], { input, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
}
function verifyProfile(executable, t) {
  const run = capture(executable, [driver]);
  if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip(`Required ${executable} alias unavailable`);
  assert.ifError(run.error); assert.equal(run.status, 0, run.stderr); assert.equal(run.stderr, '');
  const receipt = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(receipt).sort(), ['cases', 'profile', 'schemaVersion']);
  assert.equal(receipt.schemaVersion, 1);
  assert.deepEqual(receipt.cases, expected);
  assert.deepEqual(receipt.cases.map(row => row.id), expected.map(row => row.id));
  const profile = receipt.profile;
  assert.deepEqual(Object.keys(profile).sort(), ['executablePath', 'executableSha256', 'implementation', 'nativeJson', 'platform', 'python', 'stdlib']);
  assert.equal(profile.implementation, 'CPython'); assert.equal(profile.platform, process.platform);
  assert.match(profile.python, /^3\.(12|13|14)\.\d+$/);
  if (executable !== 'python3') assert.ok(profile.python.startsWith(executable.slice(6) + '.'));
  const probe = capture(executable, ['-c',
    'import _json,json,json.encoder,json.decoder,pathlib,platform,sys; print(json.dumps([str(pathlib.Path(sys.executable).resolve()),platform.python_version(),[[m.__name__,str(pathlib.Path(m.__file__).resolve())] for m in [json,json.encoder,json.decoder,json.scanner]],[_json.__spec__.origin,getattr(_json,"__file__",None)]]))']);
  assert.ifError(probe.error); assert.equal(probe.status, 0, probe.stderr);
  const [actualExecutable, version, modules, nativeJson] = JSON.parse(probe.stdout);
  assert.equal(profile.python, version); assert.equal(profile.executablePath, actualExecutable);
  assert.equal(profile.executableSha256, digest(actualExecutable));
  assert.deepEqual(profile.stdlib, modules.map(([module, path]) => ({ module, path, sha256: digest(path) })));
  assert.deepEqual(profile.nativeJson, { origin: nativeJson[0], sha256: nativeJson[1] === null ? null : digest(nativeJson[1]) });
  t.diagnostic(`${executable}: CPython ${version}; ${expected.length} closed fixtures; executable ${profile.executableSha256}`);
}

test('Python object reference default profile', t => verifyProfile('python3', t));
test('Python object reference 3.12 profile', t => verifyProfile('python3.12', t));
test('Python object reference 3.13 profile', t => verifyProfile('python3.13', t));
test('Python object reference 3.14 profile', t => verifyProfile('python3.14', t));
test('Python object reference rejects caller input', () => {
  for (const [args, input] of [[['--external'], ''], [[], 'external']]) {
    const run = capture('python3', [driver, ...args], input);
    assert.ifError(run.error); assert.equal(run.status, 2); assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'python_object_reference_input_rejected\n');
  }
});
