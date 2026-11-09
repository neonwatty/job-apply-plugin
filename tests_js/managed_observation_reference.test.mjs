import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const reference = fileURLToPath(new URL('tools/contracts/managed-observation/reference.py', root));
const ids = ['normal', 'cache-empty', 'cache-fresh', 'cache-zero-age', 'cache-expired',
  'cache-future', 'cache-wrong-identity', 'cache-disabled', 'missing', 'directory', 'symlink',
  'oversized', 'digest-none', 'after-read-change', 'first-stat-error', 'second-stat-error',
  'cache-missing-time', 'cache-missing-digest'];
const digest = '04d34371fbc3fd0896e3db34a071b92f232b1f49703c86719587bbcd95a266e4';
const missing = { exists: false, size: null, modifiedAt: null, digest: null };
const hitIds = ['cache-fresh', 'cache-zero-age'];
const errorIds = ['cache-missing-time', 'cache-missing-digest'];
const rejected = ['missing', 'directory', 'symlink', 'oversized', 'digest-none', 'after-read-change',
  'first-stat-error', 'second-stat-error'];
const closed = (value, keys) => assert.deepEqual(Object.keys(value).sort(), keys.sort());

for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`managed observation reference: ${executable}`, (t) => {
    if (process.platform === 'win32') return t.skip('POSIX cache reference; native Windows remains unverified');
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter profile unavailable');
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    closed(receipt, ['schemaVersion', 'profile', 'sources', 'cacheSeconds', 'cases']);
    assert.equal(receipt.schemaVersion, 1);
    closed(receipt.profile, ['implementation', 'python', 'platform']);
    assert.equal(receipt.profile.implementation, 'CPython');
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
  });
}

test('managed observation reference rejects caller arguments and input', () => {
  const executable = process.platform === 'win32' ? 'python' : 'python3';
  for (const [args, input] of [[['synthetic'], ''], [[], 'synthetic']]) {
    const run = spawnSync(executable, ['-I', reference, ...args], { input, encoding: 'utf8', timeout: 3000 });
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'managed_observation_reference_input_rejected\n');
  }
});
