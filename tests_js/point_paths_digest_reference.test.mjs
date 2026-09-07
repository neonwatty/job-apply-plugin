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

function observeDigest(t, executable) {
  const reference = fileURLToPath(new URL('../tools/contracts/private-file-digest/reference.py', import.meta.url));
  const primary = process.platform === 'win32' ? 'python' : 'python3';
  const chunkSize = baselineData.groups.digest.chunkSize;
  const maximum = baselineData.groups.digest.maximum;
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const ids = baselineData.groups.digest.ids;
  const sizes = baselineData.groups.digest.sizes;
  const standard = Buffer.from(baselineData.groups.digest.standard, 'hex');
  const successIds = new Set(baselineData.groups.digest.successIds);

  function keys(record, names) {
    assert.deepEqual(Object.keys(record).sort(), names.sort());
  }

  function expectedEvents(id, flags, size, osName) {
    if (id === 'symlink' || id === 'broken-link') return [];
    const events = [{ op: 'open', flags }];
    if (['missing', 'missing-parent', 'open-error', 'swap-symlink'].includes(id)) return events;
    // Windows cannot open directories through os.open; native execution must
    // substantiate this platform branch before any Windows acceptance claim.
    if (id === 'directory' && osName === 'nt') return events;
    events.push({ op: 'fstat' });
    if (!['directory', 'max-plus-one', 'fstat-error'].includes(id)) {
      const reads = id === 'read-error' ? 1 : Math.ceil(size / chunkSize) + 1;
      for (let index = 0; index < reads; index += 1) events.push({ op: 'read', requested: chunkSize });
    }
    events.push({ op: 'close' });
    return events;
  }


  const run = spawnSync(executable, ['-I', reference], {
    input: '', encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024,
  });
  record(t, executable, 'digest', run);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const receipt = JSON.parse(run.stdout);
  keys(receipt, ['schemaVersion', 'provenance', 'cases']);
  assert.equal(receipt.schemaVersion, 1);
  const provenance = receipt.provenance;
  keys(provenance, ['implementation', 'python', 'platform', 'osName', 'maximumBytes', 'noFollow', 'readOnly', 'binary', 'sourceSha256']);
  assert.equal(provenance.implementation, 'CPython');
  assert.equal(provenance.python, observedProfiles.get(executable).python);
  assert.match(provenance.python, /^3\.(12|13|14)\.\d+$/);
  assert.equal(provenance.platform, process.platform);
  assert.equal(provenance.osName, 'posix');
  if (executable !== primary) assert.equal(provenance.python.split('.').slice(0, 2).join('.'), executable.slice(6));
  assert.equal(provenance.maximumBytes, maximum);
  assert.equal(provenance.sourceSha256, hash(readFileSync(new URL('../scripts/job_apply_store/domains/resumes/storage.py', import.meta.url))));
  const constants = readFileSync(new URL('../scripts/job_apply_store/constants.py', import.meta.url), 'utf8');
  assert.match(constants, /^RESUME_MAX_BYTES = 10 \* 1024 \* 1024$/m);
  const flags = provenance.readOnly | provenance.binary | (provenance.noFollow ?? 0);
  assert.deepEqual(receipt.cases.map((item) => item.id), ids);
  let unavailable = 0;
  for (const item of receipt.cases) {
    const native = ['symlink', 'broken-link', 'swap-symlink'].includes(item.id);
    assert.equal(item.native, native);
    if (item.status === 'unavailable') {
      keys(item, ['id', 'status', 'native', 'reason']);
      assert.equal(native, true);
      assert.match(item.reason, /^(O_NOFOLLOW unavailable|OSError|PermissionError|NotImplementedError)$/);
      unavailable += 1;
      t.diagnostic(`${item.id}: ${item.reason}; native cell unavailable, not passed`);
      continue;
    }
    keys(item, ['id', 'status', 'native', 'inputSize', 'inputSha256', 'outcome', 'events',
      'readBytes', 'openedCount', 'closedCount', 'leakedCount', 'racePerformed', 'openErrno', 'before', 'after', 'unchanged']);
    assert.equal(item.status, 'observed');
    const data = Object.hasOwn(sizes, item.id) ? Buffer.alloc(sizes[item.id], 'x') : standard;
    const readData = item.id === 'grow-after-stat'
      ? Buffer.concat([data, Buffer.alloc(maximum + 1, 'x')]) : data;
    const absent = ['missing', 'missing-parent', 'directory', 'broken-link'].includes(item.id);
    assert.equal(item.inputSize, absent ? null : data.length);
    assert.equal(item.inputSha256, absent ? null : hash(data));
    const expected = item.id === 'close-error'
      ? { kind: 'error', name: 'OSError', message: 'synthetic close failure' }
      : { kind: 'return', digest: successIds.has(item.id) ? hash(readData) : null };
    assert.deepEqual(item.outcome, expected, item.id);
    assert.deepEqual(item.events, expectedEvents(item.id, flags, readData.length, provenance.osName), item.id);
    const closes = item.events.filter((event) => event.op === 'close').length;
    assert.equal(item.openedCount, closes);
    assert.equal(item.closedCount, closes);
    assert.equal(item.leakedCount, 0);
    assert.equal(item.readBytes, successIds.has(item.id) || item.id === 'close-error' ? readData.length : 0);
    if (item.id === 'grow-after-stat') {
      assert.equal(item.racePerformed, true);
      assert.equal(item.unchanged, false);
      assert.ok(item.readBytes > maximum);
      const original = item.before.find((entry) => entry.path === 'input.bin');
      const grown = item.after.find((entry) => entry.path === 'input.bin');
      assert.equal(original.sha256, hash(data));
      assert.equal(grown.sha256, hash(readData));
      assert.equal(grown.mode, original.mode);
      assert.equal(grown.kind, 'file');
      assert.deepEqual(item.after.map((entry) => entry.path), item.before.map((entry) => entry.path));
    } else if (item.id === 'swap-symlink') {
      assert.notEqual(provenance.noFollow, null);
      assert.equal(item.racePerformed, true);
      assert.equal(item.unchanged, false);
      assert.ok(Number.isInteger(item.openErrno));
      const beforeForeign = item.before.find((entry) => entry.path === 'foreign.bin');
      assert.equal(beforeForeign.sha256, hash(Buffer.from('synthetic foreign bytes')));
      assert.deepEqual(item.after.find((entry) => entry.path === 'foreign.bin'), beforeForeign);
      const replaced = item.after.find((entry) => entry.path === 'input.bin');
      assert.equal(replaced.kind, 'symlink');
      assert.equal(replaced.target, 'foreign.bin');
    } else {
      assert.equal(item.racePerformed, false);
      assert.equal(item.unchanged, true);
      assert.deepEqual(item.after, item.before, item.id);
    }
    for (const entry of [...item.before, ...item.after]) {
      keys(entry, ['path', 'kind', 'mode', 'mtimeNs', 'sha256', 'target']);
      assert.ok(!entry.path.startsWith('/') && !entry.path.includes('..'));
      assert.match(entry.mtimeNs, /^\d+$/);
      assert.ok(Number.isSafeInteger(entry.mode));
      if (entry.kind === 'file') assert.match(entry.sha256, /^[0-9a-f]{64}$/);
      else assert.equal(entry.sha256, null);
    }
    if (item.id === 'missing-parent' || item.id === 'missing') assert.deepEqual(item.after.map((entry) => entry.path), ['.']);
  }
  t.diagnostic(`${provenance.python}: ${ids.length - unavailable} observed, ${unavailable} native unavailable; 10MiB initial limit/1MiB chunks`);
  assert.equal(unavailable, 0, 'All supported native baseline cells must be observed');
  if (executable === 'python3') refusals(t, executable, reference, 'digest_reference_input_rejected');
}

function observeCache(t, executable) {
  const root = new URL('../', import.meta.url);
  const reference = fileURLToPath(new URL('tools/contracts/managed-observation/reference.py', root));
  const ids = baselineData.groups.observation.ids;
  const digest = baselineData.groups.observation.digest;
  const missing = baselineData.groups.observation.missing;
  const hitIds = baselineData.groups.observation.hitIds;
  const errorIds = baselineData.groups.observation.errorIds;
  const rejected = baselineData.groups.observation.rejected;
  const closed = (value, keys) => assert.deepEqual(Object.keys(value).sort(), keys.sort());


  const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  record(t, executable, 'observation', run);
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const receipt = JSON.parse(run.stdout);
  closed(receipt, ['schemaVersion', 'profile', 'sources', 'cacheSeconds', 'cases']);
  assert.equal(receipt.schemaVersion, 1);
  closed(receipt.profile, ['implementation', 'python', 'platform']);
  assert.equal(receipt.profile.implementation, 'CPython');
  assert.equal(receipt.profile.python, observedProfiles.get(executable).python);
  assert.equal(receipt.profile.platform, process.platform);
  assert.match(receipt.profile.python, /^3\.(12|13|14)\.\d+$/);
  if (executable !== 'python3') assert.ok(receipt.profile.python.startsWith(executable.slice(6) + '.'));
  assert.equal(receipt.cacheSeconds, 30);
  closed(receipt.sources, ['scripts/job_apply_store/domains/resumes/storage.py',
    'scripts/job_apply_store/normalization.py', 'scripts/job_apply_store/constants.py']);
  for (const [path, hash] of Object.entries(receipt.sources)) {
    assert.equal(hash, createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex'));
  }
  assert.deepEqual(receipt.cases.map(item => item.id), ids);
  for (const item of receipt.cases) {
    closed(item, ['id', 'outcome', 'calls', 'before', 'after', 'unchanged', 'cacheBefore', 'cacheAfter']);
    const earlyStat = ['missing', 'first-stat-error'].includes(item.id);
    const earlyKind = ['directory', 'symlink', 'oversized'].includes(item.id);
    const cached = hitIds.includes(item.id);
    const error = errorIds.includes(item.id);
    const readsDigest = !earlyStat && !earlyKind && !cached && !error;
    assert.deepEqual(item.calls, { path: 1, stat: readsDigest && item.id !== 'digest-none' ? 2 : 1,
      symlink: earlyStat ? 0 : 1, digest: Number(readsDigest), clock: Number(!earlyStat && !earlyKind) }, item.id);
    assert.deepEqual(item.outcome, error ? { kind: 'error', name: 'KeyError' } : {
      kind: 'value', value: rejected.includes(item.id) ? missing : {
        exists: true, size: 27, modifiedAt: '2026-01-01T00:00:00Z', digest: cached ? 'cached-marker' : digest,
      },
    }, item.id);
    assert.equal(item.unchanged, item.id !== 'after-read-change', item.id);
    if (item.unchanged) assert.deepEqual(item.after, item.before);
    else assert.notEqual(item.after[1].sha256, item.before[1].sha256);
    for (const rows of [item.before, item.after]) for (const row of rows) {
      closed(row, ['path', 'kind', 'target', 'mode', 'mtimeNs', 'sha256']);
      assert.ok(row.path === '.' || row.path === 'synthetic.bin' || row.path === 'target.bin');
      assert.ok(Number.isSafeInteger(row.mode));
      assert.match(row.mtimeNs, /^\d+$/);
      if (row.kind === 'file') assert.match(row.sha256, /^[a-f0-9]{64}$/);
      else { assert.ok(['directory', 'symlink'].includes(row.kind)); assert.equal(row.sha256, null); }
      assert.equal(row.target, row.kind === 'symlink' ? 'target.bin' : null);
    }
    let expectedBefore = null;
    if (item.id === 'cache-empty') expectedBefore = {};
    else if (item.id.startsWith('cache-')) {
      const fields = ['checkedAt', 'digest', 'identity'].filter(field =>
        !(item.id === 'cache-missing-time' && field === 'checkedAt') &&
        !(item.id === 'cache-missing-digest' && field === 'digest'));
      const ages = { 'cache-zero-age': 0, 'cache-expired': 30, 'cache-future': -1, 'cache-missing-time': null };
      expectedBefore = { synthetic: { fields,
        digest: item.id === 'cache-missing-digest' ? null : 'cached-marker',
        ageSeconds: Object.hasOwn(ages, item.id) ? ages[item.id] : 1,
        identityMatchesInitial: item.id !== 'cache-wrong-identity' } };
    }
    assert.deepEqual(item.cacheBefore, expectedBefore, item.id);
    if (['cache-empty', 'cache-expired', 'cache-future', 'cache-wrong-identity'].includes(item.id)) {
      assert.deepEqual(item.cacheAfter, { synthetic: { fields: ['checkedAt', 'digest', 'identity'],
        digest, ageSeconds: 0, identityMatchesInitial: true } });
    } else assert.deepEqual(item.cacheAfter, item.cacheBefore, item.id);
  }
  t.diagnostic(`${receipt.profile.python}: 18 observation/cache cases; disabled cache is injected policy, not native Windows`);
  if (executable === 'python3') refusals(t, executable, reference, 'managed_observation_reference_input_rejected');
}

test("S05 reference preserves descriptor and observation baselines under default CPython", (t) => {
  assert.equal(process.platform, 'darwin', 'Frozen native reference profile required');
  identifyProfile(t, 'python3');
  observeDigest(t, 'python3');
  observeCache(t, 'python3');
});

test("S05 reference preserves descriptor and observation baselines under CPython 3.12", (t) => {
  assert.equal(process.platform, 'darwin', 'Frozen native reference profile required');
  identifyProfile(t, 'python3.12');
  observeDigest(t, 'python3.12');
  observeCache(t, 'python3.12');
});

test("S05 reference preserves descriptor and observation baselines under CPython 3.13", (t) => {
  assert.equal(process.platform, 'darwin', 'Frozen native reference profile required');
  identifyProfile(t, 'python3.13');
  observeDigest(t, 'python3.13');
  observeCache(t, 'python3.13');
});

test("S05 reference preserves descriptor and observation baselines under CPython 3.14", (t) => {
  assert.equal(process.platform, 'darwin', 'Frozen native reference profile required');
  identifyProfile(t, 'python3.14');
  observeDigest(t, 'python3.14');
  observeCache(t, 'python3.14');
});
