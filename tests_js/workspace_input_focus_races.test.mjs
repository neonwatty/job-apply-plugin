import assert from 'node:assert/strict';
import test from 'node:test';
import { openWorkspace } from './workspace_menu_support.mjs';
import { createOwnerBetaScenario, startOwnerBetaScenario, cleanupOwnerBetaScenario } from './workspace_owner_beta_scenario_support.mjs';

test('late navigation loading does not take focus from an employer override draft', { timeout: 30_000 }, async () => {
  const context = await createOwnerBetaScenario();
  try {
    await startOwnerBetaScenario(context);
    const page = await context.browser.newPage();
    await page.goto(context.running.startup.url);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/account-operation', async route => { await gate; await route.continue(); });
    try {
      await openWorkspace(page, 'automation');
      await page.getByLabel('Exact employer portal URL').fill('https://acme.wd5.myworkdayjobs.com/en-US/jobs/one');
      await page.getByRole('button', { name: 'Add employer portal', exact: true }).click();
      const input = page.getByRole('form', { name: /Edit signup email override/ }).getByLabel('Signup email override');
      await input.fill('replacement@example.com');
      await page.evaluate(() => { document.querySelector('#account-operation-status').textContent = 'Waiting for controlled response'; });
      release();
      await page.getByText('No protected account operation is pending.', { exact: true }).waitFor();
      assert.equal(await input.evaluate(node => node === document.activeElement), true);
      await page.getByRole('button', { name: 'Save override', exact: true }).click();
      await page.getByText(/revision 2 · email override configured/).waitFor();
    } finally { release(); }
  } finally { await cleanupOwnerBetaScenario(context); }
});

test('answer dialog opening cannot redirect subsequent value input into its question', { timeout: 30_000 }, async () => {
  const context = await createOwnerBetaScenario();
  try {
    await startOwnerBetaScenario(context);
    const page = await context.browser.newPage();
    await page.addInitScript(() => {
      const timeout = globalThis.setTimeout;
      globalThis.answerFocusCallbacks = [];
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay === 0 && String(callback).includes('elements.question.focus')) {
          globalThis.answerFocusCallbacks.push(callback);
          return -1;
        }
        return timeout(callback, delay, ...args);
      };
    });
    await page.goto(context.running.startup.url);
    await openWorkspace(page, 'answers');
    await page.getByRole('button', { name: 'New answer', exact: true }).click();
    const dialog = page.locator('#answer-dialog');
    await dialog.getByLabel('Question', { exact: true }).fill('Synthetic focus question?');
    const value = dialog.getByLabel('Value', { exact: true });
    await value.focus();
    await page.evaluate(() => { for (const callback of globalThis.answerFocusCallbacks.splice(0)) callback(); });
    await page.keyboard.insertText('Synthetic focus value');
    assert.equal(await value.inputValue(), 'Synthetic focus value');
    await dialog.getByRole('button', { name: 'Save answer', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const answer = await context.cli('answer-find', ['--question', 'Synthetic focus question?', '--scope', '{}']);
    assert.equal(answer?.value, 'Synthetic focus value');
  } finally { await cleanupOwnerBetaScenario(context); }
});
