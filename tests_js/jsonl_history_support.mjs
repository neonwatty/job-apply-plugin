import { createHash } from 'node:crypto';
import { chmod, lstat, lutimes, mkdir, mkdtemp, readFile, readdir, readlink, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePythonJson } from '../runtime/contracts/raw-json/parser.js';
import assert from 'node:assert/strict';
import { createNativeJsonlHistoryIO } from '../runtime/store/jsonl-history-io.js';

export const fixedTime = '1600000000000000000';
export const old = Buffer.from('{"old": true}\n');
export function payload(id) {
  const raw = { unicode: '{"😀":"astral","\ue000":"private","a":"λ\\n"}',
    numbers: '{"big":1208925819614629174706176,"float":1.0,"nan":NaN,"negativeZero":-0.0}',
    surrogate: '{"a":"\\ud800"}', 'integer-limit': `{"a":1${'0'.repeat(4300)}}` }[id];
  if (id === 'cycle') { const value = new Map(); value.set('a', value); return value; }
  return parsePythonJson(raw ?? '{"z":1,"a":"λ"}', { intMaxStrDigits: 0 });
}

export async function fixture(operation, id) {
  const root = await mkdtemp(join(tmpdir(), 'ts-jsonl-history-'));
  const path = operation === 'append' && id === 'missing-parent' ? join(root, 'absent', 'history.jsonl') : join(root, 'history.jsonl');
  if (id === 'missing-parent') { /* Deliberately no parent creation. */ }
  else if (['symlink', 'broken-symlink'].includes(id)) {
    if (id === 'symlink') { await writeFile(join(root, 'target.jsonl'), old); await chmod(join(root, 'target.jsonl'), 0o644); }
    await symlink('target.jsonl', path);
  } else if (id === 'directory') await mkdir(path);
  else if (!['new-file', 'missing'].includes(id)) {
    const data = operation === 'append' ? old : id === 'empty' ? Buffer.alloc(0)
      : id === 'complete' ? old : id === 'line-less' ? Buffer.from('partial') : Buffer.concat([old, Buffer.from('{"partial":')]);
    await writeFile(path, data); await chmod(path, 0o644);
  }
  for (const name of ['.', ...(await readdir(root))]) {
    const path = name === '.' ? root : join(root, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) await lutimes(path, 1600000000, 1600000000);
    else await utimes(path, 1600000000, 1600000000);
  }
  return { root, path };
}

export async function snapshot(root) {
  const rows = [];
  for (const name of ['.', ...(await readdir(root)).sort()]) {
    const path = name === '.' ? root : join(root, name);
    const info = await lstat(path, { bigint: true });
    const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file';
    const data = kind === 'file' ? await readFile(path) : null;
    rows.push({ path: name, kind, mode: Number(info.mode & 0o7777n), mtimeNs: String(info.mtimeNs),
      hex: data?.toString('hex') ?? null, sha256: data === null ? null : createHash('sha256').update(data).digest('hex'),
      target: kind === 'symlink' ? await readlink(path) : null });
  }
  return rows;
}

export const effects = rows => rows.map(row => ({ ...row, mtimeNs: row.mtimeNs === fixedTime ? fixedTime : 'changed' }));
export function outcome(error) {
  if (error === undefined) return { kind: 'value' };
  return { kind: 'error', name: error.name, errno: typeof error.errno === 'number' ? Math.abs(error.errno) : null,
    stage: error.stage ?? null, message: error.name === 'StoreError' ? error.message : null,
    context: error.cause === undefined ? null : outcome(error.cause) };
}

export function observedIO(path, profile, expected) {
  const native = createNativeJsonlHistoryIO(profile);
  const handles = new Set();
  const calls = [];
  let writes = 0;
  let rollingBack = false;
  let existsCalls = 0;
  const event = (stage, args = {}) => {
    calls.push({ stage, arguments: args });
    if (expected.faults.includes(stage)) throw Object.assign(new Error(`synthetic ${stage}`), {
      name: 'InjectedFailure', errno: 5, stage,
    });
  };
  const io = {
    async exists(candidate) { assert.equal(candidate, path); existsCalls += 1; return native.exists(candidate); },
    async open(candidate, flags, mode) {
      assert.equal(candidate, path);
      event('open', { flags, mode: mode ?? null });
      const handle = await native.open(candidate, flags, mode);
      handles.add(handle);
      return {
        async stat() { assert.ok(handles.has(handle)); event('fstat'); return handle.stat(); },
        async write(bytes) {
          assert.ok(handles.has(handle)); writes += 1; event('write', { hex: bytes.toString('hex') });
          if (expected.behavior === 'baseexception') throw Object.assign(new Error('synthetic write'), { name: 'KeyboardInterrupt' });
          if (expected.behavior === 'zero' || expected.behavior === 'partial-zero' && writes === 2) return 0;
          if (expected.behavior === 'negative') return -1;
          if (expected.behavior === 'partial-error' && writes === 2) throw Object.assign(new Error('synthetic write'), {
            name: 'InjectedFailure', errno: 5, stage: 'write',
          });
          return handle.write(['short', 'partial-zero', 'partial-error'].includes(expected.behavior) ? bytes.subarray(0, 5) : bytes);
        },
        async read(length) {
          assert.ok(handles.has(handle)); event('read', { length: Number(length) });
          return handle.read(expected.behavior === 'short-read' ? 5n : length);
        },
        async truncate(size) {
          assert.ok(handles.has(handle)); rollingBack = expected.operation === 'append';
          event('truncate', { size: Number(size) }); await handle.truncate(size);
        },
        async sync() { assert.ok(handles.has(handle)); event(rollingBack ? 'rollback-fsync' : 'fsync'); await handle.sync(); },
        async close() { assert.ok(handles.has(handle)); event('close'); await handle.close(); handles.delete(handle); },
      };
    },
    async chmod(candidate, mode) { assert.equal(candidate, path); event('chmod', { mode }); await native.chmod(candidate, mode); },
  };
  return { io, calls, handles, event, existsCalls: () => existsCalls,
    async cleanup() { for (const handle of handles) await handle.close(); handles.clear(); } };
}

// Bounded point append observer: all descriptor operations still use owned files.
export function pointHistoryIO(path, profile, faults = {}, shortWrites = false) {
  const native = createNativeJsonlHistoryIO(profile);
  const calls = [], handles = new Set(), writes = [];
  let rollingBack = false;
  const fault = stage => { if (Object.hasOwn(faults, stage)) throw faults[stage]; };
  const io = {
    async exists(candidate) { calls.push('exists'); return native.exists(candidate); },
    async open(candidate, flags, mode) {
      assert.equal(candidate, path); calls.push('open'); fault('open');
      const handle = await native.open(candidate, flags, mode); handles.add(handle);
      return {
        async stat() { calls.push('stat'); fault('stat'); return handle.stat(); },
        async write(bytes) {
          calls.push('write');
          const row = { requested: Buffer.from(bytes), result: null }; writes.push(row);
          if (writes.length > 1) fault('second-write');
          fault('write');
          row.result = await handle.write(shortWrites ? bytes.subarray(0, 3) : bytes);
          return row.result;
        },
        async read(length) { calls.push('read'); return handle.read(length); },
        async truncate(size) {
          rollingBack = true; calls.push('truncate'); fault('truncate'); await handle.truncate(size);
        },
        async sync() { const stage = rollingBack ? 'rollback-sync' : 'sync'; calls.push(stage); fault(stage); await handle.sync(); },
        async close() { calls.push('close'); await handle.close(); handles.delete(handle); fault('close'); },
      };
    },
    async chmod(candidate, mode) { assert.equal(candidate, path); assert.equal(mode, 0o600); calls.push('chmod'); await native.chmod(candidate, mode); },
  };
  return { io, calls, writes, handles,
    async cleanup() { for (const handle of handles) await handle.close(); handles.clear(); } };
}
