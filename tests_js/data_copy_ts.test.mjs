import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { copyFileData, copyFileObjects } from '../runtime/package/data-copy.js';
import { model, errorReceipt, failure, branchProbe, sourceData } from './data_copy_support.mjs';

const reference = fileURLToPath(new URL('../tools/contracts/artifact-data-copy/reference.py', import.meta.url));
const effect = rows => rows.map(({ path, kind, mode, content, target }) => ({ path, kind, mode, content, target }))
  .sort((a, b) => a.path.localeCompare(b.path));
for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`explicit-IO data-copy matches frozen direct-copy cases: ${executable}`, async t => {
    if (process.platform !== 'darwin') return t.skip('This package observes the macOS single-accelerator protocol only');
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter alias unavailable');
    assert.ifError(run.error); assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.profile.platform, 'darwin'); assert.equal(receipt.profile.accelerator, '_fastcopy_fcopyfile');
    const profile = receipt.profile.python.split('.').slice(0, 2).join('.');
    if (executable !== 'python3') assert.equal(profile, executable.slice(6));
    const rows = receipt.cases.filter(row => !row.id.startsWith('preflight:'));
    assert.equal(rows.length, 30);
    for (const row of rows) await t.test(row.id, async () => {
      assert.equal(row.status, 'observed');
      const [lane, id] = row.id.split(':');
      const fixture = model(lane, id, profile);
      assert.deepEqual(fixture.snapshot(), effect(row.before));
      let value, error;
      try { value = await copyFileData(fixture.source, fixture.target, {
        profile, platform: 'darwin', followSymlinks: false, io: fixture.io,
      }); } catch (caught) { error = caught; }
      assert.equal(value ?? null, row.value === null ? null : '<ROOT>/' + row.value);
      assert.deepEqual(errorReceipt(error), row.error);
      assert.deepEqual(fixture.calls, row.calls);
      assert.deepEqual(fixture.snapshot(), effect(row.after));
      assert.deepEqual(fixture.descriptors(), row.descriptors);
      const preflight = id === 'same-path' || id === 'hardlink' ? ['same-file']
        : id === 'source-fifo' ? ['same-file', 'stat:source']
          : id === 'target-fifo' ? ['same-file', 'stat:source', 'stat:target']
            : ['same-file', 'stat:source', 'stat:target', 'is-link:source',
              ...(id === 'source-link' ? ['read-link:source', 'symlink:target'] : []),
              ...(id === 'target-directory' ? ['exists:target'] : [])];
      assert.deepEqual(fixture.protocol, preflight);
    });
  });
}

test('unsupported profiles and platforms reject before IO', async () => {
  let calls = 0;
  const io = new Proxy({}, { get() { calls += 1; throw new Error('unexpected IO'); } });
  await assert.rejects(copyFileData('a', 'b', { profile: '3.11', platform: 'darwin', io }), RangeError);
  await assert.rejects(copyFileData('a', 'b', { profile: '3.14', platform: 'linux', io }), RangeError);
  assert.equal(calls, 0);
});

test('copyfileobj rejects invalid explicit buffer lengths before IO', async () => {
  for (const length of [0, -1, NaN, Infinity, 0.5]) await assert.rejects(copyFileObjects({}, {}, length), RangeError);
});

test('samefile and per-path stat swallow only OS failures', async () => {
  for (const stage of ['sameFile', 'stat']) {
    const f = model('buffered', 'existing', '3.14');
    f.io[stage] = async () => { throw failure('PermissionError', 'controlled OS error', 13); };
    await copyFileData(f.source, f.target, { profile: '3.14', platform: 'darwin', followSymlinks: false, io: f.io });
    const bad = model('buffered', 'existing', '3.14');
    const error = new TypeError('non-OS failure');
    bad.io[stage] = async () => { throw error; };
    await assert.rejects(copyFileData(bad.source, bad.target, { profile: '3.14', platform: 'darwin', followSymlinks: false, io: bad.io }), caught => caught === error);
    assert.deepEqual(bad.calls, []);
  }
});

function contextReceipt(error) {
  if (!error) return null;
  return { name: error.name, message: error.message, errno: error.errno ?? null,
    context: contextReceipt(error.pythonContext), cause: contextReceipt(error.cause),
    suppressContext: error.pythonSuppressContext ?? false };
}
for (const executable of ['python3.12', 'python3.13', 'python3.14']) {
  test(`directory translation and no-errno OS classification use actual shutil: ${executable}`, async t => {
    if (process.platform !== 'darwin') return t.skip('Native macOS branch witness required');
    const run = spawnSync(executable, ['-I', '-c', branchProbe], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    if (run.error?.code === 'ENOENT') return t.skip('Interpreter alias unavailable');
    assert.ifError(run.error); assert.equal(run.status, 0, run.stderr);
    const observed = JSON.parse(run.stdout);
    assert.equal(observed.profile.python.split('.').slice(0, 2).join('.'), executable.slice(6));
    assert.equal(observed.profile.platform, 'darwin'); assert.equal(observed.profile.implementation, 'CPython');
    assert.equal(observed.profile.executableSha256, createHash('sha256').update(readFileSync(observed.profile.executable)).digest('hex'));
    assert.equal(observed.stdlib.sha256, createHash('sha256').update(readFileSync(observed.stdlib.path)).digest('hex'));
    const ids = ['source-open', 'target-open', 'read', 'target-close-missing', 'target-close-existing', 'source-close', 'target-open-source-close', 'exists-error', 'reused-error-context', 'target-open-child', 'target-open-other21'];
    assert.deepEqual(observed.rows.map(row => row.id), ids);
    for (const expected of observed.rows) {
      const fixture = model('buffered', 'existing', executable.slice(6));
      fixture.removeTarget();
      const calls = [], handles = [];
      const reusedA = failure('RuntimeError', 'synthetic reused A');
      const reusedB = failure('RuntimeError', 'synthetic reused B');
      const directoryError = stage => failure(expected.id === 'target-open-child' ? 'DirectoryChild'
        : expected.id === 'target-open-other21' ? 'OtherOSError' : 'IsADirectoryError', '[Errno 21] synthetic ' + stage, 21);
      fixture.io.isDirectoryError = error => ['IsADirectoryError', 'DirectoryChild'].includes(error?.name);
      for (const [method, owner] of [['openSource', 'source'], ['openTarget', 'target']]) {
        const open = fixture.io[method];
        fixture.io[method] = async path => {
          calls.push(owner + '-open');
          if (owner === 'source' && expected.id === 'source-open') throw directoryError('source-open');
          if (owner === 'target' && ['target-open', 'target-open-source-close', 'exists-error', 'target-open-child', 'target-open-other21'].includes(expected.id)) throw directoryError('target-open');
          const handle = await open(path); handles.push(handle);
          return {
            async read(length) {
              calls.push('read');
              if (expected.id === 'reused-error-context') throw reusedA;
              if (expected.id === 'read') { fixture.removeTarget(); calls.push('remove-target'); throw directoryError('read'); }
              return handle.read(length);
            },
            async write(bytes) { calls.push('write'); return handle.write(bytes); },
            async close() {
              calls.push(owner + '-close'); await handle.close();
              if (expected.id === 'reused-error-context') throw owner === 'target' ? reusedB : reusedA;
              if (owner === 'target' && expected.id.startsWith('target-close')) {
                if (expected.id === 'target-close-missing') { fixture.removeTarget(); calls.push('remove-target'); }
                throw directoryError('target-close');
              }
              if (owner === 'source' && expected.id === 'source-close') throw directoryError('source-close');
              if (owner === 'source' && expected.id === 'target-open-source-close') throw failure('OSError', '[Errno 5] synthetic source-close', 5);
            },
          };
        };
      }
      fixture.io.exists = async () => {
        calls.push('exists-target');
        if (expected.id === 'exists-error') throw failure('RuntimeError', 'synthetic exists');
        return fixture.snapshot().some(row => row.path === 'target');
      };
      let error;
      try { await copyFileData(fixture.source, fixture.target, { profile: executable.slice(6), platform: 'darwin', followSymlinks: false, io: fixture.io }); }
      catch (caught) { error = caught; }
      if (expected.id === 'reused-error-context') {
        assert.equal(error, reusedA); assert.equal(reusedA.pythonContext, reusedB);
        assert.equal(reusedB.pythonContext, undefined); assert.equal(reusedA.cause, undefined);
      }
      assert.deepEqual(contextReceipt(error), expected.error, expected.id);
      assert.deepEqual(calls, expected.calls, expected.id);
      assert.deepEqual(handles.map(handle => !handle.open), expected.closed);
      assert.equal(fixture.snapshot().find(row => row.path === 'target')?.content.hex ?? null, expected.target);
      assert.equal(expected.source, sourceData.toString('hex'));
    }
    assert.deepEqual(observed.classification, [
      { stage: 'samefile', error: 'OSError', outcome: null, target: '78' },
      { stage: 'samefile', error: 'ValueError', outcome: 'ValueError', target: null },
      { stage: 'stat', error: 'OSError', outcome: null, target: '78' },
      { stage: 'stat', error: 'ValueError', outcome: 'ValueError', target: null },
    ]);
    for (const entry of observed.classification) {
      const fixture = model('buffered', 'existing', executable.slice(6), Buffer.from('x'));
      fixture.removeTarget();
      const injected = failure(entry.error, entry.error === 'OSError' ? 'no errno' : 'non OS');
      fixture.io[entry.stage === 'samefile' ? 'sameFile' : 'stat'] = async () => { throw injected; };
      let actual;
      try { await copyFileData(fixture.source, fixture.target, { profile: executable.slice(6), platform: 'darwin', followSymlinks: false, io: fixture.io }); }
      catch (error) { actual = error; }
      assert.equal(actual?.name ?? null, entry.outcome);
      if (actual) assert.equal(actual, injected);
      assert.equal(fixture.snapshot().find(row => row.path === 'source').content.hex, '78');
      assert.equal(fixture.snapshot().find(row => row.path === 'target')?.content.hex ?? null, entry.target);
      assert.ok(fixture.descriptors().every(handle => !handle.open));
    }
  });
}
