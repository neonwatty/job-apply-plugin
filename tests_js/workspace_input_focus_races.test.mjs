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

for (const lateFailure of [false, true]) {
  test(`older automation ${lateFailure ? 'failure' : 'refresh'} cannot replace an employer override draft`, { timeout: 30_000 }, async () => {
    const context = await createOwnerBetaScenario();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
      await startOwnerBetaScenario(context);
      const page = await context.browser.newPage();
      await page.addInitScript(() => {
        const fetch = globalThis.fetch;
        let firstAutomation = true;
        globalThis.fetch = async (...args) => {
          const first = firstAutomation && String(args[0]).endsWith('/api/automation');
          if (first) firstAutomation = false;
          const response = await fetch(...args);
          if (first) {
            const json = response.json.bind(response);
            response.json = async () => {
              const payload = await json();
              setTimeout(() => { globalThis.initialAutomationConsumed = true; }, 0);
              return payload;
            };
          }
          return response;
        };
      });
      await page.goto(context.running.startup.url);
      let first = true;
      let delivered;
      const delivery = new Promise(resolve => { delivered = resolve; });
      await page.route('**/api/automation', async route => {
        if (!first) return route.continue();
        first = false;
        await gate;
        if (lateFailure) {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Obsolete load failure' } }) });
        } else {
          const response = await route.fetch();
          await route.fulfill({ response });
        }
        delivered();
      });
      await openWorkspace(page, 'automation');
      await page.getByLabel('Exact employer portal URL').fill('https://acme.wd5.myworkdayjobs.com/en-US/jobs/one');
      await page.getByLabel('Optional signup email override').fill('realm@example.com');
      await page.getByRole('button', { name: 'Add employer portal', exact: true }).click();
      const input = page.getByRole('form', { name: /Edit signup email override/ }).getByLabel('Signup email override');
      await input.fill('replacement@example.com');
      // A late initial load must neither detach the draft nor reset its value.
      await input.evaluate(node => { globalThis.originalOverrideInput = node; });
      release();
      await delivery;
      // Wait for the initial refresh continuation, not merely response headers.
      await page.waitForFunction(() => globalThis.initialAutomationConsumed);
      assert.equal(await input.inputValue(), 'replacement@example.com');
      assert.equal(await input.evaluate(node => node === globalThis.originalOverrideInput), true);
      assert.equal(await page.locator('#automation-error').isVisible(), false);
      await page.getByRole('button', { name: 'Save override', exact: true }).click();
      await page.getByText(/revision 2 · email override configured/).waitFor();
      const account = (await context.cli('employer-account-list'))[0];
      assert.equal(account.signupEmailOverrideConfigured, true);
      assert.equal(account.revision, 2);
      assert.equal(await page.locator('#automation-error').isVisible(), false);
    } finally {
      release();
      await cleanupOwnerBetaScenario(context);
    }
  });
}
