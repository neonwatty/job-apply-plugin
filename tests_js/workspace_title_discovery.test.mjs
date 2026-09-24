import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { chromium } from 'playwright';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { spawnOwnedCompanion } from './workspace_next_process_support.mjs';
import { nativeTitleDiscoveryBrowser } from './workspace_native_title_discovery_browser_support.mjs';
const execute = promisify(execFile);
const repository = dirname(fileURLToPath(import.meta.url));
const buildRoot = dirname(repository);

test('Companion title discovery reviews, cancels, saves and retries conflicts against the Store', { timeout: 180000 }, async () => {
  await execute('npm', ['run', 'companion:build'], { cwd: buildRoot, timeout: 90000,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, maxBuffer: 2 * 1024 * 1024 });
  const fixture = await nativeFixture();
  const root = join(await realpath(fixture.root), 'titles');
  await initializeJobsFixture(root);
  const launcher = await spawnOwnedCompanion(buildRoot, root,
    ['--writer', 'native-fixture', '--native-lock', fixture.receipt.artifact],
    { leaseArtifact: fixture.receipt.artifact });
  let browser;
  try {
    const startup = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Companion startup timed out')), 30000);
      launcher.child.once('error', reject);
      launcher.child.once('exit', () => reject(Error('Companion exited before startup')));
      launcher.child.stdout.on('data', bytes => {
        output += bytes;
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(output.split('\n')[0])); } catch (failure) { reject(failure); }
      });
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', failure => errors.push(failure.message));
    await page.goto(startup.url);
    await page.getByRole('button', { name: 'Facts', exact: true }).click();
    await page.locator('#title-discovery').getByText('Saved now: No target titles yet.').waitFor();
    assert.deepEqual(await nativeTitleDiscoveryBrowser(page, root, fixture, buildRoot),
      { cancel: true, unavailable: true, exactSave: true, conflictRetry: true, canonicalReconciliation: true, factsDraft: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await launcher.stop();
    await fixture.cleanup();
  }
});
