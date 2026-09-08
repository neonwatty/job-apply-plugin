import { PythonText, PythonUnicodeEncodeError } from '../runtime/contracts/python-text.js';
import { filesystemEncode, filesystemDecode } from '../runtime/contracts/posix-path-bytes.js';
import { pointContents } from '../runtime/contracts/raw-json/point-text-codec.js';
import { filesystemEncodePoint, filesystemDecodePoint } from '../runtime/contracts/point-filesystem.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const driver = join(root, 'tools/contracts/point-paths/reference.py');
const hash = value => createHash('sha256').update(value).digest('hex');
const points = value => [...value].map(character => character.codePointAt(0));
const bytes = readFileSync(join(root, 'docs/migration/evidence/s05/reference-vectors.json'));
assert.equal(hash(bytes), '4c6af618ffbea1ad274b7d98dc12669c2d38fcb2b3ce72080e5afe5cf14a7967');
const vectors = JSON.parse(bytes);
const pins = new Map(JSON.parse(readFileSync(join(root, 'docs/migration/evidence/s05/S05.R.json'))).inputs.map(row => [row.path, row.sha256]));
const encode = ['empty', 'nul', 'scalar', 'high', 'low', 'low7f', 'escape80', 'escapeff', 'pair', 'high-escape', 'adjacent-escapes', 'nul-high'];
const decode = ['empty', 'ascii-nul', 'max-scalar', 'scalar', 'ff', '80', 'overlong2', 'overlong3', 'surrogate-pair-bytes', 'truncated4', 'mixed', 'out-of-range'];
const parents = ['scalar-leaf', 'pair-leaf', 'escape-leaf', 'nul-leaf', 'pair-parent', 'nul-parent', 'nul-pair-parent', 'outside-parent', 'pair-inside-link', 'pair-outside-link', 'pair-parent-error', 'pair-root-error', 'missing-storage', 'missing-file', 'nonstring-file', 'empty-file'];
const caches = ['equal-pair', 'equal-scalar', 'pair-versus-scalar', 'escape-versus-scalar', 'nul-text', 'empty-text', 'text-versus-numeric', 'expired-pair'];
const ids = [...encode.map(id => `encode-${id}`), ...decode.map(id => `decode-${id}`), ...parents.map(id => `managed-${id}`), ...caches.map(id => `cache-${id}`)];
assert.deepEqual([...vectors.codecs, ...vectors.parents, ...vectors.caches].map(row => row.id), ids);
const modules = ['__init__', 'base', 'constants', 'errors', 'io', 'normalization', 'domains/__init__',
  'validation/__init__', 'validation/accounts', 'validation/extraction', 'validation/jobs_resumes',
  'validation/profile_answers', 'validation/sessions', 'domains/resumes/__init__', 'domains/resumes/storage'];
const sourcePaths = [...modules.map(name => `scripts/job_apply_store/${name}.py`),
  ...['reference', 'fixtures', 'support'].map(name => `tools/contracts/point-paths/${name}.py`)];
const probe = String.raw`
import json, tempfile, pathlib, platform, sys, os, posixpath, _json, _io, _codecs, posix
from pathlib import Path
names = ['json', 'json.decoder', 'json.encoder', 'json.scanner', 'tempfile', 'os', 'posixpath', '_json', '_io', '_codecs', 'posix']
names += sorted(n for n in sys.modules if n == 'pathlib' or n.startswith('pathlib.'))
rows = []
for name in names:
    module = sys.modules[name]
    file = getattr(module, '__file__', None)
    rows.append(dict(name=name, origin=module.__spec__.origin,
                     file=str(Path(file).resolve()) if file else None))
print(json.dumps(dict(executable=str(Path(sys.executable).resolve()), version=sys.version,
 implementation=platform.python_implementation(), platform=sys.platform, machine=platform.machine(),
 byteorder=sys.byteorder, filesystemEncoding=sys.getfilesystemencoding(),
 filesystemErrors=sys.getfilesystemencodeerrors(), rows=rows)))
`;
function keys(row, names) { assert.deepEqual(Object.keys(row).sort(), [...names].sort()); }
function fullError(want) {
  if (!want) return null;
  return { ...want, ...(want.name.startsWith('Unicode') ? { objectHex: null } : {}),
    cause: fullError(want.cause), context: fullError(want.context) };
}
function shiftedError(want, prefix) {
  const start = prefix.length + want.start, end = prefix.length + want.end;
  return { ...fullError(want), objectPoints: [...prefix, ...want.objectPoints], start, end,
    message: `'utf-8' codec can't encode characters in position ${start}-${end - 1}: surrogates not allowed` };
}
function unchanged(before, after) {
  assert.equal(before.length, after.length);
  for (const row of [...before, ...after]) {
    keys(row, ['path', 'kind', 'mode', 'ino', 'device', 'size', 'mtimeNs', 'ctimeNs', 'atimeNs', 'contentHex', 'target']);
    for (const key of ['ino', 'device', 'size', 'mtimeNs', 'ctimeNs', 'atimeNs']) assert.match(row[key], /^-?\d+$/);
    assert.ok(['file', 'directory', 'symlink'].includes(row.kind));
    assert.ok(Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o777);
    if (row.kind !== 'file') assert.equal(row.contentHex, null);
    if (row.kind !== 'symlink') assert.equal(row.target, null);
    if (row.kind === 'file') assert.equal(BigInt(row.size), BigInt(row.contentHex.length / 2));
  }
  const removeAtime = rows => rows.map(({ atimeNs, ...row }) => row);
  assert.deepEqual(removeAtime(after), removeAtime(before));
  const sentinel = before.find(row => row.path === 'sentinel');
  assert.equal(sentinel.contentHex, '73656e74696e656c');
  assert.equal(sentinel.mode, 0o600);
  const files = before.find(row => row.path === 'files');
  assert.equal(files.kind, 'directory');
  assert.equal(files.mode, 0o700);
  for (const row of before.filter(row => row.kind === 'symlink')) {
    assert.ok(['files/inside', 'files/outside-link'].includes(row.path));
    assert.equal(row.target, row.path === 'files/inside' ? '.' : '../outside');
  }
}
function checkParent(row, want) {
  keys(row, ['id', 'record', 'recordAfter', 'sameRecordObject', 'rootPoints', 'resolvedRootPoints', 'events', 'error', 'result', 'before', 'after']);
  assert.deepEqual(row.record, want.record);
  assert.deepEqual(row.recordAfter, want.record);
  assert.equal(row.sameRecordObject, true);
  unchanged(row.before, row.after);
  const expectedPaths = ['.', 'files', 'sentinel'];
  if (row.id === 'managed-pair-inside-link') expectedPaths.push('files/inside');
  if (row.id === 'managed-pair-outside-link') expectedPaths.push('files/outside-link');
  if (['managed-pair-outside-link', 'managed-outside-parent'].includes(row.id)) expectedPaths.push('outside');
  assert.deepEqual(row.before.map(entry => entry.path).sort(), expectedPaths.sort());
  const lexicalRoot = String.fromCodePoint(...row.rootPoints);
  const marker = lexicalRoot.indexOf('/s05-point-paths-');
  assert.ok(marker > 0);
  // Resolve only the extant temp ancestor independently; preserve the entire owned suffix.
  assert.deepEqual(row.resolvedRootPoints, points(realpathSync(lexicalRoot.slice(0, marker)) + lexicalRoot.slice(marker)));
  assert.deepEqual(row.events.map(event => event.operation), want.events);
  const resolves = row.events.filter(event => event.operation.endsWith('.resolve(strict=false)'));
  for (const event of row.events) {
    const fields = event.operation.endsWith('.resolve(strict=false)') ? ['strict', 'pathPoints']
      : event.operation === 'root / managedFile' ? ['child']
      : event.operation === 'resolved parent == resolved root' ? ['equal'] : [];
    keys(event, ['operation', ...fields]);
  }
  for (const event of resolves) assert.equal(event.strict, false);
  const joinEvent = row.events.find(event => event.operation === 'root / managedFile');
  if (joinEvent) assert.deepEqual(joinEvent.child, want.record.managedFile);
  if (resolves.length) {
    const child = want.record.managedFile.points;
    const finalSlash = child.lastIndexOf(47);
    const parentPoints = child.length === 0 ? row.rootPoints.slice(0, row.rootPoints.lastIndexOf(47))
      : finalSlash === -1 ? row.rootPoints : [...row.rootPoints, 47, ...child.slice(0, finalSlash)];
    assert.deepEqual(resolves[0].pathPoints, parentPoints);
    if (resolves.length === 2) assert.deepEqual(resolves[1].pathPoints, row.rootPoints);
  }
  let error = fullError(want.error);
  if (want.error?.objectPointsTemplate) {
    const template = want.error;
    const objectPoints = [...row.resolvedRootPoints, 47, ...template.objectPointsTemplate.componentPoints];
    const start = row.resolvedRootPoints.length + template.startTemplate.add;
    const end = row.resolvedRootPoints.length + template.endTemplate.add;
    error = { name: 'UnicodeEncodeError', errno: null, cause: null, context: null, suppressContext: false,
      encoding: 'utf-8', objectPoints, objectHex: null, start, end, reason: 'surrogates not allowed',
      message: `'utf-8' codec can't encode characters in position ${start}-${end - 1}: surrogates not allowed` };
  }
  assert.deepEqual(row.error, error);
  if (!want.result) assert.equal(row.result, null);
  else {
    const prefix = [...row.rootPoints, 47];
    keys(row.result, ['pathPoints', 'outputHex', 'error']);
    assert.deepEqual(row.result.pathPoints, [...prefix, ...want.result.relativePoints]);
    const encoding = want.result.fsencode;
    if (encoding.errorRelativeToSuffix) {
      assert.equal(row.result.outputHex, null);
      assert.deepEqual(row.result.error, shiftedError(encoding.errorRelativeToSuffix, prefix));
    } else {
      assert.equal(row.result.error, null);
      assert.equal(row.result.outputHex, Buffer.from(String.fromCodePoint(...prefix)).toString('hex') + encoding.suffixHex);
    }
  }
  const comparison = row.events.find(event => event.operation === 'resolved parent == resolved root');
  if (comparison) assert.equal(comparison.equal, want.result !== null);
}
const derivedPredicates = new Set(['size <= RESUME_MAX_BYTES', 'second identity == first identity',
  'identity equality', '0 <= age < 30 seconds']);
function checkCache(row, want) {
  keys(row, ['id', 'calls', 'keyIdentity', 'ttlSeconds', 'identity', 'mtimeFloat', 'before', 'after']);
  unchanged(row.before, row.after);
  assert.equal(row.ttlSeconds, want.ttlSeconds);
  assert.equal(row.calls.length, want.calls.length);
  assert.deepEqual(row.before.map(entry => entry.path).sort(), ['.', 'files', 'files/file.bin', 'sentinel']);
  const file = row.before.find(entry => entry.path === 'files/file.bin');
  assert.equal(file.contentHex, want.fileHex);
  assert.deepEqual(row.identity, [file.device, file.ino, file.size, file.mtimeNs, file.ctimeNs]);
  assert.equal(Number(file.size), 27);
  assert.equal(row.mtimeFloat, 1700000000);
  assert.equal(file.mtimeNs, '1700000000000000000');
  const modifiedAt = new Date(row.mtimeFloat * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  assert.equal(row.keyIdentity.length, row.calls.length);
  for (let i = 0; i < row.calls.length; i++) {
    assert.equal(row.keyIdentity[i].length, row.calls.length);
    assert.equal(row.keyIdentity[i][i], true);
    for (let j = 0; j < row.calls.length; j++) {
      assert.equal(typeof row.keyIdentity[i][j], 'boolean');
      assert.equal(row.keyIdentity[i][j], row.keyIdentity[j][i]);
    }
  }
  if (['cache-equal-pair', 'cache-equal-scalar', 'cache-expired-pair'].includes(row.id)) {
    assert.deepEqual(row.keyIdentity, row.calls.map((_, i) => row.calls.map((_, j) => i === j)));
  }
  for (const [index, call] of row.calls.entries()) {
    const expected = want.calls[index];
    keys(call, ['key', 'recordAfter', 'clockOffsetSeconds', 'events', 'reads', 'metadataReads', 'descriptorCalls', 'result', 'cacheBefore', 'cacheAfter', 'retainedKeyObjectFromCall']);
    assert.deepEqual(call.key, expected.key);
    assert.deepEqual(call.recordAfter, { storageKind: 'managed', managedFile: { type: 'text', points: points('file.bin') }, id: expected.key });
    assert.equal(call.clockOffsetSeconds, expected.clockOffsetSeconds);
    const observed = call.events.filter((event, i, events) => event !== 'private_digest:os.read' || events[i - 1] !== event)
      .map(event => event === 'private_digest:os.read' ? 'private_digest:os.read* through EOF' : event);
    assert.deepEqual(observed, expected.events.filter(event => !derivedPredicates.has(event))
      .map(event => event === 'private_digest:S_ISREG and size bound' ? 'private_digest:S_ISREG' : event));
    assert.equal(call.events.includes('private_digest:os.open(O_RDONLY|O_NOFOLLOW)'), !expected.hit);
    assert.equal(call.events.includes('path.lstat:second'), !expected.hit);
    assert.equal(call.metadataReads.length, expected.hit ? 1 : 2);
    for (const metadata of call.metadataReads) {
      assert.deepEqual(metadata.identity, row.identity);
      assert.equal(metadata.size, '27');
      assert.ok(BigInt(metadata.size) <= 10n * 1024n * 1024n);
      assert.equal(metadata.mode & 0o170000, 0o100000);
    }
    if (expected.hit) {
      assert.deepEqual(call.reads, []);
      assert.deepEqual(call.descriptorCalls, []);
    }
    else {
      assert.equal(call.descriptorCalls.length, 2);
      assert.equal(call.descriptorCalls[0].operation, 'open');
      assert.equal(call.descriptorCalls[0].flags, process.platform === 'darwin' ? 256 : 131072);
      assert.ok(String.fromCodePoint(...call.descriptorCalls[0].pathPoints).endsWith('/files/file.bin'));
      assert.deepEqual(call.descriptorCalls[1], { operation: 'fstat', metadata: call.metadataReads[0] });
      assert.ok(call.reads.length >= 2);
      assert.equal(call.reads.at(-1).hex, '');
      assert.ok(call.reads.slice(0, -1).every(read => read.hex.length > 0));
      assert.ok(call.reads.every(read => read.requested === 1024 * 1024));
      assert.equal(call.reads.map(read => read.hex).join(''), want.fileHex);
    }
    assert.deepEqual(call.result, { ...expected.result, modifiedAt });
    for (const key of ['cacheBefore', 'cacheAfter']) {
      assert.deepEqual(call[key].map(({ identity, digest, ...entry }) => entry), expected[key]);
      for (const entry of call[key]) {
        assert.deepEqual(entry.identity, row.identity);
        assert.equal(entry.digest, hash(Buffer.from(want.fileHex, 'hex')));
      }
    }
    assert.equal(call.retainedKeyObjectFromCall, expected.retainedKeyObjectFromCall);
    // Predicate checks are derived from captured immutable metadata/cache/clock, not invented calls.
    const cached = call.cacheBefore.find(entry => entry.originalKeyCall === call.retainedKeyObjectFromCall);
    assert.equal(cached !== undefined, expected.cacheCondition.cachedNonNull);
    if (cached) {
      const age = call.clockOffsetSeconds - cached.checkedAtSeconds;
      assert.equal(age, expected.cacheCondition.ageSeconds);
      assert.equal(age >= 0, expected.cacheCondition.lowerBound);
      assert.equal(age < row.ttlSeconds, expected.cacheCondition.upperBound);
      assert.deepEqual(cached.identity, row.identity);
      assert.equal(expected.hit, age >= 0 && age < row.ttlSeconds);
    }
  }
}

function checkProvenance(t, receipt, executable, expectedVersion) {
  const run = spawnSync(executable, ['-I', '-B', '-c', probe], { input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 150000 });
  t.diagnostic(JSON.stringify({ kind: 'independent-provenance', executable, stdoutSha256: hash(run.stdout ?? ''), stdout: run.stdout, stderr: run.stderr, status: run.status }));
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const independent = JSON.parse(run.stdout), profile = receipt.profile;
  for (const field of ['executable', 'version', 'implementation', 'platform', 'machine', 'byteorder', 'filesystemEncoding', 'filesystemErrors']) assert.equal(profile[field], independent[field]);
  assert.equal(profile.implementation, 'CPython');
  assert.equal(profile.platform, process.platform);
  assert.equal(profile.isolated, 1);
  assert.equal(profile.filesystemEncoding, 'utf-8');
  assert.equal(profile.filesystemErrors, 'surrogateescape');
  assert.equal(profile.executable, realpathSync(profile.executable));
  assert.equal(profile.executableSha256, hash(readFileSync(independent.executable)));
  keys(profile, ['version', 'versionInfo', 'implementation', 'platform', 'machine', 'byteorder', 'executable', 'executableSha256', 'filesystemEncoding', 'filesystemErrors', 'isolated']);
  assert.equal(profile.versionInfo.length, 3);
  assert.ok(profile.versionInfo.every(Number.isSafeInteger));
  const version = profile.versionInfo.slice(0, 2).join('.');
  assert.ok(['3.12', '3.13', '3.14'].includes(version));
  if (expectedVersion) assert.equal(version, expectedVersion);
  assert.deepEqual(receipt.sourceProvenance.map(row => row.path), sourcePaths);
  for (const row of receipt.sourceProvenance) {
    assert.equal(row.sha256, hash(readFileSync(join(root, row.path))));
    if (row.path.startsWith('scripts/')) assert.equal(row.sha256, pins.get(row.path));
  }
  for (const row of receipt.loadedModules) {
    keys(row, row.origin === 'built-in' ? ['name', 'origin']
      : ['name', 'origin', 'sha256', ...(Object.hasOwn(row, 'file') ? ['file'] : [])]);
    if (row.origin !== 'built-in') {
      assert.match(row.sha256, /^[a-f0-9]{64}$/);
      if (row.file) assert.notEqual(row.file, row.origin);
      else assert.ok(row.origin.startsWith('/'));
    }
  }
  const modules = receipt.loadedModules.map(row => ({ ...row, file: row.file ?? (row.origin?.startsWith('/') ? row.origin : undefined) }));
  const loaded = new Map(modules.map(row => [row.name, row]));
  assert.equal(loaded.size, receipt.loadedModules.length);
  for (const row of modules) if (row.file) assert.equal(row.sha256, hash(readFileSync(row.file)));
  for (const row of independent.rows) {
    const actual = loaded.get(row.name);
    assert.ok(actual, row.name);
    assert.equal(actual.origin, row.origin);
    if (row.file) assert.equal(actual.file, row.file);
    else assert.equal(actual.origin, 'built-in');
  }
  const actualLocal = modules.filter(row => row.file?.startsWith(realpathSync(join(root, 'scripts/job_apply_store')) + '/')).map(row => row.file.slice(realpathSync(root).length + 1)).sort();
  assert.deepEqual(actualLocal, sourcePaths.filter(path => path.startsWith('scripts/')).sort());
  return version;
}
function observe(t, executable, expectedVersion) {
  const run = spawnSync(executable, ['-I', '-B', driver], { input: '', encoding: 'utf8', timeout: 20000, maxBuffer: 150000 });
  t.diagnostic(JSON.stringify({ executable, stdoutSha256: hash(run.stdout ?? ''), stdout: run.stdout, stderr: run.stderr, status: run.status }));
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.ok(Buffer.byteLength(run.stdout) <= 150000);
  const receipt = JSON.parse(run.stdout);
  keys(receipt, ['schemaVersion', 'scope', 'sourceProvenance', 'cases', 'profile', 'loadedModules']);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.scope, 'owned-point-path-reference');
  checkProvenance(t, receipt, executable, expectedVersion);
  assert.deepEqual(receipt.cases.map(row => row.id), ids);
  for (let index = 0; index < 24; index++) {
    const want = vectors.codecs[index];
    assert.deepEqual(receipt.cases[index], { ...want, error: fullError(want.error) });
  }
  vectors.parents.forEach((want, index) => checkParent(receipt.cases[index + 24], want));
  vectors.caches.forEach((want, index) => checkCache(receipt.cases[index + 40], want));
}
test('S05 reference observes point codecs parent order and cache identity under default CPython', t => observe(t, 'python3'));
test('S05 reference observes point codecs parent order and cache identity under CPython 3.12', t => observe(t, 'python3.12', '3.12'));
test('S05 reference observes point codecs parent order and cache identity under CPython 3.13', t => observe(t, 'python3.13', '3.13'));
test('S05 reference observes point codecs parent order and cache identity under CPython 3.14', t => observe(t, 'python3.14', '3.14'));
test('S05 reference rejects caller arguments paths and stdin', () => {
  for (const [args, input] of [[['synthetic'], ''], [['/outside/caller/path'], ''], [[], '{}'], [[], '\n']]) {
    const run = spawnSync('python3', ['-I', '-B', driver, ...args], { input, encoding: 'utf8', timeout: 3000, maxBuffer: 10000 });
    assert.ifError(run.error);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'point_paths_reference_input_rejected\n');
  }
});


const codecEncodeInputs = [[], [0], [0x10000], [0xd800], [0xdc00], [0xdc7f],
  [0xdc80], [0xdcff], [0xd800, 0xdc00], [0xd800, 0xdc80], [0xdc80, 0xdcff], [0, 0xd800]];
const codecDecodeInputs = ['', '610062', 'f48fbfbf', 'f0908080', 'ff', '80',
  'c0af', 'e08080', 'eda080edb080', 'f09080', '61ff62', 'f4908080'];
function codecError(error, input) {
  assert.ok(error instanceof PythonUnicodeEncodeError);
  assert.equal(error.object, input);
  return { name: error.name, message: error.message, errno: error.errno ?? null,
    cause: error.cause ?? null, context: error.context ?? null,
    suppressContext: error.suppressContext ?? false, encoding: error.encoding,
    objectPoints: [...pointContents(error.object)], objectHex: null,
    start: error.start, end: error.end, reason: error.reason };
}
test('S05 point filesystem codec matches the accepted24 surrogateescape observations', t => {
  const actual = [];
  for (const [index, inputPoints] of codecEncodeInputs.entries()) {
    const input = PythonText.fromCodePoints(inputPoints);
    let outputHex = null, error = null;
    try {
      const output = filesystemEncodePoint(input);
      assert.ok(Buffer.isBuffer(output));
      outputHex = output.toString('hex');
      assert.deepEqual(pointContents(filesystemDecodePoint(output)), inputPoints);
      assert.notEqual(filesystemEncodePoint(input), output);
    } catch (caught) { error = codecError(caught, input); }
    assert.deepEqual(pointContents(input), inputPoints);
    actual.push({ id: `encode-${encode[index]}`, operation: 'os.fsencode', inputPoints, outputHex, error });
  }
  for (const [index, inputHex] of codecDecodeInputs.entries()) {
    const input = Buffer.from(inputHex, 'hex'), before = Buffer.from(input);
    const output = filesystemDecodePoint(input);
    assert.ok(output instanceof PythonText);
    assert.deepEqual(input, before);
    assert.deepEqual(filesystemEncodePoint(output), input);
    actual.push({ id: `decode-${decode[index]}`, operation: 'os.fsdecode', inputHex,
      outputPoints: [...pointContents(output)], error: null });
  }
  assert.deepEqual(actual, vectors.codecs.map(row => ({ ...row, error: fullError(row.error) })));
  t.diagnostic(JSON.stringify({ kind: 'typescript-codec24', cases: actual }));
});
test('S05 point filesystem codec preserves trusted text identity and leaves legacy bytes unchanged', () => {
  class HostileText extends PythonText {
    get codePoints() { throw new Error('virtual points'); }
    get length() { throw new Error('virtual length'); }
    encodeUtf8() { throw new Error('virtual encoding'); }
    toString() { throw new Error('virtual string'); }
    [Symbol.toPrimitive]() { throw new Error('virtual coercion'); }
  }
  const branded = points => Reflect.construct(PythonText, [points], HostileText);
  assert.equal(filesystemEncodePoint(branded([0x10000, 0xdc80, 0])).toString('hex'), 'f09080808000');
  for (const inputPoints of [[0xd800], [0xd800, 0xdc80], [0, 0xd800]]) {
    const input = branded(inputPoints);
    const want = vectors.codecs.find(row => JSON.stringify(row.inputPoints) === JSON.stringify(inputPoints));
    assert.throws(() => filesystemEncodePoint(input), error => {
      assert.deepEqual(codecError(error, input), fullError(want.error));
      return true;
    });
  }
  for (const forged of [Object.create(PythonText.prototype), {}, 'text', null]) {
    assert.throws(() => filesystemEncodePoint(forged), TypeError);
  }
  for (const [input, outputHex] of [['\u{10000}', 'f0908080'], ['\ud800\udc80', 'f0908280'],
    ['\udc80\udcff', '80ff'], ['a\0b', '610062']]) {
    assert.equal(filesystemEncode(input).toString('hex'), outputHex);
    assert.equal(filesystemDecode(Buffer.from(outputHex, 'hex')), input);
  }
  assert.throws(() => filesystemEncode('\ud800'), { name: 'UnicodeEncodeError' });
  const backing = new Uint8Array([0x7e, 0xf0, 0x90, 0x80, 0x80, 0xff, 0, 0x7e]);
  const before = new Uint8Array(backing), view = backing.subarray(1, 7);
  assert.deepEqual(pointContents(filesystemDecodePoint(view)), [0x10000, 0xdcff, 0]);
  assert.deepEqual(backing, before);
  const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const decoded = filesystemDecodePoint(allBytes);
  assert.ok(pointContents(decoded).every(point => point < 0xd800 || point > 0xdfff
    || (point >= 0xdc80 && point <= 0xdcff)));
  assert.deepEqual(filesystemEncodePoint(decoded), Buffer.from(allBytes));
});

// Immutable prior matrix canonicalization preserves every key and array order.
const registrationBaselineSha256 = '9df019e90b2bf485917f94364c36cbfd6ab8dd94f8d3ced21c383957985183ac';
const registrationOwnership = {
  "paths": [
    "tests_js/point_paths_domain_support.mjs",
    "tests_js/point_managed_path_support.mjs",
    "tests_js/point_managed_observation_support.mjs",
    "tests_js/point_managed_native_support.mjs"
  ],
  "suites": [
    "node-workspace-other",
    "node-reference-s05"
  ]
};

test('S05 path support registration preserves the exact prior matrix', t => {
  const matrix = JSON.parse(readFileSync(join(root, 'config/test-matrix.json'), 'utf8'));
  assert.deepEqual(matrix.ownership.at(-1), registrationOwnership);
  for (const path of registrationOwnership.paths) {
    const owners = matrix.ownership.filter(rule => rule.paths.includes(path));
    assert.deepEqual(owners, [registrationOwnership], path);
  }
  for (const id of registrationOwnership.suites) {
    const suites = matrix.suites.filter(suite => suite.id === id);
    assert.equal(suites.length, 1);
    assert.equal(suites[0].kind, 'node-test');
    assert.ok(suites[0].tiers.includes('full'));
  }
  matrix.ownership.pop();
  assert.equal(hash(JSON.stringify(matrix)), registrationBaselineSha256);
  t.diagnostic(JSON.stringify({ registrationBaselineSha256, ownership: registrationOwnership }));
});
