import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { endianness } from 'node:os';

const root = new URL('../', import.meta.url);
const reference = fileURLToPath(new URL('../tools/contracts/history-read-idempotency/reference.py', import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
const valid = { answerKeys: [], applicationId: 'app-1', at: 'synthetic-time', event: 'started', eventId: 'synthetic-id', schemaVersion: 1 };
const wire = value => JSON.stringify(value);
const validLine = wire(valid) + '\n';
const readStages = ['loads', 'object', 'version', 'record'];
const cp = value => Array.from(value, character => character.codePointAt(0));

// Independently specified inputs; receipt data never chooses a scenario's fixture.
const rawNumber = Symbol('python numeric spelling');
const number = spelling => ({ [rawNumber]: spelling });
function pythonText(value, ascii = true) {
  if (value && typeof value === 'object' && rawNumber in value) return value[rawNumber];
  if (Array.isArray(value)) return `[${value.map(item => pythonText(item, ascii)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${pythonText(key, ascii)}:${pythonText(value[key], ascii)}`).join(',')}}`;
  const result = typeof value === 'string' ? '"' + Array.from(value, char =>
    char.codePointAt(0) >= 32 && char !== '"' && char !== '\\' ? char : JSON.stringify(char).slice(1, -1)).join('') + '"' : JSON.stringify(value);
  return ascii ? result.replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`) : result;
}
const event = changes => ({ ...valid, ...changes });
const omit = field => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field));
const line = value => pythonText(value) + '\n';
const invalidLine = line(event({ extra: 'unsupported' }));
const b = value => Buffer.from(value, 'utf8');
const bytes = (...values) => Buffer.concat(values.map(value => Buffer.isBuffer(value) ? value : b(value)));
const readerInputs = {
  missing: null, empty: b(''), valid: b(validLine), 'unterminated-valid': b(validLine.slice(0, -1)),
  'blank-lines': b('\n \t\r\n' + validLine + '\n'), 'unicode-blank': b('\u0085\u2003\n' + validLine),
  'cr-crlf': b(validLine.replace('\n', '\r') + validLine.replace('\n', '\r\n')),
  'unknown-event': b(line(event({ event: 'future-event' }))), 'missing-schema': b(line(omit('schemaVersion'))),
  'float-schema': b(line(event({ schemaVersion: number('1.0') }))), 'bool-schema': b(line(event({ schemaVersion: true }))),
  'future-schema': b(line(event({ schemaVersion: 2 }))), 'old-schema': b(line(event({ schemaVersion: 0 }))),
  'null-object': b('null\n'), 'array-object': b('[]\n'), 'physical-line-label': b('\n \t\n[]\n'),
  'malformed-json': b('{\n'), bom: bytes(Buffer.from([239, 187, 191]), validLine),
  'invalid-utf8': Buffer.from([255, 10]), 'schema-before-json': b('{}\n{\n'), 'json-before-schema': b('{\n{}\n'),
  'record-before-json': b(invalidLine + '{\n'), 'read-ahead-utf8-before-record': bytes(invalidLine, Buffer.from([255, 10])),
  'record-before-distant-utf8': bytes(invalidLine, ' '.repeat(16384), Buffer.from([255, 10])),
  'json-before-distant-utf8': bytes('{\n', ' '.repeat(16384), Buffer.from([255, 10])),
  'utf8-at-8191': bytes(' '.repeat(8191), Buffer.from([255, 10])), 'utf8-at-8192': bytes(' '.repeat(8192), Buffer.from([255, 10])),
  'split-multibyte': b(' '.repeat(8191) + '\u2003\n' + validLine), 'surrogate-text': b(line(event({ role: '\ud800' }))),
  'duplicate-keys': b(validLine.replace('"event":"started"', '"event":"bad","event":"started"')),
  'integer-limit': b('{"schemaVersion":1' + '0'.repeat(4300) + '}\n'),
  directory: 'directory', symlink: 'symlink', 'broken-symlink': 'broken-symlink',
};
const validationInputs = {
  valid, 'unknown-event': event({ event: 'future-event' }), 'bad-event': event({ event: 'Started' }),
  'empty-event': event({ event: '' }), 'long-event': event({ event: 'a'.repeat(65) }), 'event-newline': event({ event: 'started\n' }),
  'unsupported-field': event({ extra: 1 }), 'bad-id': event({ applicationId: 'a..b' }), 'id-nonascii': event({ applicationId: 'λ' }),
  'id-long': event({ applicationId: 'a'.repeat(129) }), 'id-boundary': event({ applicationId: 'a'.repeat(128) }),
  'empty-event-id': event({ eventId: '' }), 'null-event-id': event({ eventId: null }), 'empty-time': event({ at: '' }),
  'keys-not-list': event({ answerKeys: 'a' }), 'keys-mixed': event({ answerKeys: ['a', 1] }),
  'optional-null': event({ company: null, role: null, ats: null, status: null }),
  'optional-multiple': event({ company: 1, role: 2, ats: 3, status: 4 }), 'missing-schema': omit('schemaVersion'),
  'float-schema': event({ schemaVersion: number('1.0') }), 'arbitrary-schema': event({ schemaVersion: [false] }),
  'surrogate-text': event({ role: '\ud800' }), 'future-event-boundary': event({ event: 'a'.repeat(64) }),
};
for (const field of ['applicationId', 'event', 'eventId', 'at', 'answerKeys']) validationInputs['missing-' + field] = omit(field);
for (const field of ['company', 'role', 'ats', 'status']) validationInputs['optional-' + field] = event({ [field]: 1 });
const other = event({ eventId: 'unrelated' });
const different = event({ role: 'different' });
const identityInputs = {
  missing: [valid, null, []], empty: [valid, b(''), []], unrelated: [valid, b(line(other)), [other]],
  same: [valid, b(validLine), [valid]],
  reordered: [valid, b(JSON.stringify(Object.fromEntries(['at', 'answerKeys', 'event', 'applicationId', 'eventId', 'schemaVersion'].map(key => [key, valid[key]]))) + '\n'), [valid]],
  'duplicates-equal': [valid, b(validLine.repeat(2)), [valid, valid]], collision: [valid, b(line(different)), [different]],
  'mixed-collision': [valid, b(validLine + line(different)), [valid, different]],
  'first-collision': [valid, b(line(different) + validLine), [different, valid]],
  'float-int-identity': [event({ schemaVersion: number('1.0') }), b(validLine), [valid]],
  'missing-schema-identity': [omit('schemaVersion'), b(validLine), [valid]],
  'surrogate-equal': [event({ role: '\ud800' }), b(line(event({ role: '\ud800' }))), [event({ role: '\ud800' })]],
  'surrogate-pair-collision': [event({ role: '😀' }), b(line(event({ role: '😀' }))), [event({ role: '😀' })]],
  'bool-int-identity': [event({ schemaVersion: true }), b(validLine), [valid]],
  'arbitrary-schema-unmatched': [event({ schemaVersion: [false] }), b(line(other)), [other]],
  'nonascii-equal': [event({ role: 'λ😀' }), b(line(event({ role: 'λ😀' }))), [event({ role: 'λ😀' })]],
  'invalid-incoming-before-file': [event({ event: 'future-event' }), Buffer.from([255]), []],
  'later-malformed-before-comparison': [valid, b(validLine + '{\n'), [valid]],
  'unknown-unrelated-record': [valid, b(line(event({ eventId: 'unrelated', event: 'future-event' }))), [event({ eventId: 'unrelated', event: 'future-event' })]],
};
const expectedIds = [...Object.keys(readerInputs).map(id => 'reader:' + id),
  ...['record', 'write'].flatMap(kind => Object.keys(validationInputs).map(id => kind + ':' + id)),
  ...Object.keys(identityInputs).map(id => 'identity:' + id)].sort();
function checkInputsAndCalls(row) {
  const [kind, id] = row.id.split(':');
  const incoming = kind === 'reader' ? null : kind === 'identity' ? identityInputs[id][0] : validationInputs[id];
  const input = kind === 'reader' ? readerInputs[id] : kind === 'identity' ? identityInputs[id][1] : null;
  assert.equal(row.incoming, pythonText(incoming), row.id);
  const role = incoming?.role;
  assert.deepEqual(row.incomingRoleCodepoints, typeof role === 'string'
    ? id === 'surrogate-pair-collision' ? [0xd83d, 0xde00] : cp(role) : null);
  assert.equal(row.inputHex, Buffer.isBuffer(input) ? input.toString('hex') : null, row.id);
  assert.equal(row.fixture, Buffer.isBuffer(input) ? 'file' : input ?? 'missing', row.id);
  const sourceText = Buffer.isBuffer(input) ? input.toString('utf8').replace(/\r\n?/g, '\n') : id === 'symlink' ? validLine : '';
  const lines = sourceText.match(/[^\n]*\n|[^\n]+$/g)?.filter(text => /[^ \t\r\n\u0085\u2003]/.test(text)) ?? [];
  const loaded = row.calls.filter(call => call.stage === 'loads');
  assert.deepEqual(loaded.map(call => call.text), lines.slice(0, loaded.length), row.id);
  const records = row.calls.filter(call => call.stage === 'record');
  const values = kind === 'identity' ? identityInputs[id][2]
    : lines.slice(0, records.length).map(text => JSON.parse(text));
  assert.deepEqual(records.map(call => call.value), values.map(value => pythonText(value)), row.id);
  const canonical = row.calls.filter(call => call.stage === 'canonical');
  if (canonical.length) {
    const arguments_ = [incoming, ...values.filter(value => value.eventId === incoming.eventId)].slice(0, canonical.length);
    assert.deepEqual(canonical.map(call => call.value), arguments_.map(value => pythonText(value)), row.id);
    assert.deepEqual(canonical.map(call => call.result), arguments_.map(value => pythonText(value, false)), row.id);
    const expectedCodepoints = arguments_.map(value => cp(pythonText(value, false)));
    if (id === 'surrogate-pair-collision') expectedCodepoints[0] = expectedCodepoints[0].flatMap(value => value === 0x1f600 ? [0xd83d, 0xde00] : [value]);
    assert.deepEqual(canonical.map(call => call.resultCodepoints), expectedCodepoints, row.id);
  }
}
function checkCause(row) {
  const cause = row.error?.context;
  if (!cause) { if (row.error) assert.equal(row.error.details, null); return; }
  assert.equal(cause.context, null); assert.equal(cause.causeIsContext, false);
  let message, details = null, errno = null;
  const id = row.id.split(':')[1];
  if (cause.name === 'JSONDecodeError') {
    message = id === 'bom' ? 'Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)'
      : 'Expecting property name enclosed in double quotes: line 2 column 1 (char 2)';
    details = id === 'bom' ? { line: 1, column: 1, position: 0 } : { line: 2, column: 1, position: 2 };
  } else if (cause.name === 'UnicodeDecodeError') {
    const position = id === 'read-ahead-utf8-before-record' ? b(invalidLine).length : id === 'utf8-at-8191' ? 8191 : 0;
    message = `'utf-8' codec can't decode byte 0xff in position ${position}: invalid start byte`;
    const input = readerInputs[id];
    const chunk = id === 'utf8-at-8192' ? input.subarray(8192) : input.subarray(0, 8192);
    details = { encoding: 'utf-8', start: position, end: position + 1, reason: 'invalid start byte', inputHex: chunk.toString('hex') };
  } else { assert.equal(cause.name, 'IsADirectoryError'); message = "[Errno 21] Is a directory: '<ROOT>/history.jsonl'"; errno = 21; }
  assert.equal(cause.message, message, row.id); assert.equal(cause.errno, errno, row.id);
  assert.deepEqual(cause.details, details, row.id); assert.equal(row.error.details, null);
}

function checkError(row, message, context = null, name = 'StoreError') {
  assert.equal(row.value, null, row.id);
  assert.equal(row.error.name, name, row.id);
  if (message !== null) assert.equal(row.error.message, message, row.id);
  assert.equal(row.error.context?.name ?? null, context, row.id);
  assert.equal(row.error.causeIsContext, context !== null, row.id);
  assert.equal(row.error.errno, null, row.id);
}
function checkTree(row) {
  assert.deepEqual(row.before, row.after, row.id);
  assert.equal(row.incoming, row.incomingAfter, row.id);
  const paths = row.before.map(item => item.path);
  assert.deepEqual(paths, row.fixture === 'missing' ? ['.'] : row.fixture === 'symlink'
    ? ['.', 'history.jsonl', 'target.jsonl'] : ['.', 'history.jsonl']);
  for (const item of row.before) {
    assert.match(item.mtimeNs, /^-?\d+$/); assert.match(item.ctimeNs, /^-?\d+$/);
    if (item.kind === 'file') {
      const bytes = Buffer.from(item.hex, 'hex');
      assert.equal(item.size, bytes.length);
      assert.equal(item.sha256, hash(bytes));
      if (item.path === 'history.jsonl') assert.equal(item.hex, row.inputHex);
    } else { assert.equal(item.hex, null); assert.equal(item.sha256, null); }
  }
}

const readerSuccess = {
  missing: [0, null], empty: [0, null], valid: [1, 1], 'unterminated-valid': [1, 1],
  'blank-lines': [1, 3], 'unicode-blank': [1, 2], 'cr-crlf': [2, 1], 'unknown-event': [1, 1],
  'split-multibyte': [1, 2], 'surrogate-text': [1, 1], 'duplicate-keys': [1, 1], symlink: [1, 1], 'broken-symlink': [0, null],
};
const readerFailure = {
  'missing-schema': ['history line 1 has no valid schemaVersion', null, 3],
  'float-schema': ['history line 1 has no valid schemaVersion', null, 3],
  'bool-schema': ['history line 1 has no valid schemaVersion', null, 3],
  'future-schema': ['history line 1 uses unsupported future schemaVersion 2', null, 3],
  'old-schema': ['history line 1 uses unsupported schemaVersion 0', null, 3],
  'null-object': ['history line 1 must be a JSON object', null, 2],
  'array-object': ['history line 1 must be a JSON object', null, 2],
  'physical-line-label': ['history line 3 must be a JSON object', null, 2],
  'malformed-json': [null, 'JSONDecodeError', 1], bom: [null, 'JSONDecodeError', 1],
  'invalid-utf8': [null, 'UnicodeDecodeError', 0],
  'schema-before-json': ['history line 1 has no valid schemaVersion', null, 3],
  'json-before-schema': [null, 'JSONDecodeError', 1],
  'record-before-json': ['history event contains unsupported fields', null, 4],
  'read-ahead-utf8-before-record': [null, 'UnicodeDecodeError', 0],
  'record-before-distant-utf8': ['history event contains unsupported fields', null, 4],
  'json-before-distant-utf8': [null, 'JSONDecodeError', 1],
  'utf8-at-8191': [null, 'UnicodeDecodeError', 0], 'utf8-at-8192': [null, 'UnicodeDecodeError', 0],
  directory: [null, 'IsADirectoryError', 0], 'integer-limit': [null, null, 1, 'ValueError'],
};
function checkReader(row) {
  const id = row.id.slice(7);
  const success = readerSuccess[id];
  if (success) {
    const [count, firstLine] = success;
    assert.equal(row.error, null);
    const expected = { ...valid };
    if (id === 'unknown-event') expected.event = 'future-event';
    if (id === 'surrogate-text') expected.role = '\ud800';
    assert.deepEqual(JSON.parse(row.value), Array.from({ length: count }, () => expected));
    assert.deepEqual(row.calls.map(call => call.stage), ['read-history', ...Array.from({ length: count }, () => readStages).flat()]);
    const labels = row.calls.filter(call => call.stage === 'object').map(call => call.label);
    assert.deepEqual(labels, Array.from({ length: count }, (_, i) => `history line ${firstLine + i}`));
    for (const call of row.calls.filter(call => call.stage === 'loads')) {
      assert.ok(!call.text.includes('\r'), 'Universal newlines must be normalized');
      if (['valid', 'blank-lines', 'unicode-blank', 'cr-crlf', 'split-multibyte', 'symlink'].includes(id)) assert.equal(call.text, validLine);
    }
  } else {
    assert.ok(readerFailure[id], row.id);
    const [message, context, stages, name] = readerFailure[id];
    checkError(row, context ? 'cannot read valid history JSONL at <ROOT>/history.jsonl' : message, context, name);
    assert.deepEqual(row.calls.map(call => call.stage), ['read-history', ...readStages.slice(0, stages)]);
    if (id === 'integer-limit') assert.match(row.error.message, /4300.*4301/);
  }
  const objects = row.calls.filter(call => call.stage === 'object');
  const versions = row.calls.filter(call => call.stage === 'version');
  for (let index = 0; index < versions.length; index += 1) assert.equal(versions[index].label, objects[index].label);

}
const validationGood = new Set(['valid', 'unknown-event', 'id-boundary', 'optional-null', 'missing-schema',
  'float-schema', 'arbitrary-schema', 'surrogate-text', 'future-event-boundary']);
function validationError(id, write) {
  if (write && ['unknown-event', 'future-event-boundary'].includes(id)) return 'history event type is unsupported';
  if (validationGood.has(id)) return null;
  if (['bad-event', 'empty-event', 'long-event', 'event-newline', 'missing-event'].includes(id)) return 'history event type is invalid';
  if (['bad-id', 'id-nonascii', 'id-long', 'missing-applicationId'].includes(id)) return 'application id contains unsupported characters';
  if (['empty-event-id', 'null-event-id', 'missing-eventId'].includes(id)) return 'history event id is invalid';
  if (['empty-time', 'missing-at'].includes(id)) return 'history event timestamp is invalid';
  if (['keys-not-list', 'keys-mixed', 'missing-answerKeys'].includes(id)) return 'history answerKeys list is invalid';
  if (id === 'unsupported-field') return 'history event contains unsupported fields';
  if (id.startsWith('optional-')) return `history event.${id.slice(9)} must be a string`;
  assert.fail(`Unknown validator scenario: ${id}`);
}
function checkValidation(row) {
  const [kind, id] = row.id.split(':');
  assert.deepEqual(row.calls, []);
  if (id === 'optional-multiple') {
    checkError(row, null);
    assert.match(row.error.message, /^history event\.(company|role|ats|status) must be a string$/);
    return;
  }
  const message = validationError(id, kind === 'write');
  if (message) checkError(row, message);
  else { assert.equal(row.error, null); assert.equal(row.value, 'null'); }
}
const identity = {
  missing: [false, 0, 0], empty: [false, 0, 0], unrelated: [false, 1, 0], same: [true, 1, 2],
  reordered: [true, 1, 2], 'duplicates-equal': [true, 2, 3], collision: [null, 1, 2],
  'mixed-collision': [null, 2, 3], 'first-collision': [null, 2, 2], 'float-int-identity': [null, 1, 2],
  'missing-schema-identity': [null, 1, 2], 'surrogate-equal': [true, 1, 2], 'nonascii-equal': [true, 1, 2],
  'surrogate-pair-collision': [null, 1, 2], 'bool-int-identity': [null, 1, 2],
  'arbitrary-schema-unmatched': [false, 1, 0], 'unknown-unrelated-record': [false, 1, 0],
};
function checkIdentity(row) {
  const id = row.id.slice(9);
  assert.equal(row.calls[0].stage, 'write-validation');
  assert.equal(row.calls[0].value, row.incoming);
  if (id === 'invalid-incoming-before-file') {
    checkError(row, 'history event type is unsupported');
    assert.deepEqual(row.calls.map(call => call.stage), ['write-validation']); return;
  }
  if (id === 'later-malformed-before-comparison') {
    checkError(row, 'cannot read valid history JSONL at <ROOT>/history.jsonl', 'JSONDecodeError');
    assert.deepEqual(row.calls.map(call => call.stage), ['write-validation', 'read-history', ...readStages, 'loads']); return;
  }
  assert.ok(identity[id], row.id);
  const [value, lines, comparisons] = identity[id];
  assert.deepEqual(row.calls.map(call => call.stage), ['write-validation', 'read-history',
    ...Array.from({ length: lines }, () => readStages).flat(), ...Array(comparisons).fill('canonical')]);
  if (value === null) checkError(row, 'history event id collision');
  else { assert.equal(row.error, null); assert.equal(row.value, String(value)); }
  const canonical = row.calls.filter(call => call.stage === 'canonical');
  if (comparisons) assert.equal(canonical[0].value, row.incoming);
  if (id === 'surrogate-pair-collision') {
    assert.deepEqual(row.incomingRoleCodepoints, [0xd83d, 0xde00]);
    assert.notDeepEqual(canonical[0].resultCodepoints, canonical[1].resultCodepoints);
    assert.ok(canonical[0].resultCodepoints.includes(0xd83d));
    assert.ok(canonical[1].resultCodepoints.includes(0x1f600));
  } else for (const call of canonical) assert.deepEqual(call.resultCodepoints, cp(call.result));
}
function checkCanonical(rows) {
  const expected = {
    nonascii: '{"\ue000":"x","😀":"λ"}', surrogate: '{"role":"\ud800"}',
    numbers: '[1,1.0,-0.0,1208925819614629174706176,NaN,Infinity]',
    whitespace: '{"x":"a\\n  b\\t"}', ordered: '{"a":{},"z":[]}',
  };
  assert.deepEqual(rows.map(row => row.id).sort(), ['nonascii', 'surrogate', 'numbers', 'whitespace', 'ordered', 'integer-limit', 'cycle'].map(id => 'canonical:' + id).sort());
  for (const row of rows) {
    const id = row.id.slice(10);
    if (Object.hasOwn(expected, id)) {
      assert.equal(row.error, null); assert.equal(row.value, expected[id]); assert.deepEqual(row.codepoints, cp(expected[id]));
    } else {
      assert.ok(['cycle', 'integer-limit'].includes(id));
      checkError(row, id === 'cycle' ? 'Circular reference detected' : null, null, 'ValueError');
      if (id === 'integer-limit') assert.match(row.error.message, /4300/);
      assert.equal(row.codepoints, null);
    }
  }
}
function run(executable, seed) {
  const env = { ...process.env, PYTHONHASHSEED: String(seed) };
  delete env.PYTHONPATH; delete env.PYTHONHOME;
  return spawnSync(executable, ['-B', '-S', '-P', reference], { input: '', encoding: 'utf8', timeout: 20000,
    maxBuffer: 8 * 1024 * 1024, env });
}
for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`actual history read/validation/identity reference: ${executable}`, t => {
    if (process.platform === 'win32') return t.skip('Native Windows reference remains open');
    const errors = [];
    for (const seed of [0, 1, 2]) {
      const result = run(executable, seed);
      if (result.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter alias unavailable');
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.profile.implementation, 'CPython');
      assert.equal(receipt.profile.osName, 'posix'); assert.equal(receipt.profile.intMaxStrDigits, 4300);
      assert.equal(receipt.profile.ignoreEnvironment, 0); assert.equal(receipt.profile.hashSeedEnvironment, String(seed));
      assert.equal(receipt.profile.hashRandomization, seed === 0 ? 0 : 1);
      const profile = receipt.profile.python.split('.').slice(0, 2).join('.');
      assert.ok(['3.12', '3.13', '3.14'].includes(profile));
      if (executable !== 'python3') assert.equal(profile, executable.slice(6));
      assert.equal(receipt.profile.executableSha256, hash(readFileSync(receipt.profile.executablePath)));
      assert.equal(receipt.profile.platform, process.platform);
      assert.equal(receipt.profile.byteOrder, endianness() === 'LE' ? 'little' : 'big');
      assert.deepEqual(Object.keys(receipt.sources).sort(), ['domains/sessions/history.py',
        'domains/coordinator/persistence.py', 'validation/sessions.py', 'normalization.py',
        'constants.py', 'io.py', 'errors.py'].map(path => 'scripts/job_apply_store/' + path).sort());
      for (const [path, digest] of Object.entries(receipt.sources)) assert.equal(digest, hash(readFileSync(new URL(path, root))));
      for (const record of Object.values(receipt.stdlib)) assert.equal(record.sha256, hash(readFileSync(record.path)));
      for (const name of ['io', 'json', 'json.decoder', 'json.encoder', 'json.scanner', 'pathlib']) assert.ok(Object.hasOwn(receipt.stdlib, name));
      for (const name of Object.keys(receipt.stdlib)) assert.ok(['io', 'json', 'json.decoder', 'json.encoder', 'json.scanner', 'pathlib'].includes(name) || name.startsWith('pathlib.'));
      assert.deepEqual(Object.keys(receipt.nativeModules).sort(), ['_io', '_json']);
      for (const module of Object.values(receipt.nativeModules)) {
        if (module.origin === 'built-in') assert.equal(module.sha256, null);
        else assert.equal(module.sha256, hash(readFileSync(module.origin)));
      }
      assert.equal(receipt.cases.length, 117);
      assert.deepEqual(receipt.cases.map(row => row.id).sort(), expectedIds);
      for (const row of receipt.cases) {
        checkTree(row); checkInputsAndCalls(row); checkCause(row);
        if (row.id.startsWith('reader:')) checkReader(row);
        else if (row.id.startsWith('identity:')) checkIdentity(row);
        else checkValidation(row);
      }
      checkCanonical(receipt.canonical);
      const multiple = receipt.cases.filter(row => row.id.endsWith(':optional-multiple'));
      assert.equal(multiple[0].error.message, multiple[1].error.message);
      errors.push({ seed, message: multiple[0].error.message });
    }
    t.diagnostic(JSON.stringify({ optionalFieldObservations: errors }));
  });
}

test('history reference rejects argv and stdin without producing a receipt', () => {
  for (const [args, input] of [[[reference, 'unexpected'], ''], [[reference], 'x']]) {
    const run = spawnSync('python3', ['-B', ...args], { input, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 2); assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'history_identity_reference_input_rejected\n');
  }
});
