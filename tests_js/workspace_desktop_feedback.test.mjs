import assert from 'node:assert/strict';
import test from 'node:test';
import { openWorkspace } from './workspace_menu_support.mjs';
import { createOwnerBetaScenario, startOwnerBetaScenario, cleanupOwnerBetaScenario } from './workspace_owner_beta_scenario_support.mjs';

test('desktop readiness refresh explains invalidation and final trash restore keeps focus', { timeout: 60_000 }, async () => {
  const context = await createOwnerBetaScenario();
  try {
    await startOwnerBetaScenario(context);
    const page = await context.browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(context.running.startup.url);
    await openWorkspace(page, 'jobs');
    await page.getByRole('button', { name: 'New job', exact: true }).click();
    const dialog = page.locator('#job-dialog');
    await dialog.getByLabel('Job URL', { exact: true }).fill('https://example.invalid/jobs/feedback');
    await dialog.getByLabel('Role', { exact: true }).fill('Feedback Engineer');
    await dialog.getByRole('button', { name: 'Save job', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: /Feedback Engineer/ }).click();
    await dialog.getByRole('button', { name: 'Run ready check', exact: true }).click();
    await page.locator('#preflight-panel').waitFor();
    await page.screenshot({ path: '/tmp/desktop-feedback-readiness.png' });
    // A canonical refresh invalidates proof, but must leave an explanation.
    await page.evaluate(() => document.querySelector('#refresh').click());
    await page.waitForResponse(response => response.url().endsWith('/api/state'));
    await page.getByText('Workspace data refreshed. Run ready check again to see current results.', { exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await page.locator('#mark-ready').isVisible(), false);
    let releaseRefresh;
    const gate = new Promise(resolve => { releaseRefresh = resolve; });
    await page.route('**/api/state', async route => { await gate; await route.continue(); });
    try {
      const requested = page.waitForRequest(request => request.url().endsWith('/api/state'));
      await page.evaluate(() => document.querySelector('#refresh').click());
      await requested;
      await dialog.getByRole('button', { name: 'Run ready check', exact: true }).click();
      await page.getByText('Workspace data is refreshing. Run ready check again when it finishes.', { exact: true }).waitFor();
      const refreshed = page.waitForResponse(response => response.url().endsWith('/api/state'));
      releaseRefresh();
      await refreshed;
    } finally {
      releaseRefresh();
      await page.unroute('**/api/state');
    }
    await dialog.getByRole('button', { name: 'Run ready check', exact: true }).click();
    await page.locator('#preflight-panel').waitFor();
    assert.equal(await page.locator('#form-error').isVisible(), false);
    assert.equal(await page.locator('#ready-check-status').textContent(), '');

    page.once('dialog', dialog => dialog.accept());
    await page.locator('#trash-job').click();
    await dialog.waitFor({ state: 'hidden' });
    await openWorkspace(page, 'trash');
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.locator('#trash-empty').waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'trash-refresh', null, { timeout: 3000 });
    const answer = await context.cli('answer-put', [], { question: 'Synthetic restore?', state: 'confirmed', value: 'Synthetic' });
    await context.cli('answer-trash', ['--key', answer.key, '--expected-revision', String(answer.revision)]);
    await page.locator('#trash-refresh').click();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.locator('#trash-empty').waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'trash-refresh', null, { timeout: 3000 });
    await openWorkspace(page, 'answers');
    await page.locator('#answer-view').selectOption('trash');
    await page.getByRole('heading', { name: 'No answers in Trash', exact: true }).waitFor();
    assert.match(await page.locator('#answers-empty').innerText(), /previous view.*Library, Observed inbox, or Declined/);
    await page.locator('#answer-view').selectOption('accepted');
    await page.locator('#answer-search').fill('No matching synthetic answer');
    await page.getByRole('heading', { name: 'No matching answers', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    assert.equal(await page.locator('#answer-search').inputValue(), '');
    await openWorkspace(page, 'automation');
    assert.equal(await page.locator('#trusted-fill-form').isVisible(), false);
    await page.getByText('Review agent-provided permission details', { exact: true }).click();
    assert.equal(await page.locator('#trusted-fill-form').isVisible(), true);
    await page.screenshot({ path: '/tmp/desktop-feedback-automation.png' });
  } finally { await cleanupOwnerBetaScenario(context); }
});
