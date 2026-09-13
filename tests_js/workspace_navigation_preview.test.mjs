import { openWorkspace, openWorkspaceMenu } from "./workspace_menu_support.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { PYTHON, spawnSync, readFile } from './workspace_test_support.mjs';
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
    // Exercise embedded wiring in headless shell; this does not qualify PDF readability.
    await page.addInitScript(() => Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: true }));
    await page.goto(context.running.startup.url);
    await openWorkspace(page, "resumes");
    await page.locator('#resume-import input[name=label]').fill('Synthetic PDF');
    await page.locator('#resume-import input[type=file]').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
    await page.getByRole('button', { name: 'Import resume', exact: true }).click();
    const response = page.waitForResponse(response => response.url().endsWith('/content'));
    const pagesBefore = context.browser.contexts()[0].pages().length;
    await page.locator('.resume-card').getByRole('button', { name: 'View PDF', exact: true }).click();
    assert.equal(await page.locator('#resume-dialog').evaluate(node => node.open), false,
      'preview must not open metadata or replacement controls');
    const content = await response;
    assert.equal(content.status(), 200);
    assert.match(content.headers()['content-type'], /application\/pdf/);
    const preview = page.locator('#pdf-preview-dialog');
    await preview.waitFor({ state: 'visible', timeout: 1500 });
    assert.equal(context.browser.contexts()[0].pages().length, pagesBefore);
    await page.waitForFunction(() => document.querySelector('#pdf-frame').getAttribute('src')?.startsWith('blob:'));
    const blobUrl = await page.locator('#pdf-frame').getAttribute('src');
    assert.match(blobUrl, /^blob:/);
    assert.equal(await preview.getByRole('link', { name: 'Download PDF' }).count(), 1);
    const fetched = await page.request.get(content.url(), { headers: await content.request().allHeaders() });
    assert.deepEqual(await fetched.body(), syntheticPdf());
    assert.equal((await page.request.get(content.url())).status(), 401);
    // Headless shell does not render Chrome's PDF viewer; owner visual acceptance is separate.
    await preview.getByRole('button', { name: 'Close PDF preview' }).click();
    await preview.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('#pdf-frame').hasAttribute('src'));
    assert.equal(await page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, blobUrl), false);
    const card = page.locator('.resume-card');
    await page.waitForFunction(() => document.activeElement?.matches('.resume-card [data-resume-preview]'));
    await page.evaluate(() => Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: false }));
    await card.getByRole('button', { name: 'View PDF', exact: true }).click();
    await page.getByText(/This browser does not support embedded PDF viewing/).waitFor();
    assert.equal(await page.locator('#pdf-frame').isVisible(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const box = document.querySelector('#pdf-preview-dialog').getBoundingClientRect();
      return box.width <= innerWidth + 1 && box.height <= innerHeight + 1;
    });
    const box = await preview.boundingBox();
    assert.ok(box.width <= 391 && box.height <= 845, JSON.stringify(box));
    await page.keyboard.press('Escape');
    await preview.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.matches('.resume-card [data-resume-preview]'));
    await page.setViewportSize({ width: 1280, height: 844 });
    let releaseContent;
    const contentGate = new Promise(resolve => { releaseContent = resolve; });
    await page.route('**/api/resumes/*/content', async route => { await contentGate; await route.continue(); });
    await card.getByRole('button', { name: 'View PDF', exact: true }).click();
    await page.getByText('Loading PDF…', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close PDF preview' }).click();
    const lateResponse = page.waitForResponse(response => response.url().endsWith('/content'));
    releaseContent();
    await lateResponse;
    await page.unroute('**/api/resumes/*/content');
    await page.waitForFunction(() => !document.querySelector('[data-resume-preview]').disabled);
    assert.equal(await preview.evaluate(node => node.open), false);
    assert.equal(await page.locator('#pdf-frame').getAttribute('src'), null);
    await page.route('**/api/resumes/*/content', route => route.abort());
    await card.getByRole('button', { name: 'View PDF', exact: true }).click();
    await page.getByText(/Resume preview failed: cannot reach the Companion/).waitFor();
    await page.getByRole('button', { name: 'Close PDF preview' }).click();
    assert.equal(await page.locator('#resume-dialog').evaluate(node => node.open), false);
    assert.equal(await card.getByRole('button', { name: 'View PDF', exact: true }).isEnabled(), true);
    await page.unroute('**/api/resumes/*/content');
    await card.getByRole('button', { name: 'Manage', exact: true }).click();
    const details = page.locator('#resume-dialog');
    assert.equal(await details.getByRole('group', { name: 'Current document', exact: true }).locator('input[type=file]').count(), 0);
    assert.equal(await details.getByRole('group', { name: 'Replace document', exact: true }).locator('input[type=file]').count(), 1);
    await details.locator('input[name=label]').fill('Unsaved resume label');
    await details.locator('input[name=tags]').fill('unsaved-tag');
    await details.locator('input[type=file]').setInputFiles({ name: 'unsubmitted.txt', mimeType: 'text/plain', buffer: Buffer.from('Unsubmitted replacement') });
    for (const closeWith of ['button', 'Escape']) {
      await details.getByRole('button', { name: 'View PDF', exact: true }).click();
      await page.getByText(/This browser does not support embedded PDF viewing/).waitFor();
      if (closeWith === 'Escape') await page.keyboard.press('Escape');
      else await page.getByRole('button', { name: 'Close PDF preview' }).click();
      await page.waitForFunction(() => document.activeElement?.id === 'resume-content');
      assert.equal(await details.evaluate(node => node.open), true);
      assert.equal(await details.locator('input[name=label]').inputValue(), 'Unsaved resume label');
      assert.equal(await details.locator('input[name=tags]').inputValue(), 'unsaved-tag');
      assert.equal(await details.locator('input[type=file]').evaluate(node => node.files[0].name), 'unsubmitted.txt');
    }
    await page.route('**/api/resumes/*/content', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
    await details.getByRole('button', { name: 'View PDF', exact: true }).click();
    await page.getByText(/Resume preview failed: this workspace session is no longer authorized/).waitFor();
    await page.getByRole('button', { name: 'Close PDF preview' }).click();
    await page.unroute('**/api/resumes/*/content');
    await details.getByRole('button', { name: 'Close resume details' }).click();
    await page.route('**/api/resume-proposals', route => route.abort());
    await page.locator('#resumes-refresh').click();
    await page.getByText(/Extraction reviews could not load: cannot reach the Companion/).waitFor();
    await page.unroute('**/api/resume-proposals');
    await page.locator('#resumes-refresh').click();
    await page.locator('#resumes-error').waitFor({ state: 'hidden' });

  } finally { await cleanupOwnerBetaScenario(context); }
});

test('TXT previews in-app and DOCX downloads unchanged bytes', { timeout: 60_000 }, async () => {
  const context = await createOwnerBetaScenario();
  try {
    await startOwnerBetaScenario(context);
    const page = await context.browser.newPage();
    await page.goto(context.running.startup.url);
    await openWorkspace(page, 'resumes');
    const generated = spawnSync(PYTHON, ['-c', `import io, sys, zipfile
out = io.BytesIO()
with zipfile.ZipFile(out, 'w') as archive:
    archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic DOCX</w:t></w:r></w:p></w:body></w:document>')
sys.stdout.buffer.write(out.getvalue())`]);
    assert.equal(generated.status, 0);
    const text = Buffer.from('Synthetic TXT resume');
    for (const [name, buffer] of [['synthetic.txt', text], ['synthetic.docx', generated.stdout]]) {
      await page.locator('#resume-import input[name=label]').fill(name);
      await page.locator('#resume-import input[type=file]').setInputFiles({ name, mimeType: name.endsWith('.txt') ? 'text/plain' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer });
      await page.getByRole('button', { name: 'Import resume', exact: true }).click();
      await page.locator('.resume-card').filter({ has: page.getByRole('heading', { name, exact: true }) }).waitFor();
    }
    await page.getByRole('button', { name: 'Preview text', exact: true }).click();
    await page.locator('#preview-dialog').waitFor();
    assert.equal(await page.locator('#resume-preview').textContent(), text.toString());
    assert.equal(await page.locator('#resume-dialog').evaluate(node => node.open), false);
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download DOCX', exact: true }).click();
    const download = await downloadEvent;
    assert.match(download.suggestedFilename(), /\.docx$/);
    assert.deepEqual(await readFile(await download.path()), generated.stdout);
    assert.equal(await page.locator('#pdf-preview-dialog').evaluate(node => node.open), false);
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
      assert.ok(tabs);
      assert.equal(await page.locator('#profile-readiness').isVisible(), false);
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
