import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const driver = fileURLToPath(new URL('tools/contracts/point-path-domain/reference.py', root));
const hash = value => createHash('sha256').update(value).digest('hex');
const fileIds = ['null', 'true', 'false', 'int-zero', 'int-huge', 'float-zero', 'float-fraction',
  'float-nan', 'float-positive-infinity', 'float-negative-infinity', 'list', 'dict'];
const types = ['NoneType', 'bool', 'bool', 'int', 'int', 'float', 'float', 'float', 'float', 'float', 'list', 'dict'];
const sequences = [
  ['null', ['none', 'none', 'false'], [0, 0, 1]],
  ['zero', ['false', 'int-zero', 'float-zero', 'float-negative-zero'], [0, 0, 0, 0]],
  ['fraction', ['float-fraction-a', 'float-fraction-b', 'int-one'], [0, 0, 1]],
  ['infinity', ['positive-inf-a', 'positive-inf-b', 'negative-inf-a', 'negative-inf-b'], [0, 0, 1, 1]],
  ['exact-large', ['int-exact', 'float-exact', 'int-rounded-neighbor', 'float-rounded-neighbor'], [0, 0, 1, 0]],
  ['integer-beyond-float', ['int-huge', 'positive-inf-a', 'int-negative-huge', 'negative-inf-a'], [0, 1, 2, 3]],
  ['nan-same', ['nan-a', 'nan-a'], [0, 0]],
  ['nan-distinct', ['nan-a', 'nan-b', 'nan-a', 'nan-b'], [0, 1, 0, 1]],
  ['negative', ['int-negative-one', 'float-negative-one', 'int-negative-two'], [0, 0, 1]],
];
const fileRefs = ['none', 'true', 'false', 'int-zero', 'int-huge', 'float-negative-zero',
  'float-fraction-a', 'nan-a', 'positive-inf-a', 'negative-inf-a', 'list', 'dict'];
const textValue = value => ({ type: 'text', points: [...value].map(character => character.codePointAt(0)) });
function expectedNode(ref) {
  if (ref === 'none') return { type: 'none' };
  if (ref === 'true' || ref === 'false') return { type: 'bool', value: ref === 'true' };
  if (ref === 'list' || ref === 'dict') return { type: ref, length: 0 };
  const integers = { 'int-zero': 0n, 'int-one': 1n, 'int-negative-one': -1n, 'int-negative-two': -2n,
    'int-huge': 2n ** 1024n, 'int-negative-huge': -(2n ** 1024n),
    'int-exact': 2n ** 53n, 'int-rounded-neighbor': 2n ** 53n + 1n };
  if (Object.hasOwn(integers, ref)) return { type: 'int', decimal: String(integers[ref]) };
  const floats = { 'float-zero': '0x0.0p+0', 'float-negative-zero': '-0x0.0p+0',
    'float-fraction-a': '0x1.8000000000000p+0', 'float-fraction-b': '0x1.8000000000000p+0',
    'float-exact': '0x1.0000000000000p+53', 'float-rounded-neighbor': '0x1.0000000000000p+53',
    'float-negative-one': '-0x1.0000000000000p+0', 'positive-inf-a': 'inf', 'positive-inf-b': 'inf',
    'negative-inf-a': '-inf', 'negative-inf-b': '-inf', 'nan-a': 'nan', 'nan-b': 'nan' };
  assert.ok(Object.hasOwn(floats, ref), ref);
  return { type: 'float', hex: floats[ref] };
}
const timing = ['list', 'dict'].flatMap(type => ['active', 'omitted', 'missing', 'null-identity'].map(mode => [type, mode]));
const missingIds = ['regular', 'leaf', 'invalid-file'];
const ids = [...fileIds.map(x => 'domain-file-' + x), ...sequences.map(x => 'domain-cache-' + x[0]),
  ...timing.map(([type, mode]) => `domain-cache-${mode}-${type}`), ...missingIds.map(x => 'domain-id-missing-' + x)];
const closed = (row, keys) => assert.deepEqual(Object.keys(row).sort(), [...keys].sort());
const pathOps = ['record.get', 'record[]', 'path.join', 'path.parent', 'path.resolve', 'path.resolve'];
const initial = [...pathOps, 'record[]', 'path.lstat', 'path.metadata', 'path.is_symlink', 'S_ISREG', 'cache.identity', 'clock'];
const digestOps = ['private_digest', 'digest.is_symlink', 'os.open', 'os.fstat', 'digest.S_ISREG', 'os.read', 'os.read', 'os.close'];
const afterOps = ['path.lstat', 'path.metadata', 'S_ISREG', 'modified_at', 'cache.identity'];
const missing = { exists: false, size: null, modifiedAt: null, digest: null };
const success = { exists: true, size: 27, modifiedAt: '2023-11-14T22:13:20Z',
  digest: hash(Buffer.from('synthetic observation bytes')) };
const error = (name, message) => ({ name, message, errno: null, cause: null, context: null, suppressContext: false });
const typeError = type => error('TypeError', `unsupported operand type(s) for /: 'PosixPath' and '${type}'`);
const probe = String.raw`
import json, sys, platform, pathlib, hashlib, os, stat, datetime, tempfile, _json, _io, _codecs
from pathlib import Path
names = ['os', 'stat', 'datetime', 'hashlib', 'json', 'pathlib', 'tempfile', '_json', '_io', '_codecs']
names += sorted(n for n in sys.modules if n.startswith('pathlib.'))
rows=[]
for name in names:
 m=sys.modules[name]; f=getattr(m,'__file__',None)
 rows.append(dict(name=name,origin=m.__spec__.origin,file=str(Path(f).resolve()) if f else None))
print(json.dumps(dict(executable=str(Path(sys.executable).resolve()),version=sys.version,
 implementation=platform.python_implementation(),platform=sys.platform,machine=platform.machine(),
 byteorder=sys.byteorder,filesystemEncoding=sys.getfilesystemencoding(),filesystemErrors=sys.getfilesystemencodeerrors(),rows=rows)))
`;

function provenance(t, executable, receipt) {
  const run = spawnSync(executable, ['-I', '-B', '-c', probe], { input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 20000 });
  t.diagnostic(JSON.stringify({ kind: 'domain-provenance', executable, stdout: run.stdout,
    stdoutSha256: hash(run.stdout ?? ''), stderr: run.stderr, status: run.status }));
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const independent = JSON.parse(run.stdout), profile = receipt.profile;
  for (const key of ['executable', 'version', 'implementation', 'platform', 'machine', 'byteorder', 'filesystemEncoding', 'filesystemErrors']) {
    assert.equal(profile[key], independent[key]);
  }
  assert.equal(profile.platform, 'darwin');
  assert.equal(profile.implementation, 'CPython');
  assert.equal(profile.isolated, 1);
  assert.equal(profile.filesystemEncoding, 'utf-8');
  assert.equal(profile.filesystemErrors, 'surrogateescape');
  assert.equal(profile.executableSha256, hash(readFileSync(independent.executable)));
  const loaded = new Map(receipt.loadedModules.map(row => [row.name, row]));
  assert.equal(loaded.size, receipt.loadedModules.length);
  for (const row of receipt.loadedModules) {
    const file = row.file ?? (row.sha256 ? row.origin : null);
    if (file) assert.equal(row.sha256, hash(readFileSync(file)));
    else assert.ok(['built-in', 'frozen'].includes(row.origin));
  }
  for (const row of independent.rows) {
    const actual = loaded.get(row.name);
    assert.ok(actual, row.name);
    assert.equal(actual.origin, row.origin);
    if (row.file) assert.equal(actual.file ?? actual.origin, row.file);
  }
  const accepted = JSON.parse(readFileSync(new URL('docs/migration/evidence/s05/S05.R.json', root)));
  const sourcePins = accepted.inputs.filter(row => row.path.startsWith('scripts/job_apply_store/'));
  const expectedPaths = [...sourcePins.map(row => row.path), ...['reference', 'fixtures', 'support'].map(name => `tools/contracts/point-path-domain/${name}.py`)];
  assert.deepEqual(receipt.localSources.map(row => row.path), expectedPaths);
  for (const row of receipt.localSources) {
    assert.equal(row.sha256, hash(readFileSync(new URL(row.path, root))));
    const old = sourcePins.find(pin => pin.path === row.path);
    if (old) assert.equal(row.sha256, old.sha256);
  }
  const actualLocal = receipt.loadedModules.filter(row => row.name === 'job_apply_store' || row.name.startsWith('job_apply_store.'));
  assert.deepEqual(actualLocal.map(row => realpathSync(row.file ?? row.origin)).sort(),
    sourcePins.filter(row => !['scripts/job_apply_store/domains/coordinator/__init__.py',
      'scripts/job_apply_store/domains/coordinator/persistence.py'].includes(row.path))
      .map(row => realpathSync(fileURLToPath(new URL(row.path, root)))).sort());
}

function tree(receipt, row) {
  const before = receipt.observations[row.treeBefore].map(id => receipt.observations[id]);
  const after = receipt.observations[row.treeAfter].map(id => receipt.observations[id]);
  const withoutAtime = rows => rows.map(({ atimeNs, ...item }) => item);
  assert.deepEqual(withoutAtime(after), withoutAtime(before));
  for (const item of [...before, ...after]) {
    closed(item, ['path', 'mode', 'device', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'atimeNs', 'sha256']);
    for (const key of ['device', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'atimeNs']) assert.match(item[key], /^-?\d+$/);
    assert.ok(['.', 'files', 'files/file.bin', 'sentinel'].includes(item.path));
    assert.equal(item.mode & 0o777, item.sha256 === null ? 0o700 : 0o600);
    if (item.path === 'sentinel') assert.equal(item.sha256, hash(Buffer.from('sentinel')));
    if (item.path === 'files/file.bin') {
      assert.equal(item.sha256, success.digest);
      assert.equal(item.size, '27');
      assert.equal(item.mtimeNs, '1700000000000000000');
    }
  }
}

function checkCall(receipt, call, ops, outcome, failure) {
  closed(call, ['keyRef', 'recordBefore', 'recordAfter', 'recordIdentityPreserved', 'result', 'error', 'events', 'cacheBefore', 'cacheAfter']);
  assert.deepEqual(call.recordAfter, call.recordBefore);
  assert.equal(call.recordIdentityPreserved, true);
  const events = call.events.map(id => receipt.observations[id]);
  assert.deepEqual(events.map(row => row[0]), ops);
  assert.deepEqual(call.result, outcome);
  assert.deepEqual(call.error, failure);
  for (const event of events) {
    if (event[0] === 'path.resolve') assert.equal(event[2], false);
    if (event[0] === 'clock') assert.equal(event[1], '2026-01-02T00:00:00+00:00');
    if (event[0] === 'os.open') assert.deepEqual(event.slice(1), ['files/file.bin', 256]);
    if (event[0] === 'os.read') assert.equal(event[1], 1048576);
    if (event[0] === 'path.metadata' || event[0] === 'os.fstat') {
      const metadata = receipt.observations[event.at(-1)];
      closed(metadata, ['mode', 'identity', 'mtimeSeconds']);
      assert.equal(metadata.identity.length, 5);
      assert.equal(metadata.identity[2], '27');
      assert.equal(metadata.mtimeSeconds, 1700000000);
    }
  }
  const reads = events.filter(row => row[0] === 'os.read').map(row => row[2]);
  if (reads.length) assert.deepEqual(reads, [Buffer.from('synthetic observation bytes').toString('hex'), '']);
}

export function observeDomain(t, executable, version) {
  const run = spawnSync(executable, ['-I', '-B', driver], { input: '', encoding: 'utf8', timeout: 15000, maxBuffer: 180000 });
  t.diagnostic(JSON.stringify({ kind: 'domain32', executable, stdoutSha256: hash(run.stdout ?? ''),
    stdoutBytes: Buffer.byteLength(run.stdout ?? ''), stderr: run.stderr, status: run.status }));
  t.diagnostic('BEGIN DOMAIN RAW STDOUT\n' + (run.stdout ?? '') + 'END DOMAIN RAW STDOUT');
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const receipt = JSON.parse(run.stdout);
  closed(receipt, ['schemaVersion', 'rows', 'observations', 'localSources', 'profile', 'loadedModules']);
  assert.equal(receipt.schemaVersion, 1);
  provenance(t, executable, receipt);
  checkDomain(receipt, version);
}

export function checkDomain(receipt, version) {
  const actualVersion = receipt.profile.versionInfo.slice(0, 2).join('.');
  assert.ok(['3.12', '3.13', '3.14'].includes(actualVersion));
  if (version) assert.equal(actualVersion, version);
  assert.deepEqual(receipt.rows.map(row => row.id), ids);
  for (const [index, row] of receipt.rows.entries()) {
    closed(row, ['id', 'nodes', 'calls', 'identity', 'equality', 'treeBefore', 'treeAfter']);
    tree(receipt, row);
    const refs = index < 12 ? [fileRefs[index]] : index < 21 ? sequences[index - 12][1]
      : index < 29 ? [timing[index - 21][0]] : [];
    assert.deepEqual(row.nodes, Object.fromEntries([...new Set(refs)].sort().map(ref => [ref, expectedNode(ref)])));
    assert.equal(row.calls.length, index < 12 || index >= 29 ? 1 : refs.length);
    for (const [callIndex, call] of row.calls.entries()) {
      const file = index < 12 ? expectedNode(fileRefs[index]) : index === 31 ? expectedNode('int-one')
        : textValue(index === 30 || (index >= 21 && index < 29 && timing[index - 21][1] === 'missing') ? 'missing.bin' : 'file.bin');
      const record = { storageKind: textValue('managed'), managedFile: file };
      if (index >= 12 && index < 29) record.id = expectedNode(refs[callIndex]);
      assert.deepEqual(receipt.observations[call.recordBefore], record);
    }
  }
  for (const [index, type] of types.entries()) {
    checkCall(receipt, receipt.rows[index].calls[0], pathOps.slice(0, 3), null, typeError(type));
  }
  for (const [index, [, refs, groups]] of sequences.entries()) {
    const row = receipt.rows[index + 12];
    assert.deepEqual(row.calls.map(call => call.keyRef), refs);
    const retained = [];
    for (const [callIndex, call] of row.calls.entries()) {
      const hit = groups.indexOf(groups[callIndex]) !== callIndex;
      assert.deepEqual(receipt.observations[call.cacheBefore].map(id => receipt.observations[id].keyRef), retained);
      if (!hit) retained.push(refs[callIndex]);
      checkCall(receipt, call, [...initial, 'cache.get', ...(hit ? ['modified_at'] : [...digestOps, ...afterOps, 'cache.set'])], success, null);
      const entries = receipt.observations[call.cacheAfter].map(id => receipt.observations[id]);
      assert.deepEqual(entries.map(entry => entry.keyRef), retained);
      for (const entry of entries) {
        assert.equal(entry.digest, success.digest);
        assert.equal(entry.checkedAt, '2026-01-02T00:00:00+00:00');
        assert.equal(entry.identity.length, 5);
        const file = receipt.observations[row.treeBefore].map(id => receipt.observations[id]).find(item => item.path === 'files/file.bin');
        assert.deepEqual(entry.identity, [file.device, file.ino, file.size, file.mtimeNs, file.ctimeNs]);
      }
    }
    assert.deepEqual(row.equality, groups.map((group, i) => groups.map(other => refs[i].startsWith('nan') ? false : group === other)));
    if (refs.some(ref => ref.startsWith('nan'))) assert.deepEqual(row.identity, refs.map(ref => refs.map(other => ref === other)));
  }
  for (const [index, [type, mode]] of timing.entries()) {
    const call = receipt.rows[index + 21].calls[0];
    const failure = ['active', 'null-identity'].includes(mode);
    const ops = mode === 'missing' ? [...pathOps, 'record[]', 'path.lstat']
      : [...initial, ...(mode === 'omitted' ? [...digestOps, ...afterOps] : ['cache.get'])];
    checkCall(receipt, call, ops, failure ? null : mode === 'missing' ? missing : success,
      failure ? error('TypeError', actualVersion === '3.14'
        ? `cannot use '${type}' as a dict key (unhashable type: '${type}')`
        : `unhashable type: '${type}'`) : null);
    assert.deepEqual(receipt.observations[call.cacheAfter], mode === 'omitted' ? null : []);
  }
  for (const [index, mode] of missingIds.entries()) {
    checkCall(receipt, receipt.rows[index + 29].calls[0], mode === 'invalid-file' ? pathOps.slice(0, 3) : [...pathOps, 'record[]'],
      null, mode === 'invalid-file' ? typeError('int') : error('KeyError', "'id'"));
  }
}

export function refuseDomain() {
  for (const [args, input] of [[['--unexpected'], ''], [['/not-a-fixture'], ''], [[], 'x']]) {
    const run = spawnSync('python3', ['-I', '-B', driver, ...args], { input, encoding: 'utf8', timeout: 3000, maxBuffer: 10000 });
    assert.ifError(run.error);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'point_paths_domain_reference_input_rejected\n');
  }
}
