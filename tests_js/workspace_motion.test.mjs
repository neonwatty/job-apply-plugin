import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerBetaScenario, startOwnerBetaScenario, cleanupOwnerBetaScenario } from './workspace_owner_beta_scenario_support.mjs';
import { openWorkspace } from './workspace_menu_support.mjs';
for (const reducedMotion of ['no-preference', 'reduce']) {
  test(`readiness backdrop dismissal and motion: ${reducedMotion}`, async () => {
    const context = await createOwnerBetaScenario();
    try {
      await startOwnerBetaScenario(context);
      const page = await context.browser.newPage({viewport:{width:1280,height:844}, reducedMotion});
      await page.goto(context.running.startup.url);
      await openWorkspace(page, 'facts');
      const drawer = page.locator('#readiness-dialog');
      await page.getByRole('button', {name:'View readiness',exact:true}).click();
      await drawer.getByRole('heading', {name:'Profile readiness',exact:true}).click();
      assert.equal(await drawer.isVisible(), true);
      await page.mouse.click(20, 400);
      await drawer.waitFor({state:'hidden',timeout:2000});
      assert.equal(await page.locator('#view-readiness').evaluate(el => el === document.activeElement), true);
      await page.getByRole('button', {name:'View readiness',exact:true}).click();
      await page.keyboard.press('Escape');
      await drawer.waitFor({state:'hidden',timeout:2000});
      await page.getByRole('button', {name:'View readiness',exact:true}).click();
      await page.getByRole('button', {name:'Close profile readiness',exact:true}).click();
      await drawer.waitFor({state:'hidden',timeout:2000});
      await page.locator('#readiness-home #profile-readiness').waitFor({state:'attached'});
    } finally { await cleanupOwnerBetaScenario(context); }
  });
}
