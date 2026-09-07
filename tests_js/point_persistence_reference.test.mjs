import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
const root = fileURLToPath(new URL('../', import.meta.url));
const driver = join(root, 'tools/contracts/point-persistence/reference.py');
const hash = value => createHash('sha256').update(value).digest('hex');
const vectorBytes = readFileSync(join(root, 'docs/migration/evidence/s04/reference-vectors.json'));
assert.equal(hash(vectorBytes), '5f780fccad0679310cd70f08a7b39493cb86879d4c65a3ffc262637b44bbe04a');
const vectors = JSON.parse(vectorBytes);
const manifest = JSON.parse(readFileSync(join(root, 'docs/migration/evidence/s04/S04.R.json')));
const pins = new Map(manifest.inputs.map(row => [row.path, row.sha256]));
const chunks = ['scalar', 'pair', 'high', 'low', 'surrogate-run', 'controls', 'pair-value',
  'pair-key', 'key-order', 'empty-nested', 'shared', 'cycle', 'invalid-key',
  'bad-before-cycle', 'bad-before-integer', 'integer640', 'integer641', 'unlimited641'];
const atomic = ['scalar', 'pair', 'pair-key', 'prefix-pair', 'pair-before-cycle', 'pair-before-integer',
  'pair-close', 'pair-cleanup', 'pair-close-cleanup', 'installed-mode-error'];
const jsonl = ['scalar', 'pair', 'pair-key', 'pair-before-cycle', 'pair-before-integer',
  'gate-hit-pair', 'gate-error-pair', 'controls'];
const ids = [...chunks.map(id => `chunk-${id}`), ...atomic.map(id => `atomic-${id}`), ...jsonl.map(id => `jsonl-${id}`)];
const expected = [...vectors.chunks, ...vectors.atomic, ...vectors.jsonl];
assert.deepEqual(expected.map(row => row.id), ids);
const modules = ['__init__', 'base', 'constants', 'errors', 'io', 'normalization', 'domains/__init__',
  'validation/__init__', 'validation/accounts', 'validation/extraction', 'validation/jobs_resumes',
  'validation/profile_answers', 'validation/sessions', 'domains/coordinator/__init__', 'domains/coordinator/persistence'];
const sourcePaths = [...modules.map(name => `scripts/job_apply_store/${name}.py`),
  ...['reference', 'fixtures', 'support'].map(name => `tools/contracts/point-persistence/${name}.py`)];
const probe = String.raw`
import json, tempfile, pathlib, platform, sys, _json, _io, _codecs
from pathlib import Path
names = ['json', 'json.decoder', 'json.encoder', 'json.scanner', 'tempfile', '_json', '_io', '_codecs']
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
function keys(row, names) { assert.deepEqual(Object.keys(row).sort(), names.sort());
}
function withoutAtime(row) {
  const { atimeNs, ...rest } = row;
  return rest;
}
function state(row) {
  keys(row, ['kind', 'mode', 'ino', 'device', 'size', 'mtimeNs', 'ctimeNs', 'atimeNs', 'contentHex']);
  assert.ok(['file', 'directory'].includes(row.kind));
  assert.ok(Number.isInteger(row.mode));
  for (const key of ['ino', 'device', 'size', 'mtimeNs', 'ctimeNs', 'atimeNs']) assert.match(row[key], /^-?\d+$/);
  if (row.kind === 'file') {
    assert.match(row.contentHex, /^(?:[0-9a-f]{2})*$/);
    assert.equal(BigInt(row.size), BigInt(row.contentHex.length / 2));
  } else assert.equal(row.contentHex, null);
}
function tree(rows) {
  assert.deepEqual(rows.map(row => row.path).sort(), [...new Set(rows.map(row => row.path))].sort());
  for (const { path, ...entry } of rows) state(entry);
  return new Map(rows.map(({ path, ...entry }) => [path, entry]));
}
function checkTrees(row, want) {
  const before = tree(row.before), after = tree(row.after);
  assert.deepEqual([...before.keys()].sort(), ['.', 'private', 'private/document.json', 'sentinel']);
  assert.deepEqual([...after.keys()].sort(), [...before.keys(), ...(want.expectedFinalTemp === 'regular-file' ? ['<temp>'] : [])].sort());
  assert.equal(before.get('private').mode, 0o700);
  assert.equal(after.get('private').mode, 0o700);
  assert.equal(before.get('private').kind, 'directory');
  assert.equal(after.get('private').kind, 'directory');
  assert.equal(after.get('private').ino, before.get('private').ino);
  assert.equal(before.get('sentinel').mode, 0o600);
  assert.equal(before.get('private/document.json').contentHex, '7b7d0a');
  assert.equal(before.get('private/document.json').mode, 0o600);
  assert.equal(before.get('sentinel').contentHex, '73656e74696e656c');
  assert.deepEqual(withoutAtime(after.get('sentinel')), withoutAtime(before.get('sentinel')));
  const old = before.get('private/document.json'), target = after.get('private/document.json');
  assert.equal(target.contentHex, want.targetHex);
  assert.equal(target.mode, want.targetMode);
  if (want.targetHex === '7b7d0a') assert.deepEqual(withoutAtime(target), withoutAtime(old));
  if (row.operation === 'jsonl') assert.equal(target.ino, old.ino);
  const close = row.events.find(event => event.operation === 'temporary.close');
  if (close) {
    state(close.postClose);
    assert.equal(close.postClose.contentHex, want.expectedPostCloseTempHex);
    assert.equal(close.postClose.mode, 0o600);
    if (row.events.some(event => event.operation === 'replace')) assert.equal(target.ino, close.postClose.ino);
    if (want.expectedFinalTemp === 'regular-file') assert.deepEqual(withoutAtime(after.get('<temp>')), withoutAtime(close.postClose));
  }
}
function atomicEvents(row, want) {
  let index = 0, syncedFile = false;
  return row.events.map(event => {
    switch (event.operation) {
      case 'mkdir':
        assert.deepEqual(event.kwargs, { parents: true, exist_ok: true, mode: 448 });
        return 'parent.mkdir(parents=true,exist_ok=true,mode=0700)';
      case 'parent-chmod':
        assert.equal(event.mode, 448);
        return 'parent.chmod(0700)';
      case 'temp-create':
        assert.deepEqual(event, { operation: 'temp-create', mode: 'w', encoding: 'utf-8', delete: false });
        return 'NamedTemporaryFile(w,utf-8,delete=false)';
      case 'temporary.write':
        return index++ < want.writeChunksPoints.length ? `temporary.write(chunk:${index - 1})` : 'temporary.write(LF)';
      case 'temporary.flush':
        case 'temporary.fileno': case 'temporary.close': return event.operation;
      case 'fsync':
        {
        const label = syncedFile ? 'os.fsync(parent)' : 'os.fsync(file)';
        syncedFile = true;
        return label;
      }
      case 'temp-chmod':
        assert.equal(event.mode, 384);
        return 'temporary.chmod(0600)';
      case 'target-chmod':
        assert.equal(event.mode, 384);
        return 'target.chmod(0600)';
      case 'replace':
        return 'os.replace(temp,target)';
      case 'open':
        assert.equal(event.flags, 0);
        assert.equal(event.mode, null);
        return 'os.open(parent,O_RDONLY)';
      case 'os.close':
        return 'os.close(parent)';
      case 'unlink':
        assert.equal(event.beforeHex, want.expectedPostCloseTempHex);
        return 'temporary.unlink';
      default: assert.fail(`Unexpected atomic event ${event.operation}`);
    }
  });
}
function checkAtomic(row, want) {
  assert.deepEqual(atomicEvents(row, want), want.productionEvents, row.id);
  const writes = row.events.filter(event => event.operation === 'temporary.write');
  const ordinary = writes.slice(0, want.writeChunksPoints.length);
  assert.deepEqual(ordinary.map(event => event.points), want.writeChunksPoints);
  assert.deepEqual(ordinary.map(event => event.result ?? null), want.expectedWriteResults);
  assert.deepEqual(ordinary.map(event => event.visibleHexAfterCall), want.expectedVisibleHexAfterEachWrite.slice(0, ordinary.length));
  assert.deepEqual(ordinary.filter(event => !event.error).map(event => Buffer.from(String.fromCodePoint(...event.points), 'utf8').toString('hex')), want.successfulWriteHex);
  for (const event of ordinary) {
    if (event.error) {
      let unicode = want.error;
      while (unicode && unicode.name !== 'UnicodeEncodeError') unicode = unicode.context;
      assert.deepEqual(event.error, unicode);
      assert.equal(Object.hasOwn(event, 'result'), false);
    } else assert.equal(event.result, event.points.length);
  }
  if (want.finalLfWrite) {
    assert.equal(writes.length, ordinary.length + 1);
    assert.deepEqual(writes.at(-1), { operation: 'temporary.write', points: [10], result: 1,
      visibleHexAfterCall: want.expectedVisibleHexAfterEachWrite.at(-1) });
  } else assert.equal(writes.length, ordinary.length);
  assert.equal(row.result, null);
}
function checkJsonl(row, want) {
  const events = [];
  let written = 0;
  for (const event of row.events) {
    switch (event.operation) {
      case 'gate':
        assert.equal(event.sameObject, true);
        assert.equal(event.result ?? null, want.gateResult);
        events.push('gate');
        break;
      case 'json.dumps':
        assert.deepEqual(event.kwargs, { sort_keys: true, ensure_ascii: false });
        events.push('json.dumps');
        break;
      case 'strictUtf8.encode':
        assert.deepEqual(event.points, want.linePoints);
        assert.deepEqual(event.args, ['utf-8']);
        assert.deepEqual(event.kwargs, {});
        events.push('strictUtf8.encode');
        break;
      case 'open':
        assert.equal(event.flags, process.platform === 'darwin' ? 521 : 1089);
        assert.equal(event.mode, 384);
        events.push('os.open(O_WRONLY|O_CREAT|O_APPEND,0600)');
        break;
      case 'fstat':
        events.push('os.fstat');
        break;
      case 'os.write':
        assert.equal(event.hex, want.appendedHex.slice(written * 2));
        assert.ok(Number.isInteger(event.result) && event.result > 0 && event.result <= event.hex.length / 2);
        written += event.result;
        if (events.at(-1) !== 'os.write*') events.push('os.write*');
        break;
      case 'fsync':
        events.push('os.fsync');
        break;
      case 'os.close':
        events.push('os.close');
        break;
      case 'target-chmod':
        assert.equal(event.mode, 384);
        events.push('target.chmod(0600)');
        break;
      default: assert.fail(`Unexpected JSONL event ${event.operation}`);
    }
  }
  assert.deepEqual(events, want.productionEvents, row.id);
  assert.equal(written * 2, want.appendedHex.length);
  assert.equal(row.result, null);
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
  const loaded = new Map(receipt.loadedModules.map(row => [row.name, row]));
  assert.equal(loaded.size, receipt.loadedModules.length);
  for (const row of receipt.loadedModules) if (row.file) assert.equal(row.sha256, hash(readFileSync(row.file)));
  for (const row of independent.rows) {
    const actual = loaded.get(row.name);
    assert.ok(actual, row.name);
    assert.equal(actual.origin, row.origin);
    if (row.file) assert.equal(actual.file, row.file);
    else assert.equal(actual.origin, 'built-in');
  }
  const actualLocal = receipt.loadedModules.filter(row => row.file?.startsWith(realpathSync(join(root, 'scripts/job_apply_store')) + '/')).map(row => row.file.slice(realpathSync(root).length + 1)).sort();
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
  assert.equal(receipt.scope, 'owned-point-persistence-reference');
  const version = checkProvenance(t, receipt, executable, expectedVersion);
  assert.deepEqual(receipt.cases.map(row => row.id), ids);
  for (const [index, row] of receipt.cases.entries()) {
    const want = expected[index];
    keys(row, ['id', 'operation', 'inputGraph', 'intMaxStrDigits', 'faults',
      ...(row.operation === 'chunk' ? ['serializer', 'strictUtf8'] : ['events', 'error', 'result', 'before', 'after'])]);
    assert.deepEqual(row.inputGraph, want.inputGraph, row.id);
    assert.equal(row.operation, row.id.split('-')[0]);
    assert.equal(row.intMaxStrDigits, want.intMaxStrDigits);
    assert.deepEqual(row.faults, (want.faults ?? []).map(fault => fault.stage));
    if (row.operation === 'chunk') {
      assert.deepEqual(row.serializer, want.profiles[version].serializer, row.id);
      assert.deepEqual(row.strictUtf8, want.profiles[version].strictUtf8, row.id);
    } else {
      assert.deepEqual(row.error, want.error, row.id);
      checkTrees(row, want);
      if (row.operation === 'atomic') checkAtomic(row, want);
      else checkJsonl(row, want);
    }
  }
}
test('S04 reference observes point chunks and persistence effects under default CPython', t => observe(t, 'python3'));
test('S04 reference observes point chunks and persistence effects under CPython 3.12', t => observe(t, 'python3.12', '3.12'));
test('S04 reference observes point chunks and persistence effects under CPython 3.13', t => observe(t, 'python3.13', '3.13'));
test('S04 reference observes point chunks and persistence effects under CPython 3.14', t => observe(t, 'python3.14', '3.14'));
test('S04 reference rejects caller arguments paths and stdin', () => {
  for (const [args, input] of [[['synthetic'], ''], [['/outside/caller/path'], ''], [[], '{}'], [[], '\n']]) {
    const run = spawnSync('python3', ['-I', '-B', driver, ...args], { input, encoding: 'utf8', timeout: 3000, maxBuffer: 10000 });
    assert.ifError(run.error);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'point_persistence_reference_input_rejected\n');
  }
});
