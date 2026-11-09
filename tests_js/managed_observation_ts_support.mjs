import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const nowMicroseconds = 1767312000000000n;
export const data = Buffer.from('synthetic observation bytes');
export const ids = ['normal', 'cache-empty', 'cache-fresh', 'cache-zero-age', 'cache-expired',
  'cache-future', 'cache-wrong-identity', 'cache-disabled', 'missing', 'directory', 'symlink',
  'oversized', 'digest-none', 'after-read-change', 'first-stat-error', 'second-stat-error',
  'cache-missing-time', 'cache-missing-digest'];

export async function setup(id) {
  const root = await mkdtemp(join(tmpdir(), 'ts-managed-observation-'));
  const path = join(root, 'synthetic.bin');
  if (id === 'directory') await mkdir(path);
  else if (id === 'symlink') {
    await writeFile(join(root, 'target.bin'), data);
    await symlink('target.bin', path, 'file');
  } else if (id !== 'missing') {
    await writeFile(path, id === 'oversized' ? Buffer.alloc(10 * 1024 * 1024 + 1, 'x') : data);
    await utimes(path, 1767225600, 1767225600);
  }
  return { root, path };
}

export async function snapshot(root) {
  const rows = [];
  for (const name of ['.', ...(await readdir(root)).sort()]) {
    const path = name === '.' ? root : join(root, name);
    const info = await lstat(path, { bigint: true });
    const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file';
    rows.push({ path: name, kind, mode: Number(info.mode & 0o7777n), mtimeNs: String(info.mtimeNs),
      target: kind === 'symlink' ? await readlink(path) : null,
      sha256: kind === 'file' ? createHash('sha256').update(await readFile(path)).digest('hex') : null });
  }
  return rows;
}
