import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const reference = fileURLToPath(new URL('../tools/contracts/managed-resume-path/reference.py', import.meta.url));
const source = new URL('../scripts/job_apply_store/domains/resumes/storage.py', import.meta.url);
const primary = process.platform === 'win32' ? 'python' : 'python3';
const ids = ['missing-storage', 'external', 'missing-name', 'normal', 'dot', 'empty',
  'dot-only', 'parent', 'nested', 'nested-dotdot', 'missing-tail', 'missing-parent',
  'missing-dotdot', 'absolute-inside', 'absolute-outside', 'null-name', 'integer-name',
  'inside-link', 'outside-link', 'loop-parent', 'loop-leaf', 'leaf-link',
  'repeated-separators', 'trailing-separator', 'embedded-dot', 'multiple-missing',
  'non-directory-parent', 'non-directory-dotdot', 'chain-inside', 'chain-outside',
  'multi-loop', 'missing-link', 'link-nested-dotdot', 'absolute-link',
  'root-link', 'root-link-absolute', 'parent-resolve-oserror', 'root-resolve-oserror'];
const linkIds = new Set(['inside-link', 'outside-link', 'loop-parent', 'loop-leaf', 'leaf-link',
  'chain-inside', 'chain-outside', 'multi-loop', 'missing-link', 'link-nested-dotdot',
  'absolute-link', 'root-link', 'root-link-absolute']);
const paths = {
  normal: 'file.bin', dot: 'file.bin', 'nested-dotdot': 'nested/../file.bin',
  'missing-tail': 'missing.bin', 'missing-dotdot': 'absent/../file.bin',
  'absolute-inside': 'file.bin', 'inside-link': 'inside/file.bin',
  'loop-leaf': 'loop', 'leaf-link': 'leaf-link',
  'repeated-separators': 'nested/../file.bin', 'trailing-separator': 'file.bin',
  'embedded-dot': 'nested/../file.bin', 'multiple-missing': 'absent/tail/../../file.bin',
  'non-directory-dotdot': 'file.bin/../file.bin', 'chain-inside': 'chain/file.bin',
  'link-nested-dotdot': 'nested-link/../file.bin', 'absolute-link': 'absolute-link/file.bin',
  'root-link': 'file.bin', 'root-link-absolute': 'file.bin',
};
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

for (const executable of [primary, 'python3.12', 'python3.13', 'python3.14']) {
  test(`managed resume path contract: ${executable}`, (t) => {
    const result = spawnSync(executable, ['-I', reference], {
      input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    });
    if (result.error?.code === 'ENOENT' && executable !== primary) {
      t.skip('Interpreter alias unavailable; no profile acceptance');
      return;
    }
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const receipt = JSON.parse(result.stdout);
    keys(receipt, ['schemaVersion', 'provenance', 'cases']);
    assert.equal(receipt.schemaVersion, 1);
    keys(receipt.provenance, ['implementation', 'python', 'platform', 'sourceSha256', 'symlinks']);
    const profile = receipt.provenance;
    assert.equal(profile.implementation, 'CPython');
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
    if (unavailable) t.skip(`${unavailable} native symlink cells unavailable; package not fully verified`);
  });
}

test('managed path reference rejects caller arguments and stdin', () => {
  for (const [args, input] of [[['--path', 'synthetic'], ''], [[], 'synthetic']]) {
    const result = spawnSync(primary, ['-I', reference, ...args], { input, encoding: 'utf8', timeout: 3000, maxBuffer: 4096 });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'managed_path_reference_input_rejected\n');
  }
});
