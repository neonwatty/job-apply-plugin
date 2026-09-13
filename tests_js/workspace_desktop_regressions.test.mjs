import assert from 'node:assert/strict';
import test from 'node:test';
import { openWorkspace } from './workspace_menu_support.mjs';
import { createOwnerBetaScenario, startOwnerBetaScenario, cleanupOwnerBetaScenario } from './workspace_owner_beta_scenario_support.mjs';

test('desktop facts can save then restore work and skills without a false conflict', { timeout: 60_000 }, async () => {
  const context = await createOwnerBetaScenario();
  try {
    await context.cli('profile-replace', ['--expected-revision', '0', '--source', 'resume'], {
      firstName: 'Synthetic', skills: ['Python'],
      workHistory: [{ title: 'Engineer', company: 'Example', description: 'Original' }],
    });
    await startOwnerBetaScenario(context);
    const page = await context.browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(context.running.startup.url);
    await openWorkspace(page, 'facts');
    for (const [description, skills, revision] of [['Updated', 'Python\nJavaScript', 2], ['Original', 'Python', 3]]) {
      await page.getByRole('tab', { name: 'Work history', exact: true }).click();
      await page.getByLabel('Description, item 1', { exact: true }).fill(description);
      await page.getByRole('tab', { name: 'Skills', exact: true }).click();
      await page.locator('[data-path="/skills"]').fill(skills);
      await openWorkspace(page, 'answers');
      await openWorkspace(page, 'facts');
      if (revision === 2) await page.keyboard.press('ControlOrMeta+s');
      else await page.locator('#facts-save').click();
      await page.waitForFunction(() => !document.querySelector('#facts-save').disabled);
      assert.equal(await page.locator('#facts-conflict').isVisible(), false, `unexpected conflict saving revision ${revision}`);
      const saved = await context.cli('profile-inspect');
      assert.equal(saved.revision, revision);
      assert.equal(saved.profile.workHistory[0].description, description);
      assert.deepEqual(saved.profile.skills, skills.split('\n'));
    }
    await page.getByRole('tab', { name: 'Work history', exact: true }).click();
    await page.getByRole('button', { name: 'Add promotion after position 1', exact: true }).click();
    await page.getByLabel('Title, item 2', { exact: true }).fill('Senior Engineer');
    await page.getByLabel('Description, item 2', { exact: true }).fill('Promoted');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Copy description from position 2 to other roles at this company', exact: true }).click();
    await page.locator('#facts-save').click();
    await page.waitForFunction(() => !document.querySelector('#facts-save').disabled);
    assert.equal(await page.locator('#facts-conflict').isVisible(), false);
    const promoted = await context.cli('profile-inspect');
    assert.equal(promoted.revision, 4);
    assert.equal(promoted.profile.workHistory.length, 2);
    assert.ok(promoted.profile.workHistory.every(role => role.description === 'Promoted'));
    await page.getByLabel('Description, item 1', { exact: true }).fill('My draft');
    const concurrent = structuredClone(promoted.profile.workHistory);
    concurrent[0].description = 'Concurrent writer';
    await context.cli('profile-patch', ['--expected-revision', '4', '--source', 'user'], { workHistory: concurrent });
    await page.locator('#facts-save').click();
    await page.locator('#facts-conflict').waitFor();
    assert.equal(await page.getByLabel('Description, item 1', { exact: true }).inputValue(), 'My draft');
    const conflicted = await context.cli('profile-inspect');
    assert.equal(conflicted.revision, 5);
    assert.equal(conflicted.profile.workHistory[0].description, 'Concurrent writer');
  } finally { await cleanupOwnerBetaScenario(context); }
});

test('desktop TXT preview restores focus after Escape', { timeout: 60_000 }, async () => {
  const context = await createOwnerBetaScenario();
  try {
    await startOwnerBetaScenario(context);
    const page = await context.browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(context.running.startup.url);
    await openWorkspace(page, 'resumes');
    await page.locator('#resume-import input[name=label]').fill('Synthetic TXT');
    await page.locator('#resume-import input[type=file]').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic resume') });
    await page.getByRole('button', { name: 'Import resume', exact: true }).click();
    const opener = page.getByRole('button', { name: 'Preview text', exact: true });
    await opener.click();
    await page.locator('#preview-dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#preview-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.matches('[data-resume-preview]'), { }, { timeout: 3000 });
    assert.equal(await opener.evaluate(node => node === document.activeElement), true);
    await opener.click();
    await page.locator('#preview-dialog').waitFor();
    const original = await opener.elementHandle();
    await page.evaluate(() => document.querySelector('#resumes-refresh').click());
    await page.waitForFunction(node => !node.isConnected, original);
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.matches('[data-resume-preview]'));
    assert.equal(await opener.evaluate(node => node === document.activeElement), true);
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    const details = page.locator('#resume-dialog');
    await details.locator('input[name=label]').fill('Unsaved label');
    await details.getByRole('button', { name: 'Preview text', exact: true }).click();
    await page.locator('#preview-dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.id === 'resume-content');
    assert.equal(await details.locator('input[name=label]').inputValue(), 'Unsaved label');

  } finally { await cleanupOwnerBetaScenario(context); }
});

test('conflict comparison ignores object order but preserves real collection changes', async () => {
  const { equalJson, conflictingPaths } = await import('../companion/workspace/lib/helpers.js');
  const original = { company: 'Example', description: 'Original', details: { z: 1, a: 2 } };
  const reordered = { details: { a: 2, z: 1 }, description: 'Original', company: 'Example' };
  const base = new Map([['/workHistory', [original]]]);
  const drafts = new Map([['/workHistory', [{ ...original, description: 'Mine' }]]]);
  assert.deepEqual(conflictingPaths(base, { workHistory: [reordered] }, drafts), []);
  assert.deepEqual(conflictingPaths(base, { workHistory: [{ ...reordered, description: 'Agent update' }] }, drafts), ['/workHistory']);
  assert.equal(equalJson([original, reordered], [reordered, original]), true);
  assert.equal(equalJson([1, 2], [2, 1]), false);
  assert.equal(equalJson(null, undefined), false);
  assert.equal(equalJson({}, { extra: null }), false);
});
