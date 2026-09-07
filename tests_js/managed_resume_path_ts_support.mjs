import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePythonJson } from '../runtime/contracts/raw-json/parser.js';

export const linkCases = new Set(['inside-link', 'outside-link', 'loop-parent', 'loop-leaf', 'leaf-link',
  'chain-inside', 'chain-outside', 'multi-loop', 'missing-link', 'link-nested-dotdot', 'absolute-link', 'root-link', 'root-link-absolute']);
export const faultCases = { 'parent-resolve-oserror': 1, 'root-resolve-oserror': 2 };

export async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ts-managed-path-'));
  const managed = join(root, 'managed');
  await mkdir(managed);
  await mkdir(join(managed, 'nested'));
  await mkdir(join(root, 'outside'));
  await writeFile(join(managed, 'file.bin'), 'synthetic managed bytes');
  let symlinks = true;
  try {
    for (const [name, target, type] of [
      ['inside', '.', 'dir'], ['outside-link', '../outside', 'dir'], ['loop', 'loop', 'dir'],
      ['leaf-link', '../outside/missing.bin', 'file'], ['chain', 'inside', 'dir'],
      ['chain-outside', 'outside-link', 'dir'], ['loop-a', 'loop-b', 'dir'], ['loop-b', 'loop-a', 'dir'],
      ['missing-link', 'absent', 'dir'], ['nested-link', 'nested', 'dir'], ['absolute-link', managed, 'dir'],
    ]) await symlink(target, join(managed, name), type);
    await symlink('managed', join(root, 'managed-alias'), 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
    symlinks = false;
  }
  return { root, managed, symlinks };
}

export function records(root) {
  const managed = join(root, 'managed');
  const paths = [
    ['normal', 'file.bin'], ['dot', './file.bin'], ['empty', ''], ['dot-only', '.'], ['parent', '../file.bin'],
    ['nested', 'nested/file.bin'], ['nested-dotdot', 'nested/../file.bin'], ['missing-tail', 'missing.bin'],
    ['missing-parent', 'absent/file.bin'], ['missing-dotdot', 'absent/../file.bin'],
    ['absolute-inside', join(managed, 'file.bin')], ['absolute-outside', join(root, 'outside/file.bin')],
    ['null-name', null], ['integer-name', 1], ['inside-link', 'inside/file.bin'],
    ['outside-link', 'outside-link/file.bin'], ['loop-parent', 'loop/file.bin'], ['loop-leaf', 'loop'],
    ['leaf-link', 'leaf-link'], ['repeated-separators', 'nested//../file.bin'], ['trailing-separator', 'file.bin/'],
    ['embedded-dot', 'nested/./../file.bin'], ['multiple-missing', 'absent/tail/../../file.bin'],
    ['non-directory-parent', 'file.bin/tail'], ['non-directory-dotdot', 'file.bin/../file.bin'],
    ['chain-inside', 'chain/file.bin'], ['chain-outside', 'chain-outside/file.bin'], ['multi-loop', 'loop-a/file.bin'],
    ['missing-link', 'missing-link/file.bin'], ['link-nested-dotdot', 'nested-link/../file.bin'],
    ['absolute-link', 'absolute-link/file.bin'], ['root-link', 'file.bin'],
    ['root-link-absolute', join(managed, 'file.bin')], ['parent-resolve-oserror', 'file.bin'], ['root-resolve-oserror', 'file.bin'],
  ];
  return new Map([
    ['missing-storage', new Map()], ['external', new Map([['storageKind', 'external']])],
    ['missing-name', new Map([['storageKind', 'managed']])],
    ...paths.map(([id, value]) => [id, parsePythonJson(JSON.stringify({ storageKind: 'managed', managedFile: value }), { intMaxStrDigits: 4300 })]),
  ]);
}

export async function snapshot(root) {
  const rows = [];
  async function visit(path, relative) {
    const info = await lstat(path, { bigint: true });
    const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file';
    rows.push({ path: relative, kind, mode: Number(info.mode & 0o7777n), mtimeNs: String(info.mtimeNs),
      sha256: kind === 'file' ? createHash('sha256').update(await readFile(path)).digest('hex') : null,
      target: kind === 'symlink' ? (await readlink(path)).replace(root, '<root>') : null });
    if (kind === 'directory') for (const name of (await readdir(path)).sort()) {
      await visit(join(path, name), relative === '.' ? name : `${relative}/${name}`);
    }
  }
  await visit(root, '.');
  return rows;
}
