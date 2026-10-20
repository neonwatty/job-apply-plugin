import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { openWorkspace } from './workspace_menu_support.mjs';
import { minimalSyntheticPdf } from './workspace_test_support.mjs';
import { createOwnerBetaScenario, startOwnerBetaScenario, cleanupOwnerBetaScenario } from './workspace_owner_beta_scenario_support.mjs';

test('poll revalidates a Saved job without removing its result or scrolling, and revokes changed dependencies', { timeout: 60_000 }, async () => {
  const context = await createOwnerBetaScenario();
  try {
    await startOwnerBetaScenario(context);
    const profile = await context.cli('profile-inspect');
    await context.cli('profile-replace', ['--expected-revision', String(profile.revision), '--source', 'user'], { firstName: 'Synthetic' });
    const path = join(context.temporary, 'synthetic.pdf');
    await writeFile(path, minimalSyntheticPdf());
    const resume = await context.cli('resume-create', [], { id: 'poll-resume', label: 'Synthetic', path });
    await context.cli('job-create', [], { id: 'poll-job', url: 'https://example.invalid/jobs/poll', role: 'Poll Engineer' });
    const page = await context.browser.newPage();
    await page.addInitScript(() => {
      globalThis.setInterval = (callback, delay) => {
        if (delay === 4000) globalThis.pollWorkspace = callback;
        return 1;
      };
      globalThis.resultScrolls = 0;
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args) {
        if (this.id === 'preflight-panel') globalThis.resultScrolls++;
        return original.apply(this, args);
      };
    });
    await page.goto(context.running.startup.url);
    await openWorkspace(page, 'jobs');
    await page.getByRole('button', { name: /Poll Engineer/ }).click();
    await page.getByRole('button', { name: 'Run ready check', exact: true }).click();
    const mark = page.locator('#mark-ready');
    await mark.waitFor();
    assert.equal(await mark.isEnabled(), true);
    const scrolls = await page.evaluate(() => globalThis.resultScrolls);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/state', async route => { await gate; await route.continue(); });
    try {
      const requested = page.waitForRequest(request => request.url().endsWith('/api/state'));
      await page.evaluate(() => { globalThis.pendingPoll = globalThis.pollWorkspace(); });
      await requested;
      assert.equal(await page.locator('#preflight-panel').isVisible(), true);
      assert.equal(await mark.isVisible(), true);
      assert.equal(await mark.isDisabled(), true);
      release();
      await page.evaluate(() => globalThis.pendingPoll);
    } finally { release(); await page.unroute('**/api/state'); }
    assert.equal(await mark.isEnabled(), true);
    assert.equal(await mark.isVisible(), true);
    await page.evaluate(() => globalThis.pollWorkspace());
    assert.equal(await mark.isEnabled(), true);
    assert.equal(await page.evaluate(() => globalThis.resultScrolls), scrolls);
    await page.route('**/api/state', route => route.abort());
    await page.evaluate(() => globalThis.pollWorkspace());
    assert.equal(await mark.isVisible(), true);
    assert.equal(await mark.isDisabled(), true);
    await page.getByText('Could not verify current data. Run ready check after reconnecting.', { exact: true }).waitFor();
    await page.unroute('**/api/state');
    await page.evaluate(() => globalThis.pollWorkspace());
    assert.equal(await mark.isEnabled(), true);
    // Job revision remains unchanged; only the managed file disappears.
    const resolved = await context.cli('resume-resolve', ['--id', resume.id]);
    await unlink(resolved.path);
    await page.evaluate(() => globalThis.pollWorkspace());
    assert.equal(await mark.isVisible(), false);
    await page.getByText('The resume file cannot be found', { exact: true }).waitFor();
    assert.equal((await context.cli('job-get', ['--id', 'poll-job'])).revision, 1);
  } finally { await cleanupOwnerBetaScenario(context); }
});
