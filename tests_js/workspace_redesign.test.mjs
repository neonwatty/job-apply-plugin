import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerBetaScenario, startOwnerBetaScenario, cleanupOwnerBetaScenario } from './workspace_owner_beta_scenario_support.mjs';
import { openWorkspace, openWorkspaceMenu } from './workspace_menu_support.mjs';
for (const [width, colorScheme] of [[1280, "light"], [390, "light"], [1280, "dark"], [390, "dark"]]) {
  test(`compact menus and section focus at ${width} in ${colorScheme}`, { timeout: 60_000 }, async () => {
    const context = await createOwnerBetaScenario();
    try {
      await startOwnerBetaScenario(context);
      const page = await context.browser.newPage({ viewport: { width, height: 844 }, colorScheme });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(context.running.startup.url);
      assert.ok((await page.locator('.topbar').boundingBox()).height <= 58);
      if (width === 390) {
        await page.locator("#workspace-menu-toggle").click();
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#workspace-menu-toggle").getAttribute("aria-expanded"), "false");
      }
      await openWorkspaceMenu(page, 'facts');
      await page.locator('#nav-facts').focus();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#nav-group-application-data').getAttribute('aria-expanded'), 'false');
      for (const section of ['facts','resumes','answers','automation','trash','jobs','attention','overview']) {
        await openWorkspace(page, section);
        await page.locator(`#${section}-workspace .hero h2`).waitFor();
        await page.waitForFunction(name => document.activeElement === document.querySelector(`#${name}-workspace .hero h2`), section);
        assert.equal(await page.evaluate(() => window.scrollY), 0);
        assert.equal(await page.locator(`#nav-${section}`).getAttribute('aria-current'), 'page');
        assert.ok(await page.locator(`#${section}-workspace .hero h2`).evaluate(el => el === document.activeElement));
      }
      await openWorkspace(page, "facts");
      await page.getByRole("tab", {name:"Work history", exact:true}).click();
      assert.equal(await page.locator("#facts-title").innerText(), "Work history");
      assert.equal(await page.locator("#profile-readiness").isVisible(), false);
      await page.getByRole("tab", {name:"Identity & contact", exact:true}).click();
      await page.getByLabel("First name").fill("Unsaved draft");
      await page.getByRole("tab", {name:"Work history", exact:true}).click();
      await page.getByRole("button", {name:"View readiness", exact:true}).click();
      assert.equal(await page.locator("#readiness-dialog").isVisible(), true);
      assert.equal(Math.round((await page.locator("#readiness-dialog").boundingBox()).width), Math.min(480, width));
      await page.screenshot({animations:"disabled", path:`/tmp/readiness-drawer-${width}-${colorScheme}.png`});
      await page.keyboard.press("Escape");
      await page.locator("#readiness-dialog").waitFor({state:"hidden"});
      await page.getByRole("tab", {name:"Identity & contact", exact:true}).click();
      assert.equal(await page.getByLabel("First name").inputValue(), "Unsaved draft");
      await page.getByRole("tab", {name:"Work history", exact:true}).click();
      assert.equal(await page.locator("#facts-title").innerText(), "Work history");
      await page.getByRole("button", {name: colorScheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}).click();
      const selectedTheme = colorScheme === "dark" ? "light" : "dark";
      assert.equal(await page.locator("html").getAttribute("data-theme"), selectedTheme);
      await page.reload();
      assert.equal(await page.locator("html").getAttribute("data-theme"), selectedTheme);
      await page.getByRole("button", {name: selectedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}).click();
      await openWorkspaceMenu(page, "facts");
      await page.locator(".topbar h1").click();
      assert.equal(await page.locator("#nav-group-application-data").getAttribute("aria-expanded"), "false");
      const contrasts = await page.evaluate(() => {
        const luminance = value => {
          const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
            const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
          });
          return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
        };
        return ['.toast', '.segmented .active', '.skip-link'].map(selector => {
          const style = getComputedStyle(document.querySelector(selector));
          const a = luminance(style.color), b = luminance(style.backgroundColor);
          return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        });
      });
      assert.ok(contrasts.every(ratio => ratio >= 4.5), `text contrast: ${contrasts}`);
      assert.deepEqual(errors, []);
      await page.screenshot({path:`/tmp/ink-blue-${width}-${colorScheme}.png`});
    } finally { await cleanupOwnerBetaScenario(context); }
  });
}
