import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { criticalPaths, assertCriticalBytes } from '../runtime/package/installed-artifacts.js';
import { fixture, alter, snapshot } from './installed_artifacts_ts_support.mjs';

const reference = fileURLToPath(new URL('../tools/contracts/installed-artifacts/reference.py', import.meta.url));
const repository = fileURLToPath(new URL('../', import.meta.url));

for (const profile of ['3.12', '3.13', '3.14']) {
  test(`installed artifact TS inventory and bytes match native Python ${profile}`, async (t) => {
    if (process.platform === 'win32') { t.skip('POSIX adapter; native Windows remains required'); return; }
    const run = spawnSync(`python${profile}`, ['-I', reference], {
      input: '', encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    });
    if (run.error?.code === 'ENOENT') { t.skip('Required interpreter unavailable'); return; }
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.ok(receipt.profile.python.startsWith(profile + '.'));
    const cases = receipt.cases.filter(row => row.operation !== 'copy');
    assert.equal(cases.length, 24);
    for (const item of cases) await t.test(item.id, async () => {
      const root = await mkdtemp(join(tmpdir(), 'ts-artifact-reference-'));
      try {
        const source = await fixture(join(root, 'source'));
        const target = await fixture(join(root, 'target'));
        await alter(target, item.change);
        let selected = target;
        if (item.id === 'inventory-root-link') {
          selected = join(root, 'alias'); await symlink('target', selected);
        }
        const before = await snapshot(root);
        let outcome;
        try {
          const result = item.operation === 'inventory' ? await criticalPaths(selected, profile)
            : await assertCriticalBytes(target, source, { label: 'synthetic', profile });
          outcome = { kind: 'value', value: result ?? null };
        } catch (error) { outcome = { kind: 'error', name: error.name, message: error.message }; }
        assert.deepEqual(outcome, item.outcome);
        assert.deepEqual(await snapshot(root), before);
        // Compare fixture shape, modes, contents and targets; independent creation times differ.
        const withoutTimes = (rows) => rows.map(({ mtimeNs, ...row }) => row);
        assert.deepEqual(withoutTimes(before), withoutTimes(item.before));
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });
}

test('emitted installed verifier runs from disposable package with an empty PATH', async (t) => {
  if (process.platform === 'win32') { t.skip('Native Windows adapter remains required'); return; }
  const root = await mkdtemp(join(tmpdir(), 'ts-artifact-offline-'));
  try {
    const source = await fixture(join(root, 'source'));
    await cp(join(repository, 'runtime'), join(source, 'runtime'), { recursive: true });
    await writeFile(join(source, 'package.json'), '{"type":"module"}\n');
    const target = join(root, 'installed');
    await cp(source, target, { recursive: true });
    const before = await snapshot(root);
    const module = pathToFileURL(join(target, 'runtime/package/installed-artifacts.js')).href;
    const script = `const {assertCriticalBytes,criticalPaths}=await import(${JSON.stringify(module)});
      await assertCriticalBytes(process.argv[1],process.argv[2],{label:'synthetic',profile:'3.14'});
      const files=await criticalPaths(process.argv[1],'3.14');
      process.stdout.write(JSON.stringify({verified:true,files}));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, target, source], {
      cwd: root, env: { PATH: '' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.verified, true);
    assert.ok(receipt.files.includes('runtime/package/installed-artifacts.js'));
    assert.ok(receipt.files.includes('runtime/contracts/posix-path-bytes.js'));
    assert.deepEqual(receipt.files, await criticalPaths(target, '3.14'));
    assert.deepEqual(await snapshot(root), before);
    t.diagnostic('Existing absolute Node used; no Python invocation, network, fresh-host or launcher acceptance claimed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native artifact scan retains Python 3.14 behavior for a readable non-executable directory', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX permissions required'); return; }
  const root = await mkdtemp(join(tmpdir(), 'ts-artifact-permission-'));
  let runtime;
  try {
    const source = await fixture(join(root, 'source'));
    runtime = join(source, 'runtime');
    const before = await snapshot(root);
    await chmod(runtime, 0o400);
    let denied = false;
    try { await access(join(runtime, 'nested'), 1); }
    catch (error) { assert.equal(error.code, 'EACCES'); denied = true; }
    if (!denied) { t.skip('Host identity bypasses fixture permission denial'); return; }
    const script = `import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('artifact_oracle',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
print(json.dumps(module.critical_paths(Path(sys.argv[2]))))`;
    const run = spawnSync('python3.14', ['-I', '-B', '-c', script, join(repository, 'scripts/smoke/artifacts.py'), source], {
      encoding: 'utf8', timeout: 5000,
    });
    if (run.error?.code === 'ENOENT') { t.skip('Required Python 3.14 unavailable'); return; }
    assert.equal(run.status, 0, run.stderr);
    const expected = JSON.parse(run.stdout);
    assert.ok(!expected.includes('runtime/nested/codec.js'));
    assert.deepEqual(await criticalPaths(source, '3.14'), expected);
    await chmod(runtime, 0o755);
    assert.deepEqual(await snapshot(root), before);
  } finally {
    if (runtime) await chmod(runtime, 0o755);
    await rm(root, { recursive: true, force: true });
  }
});

test('native declared-root failures retain Python exception categories', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX adapter; native Windows remains required'); return; }
  const root = await mkdtemp(join(tmpdir(), 'ts-artifact-root-errors-'));
  try {
    await symlink('loop', join(root, 'loop'));
    const before = await snapshot(root);
    for (const profile of ['3.12', '3.13', '3.14']) {
      const script = `import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('artifact_oracle',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
rows=[]
for path in sys.argv[2:]:
 try: rows.append({'value':module.critical_paths(Path(path))})
 except Exception as error: rows.append({'name':type(error).__name__,'errno':getattr(error,'errno',None)})
print(json.dumps(rows))`;
      const paths = [join(root, 'absent'), join(root, 'loop')];
      const run = spawnSync(`python${profile}`, ['-I', '-B', '-c', script, join(repository, 'scripts/smoke/artifacts.py'), ...paths], {
        encoding: 'utf8', timeout: 5000,
      });
      if (run.error?.code === 'ENOENT') { t.skip('Required interpreter unavailable'); return; }
      assert.equal(run.status, 0, run.stderr);
      const actual = [];
      for (const path of paths) {
        try { actual.push({ value: await criticalPaths(path, profile) }); }
        catch (error) { actual.push({ name: error.name, errno: typeof error.errno === 'number' ? Math.abs(error.errno) : null }); }
      }
      assert.deepEqual(actual, JSON.parse(run.stdout));
    }
    assert.deepEqual(await snapshot(root), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
