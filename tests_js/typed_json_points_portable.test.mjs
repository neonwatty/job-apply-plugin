import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { endianness } from 'node:os';
import test from 'node:test';
import { PythonText } from '../runtime/contracts/python-text.js';
import { PythonObject } from '../runtime/contracts/python-object.js';
import { parsePythonPointJson, parsePythonPointJsonBytes, PythonPointJsonDecodeError, PythonPointJsonValueError } from '../runtime/contracts/raw-json/point-parser.js';
import { serializePythonPointScope } from '../runtime/contracts/raw-json/point-serializer.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(name, expectedHash) {
  const bytes = readFileSync(new URL(`../docs/migration/evidence/s08/${name}`, import.meta.url));
  assert.equal(hash(bytes), expectedHash);
  return JSON.parse(bytes);
}
const composed = fixture('composed-reference-vectors.json', '1ccb7cdb553cd70a1f6107904b595c4a9c9ea720e9d8c5cbc48955233f280e7b');
const supplemental = fixture('additional-reference-vectors.json', '500ce6a2f35ac9f9e0bfe9ec8a676d0aa1165687a768f53e3bffeacf5048225d');
const reference = fileURLToPath(new URL('../tools/contracts/codepoint-json/reference.py', import.meta.url));
assert.equal(hash(readFileSync(reference)), 'fef264468e9190a80cd6edbc03ec06693f6269edc3df7f30757fb16a8d63c231');
const moduleNames = ['json', 'json.decoder', 'json.encoder', 'json.scanner', 'codecs',
  'encodings', 'encodings.utf_8', 'encodings.utf_8_sig', 'encodings.utf_16', 'encodings.utf_32'];
const probe = `import importlib,json,pathlib,platform,sys
names=${JSON.stringify(moduleNames)}
print(json.dumps({'executable':str(pathlib.Path(sys.executable).resolve()),'python':platform.python_version(),
 'implementation':platform.python_implementation(),'platform':sys.platform,'machine':platform.machine(),
 'byteOrder':sys.byteorder,'isolated':sys.flags.isolated,
 'modules':{n:str(pathlib.Path(importlib.import_module(n).__file__).resolve()) for n in names},
 'native':{n:importlib.import_module(n).__spec__.origin for n in ['_json','_codecs']}}))`;

// Fixed test-owned points/limits are observed by stdlib json. Expected outcomes
// are never supplied to this process or generated from the implementation.
const supplementalProbe = `import json,platform,sys
rows=json.load(sys.stdin)
def points(value): return list(map(ord,value))
def typed(value):
 if value is None: return {'kind':'null'}
 if isinstance(value,bool): return {'kind':'boolean','value':value}
 if isinstance(value,str): return {'kind':'text','points':points(value)}
 if isinstance(value,int): return {'kind':'integer','decimal':str(value)}
 if isinstance(value,float): return {'kind':'float','hex':value.hex()}
 if isinstance(value,list): return {'kind':'array','items':[typed(x) for x in value]}
 if isinstance(value,dict): return {'kind':'object','entries':[[points(k),typed(v)] for k,v in value.items()]}
 raise AssertionError(type(value).__name__)
result=[]
for row in rows:
 assert set(row)=={'id','documentPoints','intMaxStrDigits'}
 previous=sys.get_int_max_str_digits()
 try:
  sys.set_int_max_str_digits(row['intMaxStrDigits'])
  document=''.join(map(chr,row['documentPoints']))
  try:
   value=json.loads(document)
   ascii_text=json.dumps(value,ensure_ascii=True,sort_keys=True,separators=(',',':'))
   outcome={'kind':'value','value':typed(value),'ascii':ascii_text,'asciiReload':typed(json.loads(ascii_text))}
  except json.JSONDecodeError as error:
   outcome={'kind':'error','name':'JSONDecodeError','message':str(error),'reason':error.msg,
    'position':error.pos,'line':error.lineno,'column':error.colno,'documentPoints':points(error.doc)}
  except ValueError as error:
   outcome={'kind':'error','name':type(error).__name__,'message':str(error)}
  result.append(dict(row,outcome=outcome))
 finally: sys.set_int_max_str_digits(previous)
print(json.dumps({'version':platform.python_version(),'cases':result},ensure_ascii=True))`;

function run(executable, args, input = '') {
  const result = spawnSync(executable, ['-I', '-B', ...args], {
    input, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error); // Required profiles must never become skips.
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}
function floatHex(value) {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value < 0 ? '-inf' : 'inf';
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  const bits = view.getBigUint64(0), sign = bits >> 63n ? '-' : '';
  const exponent = Number(bits >> 52n & 2047n), fraction = bits & 0xfffffffffffffn;
  if (!exponent && !fraction) return `${sign}0x0.0p+0`;
  const power = exponent ? exponent - 1023 : -1022;
  return `${sign}0x${exponent ? 1 : 0}.${fraction.toString(16).padStart(13, '0')}p${power >= 0 ? '+' : ''}${power}`;
}
function typed(value) {
  if (value === null) return { kind: 'null' };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (value instanceof PythonText) return { kind: 'text', points: [...value.codePoints] };
  if (Array.isArray(value)) return { kind: 'array', items: value.map(typed) };
  if (value instanceof PythonObject) return { kind: 'object', entries: value.entries().map(([key, item]) => [[...key.codePoints], typed(item)]) };
  if (value.kind === 'int') return { kind: 'integer', decimal: value.value.toString() };
  assert.equal(value.kind, 'float');
  return { kind: 'float', hex: floatHex(value.value) };
}
function observeTs(row, version) {
  const options = { intMaxStrDigits: row.intMaxStrDigits ?? 640, diagnosticProfile: version.split('.').slice(0, 2).join('.') };
  try {
    const value = row.inputHex == null ? parsePythonPointJson(PythonText.fromCodePoints(row.documentPoints), options)
      : parsePythonPointJsonBytes(Buffer.from(row.inputHex, 'hex'), options);
    const ascii = serializePythonPointScope(value);
    return { kind: 'value', value: typed(value), ascii,
      asciiReload: typed(parsePythonPointJson(PythonText.fromJavaScript(ascii), options)) };
  } catch (error) {
    if (error instanceof PythonPointJsonDecodeError) return {
      kind: 'error', name: error.name, message: error.message, reason: error.msg,
      position: error.pos, line: error.lineno, column: error.colno, documentPoints: [...error.doc.codePoints],
    };
    assert.ok(error instanceof PythonPointJsonValueError);
    return { kind: 'error', name: error.name, message: error.message };
  }
}
function verify(executable, t) {
  const selected = run(executable, ['-c', probe]);
  assert.equal(selected.implementation, 'CPython');
  assert.equal(selected.platform, process.platform);
  assert.equal(selected.byteOrder, endianness() === 'LE' ? 'little' : 'big');
  assert.equal(selected.isolated, 1);
  if (executable !== 'python3') assert.ok(selected.python.startsWith(executable.slice(6) + '.'));
  const minor = selected.python.split('.').slice(0, 2).join('.');
  assert.ok(['3.12', '3.13', '3.14'].includes(minor), `Unsupported CPython minor ${minor}`);
  // Historical receipts provide only fixed inputs here. This is fresh portable
  // differential coverage, not acceptance of a foreign build under an old identity.
  const expected = composed.profiles.find(profile => profile.version.startsWith(`${minor}.`));
  const extra = supplemental.profiles.find(profile => profile.receipt.profile.version.startsWith(`${minor}.`))?.receipt;
  assert.ok(expected && extra, `Missing fixed inputs for CPython ${minor}`);
  const actual = run(executable, [reference]);
  assert.deepEqual(Object.keys(actual).sort(), ['cases', 'native', 'profile', 'schemaVersion', 'scope', 'serializers', 'stdlib']);
  assert.equal(actual.schemaVersion, 1);
  assert.equal(actual.scope, 'fixed-composed-codepoint-json');
  assert.deepEqual(actual.profile, { python: selected.python, implementation: 'CPython', platform: process.platform,
    byteOrder: selected.byteOrder, intMaxStrDigits: 640, executablePath: selected.executable,
    executableSha256: hash(readFileSync(selected.executable)) });
  assert.deepEqual(Object.keys(actual.stdlib).sort(), [...moduleNames].sort());
  for (const name of moduleNames) assert.deepEqual(actual.stdlib[name], {
    path: selected.modules[name], sha256: hash(readFileSync(selected.modules[name])),
  });
  assert.deepEqual(Object.keys(actual.native).sort(), ['_codecs', '_json']);
  for (const [name, origin] of Object.entries(selected.native)) assert.deepEqual(actual.native[name], {
    origin, sha256: origin === 'built-in' ? null : hash(readFileSync(origin)),
  });
  assert.equal(expected.cases.length, 38);
  assert.equal(new Set(actual.cases.map(row => row.id)).size, 38);
  assert.deepEqual(actual.cases.map(row => row.id).sort(), expected.cases.map(row => row.id).sort());
  for (const row of expected.cases) {
    const observed = actual.cases.find(item => item.id === row.id);
    const input = ({ outcome, ...fields }) => fields;
    assert.deepEqual(input(observed), input(row), `fixed input ${row.id}`);
  }
  assert.deepEqual(actual.serializers, composed.serializers);
  for (const row of actual.cases) assert.deepEqual(observeTs(row, selected.python), row.outcome, row.id);
  const inputs = extra.cases.map(({ id, documentPoints, intMaxStrDigits }) => ({ id, documentPoints, intMaxStrDigits }));
  assert.equal(inputs.length, 48);
  assert.equal(new Set(inputs.map(row => row.id)).size, 48);
  const observedExtra = run(executable, ['-c', supplementalProbe], JSON.stringify(inputs));
  assert.equal(observedExtra.version, selected.python);
  assert.equal(observedExtra.cases.length, 48);
  assert.deepEqual(observedExtra.cases.map(({ outcome, ...input }) => input), inputs);
  for (const row of observedExtra.cases) assert.deepEqual(observeTs(row, selected.python), row.outcome, row.id);
  t.diagnostic(JSON.stringify({ evidenceKind: 'portable-live-differential', ...actual.profile, stdlib: actual.stdlib, native: actual.native,
    composedCases: 38, supplementalCases: 48, serializerGraphs: 3, defaultMayDuplicateProfile: executable === 'python3' }));
}

test('S08 portable point JSON matches fresh CPython observations under default CPython', t => verify('python3', t));
test('S08 portable point JSON matches fresh CPython observations under CPython 3.12', t => verify('python3.12', t));
test('S08 portable point JSON matches fresh CPython observations under CPython 3.13', t => verify('python3.13', t));
test('S08 portable point JSON matches fresh CPython observations under CPython 3.14', t => verify('python3.14', t));
