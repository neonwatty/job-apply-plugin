import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { appendHistoryEvent, repairPendingHistoryTail } from '../runtime/store/jsonl-history.js';
import { fixture, snapshot, payload, effects, outcome, observedIO } from './jsonl_history_support.mjs';

const reference = fileURLToPath(new URL('../tools/contracts/jsonl-append/reference.py', import.meta.url));
for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`JSONL append and repair preserve Python native effects and rollback: ${executable}`, async t => {
    if (process.platform === 'win32') return t.skip('Native Windows JSONL acceptance remains open');
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 2 ** 20 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter alias unavailable');
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.cases.length, 43);
    const profile = receipt.profile.python.split('.').slice(0, 2).join('.');
    if (executable !== 'python3') assert.equal(profile, executable.slice(6));
    for (const expected of receipt.cases) await t.test(expected.id, async () => {
      const [operation, id] = expected.id.split(':');
      const tree = await fixture(operation, id);
      const observed = observedIO(tree.path, profile, expected);
      const event = payload(id);
      try {
        assert.deepEqual(await snapshot(tree.root), expected.before);
        let error;
        try {
          if (operation === 'append') await appendHistoryEvent(tree.path, event, {
            serialization: { pathProfile: profile, intMaxStrDigits: 4300 }, io: observed.io,
            async isIdempotent(actual) { assert.equal(actual, event); observed.event('gate'); return id === 'gate-hit'; },
          });
          else await repairPendingHistoryTail(tree.path, { pathProfile: profile, io: observed.io,
            async pendingOperation() { observed.event('journal'); return id === 'idle' ? null : { synthetic: true }; },
          });
        } catch (caught) { error = caught; }
        assert.deepEqual(outcome(error), expected.outcome);
        assert.deepEqual(observed.calls, expected.calls);
        assert.equal(observed.handles.size, expected.openDescriptorsAtReturn);
        for (const handle of observed.handles) assert.ok((await handle.stat()).size >= 0n, 'Descriptor leak witness must still be open');
        assert.deepEqual(effects(await snapshot(tree.root)), effects(expected.after));
        assert.equal(observed.existsCalls(), operation === 'repair' && id !== 'idle' ? 1 : 0);
      } finally { await observed.cleanup(); await rm(tree.root, { recursive: true, force: true }); }
    });
    for (const name of ['append:normal', 'append:new-file', 'append:symlink', 'append:broken-symlink',
      'append:unicode', 'append:numbers', 'repair:partial', 'repair:line-less', 'repair:complete', 'repair:missing']) {
      await t.test(`unwrapped native ${name}`, async () => {
        const [operation, id] = name.split(':');
        const tree = await fixture(operation, id);
        try {
          if (operation === 'append') await appendHistoryEvent(tree.path, payload(id), {
            serialization: { pathProfile: profile, intMaxStrDigits: 4300 }, async isIdempotent() { return false; },
          });
          else await repairPendingHistoryTail(tree.path, { pathProfile: profile, async pendingOperation() { return {}; } });
          assert.deepEqual(effects(await snapshot(tree.root)), effects(receipt.cases.find(row => row.id === name).after));
        } finally { await rm(tree.root, { recursive: true, force: true }); }
      });
    }
  });
}
