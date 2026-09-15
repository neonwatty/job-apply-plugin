import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { prepareCanonicalStoreClone } from '../runtime/store/native-store-clone.js';
import { recoverNativeWriterSwitch } from '../runtime/store/native-writer-switch.js';
import { ProcessOwnedWriterController } from '../runtime/store/process-owned-writer.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';

const execute = promisify(execFile);
const childScript = new URL('./process_owned_writer_child.mjs', import.meta.url).pathname;
const python = `
import sys,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('switch_reference','scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s=m.Store(Path(sys.argv[1]));s.initialize()
`;

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function setup(t, behaviors = {}) {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const parent = await realpath(fixture.root), active = join(parent, 'store');
  const candidate = `${active}.native-candidate`, state = join(parent, 'process-state');
  await mkdir(state, { mode: 0o700 });
  await execute('python3', ['-c', python, active]);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  await prepareCanonicalStoreClone(active, candidate, provider, '2026-09-15T12:00:00Z');
  let sequence = 0;
  const records = [];
  const createController = () => new ProcessOwnedWriterController({
    active, candidate, provider, shutdownGraceMilliseconds: 80, ownershipTimeoutMilliseconds: 60,
    createSpec: async mode => {
      const identity = `${mode}-${++sequence}`;
      records.push(identity);
      return {
        command: process.execPath,
        argv: [childScript, mode, state, identity, behaviors[mode] ?? 'graceful'],
        cwd: process.cwd(),
        startupTimeoutMilliseconds: 2000,
        ready: line => JSON.parse(line).mode === mode,
      };
    },
  });
  const controller = createController();
  t.after(() => controller.stop().catch(() => {}));
  return { active, candidate, controller, createController, provider, records, state };
}

async function record(state, identity) {
  return JSON.parse(await readFile(join(state, `${identity}.json`), 'utf8'));
}

test('controller proves its complete writer process group is gone before each Store rename', { timeout: 60000 }, async t => {
  const { controller, records, state } = await setup(t);
  await controller.start('python');
  const pythonRecord = await record(state, records.at(-1));
  assert(alive(pythonRecord.parent));
  assert(alive(pythonRecord.descendant));
  assert.equal(pythonRecord.ownershipLeaseInherited, true);

  await controller.activate({
    boundary: async point => {
      if (point === 'before-source-rename') {
        assert.equal(alive(pythonRecord.parent), false);
        assert.equal(alive(pythonRecord.descendant), false);
      }
    },
  });
  assert.equal(controller.mode, 'native');
  const nativeRecord = await record(state, records.at(-1));
  assert(alive(nativeRecord.parent));

  await controller.rollback({
    boundary: async point => {
      if (point === 'before-native-rename') assert.equal(alive(nativeRecord.parent), false);
    },
  });
  assert.equal(controller.mode, 'python');
  assert(alive((await record(state, records.at(-1))).parent));
});

test('controller force-kills an uncooperative writer tree and rejects overlapping transitions', { timeout: 60000 }, async t => {
  const { controller, records, state } = await setup(t, { python: 'ignore' });
  await controller.start('python');
  const ignored = await record(state, records.at(-1));
  const activation = controller.activate();
  await assert.rejects(controller.rollback(), /writer lifecycle operation is already active/);
  await activation;
  assert.equal(alive(ignored.parent), false);
  assert.equal(alive(ignored.descendant), false);
  assert.equal(controller.mode, 'native');
});

test('a Store lifetime lease excludes a second process owner before it can start a writer', { timeout: 60000 }, async t => {
  const { controller, createController, records } = await setup(t);
  const competing = createController();
  t.after(() => competing.stop().catch(() => {}));
  await controller.start('python');
  const count = records.length;
  await assert.rejects(competing.start('python'), error => error?.name === 'TimeoutError' || error?.name === 'AbortError');
  assert.equal(records.length, count);
  assert.equal(controller.mode, 'python');
  assert.equal(competing.mode, null);
});

test('failed replacement startup preserves native state for explicit quiescent rollback', { timeout: 60000 }, async t => {
  const { active, controller, provider, records, state } = await setup(t, { native: 'startup-failure' });
  await controller.start('python');
  await assert.rejects(controller.activate(), /owned writer failed before readiness/);
  assert.equal(await recoverNativeWriterSwitch(active, { provider }), 'native');
  assert.equal(controller.mode, null);
  await controller.rollbackQuiescent();
  assert.equal(await recoverNativeWriterSwitch(active, { provider }), 'python');
  assert.equal(controller.mode, 'python');
  assert(alive((await record(state, records.at(-1))).parent));
});

test('activation interruption leaves no writer until explicit recovery', { timeout: 60000 }, async t => {
  const { active, controller, provider, records, state } = await setup(t);
  await controller.start('python');
  const first = await record(state, records.at(-1));
  await assert.rejects(controller.activate({
    boundary: point => { if (point === 'after-candidate-rename') throw new Error('activation interrupted'); },
  }), /activation interrupted/);
  assert.equal(alive(first.parent), false);
  assert.equal(await recoverNativeWriterSwitch(active, { provider }), 'native');
  assert.equal(controller.mode, null);
  await controller.rollbackQuiescent();
  assert.equal(await recoverNativeWriterSwitch(active, { provider }), 'python');
  assert.equal(controller.mode, 'python');
  assert(alive((await record(state, records.at(-1))).parent));
});

test('rollback interruption resumes the recovered writer instead of leaving the Store unattended', { timeout: 60000 }, async t => {
  const { active, controller, provider, records, state } = await setup(t);
  await controller.start('python');
  await controller.activate();
  const native = await record(state, records.at(-1));
  await assert.rejects(controller.rollback({
    boundary: point => { if (point === 'after-native-rename') throw new Error('rollback interrupted'); },
  }), /rollback interrupted/);
  assert.equal(alive(native.parent), false);
  assert.equal(await recoverNativeWriterSwitch(active, { provider }), 'python');
  assert.equal(controller.mode, 'python');
  assert(alive((await record(state, records.at(-1))).parent));
});
