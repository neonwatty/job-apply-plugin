import { openWorkspace, openWorkspaceMenu } from "./workspace_menu_support.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerBetaScenario, startOwnerBetaScenario, cleanupOwnerBetaScenario } from './workspace_owner_beta_scenario_support.mjs';

function syntheticPdf() {
  const content = 'BT /F1 20 Tf 50 700 Td (Synthetic resume preview) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('synthetic PDF has an authenticated browser preview', { timeout: 60_000 }, async () => {
  const context = await createOwnerBetaScenario();
  try {
    await startOwnerBetaScenario(context);
    const page = await context.browser.newPage();
    await page.goto(context.running.startup.url);
    await openWorkspace(page, "resumes");
    await page.locator('#resume-import input[name=label]').fill('Synthetic PDF');
    await page.locator('#resume-import input[type=file]').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
    await page.getByRole('button', { name: 'Import resume', exact: true }).click();
    const response = page.waitForResponse(response => response.url().endsWith('/content'));
    const popup = page.waitForEvent('popup');
    await page.locator('.resume-card').getByRole('button', { name: 'View PDF', exact: true }).click();
    const content = await response;
    assert.equal(content.status(), 200);
    assert.match(content.headers()['content-type'], /application\/pdf/);
    const preview = await popup;
    const fetched = await page.request.get(content.url(), { headers: await content.request().allHeaders() });
    assert.deepEqual(await fetched.body(), syntheticPdf());
    assert.equal((await page.request.get(content.url())).status(), 401);
    // Headless shell does not render Chrome's PDF viewer; owner visual acceptance is separate.
    await preview.close();
  } finally { await cleanupOwnerBetaScenario(context); }
});

for (const width of [1280, 390]) {
  test(`grouped navigation stays visible at ${width}px`, { timeout: 60_000 }, async () => {
    const context = await createOwnerBetaScenario();
    try {
      await startOwnerBetaScenario(context);
      const page = await context.browser.newPage({ viewport: { width, height: 844 } });
      await page.goto(context.running.startup.url);
      await openWorkspace(page, "facts");
      const tabs = await page.locator('#fact-group-nav').boundingBox();
      const readiness = await page.locator('#profile-readiness').boundingBox();
      assert.ok(tabs.y < readiness.y, 'fact sections precede advisory readiness');
      await page.getByRole('tab', { name: 'Identity & contact', exact: true }).click();
      await page.locator('[data-path="/firstName"]').fill('Unsaved synthetic draft');
      for (const section of ['overview', 'jobs', 'attention', 'resumes', 'answers', 'automation', 'trash', 'facts']) {
        await openWorkspaceMenu(page, section);
        await page.locator(`#nav-${section}`).focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator(`#${section}-workspace`).isVisible(), true);
      }
      assert.equal(await page.locator('[data-path="/firstName"]').inputValue(), 'Unsaved synthetic draft');
      await page.getByRole('tab', { name: 'Work history', exact: true }).click();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const navigation = await page.locator('.topbar').boundingBox();
      assert.ok(navigation.y >= 0 && navigation.y + navigation.height <= 844, 'header stays in viewport');
      await page.screenshot({ path: `/tmp/python-navigation-${width}.png` });
    } finally { await cleanupOwnerBetaScenario(context); }
  });
}
