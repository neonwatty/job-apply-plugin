import assert from 'node:assert/strict';
import test from 'node:test';
import { openWorkspace } from './workspace_menu_support.mjs';
import { refreshJobsAndWait } from './workspace_refresh_support.mjs';
import { createOwnerBetaScenario, startOwnerBetaScenario, cleanupOwnerBetaScenario } from './workspace_owner_beta_scenario_support.mjs';

test('manual refresh completion waits for consumed state before retrying readiness', { timeout: 30_000 }, async () => {
  const context = await createOwnerBetaScenario();
  try {
    await startOwnerBetaScenario(context);
    await context.cli('job-create', [], { id: 'refresh-job', role: 'Refresh Engineer', url: 'https://example.invalid/refresh' });
    const page = await context.browser.newPage();
    await page.addInitScript(() => {
      globalThis.setInterval = () => 1;
      const json = Response.prototype.json;
      Response.prototype.json = async function (...args) {
        const data = await json.apply(this, args);
        if (globalThis.holdState && new URL(this.url).pathname === '/api/state') {
          globalThis.stateBodyHeld = true;
          await new Promise(resolve => { globalThis.releaseState = resolve; });
        }
        return data;
      };
    });
    await page.goto(context.running.startup.url);
    await openWorkspace(page, 'jobs');
    await page.getByRole('button', { name: /Refresh Engineer/ }).click();
    await refreshJobsAndWait(page);
    await page.evaluate(() => { globalThis.holdState = true; });
    let preflightRequests = 0;
    page.on("request", request => { if (request.url().endsWith("/preflight")) preflightRequests++; });
    let completed = false;
    const refreshed = refreshJobsAndWait(page).then(() => { completed = true; });
    await page.waitForFunction(() => globalThis.stateBodyHeld);
    try {
      assert.equal(completed, false, 'headers must not count as completed refresh');
      await page.getByRole('button', { name: 'Run ready check', exact: true }).click();
      assert.equal(preflightRequests, 0, 'readiness is rejected while state consumption is pending');
      assert.equal(await page.locator('#preflight-panel').isVisible(), false);
    } finally {
      await page.evaluate(() => { globalThis.holdState = false; globalThis.releaseState(); });
      await refreshed;
    }
    await page.getByRole('button', { name: 'Run ready check', exact: true }).click();
    await page.getByText('Assign an active resume', { exact: true }).waitFor();
  } finally { await cleanupOwnerBetaScenario(context); }
});
