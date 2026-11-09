import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, lstat, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildNativeTimestamps } from '../tools/build-native-timestamps.mjs';
import { loadPosixTimestampProvider, setTimesNs } from '../runtime/package/posix-timestamps.js';
import { splitNs, timestampFixture } from './posix_timestamps_support.mjs';

const supported = ['darwin', 'linux'].includes(process.platform);
const stamp = 1700000000123456789n;
const access = 1699999990987654321n;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const times = value => [value.atimeNs, value.mtimeNs];

// Inputs and bigint stat assertions are independent of the native implementation.
test('exact POSIX timestamp primitive on owned native files', async (t) => {
  if (!supported) { t.skip('Native POSIX compiler and host required'); return; }
  const fixture = await timestampFixture();
  const { root, receipt } = fixture;
  const provider = loadPosixTimestampProvider(receipt.artifact);
  const native = createRequire(import.meta.url)(receipt.artifact);
  const path = join(root, 'synthetic.bin');
  await writeFile(path, 'synthetic payload');
  try {
    await t.test('explicit builder receipt binds source, headers and emitted binary', async () => {
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.platform, process.platform);
      assert.equal(receipt.arch, process.arch);
      assert.equal(receipt.nodeApiVersion, 8);
      assert.equal(receipt.artifactSha256, hash(await readFile(receipt.artifact)));
      assert.equal(receipt.sourceSha256, hash(await readFile(new URL('../native/posix/timestamps.c', import.meta.url))));
      assert.deepEqual(Object.keys(receipt.headerHashes).sort(),
        ['js_native_api.h', 'js_native_api_types.h', 'node_api.h', 'node_api_types.h']);
      const include = join(dirname(dirname(await realpath(process.execPath))), 'include/node');
      for (const [name, digest] of Object.entries(receipt.headerHashes)) {
        assert.equal(digest, hash(await readFile(join(include, name))));
      }
      await assert.rejects(buildNativeTimestamps({ outputDirectory: join(root, 'addon') }), { code: 'EEXIST' });
      assert.throws(() => loadPosixTimestampProvider('relative.node'), TypeError);
      assert.throws(() => loadPosixTimestampProvider(join(root, 'missing.node')));
    });

    for (const mtime of [stamp, -600n, 1767225600999999500n, 0n, -1000000001n]) {
      await t.test(`preserves independent access time and mtime ${mtime}`, async () => {
        const before = await stat(path, { bigint: true });
        await setTimesNs(provider, path, access, mtime, true);
        const after = await stat(path, { bigint: true });
        assert.deepEqual(times(after), [access, mtime]);
        assert.equal(after.size, before.size);
        assert.equal(after.mode, before.mode);
      });
    }

    await t.test('beyond-2262 timestamp agrees with independent native Python observation', async (subtest) => {
      const future = 10000000000123456789n;
      let nativeError;
      try { await setTimesNs(provider, path, access, future, true); }
      catch (error) { nativeError = error; }
      const nodeObserved = times(await stat(path, { bigint: true })).map(String);
      const script = `import json, os, sys
p, atime, mtime = sys.argv[1:]
def observe():
    s = os.stat(p)
    return [str(s.st_atime_ns), str(s.st_mtime_ns)]
receipt = {'before': observe(), 'python': sys.version, 'requested': [atime, mtime]}
try:
    os.utime(p, ns=(int(atime), int(mtime)))
    receipt['after'] = observe()
except OSError as error:
    receipt['errno'] = error.errno
print(json.dumps(receipt))`;
      const run = spawnSync('python3', ['-B', '-c', script, path, String(access), String(future)], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
      });
      assert.ifError(run.error);
      assert.equal(run.status, 0, run.stderr);
      const observation = JSON.parse(run.stdout);
      assert.deepEqual(observation.requested, [String(access), String(future)]);
      if (Object.hasOwn(observation, 'errno')) {
        assert.ok(nativeError, 'Native operation must fail when baseline syscall fails');
        assert.equal(Math.abs(nativeError.errno), observation.errno);
      } else {
        assert.ifError(nativeError);
        assert.deepEqual(observation.before, observation.after,
          'Native addon and Python must leave identical kernel timestamps');
        assert.deepEqual(nodeObserved, times(await stat(path, { bigint: true })).map(String));
      }
      subtest.diagnostic(JSON.stringify({ requested: observation.requested,
        pythonVersion: observation.python, pythonNative: observation.before,
        pythonBaseline: observation.after, nodeObserved, errno: observation.errno }));
    });

    await t.test('native validation rejects invalid arguments synchronously before effects', async () => {
      await setTimesNs(provider, path, access, stamp, true);
      const valid = [Buffer.from(path), 1700000000n, 123456789, 1700000001n, 987654321, true];
      const invalid = [
        [0, path], [0, new Uint8Array([1])], [0, new DataView(new ArrayBuffer(1))],
        [0, new ArrayBuffer(1)], [0, null], [0, Buffer.from(`${path}\0suffix`)],
        [1, 1700000000], [1, '1'], [1, 1n << 100n], [1, -(1n << 100n)],
        [2, -1], [2, 1000000000], [2, NaN], [2, Infinity], [2, 1.5], [2, 1n],
        [3, 1], [3, 1n << 100n], [4, -1], [4, 1000000000], [5, 1], [5, undefined],
      ];
      for (const [index, value] of invalid) {
        const args = [...valid]; args[index] = value;
        let unexpected;
        try { assert.throws(() => { unexpected = native.setTimes(...args); }, `${index}: ${String(value)}`); }
        finally { if (unexpected instanceof Promise) await unexpected.catch(() => {}); }
      }
      assert.throws(() => native.setTimes());
      assert.throws(() => native.setTimes(...valid, 'extra'));
      assert.deepEqual(times(await stat(path, { bigint: true })), [access, stamp]);
    });

    await t.test('syscall failures reject asynchronously with Python filesystem categories', async () => {
      for (const [target, code, name] of [
        [join(root, 'missing'), 'ENOENT', 'FileNotFoundError'],
        [join(path, 'child'), 'ENOTDIR', 'NotADirectoryError'],
      ]) {
        let operation;
        assert.doesNotThrow(() => { operation = provider.setTimes(Buffer.from(target), 1n, 0, 2n, 0, true); });
        assert.ok(operation instanceof Promise);
        await assert.rejects(operation, error => error.code === code && error.name === name);
      }
    });

    await t.test('follow and no-follow keep symlink and referent timestamp ownership distinct', async () => {
      const link = join(root, 'alias');
      const dangling = join(root, 'dangling');
      await symlink(path, link);
      await symlink(join(root, 'absent-target'), dangling);
      await setTimesNs(provider, path, access, stamp, true);
      await setTimesNs(provider, link, access + 10n, stamp + 20n, false);
      assert.deepEqual(times(await lstat(link, { bigint: true })), [access + 10n, stamp + 20n]);
      assert.deepEqual(times(await stat(path, { bigint: true })), [access, stamp]);
      await setTimesNs(provider, link, access + 30n, stamp + 40n, true);
      assert.deepEqual(times(await stat(path, { bigint: true })), [access + 30n, stamp + 40n]);
      // Following a link can change its access time, but must not rewrite its mtime.
      assert.equal((await lstat(link, { bigint: true })).mtimeNs, stamp + 20n);
      await setTimesNs(provider, dangling, access, stamp, false);
      assert.deepEqual(times(await lstat(dangling, { bigint: true })), [access, stamp]);
      await assert.rejects(setTimesNs(provider, dangling, access, stamp, true), { code: 'ENOENT' });
    });

    await t.test('actual denied directory traversal leaves owned file metadata and bytes intact', async (subtest) => {
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        subtest.skip('Permission denial requires an unprivileged native user'); return;
      }
      const directory = join(root, 'denied');
      const target = join(directory, 'payload');
      await mkdir(directory, { mode: 0o700 });
      await writeFile(target, 'permission fixture');
      await setTimesNs(provider, target, access, stamp, true);
      await chmod(directory, 0);
      try {
        await assert.rejects(setTimesNs(provider, target, 0n, 0n, true),
          error => ['EACCES', 'EPERM'].includes(error.code) && error.name === 'PermissionError');
      } finally { await chmod(directory, 0o700); }
      assert.deepEqual(times(await stat(target, { bigint: true })), [access, stamp]);
      assert.equal(await readFile(target, 'utf8'), 'permission fixture');
    });

    await t.test('valid Unicode filename reaches the intended native file', async () => {
      const target = join(root, 'résumé-漢字-🌍');
      await writeFile(target, 'unicode fixture');
      await setTimesNs(provider, target, access, stamp, true);
      assert.deepEqual(times(await stat(target, { bigint: true })), [access, stamp]);
      assert.equal(await readFile(target, 'utf8'), 'unicode fixture');
    });

    await t.test('queued work owns a path copy before caller mutates its Buffer', async () => {
      const first = join(root, 'buffer-a');
      const second = join(root, 'buffer-b');
      await writeFile(first, 'a'); await writeFile(second, 'b');
      await setTimesNs(provider, first, 0n, 0n, true);
      await setTimesNs(provider, second, 0n, 0n, true);
      const bytes = Buffer.from(first);
      const operation = provider.setTimes(bytes, ...splitNs(access), ...splitNs(stamp), true);
      Buffer.from(second).copy(bytes);
      await operation;
      assert.deepEqual(times(await stat(first, { bigint: true })), [access, stamp]);
      assert.deepEqual(times(await stat(second, { bigint: true })), [0n, 0n]);
    });

    await t.test('preserves raw POSIX filename bytes where filesystem permits them', async (subtest) => {
      const raw = Buffer.concat([Buffer.from(`${root}/raw-`), Buffer.from([0xff])]);
      try { await writeFile(raw, 'raw'); }
      catch (error) {
        if (error.code === 'EILSEQ') { subtest.skip('Native filesystem rejects invalid UTF-8 filename bytes'); return; }
        throw error;
      }
      await provider.setTimes(raw, ...splitNs(access), ...splitNs(stamp), true);
      assert.deepEqual(times(await stat(raw, { bigint: true })), [access, stamp]);
      await setTimesNs(provider, `${root}/raw-\udcff`, access + 1n, stamp + 1n, true);
      assert.deepEqual(times(await stat(raw, { bigint: true })), [access + 1n, stamp + 1n]);
    });

    await t.test('existing emitted runtime and addon operate with empty PATH', async () => {
      const script = `import {loadPosixTimestampProvider,setTimesNs} from ${JSON.stringify(new URL('../runtime/package/posix-timestamps.js', import.meta.url).href)};
        await setTimesNs(loadPosixTimestampProvider(process.argv[1]),process.argv[2],${access}n,${stamp}n,true);`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, receipt.artifact, path], {
        env: { PATH: '' }, encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
      });
      assert.ifError(run.error);
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(times(await stat(path, { bigint: true })), [access, stamp]);
    });
  } finally { await fixture.cleanup(); }
});

test('nanosecond convenience splitter uses floor division for negative fractions', async () => {
  const calls = [];
  const provider = { async setTimes(...args) { calls.push(args); } };
  await setTimesNs(provider, '/synthetic', -600n, 10000000000123456789n, false);
  assert.deepEqual(calls, [[Buffer.from('/synthetic'), -1n, 999999400, 10000000000n, 123456789, false]]);
});

test('convenience validation rejects malformed path or time before invoking provider', async () => {
  let calls = 0;
  const provider = { async setTimes() { calls += 1; } };
  await assert.rejects(setTimesNs(provider, '/synthetic\0suffix', 0n, 0n, true), { name: 'ValueError' });
  await assert.rejects(setTimesNs(provider, '/synthetic', 1, 0n, true), TypeError);
  await assert.rejects(setTimesNs(provider, '/synthetic', 0n, 1, true), TypeError);
  assert.equal(calls, 0);
});
