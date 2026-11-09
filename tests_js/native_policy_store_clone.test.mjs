import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, link, lstat, mkdir, readFile, readdir, realpath, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { authorization, campaignInput, deterministicOptions, now } from './final_action_policy_support.mjs';
import { prepareCanonicalStoreClone } from '../runtime/store/native-store-clone.js';
import { FinalActionPolicyService } from '../runtime/final-action-policy/service.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';

const execute = promisify(execFile);
const python = `
import sys,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('clone_reference','scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.utc_now=lambda:'${now}'
s=m.Store(Path(sys.argv[1]));s.initialize()
`;

async function sourceAt(root, name) {
  const source = join(root, name);
  await execute('python3', ['-c', python, source]);
  return source;
}

async function policyTree(root) {
  const result = {};
  async function visit(relative) {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const child = join(relative, name), metadata = await lstat(join(root, child));
      result[child] = metadata.isDirectory()
        ? { type: 'directory', mode: metadata.mode & 0o777 }
        : { type: 'file', mode: metadata.mode & 0o777, bytes: await readFile(join(root, child), 'base64') };
      if (metadata.isDirectory()) await visit(child);
    }
  }
  await visit('auto-submit');
  return result;
}

const pythonPolicy = `
import os,runpy,sys
os.umask(0o022)
sys.argv=['scripts/job_apply_policy.py',*sys.argv[1:]]
runpy.run_path('scripts/job_apply_policy.py',run_name='__main__')
`;

async function policyCommand(source, root, name, command, input) {
  const args = ['-c', pythonPolicy, '--root', source, command];
  if (input) {
    const path = join(root, `${name}.json`);
    await writeFile(path, JSON.stringify(input), { mode: 0o600 });
    args.push('--input', path);
  }
  await execute('python3', args);
}

async function populatedPolicy(source, root) {
  await policyCommand(source, root, 'activate-one', 'activate', campaignInput);
  await policyCommand(source, root, 'revoke', 'revoke');
  await policyCommand(source, root, 'activate-two', 'activate', campaignInput);
  await policyCommand(source, root, 'authorize', 'authorize', authorization);
}

test('canonical clone copies the complete policy tree byte-for-byte and it remains readable', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture(); t.after(fixture.cleanup);
  const root = await realpath(fixture.root), provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const source = await sourceAt(root, 'source'), target = join(root, 'target');
  await populatedPolicy(source, root);
  assert.equal((await stat(join(source, 'auto-submit/applications'))).mode & 0o777, 0o755);
  await writeFile(join(source, 'auto-submit/receipts.jsonl'), '{"receipt":"exact bytes"}\n', { mode: 0o600 });
  const before = await policyTree(source);
  for (const relative of ['auto-submit/.lock', 'auto-submit/campaign.json', 'auto-submit/campaigns',
    'auto-submit/applications', 'auto-submit/receipts.jsonl']) assert.ok(before[relative], relative);
  assert.ok(Object.keys(before).some(relative => /^auto-submit\/campaigns\/[0-9a-f]{64}\.json$/.test(relative)));
  assert.ok(Object.keys(before).some(relative => /^auto-submit\/applications\/[0-9a-f]{64}\/[0-9a-f]{64}\.json$/.test(relative)));
  await prepareCanonicalStoreClone(source, target, provider, now);
  const after = await policyTree(target);
  const content = tree => Object.fromEntries(Object.entries(tree).map(([path, entry]) =>
    [path, { type: entry.type, bytes: entry.bytes }]));
  assert.deepEqual(content(after), content(before));
  for (const entry of Object.values(after)) assert.equal(entry.mode, entry.type === 'directory' ? 0o700 : 0o600);
  const campaignId = JSON.parse(await readFile(join(source, 'auto-submit/campaign.json'), 'utf8')).campaignId;
  assert.deepEqual(await new FinalActionPolicyService(target, deterministicOptions(provider)).status(), {
    mode: 'auto_submit', reason: 'active_campaign', campaignId,
  });
});

test('a missing policy tree remains valid and is not created by cloning', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture(); t.after(fixture.cleanup);
  const root = await realpath(fixture.root), provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const source = await sourceAt(root, 'source'), target = join(root, 'target');
  await prepareCanonicalStoreClone(source, target, provider, now);
  await assert.rejects(stat(join(target, 'auto-submit')), { code: 'ENOENT' });
});

async function invalidCase(t, label, mutate) {
  await t.test(label, { timeout: 60000 }, async () => {
    const fixture = await nativeFixture();
    try {
      const root = await realpath(fixture.root), provider = loadPosixFlockProvider(fixture.receipt.artifact);
      const source = await sourceAt(root, 'source'), target = join(root, 'target');
      await mkdir(join(source, 'auto-submit'), { mode: 0o700 });
      await writeFile(join(source, 'auto-submit/.lock'), '', { mode: 0o600 });
      await mutate(source);
      await assert.rejects(prepareCanonicalStoreClone(source, target, provider, now), /policy|unsupported|private|bounded/);
      await assert.rejects(stat(target), { code: 'ENOENT' });
    } finally { await fixture.cleanup(); }
  });
}

test('canonical clone rejects unsafe or unbounded policy trees without leaving a target', { timeout: 180000 }, async t => {
  const campaign = source => join(source, 'auto-submit/campaign.json');
  await invalidCase(t, 'symlink', async source => symlink(join(source, 'jobs.json'), campaign(source)));
  await invalidCase(t, 'hard link', async source => link(join(source, 'jobs.json'), campaign(source)));
  await invalidCase(t, 'FIFO', async source => execute('mkfifo', [campaign(source)]));
  await invalidCase(t, 'loose file permissions', async source => writeFile(campaign(source), '{}', { mode: 0o644 }));
  await invalidCase(t, 'loose policy root permissions', async source => chmod(join(source, 'auto-submit'), 0o755));
  await invalidCase(t, 'writable structural directory permissions', async source => {
    const directory = join(source, 'auto-submit/campaigns');
    await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o770);
  });
  await invalidCase(t, 'stale temporary file', async source => writeFile(join(source, 'auto-submit/.campaign.json.dead.tmp'), '', { mode: 0o600 }));
  await invalidCase(t, 'unknown name', async source => writeFile(join(source, 'auto-submit/notes.txt'), '', { mode: 0o600 }));
  await invalidCase(t, 'malformed campaign archive name', async source => {
    await mkdir(join(source, 'auto-submit/campaigns'), { mode: 0o700 });
    await writeFile(join(source, 'auto-submit/campaigns/not-a-reference.json'), '', { mode: 0o600 });
  });
  await invalidCase(t, 'malformed application path', async source => {
    const path = join(source, `auto-submit/applications/${'1'.repeat(64)}/not-a-reference.json`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, '', { mode: 0o600 });
  });
  await invalidCase(t, 'excessive depth', async source => {
    const path = join(source, `auto-submit/applications/${'1'.repeat(64)}/${'2'.repeat(64)}.json/extra`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, '', { mode: 0o600 });
  });
  await invalidCase(t, 'oversized file', async source => {
    await writeFile(campaign(source), '', { mode: 0o600 });
    await truncate(campaign(source), 16 * 1024 * 1024 + 1);
  });
  await invalidCase(t, 'excessive aggregate bytes', async source => {
    await mkdir(join(source, 'auto-submit/campaigns'), { mode: 0o700 });
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      const path = join(source, `auto-submit/campaigns/${String(ordinal).padStart(64, '0')}.json`);
      await writeFile(path, '', { mode: 0o600 }); await truncate(path, 12 * 1024 * 1024);
    }
  });
  await invalidCase(t, 'excessive entry count', async source => {
    const directory = join(source, 'auto-submit/campaigns');
    await mkdir(directory, { mode: 0o700 });
    for (let start = 0; start < 4097; start += 128) {
      await Promise.all(Array.from({ length: Math.min(128, 4097 - start) }, (_, offset) =>
        writeFile(join(directory, (start + offset).toString(16).padStart(64, '0') + '.json'), '', { mode: 0o600 })));
    }
  });
});
