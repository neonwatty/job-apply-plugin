import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const child = (base, suffix) => Buffer.concat([base, Buffer.from('/'), Buffer.isBuffer(suffix) ? suffix : Buffer.from(suffix)]);
export const unavailableNames = ['resolve-byte-directory', 'resolve-byte-file', 'resolve-byte-link', 'managed-byte-parent', 'managed-byte-link-parent'];

export function codecCorpus() {
  const byteHex = Array.from({ length: 256 }, (_, value) => Buffer.from([value]).toString('hex'));
  byteHex.push('', 'efbbbf', 'eda080', 'edbfbf', 'c080', 'f0808080', 'f4908080', 'f48fbfbf',
    'e08080', 'e0a080', 'eda08061', 'f09f9880', 'f09f98', 'e282', 'c2', '80ff00');
  let state = 0x632d4;
  for (let index = 0; index < 4096; index += 1) {
    const bytes = [];
    for (let offset = 0; offset < index % 13; offset += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bytes.push(state >>> 24);
    }
    byteHex.push(Buffer.from(bytes).toString('hex'));
  }
  const strings = ['', '\0', 'a/b', '\ufeff', 'é😀', '日本語', '\u007f', '\u0080', '\u07ff', '\u0800', '\uffff',
    '\ud800\udc00', '\udbff\udfff'];
  for (let unit = 0xd800; unit <= 0xdfff; unit += 1) strings.push(`a${String.fromCharCode(unit)}b`);
  for (const value of ['\ud800\udc80', '\ud800\ud800', '\udcff\ud800', '\udc80\udcff', '\udfff\ud800']) strings.push(value);
  return { byteHex, strings, seed: 0x632d4 };
}

export async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ts-posix-bytes-')));
  const bytes = Buffer.from(root);
  const managed = child(bytes, 'managed');
  await mkdir(managed);
  let namesAvailable = true;
  try {
    await mkdir(child(managed, Buffer.from([0xff])));
    await writeFile(child(managed, Buffer.from([0xff, 47, 100, 97, 116, 97])), 'synthetic');
    await symlink(Buffer.from('.'), child(managed, Buffer.from([0xfe])));
  } catch (error) {
    if (error.code !== 'EILSEQ') throw error;
    namesAvailable = false;
  }
  await symlink(Buffer.from([0xff]), child(managed, 'byte-target'));
  await symlink(Buffer.from([0xfd]), child(managed, 'dangling-byte'));
  await mkdir(child(managed, '😀'));
  return { root, managed: `${root}/managed`, namesAvailable };
}

export async function snapshot(root) {
  const rows = [];
  async function visit(path, relative) {
    const info = await lstat(path, { bigint: true });
    const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file';
    rows.push({ pathHex: relative.toString('hex'), kind, mode: Number(info.mode & 0o7777n), mtimeNs: String(info.mtimeNs),
      sha256: kind === 'file' ? createHash('sha256').update(await readFile(path)).digest('hex') : null,
      targetHex: kind === 'symlink' ? (await readlink(path, { encoding: 'buffer' })).toString('hex') : null });
    if (kind === 'directory') {
      const names = await readdir(path, { encoding: 'buffer' });
      names.sort(Buffer.compare);
      for (const name of names) await visit(child(path, name), relative.equals(Buffer.from('.')) ? name : child(relative, name));
    }
  }
  await visit(Buffer.from(root), Buffer.from('.'));
  return rows;
}
