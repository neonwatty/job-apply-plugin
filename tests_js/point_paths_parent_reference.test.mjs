import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const dataBytes = readFileSync(new URL('../docs/migration/evidence/s05/reference-baselines.json', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha256(dataBytes), 'e693a5105ffe3e1efb56b4fe6d7e942704e8c81fc73c4dcc9ecc1a8c7ef82ced');
const baselineData = JSON.parse(dataBytes);
for (const pin of baselineData.sourcePins) {
  assert.equal(sha256(readFileSync(new URL('../' + pin.path, import.meta.url))), pin.sha256, pin.path);
}

function record(t, executable, label, result) {
  t.diagnostic(JSON.stringify({ executable, label, stdoutSha256: sha256(result.stdout ?? ''),
    stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderr: result.stderr, status: result.status, signal: result.signal,
    error: result.error ? { code: result.error.code, message: result.error.message } : null }));
  t.diagnostic('BEGIN RAW STDOUT\n' + (result.stdout ?? '') + 'END RAW STDOUT');
  assert.ifError(result.error);
  assert.equal(result.signal, null);
}

const observedProfiles = new Map();
const profileProbe = `import sys,json,platform,pathlib,tempfile,hashlib,_json,_io,_codecs
from pathlib import Path
exe=Path(sys.executable).resolve()
modules=[]
for name,module in sorted(sys.modules.items()):
    if name.split('.')[0] not in ('json','pathlib','tempfile','_json','_io','_codecs'):
        continue
    origin=getattr(module,'__file__',None)
    modules.append({'name':name,'origin':str(Path(origin).resolve()) if origin else None,
        'sha256':hashlib.sha256(Path(origin).read_bytes()).hexdigest() if origin else None})
print(json.dumps({'executable':str(exe),'executableSha256':hashlib.sha256(exe.read_bytes()).hexdigest(),
    'implementation':platform.python_implementation(),'python':platform.python_version(),
    'platform':sys.platform,'architecture':platform.machine(),'byteorder':sys.byteorder,
    'filesystemEncoding':sys.getfilesystemencoding(),'filesystemErrors':sys.getfilesystemencodeerrors(),
    'modules':modules}))`;

function identifyProfile(t, executable) {
  const result = spawnSync(executable, ['-I', '-c', profileProbe], {
    input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
  });
  record(t, executable, 'independent-profile-probe', result);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const profile = JSON.parse(result.stdout);
  assert.equal(profile.implementation, 'CPython');
  assert.match(profile.python, /^3\.(12|13|14)\.\d+$/);
  if (executable !== 'python3') assert.ok(profile.python.startsWith(executable.slice(6) + '.'));
  assert.equal(profile.platform, 'darwin');
  assert.equal(profile.architecture, 'arm64');
  assert.equal(profile.byteorder, 'little');
  assert.equal(profile.filesystemEncoding, 'utf-8');
  assert.equal(profile.filesystemErrors, 'surrogateescape');
  assert.equal(sha256(readFileSync(profile.executable)), profile.executableSha256);
  for (const entry of profile.modules) {
    if (entry.origin === null) assert.equal(entry.sha256, null);
    else assert.equal(sha256(readFileSync(entry.origin)), entry.sha256, entry.name);
  }
  for (const name of ['json', 'json.encoder', 'json.decoder', 'json.scanner', 'pathlib', 'tempfile', '_json', '_io', '_codecs']) {
    assert.ok(profile.modules.some(entry => entry.name === name), name);
  }
  observedProfiles.set(executable, profile);
}

function refusals(t, executable, reference, prefix) {
  for (const [args, input] of [[['--path', 'synthetic'], ''], [[], 'synthetic']]) {
    const result = spawnSync(executable, ['-I', reference, ...args], {
      input, encoding: 'utf8', timeout: 3000, maxBuffer: 4096,
    });
    record(t, executable, 'input-refusal', result);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, prefix + '\n');
  }
}

function observeManaged(t, executable) {
  const reference = fileURLToPath(new URL('../tools/contracts/managed-resume-path/reference.py', import.meta.url));
  const source = new URL('../scripts/job_apply_store/domains/resumes/storage.py', import.meta.url);
  const primary = process.platform === 'win32' ? 'python' : 'python3';
  const ids = baselineData.groups.managed.ids;
  const linkIds = new Set(baselineData.groups.managed.linkIds);
  const paths = baselineData.groups.managed.paths;
  const keys = (object, expected) => assert.deepEqual(Object.keys(object).sort(), expected.sort());

  function expected(id, version, platform) {
    if (Object.hasOwn(paths, id)) {
      const separator = platform === 'win32' ? '\\' : '/';
      const rootName = id === 'root-link' ? 'managed-alias' : 'managed';
      return { kind: 'path', path: '<root>' + separator + [rootName, ...paths[id].split('/')].join(separator) };
    }
    if (id === 'missing-name') return { kind: 'error', name: 'KeyError' };
    if (['null-name', 'integer-name'].includes(id)) return { kind: 'error', name: 'TypeError' };
    if (['loop-parent', 'multi-loop'].includes(id) && version.startsWith('3.12.')) return { kind: 'error', name: 'RuntimeError' };
    return { kind: 'error', name: 'StoreError', message: ['missing-storage', 'external'].includes(id)
      ? 'resume is not managed' : 'managed resume file identity is invalid' };
  }


  const result = spawnSync(executable, ['-I', reference], {
    input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  record(t, executable, 'managed', result);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const receipt = JSON.parse(result.stdout);
  keys(receipt, ['schemaVersion', 'provenance', 'cases']);
  assert.equal(receipt.schemaVersion, 1);
  keys(receipt.provenance, ['implementation', 'python', 'platform', 'sourceSha256', 'symlinks']);
  const profile = receipt.provenance;
  assert.equal(profile.implementation, 'CPython');
  assert.equal(profile.python, observedProfiles.get(executable).python);
  assert.equal(profile.platform, process.platform);
  assert.match(profile.python, /^3\.(12|13|14)\.\d+$/);
  if (executable !== primary) assert.equal(profile.python.split('.').slice(0, 2).join('.'), executable.slice(6));
  assert.equal(profile.sourceSha256, createHash('sha256').update(readFileSync(source)).digest('hex'));
  assert.deepEqual(receipt.cases.map(item => item.id), ids);
  let unavailable = 0;
  for (const item of receipt.cases) {
    if (item.status === 'unavailable') {
      keys(item, ['id', 'status', 'reason']);
      assert.ok(linkIds.has(item.id));
      assert.match(item.reason, /^(OSError|PermissionError|NotImplementedError)$/);
      unavailable += 1;
      continue;
    }
    keys(item, ['id', 'status', 'outcome', 'native', 'resolveCalls', 'before', 'after', 'unchanged']);
    assert.equal(item.status, 'observed');
    const injected = item.id.endsWith('-oserror');
    assert.equal(item.native, !injected);
    assert.deepEqual(item.resolveCalls, injected
      ? Array.from({ length: item.id === 'parent-resolve-oserror' ? 1 : 2 }, (_, index) => ({ call: index + 1, strict: false }))
      : []);
    assert.deepEqual(item.outcome, expected(item.id, profile.python, profile.platform), item.id);
    assert.equal(item.unchanged, true);
    assert.deepEqual(item.after, item.before, item.id);
    for (const entry of item.before) {
      keys(entry, ['path', 'kind', 'mode', 'mtimeNs', 'sha256', 'target']);
      assert.ok(!entry.path.startsWith('/') && !entry.path.split(/[\\/]/).includes('..'));
      assert.match(entry.mtimeNs, /^\d+$/);
      assert.ok(Number.isSafeInteger(entry.mode));
      if (entry.kind === 'file') assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      else assert.equal(entry.sha256, null);
    }
  }
  t.diagnostic(`${profile.python}/${profile.platform}: ${ids.length - unavailable - 2} native observed, 2 injected, ${unavailable} native unavailable; loops preserve interpreter difference`);

  assert.equal(unavailable, 0, 'All supported native baseline cells must be observed');
  if (executable === 'python3') refusals(t, executable, reference, 'managed_path_reference_input_rejected');
}

function observeBytes(t, executable) {
  const driver = fileURLToPath(new URL('../tools/contracts/posix-path-bytes/reference.py', import.meta.url));
  const primary = process.platform === 'win32' ? 'python' : 'python3';
  const source = new URL('../scripts/job_apply_store/domains/resumes/storage.py', import.meta.url);
  const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
  const inputs = baselineData.groups.bytes.inputs;
  const paths = baselineData.groups.bytes.paths;
  const ids = baselineData.groups.bytes.ids;
  const nativeNameCases = new Set(baselineData.groups.bytes.nativeNameCases);


  const result = spawnSync(executable, ['-I', driver], { input: '', encoding: 'utf8', timeout: 15000, maxBuffer: 2 ** 20 });
  record(t, executable, 'bytes', result);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const receipt = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(receipt).sort(), ['cases', 'provenance', 'reason', 'schemaVersion', 'status']);
  assert.equal(receipt.schemaVersion, 1);
  keys(receipt.provenance, ['implementation', 'python', 'platform', 'filesystemEncoding', 'filesystemErrors', 'sourceSha256']);
  assert.equal(receipt.provenance.implementation, 'CPython');
  assert.equal(receipt.provenance.python, observedProfiles.get(executable).python);
  assert.equal(receipt.provenance.platform, process.platform);
  assert.match(receipt.provenance.python, /^3\.(12|13|14)\./);
  if (executable !== primary) assert.equal(receipt.provenance.python.split('.').slice(0, 2).join('.'), executable.slice(6));
  assert.equal(receipt.provenance.filesystemEncoding, 'utf-8');
  assert.equal(receipt.provenance.sourceSha256, createHash('sha256').update(readFileSync(source)).digest('hex'));
  assert.equal(receipt.status, 'observed', 'POSIX native profile required');
  assert.equal(receipt.reason, null);
  assert.equal(receipt.provenance.filesystemErrors, 'surrogateescape');
  assert.deepEqual(receipt.cases.map((item) => item.id), ids);
  let unavailable = 0;
  for (const item of receipt.cases) {
    if (item.status === 'unavailable') {
      keys(item, ['id', 'status', 'reason', 'setupFailure']);
      assert.ok(nativeNameCases.has(item.id));
      assert.equal(item.reason, 'Filesystem rejects native non-UTF-8 names');
      keys(item.setupFailure, ['stage', 'name', 'errno']);
      assert.equal(item.setupFailure.stage, baselineData.availability.stage);
      assert.equal(item.setupFailure.name, 'OSError');
      assert.equal(item.setupFailure.errno, constants.errno.EILSEQ);
      unavailable += 1;
      continue;
    }
    assert.equal(item.status, 'observed');
    keys(item, ['id', 'status', 'operation', 'input', 'outcome', 'before', 'after', 'unchanged']);
    assert.equal(item.operation, item.id.startsWith('resolve-') ? 'resolve' : 'managed');
    assert.equal(item.input, inputs[ids.indexOf(item.id)]);
    assert.equal(item.unchanged, true);
    assert.deepEqual(item.before, item.after);
    assert.ok(item.before.length >= 5);
    const names = item.before.map((entry) => entry.pathHex);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(names, [...names].sort());
    for (const entry of item.before) {
      keys(entry, ['pathHex', 'kind', 'mode', 'mtimeNs', 'sha256', 'targetHex']);
      assert.match(entry.pathHex, /^(?:[0-9a-f]{2})+$/);
      assert.ok(['file', 'directory', 'symlink'].includes(entry.kind));
      assert.ok(Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o7777);
      assert.match(entry.mtimeNs, /^\d+$/);
      if (entry.kind === 'file') assert.match(entry.sha256, /^[0-9a-f]{64}$/);
      else assert.equal(entry.sha256, null);
      if (entry.kind === 'symlink') assert.match(entry.targetHex, /^(?:[0-9a-f]{2})+$/);
      else assert.equal(entry.targetHex, null);
    }
    const tree = new Map(item.before.map((entry) => [entry.pathHex, entry]));
    for (const directory of ['.', 'managed', 'managed/😀']) {
      assert.equal(tree.get(Buffer.from(directory).toString('hex'))?.kind, 'directory');
    }
    for (const [name, target] of [['managed/byte-target', 'ff'], ['managed/dangling-byte', 'fd']]) {
      assert.equal(tree.get(Buffer.from(name).toString('hex'))?.kind, 'symlink');
      assert.equal(tree.get(Buffer.from(name).toString('hex'))?.targetHex, target);
    }
    if (!receipt.cases.some((record) => record.status === 'unavailable')) {
      const byteDirectory = Buffer.concat([Buffer.from('managed/'), Buffer.from([255])]);
      assert.equal(tree.get(byteDirectory.toString('hex'))?.kind, 'directory');
      assert.equal(tree.get(Buffer.concat([byteDirectory, Buffer.from('/data')]).toString('hex'))?.sha256,
        createHash('sha256').update('synthetic').digest('hex'));
      assert.equal(tree.get(Buffer.concat([Buffer.from('managed/'), Buffer.from([254])]).toString('hex'))?.targetHex, '2e');
    }
    if (Object.hasOwn(paths, item.id)) {
      keys(item.outcome, ['kind', 'path', 'pathHex']);
      const suffix = paths[item.id];
      assert.equal(item.outcome.kind, 'path');
      assert.equal(item.outcome.path, '<root>/managed' + (suffix ? '/' + suffix : ''));
      if (item.id === 'managed-high-surrogate-leaf') assert.equal(item.outcome.pathHex, null);
      else {
        const components = [...item.outcome.path].map((character) => {
          const code = character.codePointAt(0);
          return code >= 0xdc80 && code <= 0xdcff ? Buffer.from([code - 0xdc00]) : Buffer.from(character);
        });
        assert.equal(item.outcome.pathHex, Buffer.concat(components).toString('hex'));
      }
    } else {
      const expected = item.id === 'managed-nul-parent' ? 'ValueError'
        : item.id.startsWith('resolve-') ? 'UnicodeEncodeError' : 'StoreError';
      assert.equal(item.outcome.name, expected);
      keys(item.outcome, expected === 'StoreError' ? ['kind', 'name', 'message'] : ['kind', 'name']);
      assert.equal(item.outcome.kind, 'error');
      if (expected === 'StoreError') assert.equal(item.outcome.message, 'managed resume file identity is invalid');
    }
  }
  t.diagnostic(`${receipt.provenance.python}: ${ids.length - unavailable} observed; ${unavailable} native filename cells unavailable`);

  assert.deepEqual(receipt.cases.filter(item => item.status === 'unavailable').map(item => item.id), baselineData.openNativeCells);
  assert.equal(unavailable, 5);
  assert.equal(process.platform, baselineData.availability.platform);
  if (executable === 'python3') refusals(t, executable, driver, 'posix_bytes_reference_input_rejected');
}

test("S05 reference records managed paths and open native filename cells under default CPython", (t) => {
  assert.equal(process.platform, 'darwin', 'Frozen native reference profile required');
  identifyProfile(t, 'python3');
  observeManaged(t, 'python3');
  observeBytes(t, 'python3');
});

test("S05 reference records managed paths and open native filename cells under CPython 3.12", (t) => {
  assert.equal(process.platform, 'darwin', 'Frozen native reference profile required');
  identifyProfile(t, 'python3.12');
  observeManaged(t, 'python3.12');
  observeBytes(t, 'python3.12');
});

test("S05 reference records managed paths and open native filename cells under CPython 3.13", (t) => {
  assert.equal(process.platform, 'darwin', 'Frozen native reference profile required');
  identifyProfile(t, 'python3.13');
  observeManaged(t, 'python3.13');
  observeBytes(t, 'python3.13');
});

test("S05 reference records managed paths and open native filename cells under CPython 3.14", (t) => {
  assert.equal(process.platform, 'darwin', 'Frozen native reference profile required');
  identifyProfile(t, 'python3.14');
  observeManaged(t, 'python3.14');
  observeBytes(t, 'python3.14');
});
