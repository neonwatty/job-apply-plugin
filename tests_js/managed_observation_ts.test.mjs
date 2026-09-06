import assert from 'node:assert/strict';
import { lstat, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { managedResumeObservation } from '../runtime/store/managed-resume-observation.js';
import { privateFileDigest } from '../runtime/store/private-file-digest.js';
import { statSecondsFromNanoseconds } from '../runtime/contracts/stat-time.js';
import { parseNumericAtom } from '../runtime/contracts/raw-json/numeric-atom.js';
import { setup, snapshot, ids, nowMicroseconds, data } from './managed_observation_ts_support.mjs';

const reference = fileURLToPath(new URL('../tools/contracts/managed-observation/reference.py', import.meta.url));
const primary = process.platform === 'win32' ? 'python' : 'python3';
const identity = (metadata) => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs];
function metadata(info) {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs,
    mtimeSeconds: statSecondsFromNanoseconds(info.mtimeNs, 'fused'), isRegularFile: info.isFile() };
}
const sameIdentity = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);
function cacheView(cache, initial) {
  return cache === null ? null : Object.fromEntries([...cache].map(([key, entry]) => [key, {
    fields: Object.keys(entry).sort(), digest: entry.digest ?? null,
    ageSeconds: Object.hasOwn(entry, 'checkedAt') ? Number(nowMicroseconds - entry.checkedAt) / 1e6 : null,
    identityMatchesInitial: sameIdentity(entry.identity, identity(initial)),
  }]));
}

for (const executable of [primary, 'python3.12', 'python3.13', 'python3.14']) {
  test(`managed observation TS matches actual Python control/cache effects: ${executable}`, async (t) => {
    if (process.platform === 'win32') { t.skip('Native Windows cache/metadata remains unverified'); return; }
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    if (run.error?.code === 'ENOENT' && executable !== primary) { t.skip('Interpreter alias unavailable'); return; }
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    if (executable !== primary) assert.ok(receipt.profile.python.startsWith(executable.replace('python', '') + '.'));
    assert.deepEqual(receipt.cases.map((item) => item.id), ids);
    for (const item of receipt.cases) await t.test(item.id, async () => {
      const fixture = await setup(item.id);
      try {
        const calls = { path: 0, stat: 0, symlink: 0, digest: 0, clock: 0 };
        let initial;
        if (item.id !== 'missing') initial = metadata(await lstat(fixture.path, { bigint: true }));
        let cache = null;
        if (item.id.startsWith('cache-')) {
          cache = new Map();
          if (item.id !== 'cache-empty') {
            const age = { 'cache-zero-age': 0n, 'cache-expired': 30000000n, 'cache-future': -1000000n }[item.id] ?? 1000000n;
            const entry = { identity: identity(initial), digest: 'cached-marker', checkedAt: nowMicroseconds - age };
            if (item.id === 'cache-wrong-identity') entry.identity = ['wrong'];
            if (item.id === 'cache-missing-time') delete entry.checkedAt;
            if (item.id === 'cache-missing-digest') delete entry.digest;
            cache.set('synthetic', entry);
          }
        }
        const io = {
          async managedPath(record) { calls.path += 1; assert.equal(record.get('id'), 'synthetic'); return fixture.path; },
          async lstat(path) {
            calls.stat += 1;
            if ((item.id === 'first-stat-error' && calls.stat === 1) || (item.id === 'second-stat-error' && calls.stat === 2)) {
              throw Object.assign(new Error('synthetic'), { errno: -5, code: 'EIO' });
            }
            return metadata(await lstat(path, { bigint: true }));
          },
          async isSymlink(path) { calls.symlink += 1; return (await lstat(path)).isSymbolicLink(); },
          async privateFileDigest(path) {
            calls.digest += 1;
            if (item.id === 'digest-none') return null;
            const value = await privateFileDigest(path);
            if (item.id === 'after-read-change') await writeFile(path, Buffer.concat([data, Buffer.from(' changed')]));
            return value;
          },
          nowMicroseconds() { calls.clock += 1; return nowMicroseconds; },
          cacheIdentity(value) { return item.id === 'cache-disabled' ? null : identity(value); },
        };
        const before = await snapshot(fixture.root);
        assert.deepEqual(cacheView(cache, initial), item.cacheBefore);
        let outcome;
        try {
          const value = await managedResumeObservation(new Map([['id', 'synthetic']]), io, cache);
          outcome = { kind: 'value', value: { ...value, size: value.size === null ? null : Number(value.size) } };
        } catch (error) { outcome = { kind: 'error', name: error.name }; }
        assert.deepEqual(outcome, item.outcome);
        assert.deepEqual(calls, item.calls);
        assert.deepEqual(cacheView(cache, initial), item.cacheAfter);
        const after = await snapshot(fixture.root);
        if (item.unchanged) assert.deepEqual(after, before);
        else { assert.equal(item.id, 'after-read-change'); assert.notEqual(after[1].sha256, before[1].sha256); }
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    });
  });
}

test('observation cache preserves exact microsecond expiry and every identity component', async () => {
  const initial = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 0n, ctimeNs: 4n, mtimeSeconds: 0, isRegularFile: true };
  for (const age of [-1n, 0n, 29999999n, 30000000n, 30000001n]) {
    let digests = 0;
    const io = { async managedPath() { return 'synthetic'; }, async lstat() { return initial; },
      async isSymlink() { return false; }, async privateFileDigest() { digests += 1; return 'fresh'; },
      nowMicroseconds() { return nowMicroseconds; }, cacheIdentity: identity };
    const cache = new Map([['synthetic', { identity: identity(initial), digest: 'cached', checkedAt: nowMicroseconds - age }]]);
    const result = await managedResumeObservation(new Map([['id', 'synthetic']]), io, cache);
    const hit = age >= 0n && age < 30000000n;
    assert.equal(result.digest, hit ? 'cached' : 'fresh');
    assert.equal(digests, hit ? 0 : 1);
  }
  for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'isRegularFile']) {
    let stats = 0;
    const after = { ...initial, [field]: field === 'isRegularFile' ? false : initial[field] + 1n };
    const io = { async managedPath() { return 'synthetic'; }, async lstat() { return ++stats === 1 ? initial : after; },
      async isSymlink() { return false; }, async privateFileDigest() { return 'fresh'; },
      nowMicroseconds() { return nowMicroseconds; }, cacheIdentity: identity };
    const cache = new Map();
    assert.deepEqual(await managedResumeObservation(new Map([['id', 'synthetic']]), io, cache),
      { exists: false, size: null, modifiedAt: null, digest: null });
    assert.equal(cache.size, 0);
  }
});

test('observation propagates non-OS failures and preserves Python key equality without widening cache writes', async () => {
  const value = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 0n, ctimeNs: 4n, mtimeSeconds: 0, isRegularFile: true };
  const makeIO = () => ({ async managedPath() { return 'synthetic'; }, async lstat() { return value; },
    async isSymlink() { return false; }, async privateFileDigest() { return 'fresh'; },
    nowMicroseconds() { return nowMicroseconds; }, cacheIdentity: identity });
  for (const stage of ['managedPath', 'lstat', 'isSymlink', 'privateFileDigest', 'nowMicroseconds', 'cacheIdentity']) {
    const io = makeIO();
    const failure = new RangeError('synthetic');
    io[stage] = () => { throw failure; };
    await assert.rejects(managedResumeObservation(new Map([['id', 'synthetic']]), io), (error) => error === failure);
  }
  await assert.rejects(managedResumeObservation(new Map(), makeIO()), (error) => error.name === 'KeyError');
  const atom = (token) => parseNumericAtom(token, { intMaxStrDigits: 4300 });
  for (const key of [true, atom('1'), atom('1.0')]) {
    const cache = new Map([[true, { identity: identity(value), checkedAt: nowMicroseconds, digest: 'cached' }]]);
    const result = await managedResumeObservation(new Map([['id', key]]), makeIO(), cache);
    assert.equal(result.digest, 'cached');
    assert.equal(cache.size, 1);
    assert.equal([...cache.keys()][0], true);
  }
  for (const key of [[], new Map()]) {
    await assert.rejects(managedResumeObservation(new Map([['id', key]]), makeIO(), new Map()), TypeError);
    assert.equal((await managedResumeObservation(new Map([['id', key]]), makeIO())).digest, 'fresh');
  }
});

test('cache identity compares Python numeric values and rejects incomplete tuples', async () => {
  const value = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 0n, ctimeNs: 4n, mtimeSeconds: 0, isRegularFile: true };
  const atom = (token) => parseNumericAtom(token, { intMaxStrDigits: 4300 });
  const sparse = identity(value);
  delete sparse[0];
  const cases = [
    { entry: null, hit: false },
    ...[true, 1, atom('1'), atom('1.0')].map((first) => ({
      entry: { identity: [first, 2n, 3n, 0n, 4n], checkedAt: nowMicroseconds, digest: 'cached' }, hit: true,
    })),
    ...[sparse, [], [false, 2n, 3n, 0n, 4n], ['1', 2n, 3n, 0n, 4n]].map((tuple) => ({
      entry: { identity: tuple, checkedAt: nowMicroseconds, digest: 'cached' }, hit: false,
    })),
  ];
  for (const { entry, hit } of cases) {
    let digests = 0;
    const io = { async managedPath() { return 'synthetic'; }, async lstat() { return value; },
      async isSymlink() { return false; }, async privateFileDigest() { digests += 1; return 'fresh'; },
      nowMicroseconds() { return nowMicroseconds; }, cacheIdentity: identity };
    const cache = new Map([['synthetic', entry]]);
    const result = await managedResumeObservation(new Map([['id', 'synthetic']]), io, cache);
    assert.equal(result.digest, hit ? 'cached' : 'fresh');
    assert.equal(digests, hit ? 0 : 1);
    assert.equal(cache.size, 1);
    if (hit) assert.equal(cache.get('synthetic'), entry);
    else assert.deepEqual(cache.get('synthetic'), { identity: identity(value), checkedAt: nowMicroseconds, digest: 'fresh' });
  }
});
