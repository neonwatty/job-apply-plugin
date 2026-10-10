import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeBrowserArchive } from '../runtime/store/native-browser-archive.js';
import { browserArchiveDirectory } from '../runtime/store/native-browser-archive-files.js';
import { emptyBrowserOperationLedger, validateBrowserOperationLedger } from '../runtime/contracts/workspace/browser-operations.js';
import { browserRecoveryGuidance } from '../runtime/app/browser-recovery-guidance.js';
import { requestFingerprint } from '../runtime/contracts/workspace/browser-boundary.js';
import { mutation, observation } from './workspace_durable_browser_support.mjs';

function operation(id, state = 'verified') {
  const request = mutation(observation(), { operationId: id });
  return { request, fingerprint: requestFingerprint(request), state, receipt: { operationId: id,
    evidenceKind: 'synthetic_adapter', status: state === 'verified' ? 'verified' : state === 'rejected' ? 'not_applied' : 'uncertain',
    reason: state === 'verified' ? 'readback_matched' : state === 'rejected' ? 'control_unavailable' : 'reconciliation_required' } };
}
const ledger = (prefix = 'one') => validateBrowserOperationLedger({ schemaVersion: 1,
  operations: Object.fromEntries(Array.from({ length: 63 }, (_, index) => [`${prefix}-${index}`, operation(`${prefix}-${index}`)])) });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'browser-archive-'));
  try { await callback(root, new NativeBrowserArchive(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function files(root) {
  const output = {};
  for (const name of (await readdir(join(root, browserArchiveDirectory))).sort()) {
    output[name] = await readFile(join(root, browserArchiveDirectory, name), 'utf8');
  }
  return output;
}

// Pure archive fixtures construct records to probe storage invariants; installed acceptance
// separately drives all operations through public execution without fabricated receipts.
test('lazy terminal archival preserves v1 reads, history and unresolved fence without publication', async () => fixture(async (root, archive) => {
  const empty = await archive.prepare(emptyBrowserOperationLedger());
  assert.deepEqual(empty.ledger, emptyBrowserOperationLedger());
  assert.deepEqual(await readdir(root), []);
  const source = structuredClone(ledger());
  source.operations['one-0'] = operation('one-0', 'uncertain');
  const prepared = await archive.prepare(source);
  assert.equal(prepared.ledger.schemaVersion, 2);
  assert.deepEqual(Object.keys(prepared.ledger.operations), ['one-0']);
  assert.equal(prepared.ledger.archive.segments[0].operationCount, 62);
  assert.equal(prepared.history.operation('one-1').state, 'verified');
  assert.deepEqual(await readdir(root), []);
  await prepared.flush();
  await archive.validate(prepared.ledger);
  const before = await files(root);
  const restored = await new NativeBrowserArchive(root).prepare(prepared.ledger);
  assert.deepEqual(restored.history.operation('one-1'), source.operations['one-1']);
  assert.deepEqual(await files(root), before);
  assert.equal(browserRecoveryGuidance(prepared.ledger).status, 'reconciliation_required');
  assert.equal(browserRecoveryGuidance(prepared.ledger).archivedOperationCount, 62);
  assert.equal(browserRecoveryGuidance(prepared.ledger).unresolvedOperationId, 'one-0');
}));

test('interrupted first publication leaves disposable private orphan data, never replay authority', async () => {
  for (const stage of ['browser_archive_file_written', 'browser_archive_file_synced', 'browser_archive_segment_published']) {
    await fixture(async root => {
      const source = ledger();
      const interrupted = new NativeBrowserArchive(root, async current => { if (current === stage) throw Error('interruption'); });
      const prepared = await interrupted.prepare(source);
      await assert.rejects(prepared.flush(), /interruption/);
      const restart = new NativeBrowserArchive(root);
      await restart.validate(source);
      assert.equal((await restart.prepare(emptyBrowserOperationLedger())).history.operation('one-0'), null);
      const recovered = await restart.prepare(source);
      await recovered.flush();
      await restart.validate(recovered.ledger);
      assert.deepEqual(Object.keys(await files(root)), [`${recovered.ledger.archive.segments[0].digest}.json`]);
    });
  }
});

test('global duplicate IDs and archived unresolved records fail closed despite valid digests', async () => fixture(async (root, archive) => {
  const prepared = await archive.prepare(ledger()); await prepared.flush();
  const duplicate = structuredClone(prepared.ledger);
  duplicate.operations['one-0'] = operation('one-0');
  await assert.rejects(archive.validate(duplicate), { code: 'invalid_browser_state' });
  const badLedger = { schemaVersion: 1, operations: { pending: operation('pending', 'pending') } };
  const bytes = JSON.stringify({ schemaVersion: 1, ledger: badLedger }), hash = digest(bytes);
  await writeFile(join(root, browserArchiveDirectory, `${hash}.json`), bytes, { mode: 0o600 });
  await assert.rejects(archive.validate({ schemaVersion: 2, operations: {}, archive: {
    schemaVersion: 1, segments: [{ digest: hash, operationCount: 1 }] } }), { code: 'invalid_browser_state' });
}));

test('reference counts, missing data, digest mismatch and private path violations fail closed', async () => {
  for (const corruption of ['count', 'missing', 'digest', 'mode', 'symlink', 'hardlink', 'directory-mode']) {
    await fixture(async (root, archive) => {
      const prepared = await archive.prepare(ledger()); await prepared.flush();
      const next = structuredClone(prepared.ledger), reference = next.archive.segments[0];
      const path = join(root, browserArchiveDirectory, `${reference.digest}.json`);
      if (corruption === 'count') reference.operationCount--;
      if (corruption === 'missing') await rm(path);
      if (corruption === 'digest') await writeFile(path, '{}');
      if (corruption === 'mode') await chmod(path, 0o644);
      if (corruption === 'hardlink') await link(path, join(root, 'hardlink.json'));
      if (corruption === 'directory-mode') await chmod(join(root, browserArchiveDirectory), 0o755);
      if (corruption === 'symlink') {
        const outside = join(root, 'outside.json'); await writeFile(outside, await readFile(path), { mode: 0o600 });
        await rm(path); await symlink(outside, path);
      }
      await assert.rejects(archive.validate(next), { code: 'invalid_browser_state' });
    });
  }
  await fixture(async (root, archive) => {
    await mkdir(join(root, browserArchiveDirectory), { mode: 0o700 });
    await writeFile(join(root, browserArchiveDirectory, 'unknown'), '{}', { mode: 0o600 });
    await assert.rejects(archive.validate(emptyBrowserOperationLedger()), { code: 'invalid_browser_state' });
  });
});

test('finite archive horizon keeps all historical identities and reports capacity without eviction', async () => fixture(async (root, archive) => {
  let current = ledger('segment-0');
  for (let index = 0; index < 32; index++) {
    const prepared = await archive.prepare(current); await prepared.flush();
    current = { ...prepared.ledger, operations: ledger(`segment-${index + 1}`).operations };
  }
  current.operations = { ...current.operations, last: operation('last') };
  const before = await files(root), prepared = await archive.prepare(current);
  assert.equal(prepared.ledger.archive.segments.length, 32);
  assert.equal(Object.keys(prepared.ledger.operations).length, 64);
  assert.equal(prepared.history.operation('segment-0-0').state, 'verified');
  await prepared.flush();
  assert.deepEqual(await files(root), before);
  assert.equal(browserRecoveryGuidance(current).status, 'capacity_reached');
  assert.equal(browserRecoveryGuidance(current).nextAction, 'handoff_capacity');
  assert.equal(browserRecoveryGuidance(current).archivedOperationCount, 32 * 63);
}));
