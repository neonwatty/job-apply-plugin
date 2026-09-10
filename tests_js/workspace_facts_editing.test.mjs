import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerBetaScenario, startOwnerBetaScenario, cleanupOwnerBetaScenario } from './workspace_owner_beta_scenario_support.mjs';

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`Facts tabs, promotion drafts and sticky Save at ${viewport.width}px`, { timeout: 60_000 }, async () => {
    const context = await createOwnerBetaScenario();
    try {
      await context.cli('profile-replace', ['--expected-revision', '0', '--source', 'user'], {
        firstName: 'Synthetic', skills: ['Python'],
        workHistory: [
          { company: 'Example Co', title: 'Engineer', startDate: '2020', endDate: '2022', description: 'Original description', extraField: 'preserved' },
          { company: 'Example Co', title: 'Senior Engineer', startDate: '2022', endDate: '2024', description: 'Second description' },
          { company: 'Other Co', title: 'Lead', description: 'Other company description' },
        ], education: [{ school: 'Example University', degree: 'BS' }],
      });
      await startOwnerBetaScenario(context);
      const page = await context.browser.newPage({ viewport });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(context.running.startup.url);
      await page.getByRole('button', { name: 'Facts', exact: true }).click();
      await page.locator('[data-path="/firstName"]').waitFor();
      await page.getByRole('tab', { name: 'Work history', exact: true }).click();
      await page.locator('#fact-group-nav').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/python-facts-tabs-${viewport.width}.png` });
      const work = page.locator('#work-history');
      await work.getByLabel('Description, item 1', { exact: true }).fill('Shared company work\nWith a second paragraph');
      await page.getByRole('tab', { name: 'Work history', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.getByRole('tab', { name: 'Education', exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(await work.isVisible(), false);
      await page.getByRole('tab', { name: 'Skills', exact: true }).click();
      await page.locator('[data-path="/skills"]').fill('Python\nTypeScript');
      await page.getByRole('tab', { name: 'Work history', exact: true }).click();
      assert.equal(await work.getByLabel('Description, item 1', { exact: true }).inputValue(), 'Shared company work\nWith a second paragraph');
      await work.getByRole('button', { name: 'Add promotion after position 1', exact: true }).click();
      const promotedTitle = work.getByLabel('Title, item 2', { exact: true });
      assert.equal(await promotedTitle.evaluate(el => el === document.activeElement), true);
      await promotedTitle.fill('Staff Engineer');
      assert.equal(await work.getByLabel('Company, item 2', { exact: true }).inputValue(), 'Example Co');
      assert.equal(await work.getByLabel('Start date, item 2', { exact: true }).inputValue(), '');
      const share = work.getByRole('button', { name: 'Copy description from position 1 to other roles at this company', exact: true });
      page.once('dialog', dialog => dialog.dismiss()); await share.click();
      assert.equal(await work.getByLabel('Description, item 3', { exact: true }).inputValue(), 'Second description');
      page.once('dialog', dialog => dialog.accept()); await share.click();
      assert.equal(await work.getByLabel('Description, item 3', { exact: true }).inputValue(), 'Shared company work\nWith a second paragraph');
      assert.equal(await work.getByLabel('Description, item 4', { exact: true }).inputValue(), 'Other company description');
      await page.evaluate(() => window.scrollTo(0, document.querySelector('#work-history').getBoundingClientRect().top + scrollY + 350));
      const save = page.locator('#facts-save');
      const box = await save.boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, JSON.stringify(box));
      assert.equal(await save.isEnabled(), true);
      await page.screenshot({ path: `/tmp/python-facts-ux-${viewport.width}.png` });
      const saved = page.waitForResponse(response => response.url().endsWith('/api/profile') && response.request().method() === 'PATCH');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
      assert.equal((await saved).status(), 200);
      const profile = await context.cli('profile-get');
      assert.deepEqual(profile.skills, ['Python', 'TypeScript']);
      assert.equal(profile.workHistory.length, 4);
      assert.equal(profile.workHistory[0].extraField, 'preserved');
      assert.equal(profile.workHistory[1].title, 'Staff Engineer');
      assert.equal(profile.workHistory[2].startDate, '2022');
      assert.equal(profile.workHistory[3].description, 'Other company description');
      assert.deepEqual(errors, []);
    } finally { await cleanupOwnerBetaScenario(context); }
  });
}
