import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, chmod, writeFile, symlink, rename, readdir, readlink, readFile, utimes, lutimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parsePythonJson } from '../runtime/contracts/raw-json/parser.js';
import assert from 'node:assert/strict';
import { createNativeAtomicWriteIO } from '../runtime/store/private-filesystem.js';

export const ids = ['basic', 'missing-parent', 'numbers', 'unicode', 'surrogate', 'unsupported', 'cycle',
  'symlink', 'broken-symlink', 'directory', 'mkdir', 'parent-chmod', 'temp-create', 'partial-write',
  'flush', 'file-fsync', 'temp-close', 'temp-chmod', 'replace', 'destination-chmod', 'directory-open',
  'directory-fsync', 'directory-close', 'replace-cleanup', 'replace-cleanup-missing', 'write-close',
  'write-cleanup', 'list', 'null', 'mixed-keys', 'integer-limit', 'parent-symlink',
  'directory-open-value', 'directory-fsync-value'];
export const basic = () => parsePythonJson('{"z":1,"emoji":"λ"}', { intMaxStrDigits: 4300 });
export function payload(id) {
  const raw = { numbers: `{"big":1${'0'.repeat(79)}1,"float":1.0,"negativeZero":-0.0,"nan":NaN,"infinity":Infinity,"tiny":5e-324}`,
    unicode: '{"😀":"astral","\ue000":"private","a":"λ\\n\\t\\u007f","empty":[{},[]]}',
    surrogate: '{"a":"\\ud800"}', list: '[1,null,{}]', null: 'null',
    'integer-limit': `{"big":1${'0'.repeat(4300)}}` }[id];
  if (raw !== undefined) return parsePythonJson(raw, { intMaxStrDigits: 0 });
  if (id === 'unsupported') return new Map([['a', new Set([1, 2])]]);
  if (id === 'mixed-keys') return new Map([['a', 1], [2, 'b']]);
  if (id === 'cycle') { const cycle = new Map(); cycle.set('a', cycle); return cycle; }
  return basic();
}

export async function setup(id) {
  const root = await mkdtemp(join(tmpdir(), 'ts-atomic-json-'));
  const parent = join(root, 'private');
  await mkdir(parent, { mode: 0o755 });
  await chmod(parent, 0o755);
  if (id === 'parent-symlink') { await rename(parent, join(root, 'real')); await symlink('real', parent); }
  const target = id === 'missing-parent' ? join(parent, 'nested', 'deep', 'document.json') : join(parent, 'document.json');
  if (['symlink', 'broken-symlink'].includes(id)) {
    if (id === 'symlink') await writeFile(join(parent, 'foreign.json'), 'foreign\n');
    await symlink('foreign.json', target);
  } else if (id === 'directory') await mkdir(target);
  else if (id !== 'missing-parent') { await writeFile(target, 'old\n'); await chmod(target, 0o644); }
  async function fixedTime(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) await lutimes(path, 1600000000, 1600000000);
    else {
      if (info.isDirectory()) for (const name of await readdir(path)) await fixedTime(join(path, name));
      await utimes(path, 1600000000, 1600000000);
    }
  }
  await fixedTime(root);
  return { root, parent, target };
}

export async function snapshot(root, temporaryPath) {
  const rows = [];
  async function visit(path) {
    const info = await lstat(path, { bigint: true });
    const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file';
    const bytes = kind === 'file' ? await readFile(path) : null;
    rows.push({ path: path === temporaryPath ? relative(root, join(path, '..', '<temp>')) : relative(root, path) || '.',
      kind, mode: Number(info.mode & 0o7777n), mtimeNs: String(info.mtimeNs), hex: bytes?.toString('hex') ?? null,
      sha256: bytes === null ? null : createHash('sha256').update(bytes).digest('hex'),
      target: kind === 'symlink' ? await readlink(path) : null });
    if (kind === 'directory') for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  await visit(root);
  return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function observedIO(fixture, profile, faults) {
  const native = createNativeAtomicWriteIO(profile);
  const state = { events: [], writeCalls: 0, tempClosed: null, directoryClosed: null, temporaryPath: undefined };
  const event = (stage) => {
    state.events.push(stage);
    if (faults.includes(`${stage}-value`)) throw Object.assign(new Error(`synthetic ${stage}`), { name: 'ValueError' });
    if (faults.includes(stage)) throw Object.assign(new Error(`synthetic ${stage}`), { name: 'InjectedFailure', errno: -5, stage });
  };
  const io = {
    async mkdir(path, options) {
      assert.equal(path, join(fixture.target, '..'));
      assert.deepEqual(options, { mode: 0o700, parents: true, existOk: true });
      event('mkdir');
      await native.mkdir(path, options);
    },
    async chmod(path, mode) {
      const stage = path === join(fixture.target, '..') ? 'parent-chmod' : path === state.temporaryPath ? 'temp-chmod' : 'destination-chmod';
      assert.equal(mode, stage === 'parent-chmod' ? 0o700 : 0o600);
      if (stage === 'destination-chmod') assert.equal(path, fixture.target);
      event(stage);
      await native.chmod(path, mode);
    },
    async createTemporary(options) {
      assert.deepEqual(options, { directory: join(fixture.target, '..'), prefix: '.document.json.', suffix: '.tmp' });
      event('temp-create');
      const temporary = await native.createTemporary(options);
      state.temporaryPath = temporary.path;
      state.tempClosed = false;
      return { path: temporary.path,
        async write(text) {
          state.writeCalls += 1;
          if (state.writeCalls === 1) {
            if (faults.includes('partial-write')) await temporary.write(text.slice(0, 1));
            event(faults.includes('partial-write') ? 'partial-write' : 'write');
          }
          await temporary.write(text);
        },
        async flush() { event('flush'); await temporary.flush(); },
        async sync() { event('file-fsync'); await temporary.sync(); },
        async close() { await temporary.close(); state.tempClosed = true; event('temp-close'); },
      };
    },
    async replace(source, destination) {
      assert.equal(source, state.temporaryPath);
      assert.equal(destination, fixture.target);
      event('replace');
      await native.replace(source, destination);
    },
    async openDirectory(path) {
      assert.equal(path, join(fixture.target, '..'));
      event('directory-open');
      const directory = await native.openDirectory(path);
      state.directoryClosed = false;
      return {
        async sync() { event('directory-fsync'); await directory.sync(); },
        async close() { await directory.close(); state.directoryClosed = true; event('directory-close'); },
      };
    },
    async unlink(path) {
      assert.equal(path, state.temporaryPath);
      event('cleanup');
      await native.unlink(path);
      if (faults.includes('cleanup-missing')) throw Object.assign(new Error('synthetic removed'), { errno: -2, code: 'ENOENT' });
    },
  };
  return { io, state };
}
