import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { atomicWriteJson } from '../runtime/store/atomic-write-json.js';
import { createNativeAtomicWriteIO } from '../runtime/store/private-filesystem.js';
import { ids, payload, setup, snapshot, observedIO } from './atomic_write_json_ts_support.mjs';

const reference = fileURLToPath(new URL('../tools/contracts/atomic-write-json/reference.py', import.meta.url));
const fixedTime = '1600000000000000000';
function filesystemEffects(rows) {
  // Separate trees have different creation times. Preserve whether each exact
  // fixture mtime changed, alongside every byte, permission and path witness.
  return rows.map(row => ({ ...row, mtimeNs: row.mtimeNs === fixedTime ? fixedTime : 'changed' }));
}
function outcome(error) {
  if (error === undefined) return { kind: 'value' };
  const context = error.cause;
  return { kind: 'error', name: error.name, errno: typeof error.errno === 'number' ? Math.abs(error.errno) : null,
    stage: error.stage ?? null,
    context: context === undefined ? null : { name: context.name, stage: context.stage ?? null } };
}

for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`atomic TS preserves actual Python persisted bytes and failure effects: ${executable}`, async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX native adapter; Windows remains unverified');
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 15000, maxBuffer: 2 ** 20 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter alias unavailable');
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    const profile = receipt.profile.python.split('.').slice(0, 2).join('.');
    if (executable !== 'python3') assert.equal(profile, executable.slice(6));
    assert.deepEqual(receipt.cases.map(row => row.id), ids);
    await t.test('native temporary text buffering matches observable Python write boundaries', async () => {
      const sequences = [[8191], [8192], [8193], [20000], [100, 8192], [8191, 1],
        [4096, 4096], [4096, 20000], [131072], [131071, 1]].map(sizes => sizes.map((size, index) => (index ? 'b' : 'a').repeat(size)));
      sequences.push(['λ'.repeat(4096)], ['😀'.repeat(2048)], ['a'.repeat(8191), 'λ']);
      const script = [
        'import sys,tempfile,json,hashlib', 'from pathlib import Path', 'rows=[]',
        'with tempfile.TemporaryDirectory(prefix="atomic-buffer-oracle-") as directory:',
        ' for sequence in json.load(sys.stdin):',
        '  handle=tempfile.NamedTemporaryFile(mode="w",encoding="utf-8",dir=directory,delete=False)',
        '  path=Path(handle.name);steps=[]',
        '  def observe():',
        '   data=path.read_bytes();return {"size":len(data),"sha256":hashlib.sha256(data).hexdigest()}',
        '  try:',
        '   for text in sequence:handle.write(text);steps.append(observe())',
        '   handle.flush();steps.append(observe())',
        '  finally:handle.close()',
        '  steps.append(observe());path.unlink();rows.append(steps)',
        'print(json.dumps(rows))',
      ].join('\n');
      const run = spawnSync(executable, ['-I', '-c', script], { input: JSON.stringify(sequences), encoding: 'utf8', timeout: 5000 });
      assert.equal(run.status, 0, run.stderr);
      const expected = JSON.parse(run.stdout);
      assert.equal(expected.length, sequences.length);
      for (let index = 0; index < sequences.length; index += 1) {
        const fixture = await setup('basic');
        let temporary;
        let closed = false;
        try {
          temporary = await createNativeAtomicWriteIO(profile).createTemporary({ directory: fixture.parent, prefix: '.visibility.', suffix: '.tmp' });
          const observe = async () => {
            const bytes = await readFile(temporary.path);
            return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
          };
          const steps = [];
          for (const text of sequences[index]) { await temporary.write(text); steps.push(await observe()); }
          await temporary.flush(); steps.push(await observe());
          await temporary.close(); closed = true; steps.push(await observe());
          assert.deepEqual(steps, expected[index], `buffer sequence ${index}`);
        } finally {
          if (temporary && !closed) await temporary.close();
          await rm(fixture.root, { recursive: true, force: true });
        }
      }
    });
    await t.test('directory sync and close preserve Python exception context', async () => {
      const script = [
        'import sys,tempfile', 'from pathlib import Path', 'from unittest.mock import patch',
        `sys.path.insert(0,${JSON.stringify(fileURLToPath(new URL('../tools/contracts/atomic-write-json/', import.meta.url)))})`,
        'import reference', 'from support import Operations,outcome',
        'with tempfile.TemporaryDirectory(prefix="atomic-context-oracle-") as directory:',
        ' root=Path(directory);target=root/"document.json";operations=Operations(root,target,["directory-fsync-value","directory-close"])',
        ' error=None',
        ' try:',
        '  with patch.object(reference.io.tempfile,"NamedTemporaryFile",operations.temporary):',
        '   reference.io.atomic_write_json(operations.Path(target),{"a":1},_runtime={"os":operations,"Path":operations.Path})',
        ' except Exception as caught:error=caught',
        ' print(reference.json.dumps(outcome(error)))',
      ].join('\n');
      const run = spawnSync(executable, ['-I', '-c', script], { input: '', encoding: 'utf8', timeout: 5000 });
      assert.equal(run.status, 0, run.stderr);
      const expected = JSON.parse(run.stdout);
      assert.deepEqual(expected.context, { name: 'ValueError', stage: null });
      const fixture = await setup('basic');
      try {
        const { io } = observedIO(fixture, profile, ['directory-fsync-value', 'directory-close']);
        let error;
        try { await atomicWriteJson(fixture.target, payload('basic'), { pathProfile: profile, intMaxStrDigits: 4300 }, io); }
        catch (caught) { error = caught; }
        assert.deepEqual(outcome(error), expected);
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    });
    await t.test('native temporary name fits Python filename boundary', async () => {
      const script = [
        'import sys,tempfile,json', 'from pathlib import Path',
        `sys.path.insert(0,${JSON.stringify(fileURLToPath(new URL('../scripts/', import.meta.url)))})`,
        'from job_apply_store.io import atomic_write_json',
        'with tempfile.TemporaryDirectory(prefix="atomic-name-oracle-") as directory:',
        ' target=Path(directory)/("a"*236)',
        ' atomic_write_json(target,{"z":1,"emoji":"λ"})',
        ' print(json.dumps({"hex":target.read_bytes().hex(),"paths":sorted(path.name for path in Path(directory).iterdir())}))',
      ].join('\n');
      const run = spawnSync(executable, ['-I', '-c', script], { input: '', encoding: 'utf8', timeout: 5000 });
      assert.equal(run.status, 0, run.stderr);
      const expected = JSON.parse(run.stdout);
      assert.deepEqual(expected.paths, ['a'.repeat(236)]);
      const fixture = await setup('basic');
      try {
        const target = join(fixture.parent, 'a'.repeat(236));
        await atomicWriteJson(target, payload('basic'), { pathProfile: profile, intMaxStrDigits: 4300 });
        assert.equal((await readFile(target)).toString('hex'), expected.hex);
        assert.deepEqual((await snapshot(fixture.root)).map(row => row.path), ['.', 'private', `private/${'a'.repeat(236)}`, 'private/document.json']);
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    });
    for (const expected of receipt.cases) await t.test(expected.id, async () => {
      const fixture = await setup(expected.id);
      try {
        assert.deepEqual(await snapshot(fixture.root), expected.before);
        const { io, state } = observedIO(fixture, profile, expected.faults);
        let error;
        try { await atomicWriteJson(fixture.target, payload(expected.id), { pathProfile: profile, intMaxStrDigits: 4300 }, io); }
        catch (caught) { error = caught; }
        assert.deepEqual(outcome(error), expected.outcome);
        // IO exposes one mkdir request; native recursive retries remain below it.
        const trace = expected.id === 'missing-parent' ? expected.events.slice(2) : expected.events;
        assert.deepEqual(state.events, trace);
        assert.equal(state.writeCalls, expected.writeCalls);
        assert.equal(state.tempClosed, expected.tempClosed);
        assert.equal(state.directoryClosed, expected.directoryClosed);
        assert.deepEqual(filesystemEffects(await snapshot(fixture.root, state.temporaryPath)), filesystemEffects(expected.after));
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    });
    // Separate unwrapped native calls establish successful adapter composition;
    // synthetic boundary failures above do not assert native hardware failures.
    for (const id of ['basic', 'missing-parent', 'numbers', 'unicode', 'symlink', 'broken-symlink', 'parent-symlink']) {
      await t.test(`unwrapped native ${id}`, async () => {
        const fixture = await setup(id);
        try {
          await atomicWriteJson(fixture.target, payload(id), { pathProfile: profile, intMaxStrDigits: 4300 });
          const expected = receipt.cases.find(row => row.id === id);
          assert.deepEqual(filesystemEffects(await snapshot(fixture.root)), filesystemEffects(expected.after));
        } finally { await rm(fixture.root, { recursive: true, force: true }); }
      });
    }
  });
}
