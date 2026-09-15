import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { campaignInput, deterministicOptions, now } from './final_action_policy_support.mjs';
import { FinalActionPolicyService } from '../runtime/final-action-policy/service.js';
import { prepareCanonicalStoreClone } from '../runtime/store/native-store-clone.js';
import { activateNativeWriter, rollbackNativeWriter } from '../runtime/store/native-writer-switch.js';
import { withExclusiveFileLock } from '../runtime/store/exclusive-file-lock.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';

const execute = promisify(execFile);
const python = `
import sys,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('switch_reference','scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.utc_now=lambda:'${now}'
s=m.Store(Path(sys.argv[1]));s.initialize()
`;

async function setup(t) {
  const fixture = await nativeFixture(); t.after(fixture.cleanup);
  const root = await realpath(fixture.root), active = join(root, 'store'), candidate = `${active}.native-candidate`;
  await execute('python3', ['-c', python, active]);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const policy = new FinalActionPolicyService(active, deterministicOptions(provider));
  await policy.activate(campaignInput); await policy.revoke(); await policy.activate(campaignInput);
  await prepareCanonicalStoreClone(active, candidate, provider, now);
  return { active, candidate, provider };
}

async function identities(active, candidate) {
  return { active: (await stat(active)).ino, candidate: (await stat(candidate)).ino };
}

async function assertUnmoved(active, candidate, before) {
  assert.deepEqual(await identities(active, candidate), before);
  await assert.rejects(stat(`${active}.python-rollback`), { code: 'ENOENT' });
  await assert.rejects(stat(`${active}.native-retained`), { code: 'ENOENT' });
}

test('writer switch rejects source policy edits before moving either Store', { timeout: 60000 }, async t => {
  const { active, candidate, provider } = await setup(t), before = await identities(active, candidate);
  const path = join(active, 'auto-submit/campaign.json');
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(' ')]), { mode: 0o600 });
  await assert.rejects(activateNativeWriter(active, candidate, { provider }), /does not match/);
  await assertUnmoved(active, candidate, before);
});

test('writer switch rejects candidate policy edits before moving either Store', { timeout: 60000 }, async t => {
  const { active, candidate, provider } = await setup(t), before = await identities(active, candidate);
  await chmod(join(candidate, 'auto-submit/campaigns'), 0o755);
  await assert.rejects(activateNativeWriter(active, candidate, { provider }), /candidate content changed/);
  await assertUnmoved(active, candidate, before);
});

test('writer switch waits for a policy mutation and detects its committed bytes', { timeout: 60000 }, async t => {
  const { active, candidate, provider } = await setup(t), before = await identities(active, candidate);
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const path = join(active, 'auto-submit/campaign.json');
  const mutation = withExclusiveFileLock(join(active, 'auto-submit/.lock'), async () => {
    entered(); await held;
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(' ')]), { mode: 0o600 });
  }, { provider, pathProfile: '3.12', signal: AbortSignal.timeout(5000) });
  await ready;
  let settled = false;
  const activation = activateNativeWriter(active, candidate, { provider }).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(settled, false);
  release(); await mutation;
  await assert.rejects(activation, /does not match/);
  await assertUnmoved(active, candidate, before);
});

for (const selected of ['source', 'candidate']) {
  test(`activation holds the ${selected} policy lock through directory movement`, { timeout: 60000 }, async t => {
    const { active, candidate, provider } = await setup(t);
    const root = selected === 'source' ? active : candidate;
    const path = join(root, 'auto-submit/campaign.json');
    let attempted = false;
    await activateNativeWriter(active, candidate, { provider, boundary: async point => {
      if (point !== 'before-source-rename') return;
      attempted = true;
      await assert.rejects(withExclusiveFileLock(join(root, 'auto-submit/.lock'), async () => {
        await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(' ')]), { mode: 0o600 });
      }, { provider, pathProfile: '3.12', signal: AbortSignal.timeout(50) }),
      error => error?.name === 'AbortError' || error?.name === 'TimeoutError');
    } });
    assert.equal(attempted, true);
  });
}

test('rollback holds both policy locks until retained and Python roots are in place', { timeout: 60000 }, async t => {
  const { active, candidate, provider } = await setup(t);
  await activateNativeWriter(active, candidate, { provider });
  let attempted = 0;
  await rollbackNativeWriter(active, { provider, boundary: async point => {
    if (point !== 'before-native-rename') return;
    for (const root of [active, `${active}.python-rollback`]) {
      attempted += 1;
      await assert.rejects(withExclusiveFileLock(join(root, 'auto-submit/.lock'), async () => {}, {
        provider, pathProfile: '3.12', signal: AbortSignal.timeout(50),
      }), error => error?.name === 'AbortError' || error?.name === 'TimeoutError');
    }
  } });
  assert.equal(attempted, 2);
});

test('activation serializes creation of a previously absent policy tree', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture(); t.after(fixture.cleanup);
  const parent = await realpath(fixture.root), active = join(parent, 'store'), candidate = `${active}.native-candidate`;
  await execute('python3', ['-c', python, active]);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  await prepareCanonicalStoreClone(active, candidate, provider, now);
  let mutation;
  await activateNativeWriter(active, candidate, { provider, boundary: async point => {
    if (point !== 'before-source-rename') return;
    let settled = false;
    mutation = new FinalActionPolicyService(active, deterministicOptions(provider)).activate(campaignInput)
      .finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(settled, false);
  } });
  await mutation;
  assert.equal((await stat(join(active, 'auto-submit'))).isDirectory(), true);
  await assert.rejects(stat(join(`${active}.python-rollback`, 'auto-submit')), { code: 'ENOENT' });
});
