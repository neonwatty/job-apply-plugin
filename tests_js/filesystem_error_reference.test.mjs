import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pythonFilesystemError, withPythonFilesystemErrors } from '../runtime/contracts/filesystem-error.js';

for (const version of ['3.12', '3.13', '3.14']) {
  test(`filesystem error categories match Python ${version} without replacing native diagnostics`, () => {
    const script = `import errno,json
names=['EACCES','EPERM','EEXIST','ENOENT','EISDIR','ENOTDIR','EINTR','EAGAIN','EWOULDBLOCK',
'EINPROGRESS','EALREADY','EPIPE','ESHUTDOWN','ECONNABORTED','ECONNREFUSED','ECONNRESET','ESRCH','ETIMEDOUT','EIO','ENAMETOOLONG']
print(json.dumps([[name,getattr(errno,name),type(OSError(getattr(errno,name),'synthetic')).__name__] for name in names]))`;
    const run = spawnSync(`python${version}`, ['-I', '-c', script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
    for (const [code, number, category] of JSON.parse(run.stdout)) {
      const error = Object.assign(new Error('native diagnostic'), { code, errno: -number, path: 'synthetic' });
      const originalStack = error.stack;
      assert.equal(pythonFilesystemError(error), error);
      assert.equal(error.name, category);
      assert.equal(error.message, 'native diagnostic');
      assert.equal(error.stack, originalStack);
      assert.equal(error.path, 'synthetic');
      assert.equal(error.code, code);
      assert.equal(error.errno, -number);
    }
  });
}

test('filesystem category bridge preserves non-filesystem and explicitly named errors', async () => {
  for (const error of [null, 'failure', new TypeError('synthetic'), new Error('plain'),
    Object.assign(new Error('injected'), { name: 'InjectedFailure', code: 'EIO', errno: -5 })]) {
    const before = error instanceof Error ? error.name : null;
    assert.equal(pythonFilesystemError(error), error);
    if (error instanceof Error) assert.equal(error.name, before);
    await assert.rejects(withPythonFilesystemErrors(Promise.reject(error)), (value) => value === error);
  }
  assert.equal(await withPythonFilesystemErrors(Promise.resolve(7)), 7);
  for (const code of ['__proto__', 'toString', 'unknown']) {
    assert.equal(pythonFilesystemError(Object.assign(new Error('native'), { code, errno: -1 })).name, 'OSError');
  }
});

test('filesystem category bridge handles real owned-file native failures', async (t) => {
  if (process.platform === 'win32') { t.skip('Native Windows errno cells remain required'); return; }
  const root = await mkdtemp(join(tmpdir(), 'ts-filesystem-errors-'));
  try {
    const file = join(root, 'file');
    await writeFile(file, 'synthetic');
    for (const [operation, category, code] of [
      [() => readFile(join(root, 'absent')), 'FileNotFoundError', 'ENOENT'],
      [() => mkdir(file), 'FileExistsError', 'EEXIST'],
      [() => mkdir(join(file, 'child')), 'NotADirectoryError', 'ENOTDIR'],
      [() => readFile(root), 'IsADirectoryError', 'EISDIR'],
    ]) {
      await assert.rejects(withPythonFilesystemErrors(operation()),
        (error) => error.name === category && error.code === code && typeof error.errno === 'number');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
