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

// Point fixtures mirror the independent frozen Python constructors, not port output.
import { PythonText } from '../runtime/contracts/python-text.js';
import { PythonObject } from '../runtime/contracts/python-object.js';
import { parseNumericAtom } from '../runtime/contracts/raw-json/numeric-atom.js';
import { pointExceptionFacts, createNativePointAtomicWriteIO } from '../runtime/store/point-persistence.js';

export const pointProfiles = ['3.12', '3.13', '3.14'];
export const pointText = points => PythonText.fromCodePoints(points);
export const pointObject = entries => {
  const object = new PythonObject();
  for (const [key, value] of entries) object.set(typeof key === 'string' ? PythonText.fromJavaScript(key) : key, value);
  return object;
};
export const pointInteger = decimal => parseNumericAtom(decimal, { intMaxStrDigits: 0 });
export async function pointVectors() {
  return JSON.parse(await readFile(new URL('../docs/migration/evidence/s04/reference-vectors.json', import.meta.url), 'utf8'));
}
export function pointPayload(id) {
  const scalar = pointText([65536]), pair = pointText([55296, 56320]);
  const controls = pointText([0, 10, 9, 34, 92, 127]);
  const cycle = []; cycle.push(cycle);
  const large = pointInteger('1'.repeat(641));
  if (id === 'chunk-shared') { const child = [scalar]; return [child, child]; }
  const fixed = {
    'chunk-scalar': scalar, 'chunk-pair': pair, 'chunk-high': pointText([55296]),
    'chunk-low': pointText([56320]), 'chunk-surrogate-run': pointText([55296, 56320, 56448]),
    'chunk-controls': controls, 'chunk-pair-value': pointObject([['a', pair]]),
    'chunk-key-order': pointObject([[scalar, pointInteger('2')], [pair, pointInteger('1')], ['', pointInteger('0')]]),
    'chunk-empty-nested': [pointObject([]), [], pointObject([['a', []]])], 'chunk-cycle': cycle,
    'chunk-integer640': pointInteger('1'.repeat(640)), 'chunk-integer641': large, 'chunk-unlimited641': large,
    'atomic-prefix-pair': pointObject([['a', PythonText.fromJavaScript('ok')], ['z', pair]]),
  };
  if (Object.hasOwn(fixed, id)) return fixed[id];
  if (id.endsWith('before-cycle')) return [pair, cycle];
  if (id.endsWith('before-integer')) return [pair, large];
  if (id.endsWith('pair-key')) return pointObject([[pair, pointInteger('1')]]);
  if (id.endsWith('controls')) return pointObject([['a', controls]]);
  return pointObject([['a', id.endsWith('scalar') || id.endsWith('installed-mode-error') ? scalar : pair]]);
}
export function pointError(error, seen = new Map()) {
  if (error === undefined || error === null) return null;
  if (!(error instanceof Error)) return error;
  if (seen.has(error)) return { ref: seen.get(error) };
  seen.set(error, seen.size);
  const facts = pointExceptionFacts(error);
  const result = { name: facts.name, message: facts.message, errno: facts.errno,
    cause: pointError(facts.cause, seen), context: pointError(facts.context, seen), suppressContext: facts.suppressContext };
  if (facts.unicode) Object.assign(result, { encoding: facts.unicode.encoding,
    objectPoints: [...Object.getOwnPropertyDescriptor(PythonText.prototype, 'codePoints').get.call(facts.unicode.object)],
    start: facts.unicode.start, end: facts.unicode.end, reason: facts.unicode.reason });
  return result;
}
export const pointFault = stage => Object.assign(new Error(`[Errno 5] synthetic ${stage}`), { name: 'OSError', errno: 5 });
export async function pointFileState(path) {
  const st = await lstat(path, { bigint: true });
  return { kind: st.isDirectory() ? 'directory' : 'file', mode: Number(st.mode & 0o777n),
    ino: String(st.ino), device: String(st.dev), size: String(st.size), mtimeNs: String(st.mtimeNs),
    ctimeNs: String(st.ctimeNs), atimeNs: String(st.atimeNs),
    contentHex: st.isFile() ? (await readFile(path)).toString('hex') : null };
}
export const withoutPointAtime = ({ atimeNs, ...state }) => state;
export async function pointFixture() {
  const root = await mkdtemp(join(tmpdir(), 's04-owned-point-'));
  const parent = join(root, 'private'), target = join(parent, 'document.json'), sentinel = join(root, 'sentinel');
  await mkdir(parent, { mode: 0o700 });
  await writeFile(target, '{}\n', { mode: 0o600 });
  await writeFile(sentinel, 'sentinel', { mode: 0o600 });
  for (const path of [target, sentinel, parent, root]) await utimes(path, 1600000000, 1600000000);
  const before = { target: await pointFileState(target), parent: await pointFileState(parent), sentinel: await pointFileState(sentinel) };
  return { root, parent, target, sentinel, before };
}
export function pointAtomicIO(fixture, profile, faults = {}) {
  const native = createNativePointAtomicWriteIO(profile);
  const state = { events: [], writes: [], temporary: null, postClose: null, failures: [] };
  function fault(stage) { if (Object.hasOwn(faults, stage)) throw faults[stage]; }
  const io = {
    async mkdir(path, options) {
      assert.equal(path, fixture.parent);
      assert.deepEqual(options, { mode: 0o700, parents: true, existOk: true });
      state.events.push('parent.mkdir(parents=true,exist_ok=true,mode=0700)');
      await native.mkdir(path, options);
    },
    async chmod(path, mode) {
      const stage = path === fixture.parent ? 'parent-chmod' : path === fixture.target ? 'target-chmod' : 'temp-chmod';
      assert.equal(mode, stage === 'parent-chmod' ? 0o700 : 0o600);
      state.events.push(stage === 'parent-chmod' ? 'parent.chmod(0700)' : stage === 'target-chmod' ? 'target.chmod(0600)' : 'temporary.chmod(0600)');
      fault(stage); await native.chmod(path, mode);
    },
    async createTemporary(options) {
      assert.deepEqual(options, { directory: fixture.parent, prefix: '.document.json.', suffix: '.tmp' });
      state.events.push('NamedTemporaryFile(w,utf-8,delete=false)');
      const handle = await native.createTemporary(options); state.temporary = handle.path;
      return { path: handle.path,
        async write(text) {
          const points = [...text.codePoints], row = { text, points, result: null, visibleHex: null };
          const previous = state.writes.at(-1)?.points;
          const finalLf = points.length === 1 && points[0] === 10 && previous?.length === 1 && previous[0] === 125;
          const label = finalLf ? 'LF' : `chunk:${state.writes.length}`;
          state.events.push(`temporary.write(${label})`); state.writes.push(row);
          try { fault('write'); await handle.write(text); row.result = points.length; }
          catch (error) { row.error = error; state.failures.push(error); throw error; }
          finally { row.visibleHex = (await readFile(handle.path)).toString('hex'); }
        },
        async flush() { state.events.push('temporary.flush'); fault('flush'); await handle.flush(); },
        async sync() { state.events.push('os.fsync(file)'); fault('file-sync'); await handle.sync(); },
        async close() {
          await handle.close(); state.postClose = await pointFileState(handle.path);
          state.events.push('temporary.close'); fault('close');
        },
      };
    },
    async replace(from, to) {
      assert.equal(from, state.temporary); assert.equal(to, fixture.target);
      state.events.push('os.replace(temp,target)'); await native.replace(from, to);
    },
    async openDirectory(path) {
      assert.equal(path, fixture.parent); state.events.push('os.open(parent,O_RDONLY)');
      const handle = await native.openDirectory(path);
      return {
        async sync() { state.events.push('os.fsync(parent)'); fault('directory-sync'); await handle.sync(); },
        async close() { await handle.close(); state.events.push('os.close(parent)'); fault('directory-close'); },
      };
    },
    async unlink(path) {
      assert.equal(path, state.temporary); state.events.push('temporary.unlink');
      state.unlinkBefore = (await readFile(path)).toString('hex'); fault('unlink'); await native.unlink(path);
    },
  };
  return { io, state };
}

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
// Limited to this test process and fixture's temporary names; restore in finally.
export async function withPointNativeFaults(fixture, faults, operation) {
  const originalOpen = fs.promises.open, originalUnlink = fs.promises.unlink;
  const events = [], handles = new Set();
  const temporary = path => String(path).startsWith(fixture.parent + '/.document.json.') && String(path).endsWith('.tmp');
  const fail = stage => { if (Object.hasOwn(faults, stage)) throw faults[stage]; };
  fs.promises.open = async function(path, ...args) {
    const handle = await originalOpen(path, ...args);
    if (!temporary(path)) return handle;
    handles.add(handle);
    return {
      async stat(...args) { events.push('native-stat'); fail('stat'); return handle.stat(...args); },
      async write(...args) { events.push('native-write'); fail('write'); return handle.write(...args); },
      async sync() { events.push('native-sync'); return handle.sync(); },
      async close() {
        events.push('native-close'); await handle.close(); handles.delete(handle); fail('close');
      },
    };
  };
  fs.promises.unlink = async function(path) {
    if (temporary(path)) { events.push('native-unlink'); fail('unlink'); }
    return originalUnlink(path);
  };
  syncBuiltinESMExports();
  try { return await operation(events); }
  finally {
    fs.promises.open = originalOpen; fs.promises.unlink = originalUnlink; syncBuiltinESMExports();
    for (const handle of handles) await handle.close();
  }
}
