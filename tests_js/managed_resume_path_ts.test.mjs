import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { managedResumePath } from '../runtime/store/managed-resume-path.js';
import { resolvePosixPath, constructPosixPath, posixParent } from '../runtime/contracts/posix-path.js';
import { StoreValidationError } from '../runtime/store/validation.js';
import { setup, snapshot, records, linkCases, faultCases } from './managed_resume_path_ts_support.mjs';

const reference = fileURLToPath(new URL('../tools/contracts/managed-resume-path/reference.py', import.meta.url));
const primary = process.platform === 'win32' ? 'python' : 'python3';

for (const executable of [primary, 'python3.12', 'python3.13', 'python3.14']) {
  test(`managed path TS preserves actual Python lexical and resolution behavior: ${executable}`, async (t) => {
    if (process.platform === 'win32') { t.skip('Native Windows path implementation unverified and unsupported by this inert POSIX leaf'); return; }
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    if (run.error?.code === 'ENOENT' && executable !== primary) { t.skip('Interpreter alias unavailable; no profile acceptance'); return; }
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.provenance.implementation, 'CPython');
    assert.equal(receipt.provenance.sourceSha256, createHash('sha256').update(
      await readFile(new URL('../scripts/job_apply_store/domains/resumes/storage.py', import.meta.url)),
    ).digest('hex'));
    const profile = receipt.provenance.python.split('.').slice(0, 2).join('.');
    assert.ok(['3.12', '3.13', '3.14'].includes(profile));
    if (executable !== primary) assert.equal(profile, executable.replace('python', ''));
    const fixture = await setup();
    try {
      const inputs = records(fixture.root);
      assert.equal(inputs.size, 38);
      assert.deepEqual(receipt.cases.map((item) => item.id), [...inputs.keys()]);
      for (const item of receipt.cases) await t.test(item.id, async (subtest) => {
        if (item.status === 'unavailable' || (linkCases.has(item.id) && !fixture.symlinks)) {
          subtest.skip('Native symlink fixture unavailable; not a passing native cell'); return;
        }
        assert.equal(item.status, 'observed');
        assert.equal(item.native, !Object.hasOwn(faultCases, item.id));
        assert.equal(item.unchanged, true);
        assert.deepEqual(item.after, item.before);
        const before = await snapshot(fixture.root);
        const calls = [];
        const io = Object.hasOwn(faultCases, item.id) ? { async resolve(path, selectedProfile) {
          assert.equal(selectedProfile, profile);
          calls.push({ call: calls.length + 1, strict: false });
          if (calls.length === faultCases[item.id]) throw Object.assign(new Error('synthetic'), { errno: -5, code: 'EIO' });
          return resolvePosixPath(path, selectedProfile);
        } } : undefined;
        const base = item.id.startsWith('root-link') ? join(fixture.root, 'managed-alias') : fixture.managed;
        const record = inputs.get(item.id);
        const recordBefore = [...record];
        let outcome;
        try {
          outcome = { kind: 'path', path: (await managedResumePath(base, record, profile, io)).replace(fixture.root, '<root>') };
        } catch (error) {
          outcome = { kind: 'error', name: error instanceof StoreValidationError ? 'StoreError' : error.name };
          if (outcome.name === 'StoreError') outcome.message = error.message;
        }
        assert.deepEqual(outcome, item.outcome, item.id);
        assert.deepEqual(calls, item.resolveCalls);
        assert.deepEqual([...record], recordBefore);
        assert.deepEqual(await snapshot(fixture.root), before, 'path operation changed bytes/modes/mtimes/link identities');
      });
      await t.test('loop cancellation and relative managed base match actual Python caller', async (subtest) => {
        if (!fixture.symlinks) { subtest.skip('Native links unavailable'); return; }
        // Read-only call against this test-owned tree; import the unchanged mixin.
        const script = [
          'import json,sys', 'from pathlib import Path', 'from types import SimpleNamespace',
          'sys.path.insert(0, "scripts")',
          'from job_apply_store.domains.resumes.storage import ResumeStorageMixin',
          'root=Path(sys.argv[1]); relative=sys.argv[2]',
          'print(json.dumps([str(ResumeStorageMixin._managed_resume_path(SimpleNamespace(resume_files_path=base),',
          ' {"storageKind":"managed","managedFile":name})) for base,name in [(root,"loop/../file.bin"),(Path(relative),"file.bin")]]))',
        ].join('\n');
        const relativeBase = relative(process.cwd(), fixture.managed);
        const native = spawnSync(executable, ['-I', '-c', script, fixture.managed, relativeBase], { encoding: 'utf8', timeout: 5000 });
        assert.equal(native.status, 0, native.stderr);
        const expected = JSON.parse(native.stdout);
        const before = await snapshot(fixture.root);
        assert.equal(await managedResumePath(fixture.managed,
          new Map([['storageKind', 'managed'], ['managedFile', 'loop/../file.bin']]), profile), expected[0]);
        assert.equal(await managedResumePath(relativeBase,
          new Map([['storageKind', 'managed'], ['managedFile', 'file.bin']]), profile), expected[1]);
        assert.deepEqual(await snapshot(fixture.root), before);
      });
      t.diagnostic(`${receipt.provenance.python}: 36 native cases plus 2 injected resolution failures; separate TS tree`);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
}

test('POSIX lexical helpers match actual pathlib joining/parents without resolving dotdot', (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only inert helper'); return; }
  const inputs = [['//base', 'leaf'], ['///base', './leaf'], ['relative/base', '../leaf'],
    ['relative/base', '/absolute/leaf'], ['.', ''], ['', '.'], ['/base', 'nested//../leaf/']];
  const script = 'import json;from pathlib import PurePosixPath; cases=' + JSON.stringify(inputs)
    + ';print(json.dumps([[str(PurePosixPath(a)/b),str((PurePosixPath(a)/b).parent)] for a,b in cases]))';
  const run = spawnSync(primary, ['-I', '-c', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(run.stdout);
  inputs.forEach(([base, child], index) => {
    const joined = constructPosixPath(base, child);
    assert.deepEqual([joined, posixParent(joined)], expected[index]);
  });
});

test('non-strict readlink failures retain Python profile distinction', async (t) => {
  // CPython 3.12 pathlib propagates readlink OSError; 3.13/3.14 non-strict
  // pathlib retains the unresolved component. Verify against each interpreter.
  for (const executable of ['python3.12', 'python3.13', 'python3.14']) await t.test(executable, async (subtest) => {
    const script = [
      'import json,os,stat', 'from pathlib import Path', 'from unittest.mock import patch',
      'from types import SimpleNamespace',
      'try:',
      ' with patch.object(os,"lstat",return_value=SimpleNamespace(st_mode=stat.S_IFLNK)), patch.object(os,"readlink",side_effect=OSError("synthetic")):',
      '  result={"kind":"path","value":str(Path("/synthetic").resolve(strict=False))}',
      'except OSError: result={"kind":"error"}',
      'print(json.dumps(result))',
    ].join('\n');
    const run = spawnSync(executable, ['-I', '-c', script], { encoding: 'utf8', timeout: 5000 });
    if (run.error?.code === 'ENOENT') { subtest.skip('Interpreter alias unavailable; profile not verified'); return; }
    assert.equal(run.status, 0, run.stderr);
    const expected = JSON.parse(run.stdout);
    const failure = Object.assign(new Error('synthetic'), { errno: -5, code: 'EIO' });
    const io = { async lstat() { return { isSymbolicLink: () => true }; },
      async readlink() { throw failure; }, async stat() {}, cwd: () => '/' };
    const profile = executable.replace('python', '');
    if (expected.kind === 'error') await assert.rejects(resolvePosixPath('/synthetic', profile, io), (error) => error === failure);
    else assert.equal(await resolvePosixPath('/synthetic', profile, io), expected.value);
  });
});

test('NUL parent fails as ValueError while unobserved NUL final name stays lexical', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only inert leaf'); return; }
  const fixture = await setup();
  try {
    for (const profile of ['3.12', '3.13', '3.14']) {
      const before = await snapshot(fixture.root);
      await assert.rejects(managedResumePath(fixture.managed,
        new Map([['storageKind', 'managed'], ['managedFile', 'nul\0/leaf']]), profile), (error) => error.name === 'ValueError');
      assert.equal(await managedResumePath(fixture.managed,
        new Map([['storageKind', 'managed'], ['managedFile', 'leaf\0']]), profile), `${fixture.managed}/leaf\0`);
      assert.deepEqual(await snapshot(fixture.root), before);
    }
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
