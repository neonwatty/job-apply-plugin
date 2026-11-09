import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, readFile, truncate, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, reportRoot, snapshot, plain } from './workspace_native_legacy_jobs_support.mjs';
import { discoverLegacyJobs } from '../runtime/store/legacy-job-discovery.js';
import { loadPosixDirectoryProvider } from '../runtime/store/posix-directory.js';

test('legacy preview and commit reject pending recovery without overwriting jobs or journals', async () => {
  const fixture = await nativeFixture();
  try {
    const f = await setup(fixture,'pending');
    const discovery = plain(await f.service.preview([])), selected = [discovery.items[0].itemId];
    const preview = plain(await f.service.preview(selected));
    for (const name of ['resume-operation.json','resume-extraction-journal.json','coordinator-journal.json']) {
      const path = join(f.root,name), original = await readFile(path,'utf8');
      const pending = JSON.stringify({schemaVersion:1,operation:{kind:'pending'}});
      await writeFile(path,pending);
      const before = await snapshot(f.root);
      await assert.rejects(f.service.preview(selected),/requires completed fixture recovery/);
      await assert.rejects(f.service.commit(selected,preview.token),/requires completed fixture recovery/);
      assert.equal(await snapshot(f.root),before);
      assert.equal(await readFile(path,'utf8'),pending);
      await writeFile(path,original);
    }
  } finally { await fixture.cleanup(); }
});

test('legacy discovery rejects entry replacement between inspection and open', async () => {
  const fixture = await nativeFixture();
  try {
    const f = await setup(fixture,'replacement');
    const provider = loadPosixDirectoryProvider(fixture.receipt.artifact);
    const file = join(f.home,reportRoot,'search-2026-09-10.md');
    const originalInspect = provider.inspect;
    let swapped = false;
    // Synchronous native callbacks let this interleaving replace the inspected inode.
    const {renameSync,writeFileSync} = await import('node:fs');
    provider.inspect = (fd,name) => {
      const value = originalInspect(fd,name);
      if (!swapped) {swapped=true;renameSync(file,file+'.old');writeFileSync(file,'replacement');}
      return value;
    };
    await assert.rejects(discoverLegacyJobs(f.home,provider),/changed during discovery/);
  } finally { await fixture.cleanup(); }
});

test('legacy discovery enforces source byte and file bounds before parsing', async () => {
  const fixture = await nativeFixture();
  try {
    const f = await setup(fixture,'limits'), provider = loadPosixDirectoryProvider(fixture.receipt.artifact);
    const file = join(f.home,reportRoot,'search-2026-09-10.md');
    await truncate(file,2*1024*1024+1);
    await assert.rejects(discoverLegacyJobs(f.home,provider),/per-file byte limit/);
    await writeFile(file,'');
    provider.listNames = () => Array.from({length:101},(_,index)=>Buffer.from(`search-${index}.md`));
    await assert.rejects(discoverLegacyJobs(f.home,provider),/file limit/);
    const root = join(f.home,reportRoot);
    await rename(root,root+'-moved'); await symlink(root+'-moved',root);
    await assert.rejects(discoverLegacyJobs(f.home,provider),/root must be a regular directory/);
  } finally { await fixture.cleanup(); }
});


test('legacy discovery ignores unrelated undecodable filename bytes before decoding report names', async () => {
  const fixture = await nativeFixture();
  try {
    const f = await setup(fixture,'filename-bytes'), provider = loadPosixDirectoryProvider(fixture.receipt.artifact);
    const expected = plain(await discoverLegacyJobs(f.home,provider));
    const original = provider.listNames;
    provider.listNames = fd => [...original(fd),Buffer.from([0xff]),Buffer.from([0x78,0xff,0x2e,0x6d,0x64])];
    assert.deepEqual(plain(await discoverLegacyJobs(f.home,provider)),expected);
  } finally { await fixture.cleanup(); }
});
