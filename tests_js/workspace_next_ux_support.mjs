import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

async function capture(page, name) {
  const directory = process.env.JOB_APPLY_UX_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name), fullPage: true });
}

export async function nextSetupAndLoading(page, url) {
  await page.getByRole('heading', { name: 'Application setup', exact: true }).waitFor();
  await capture(page, 'overview-desktop.png');
  for (const [label, section] of [['Edit Facts', 'facts'], ['Manage Resumes', 'resumes']]) {
    const link = page.getByRole('link', { name: label, exact: true });
    await link.waitFor();
    assert.ok((await link.getAttribute('href')).includes(`workspace=${section}`));
    await link.click();
    await page.locator(`#nav-${section}[aria-current]`).waitFor();
    await page.goto(url, { waitUntil: 'networkidle' });
  }
  // A slow legacy boot must not override a destination the user chose meanwhile.
  let bootRelease;
  const bootGate = new Promise(resolve => { bootRelease = resolve; });
  await page.route('**/api/boot', async route => { await bootGate; await route.continue(); });
  const legacy = new URL(url);
  const fragment = new URLSearchParams(legacy.hash.slice(1));
  fragment.set('workspace', 'facts');
  await page.goto(`${legacy.origin}/legacy/#${fragment}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#nav-jobs').click();
  bootRelease();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#nav-jobs').getAttribute('aria-current'), '');
  await page.unroute('**/api/boot');
  await page.goto(url, { waitUntil: 'networkidle' });
  const boot = '**/api/boot';
  await page.route(boot, route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic boot failure' } } }));
  await page.reload();
  await page.getByText('Connection unavailable', { exact: true }).waitFor();
  await page.unroute(boot);
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await page.getByText('Canonical store connected', { exact: true }).waitFor();

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/state', async route => {
    await gate;
    await route.fulfill({ status: 503, json: { error: { message: 'Synthetic list failure' } } });
  });
  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.getByText('Loading jobs…', { exact: true }).waitFor();
  assert.equal(await page.getByText('No jobs yet.', { exact: false }).count(), 0);
  release();
  await page.getByText(/Jobs could not be loaded/).waitFor();
  assert.equal(await page.getByText('No jobs yet.', { exact: false }).count(), 0);
  await page.unroute('**/api/state');
  await page.getByRole('button', { name: 'Retry loading jobs' }).click();
  await page.getByText('No jobs yet. Capture a job to get started.', { exact: true }).waitFor();
}

export async function nextDraftAndRecovery(page, origin, headers) {
  await page.getByLabel('Search jobs', { exact: true }).fill('does-not-match-any-job');
  await page.getByText('No jobs match these filters.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  const card = page.getByRole('button', { name: /Next synthetic role/ });
  await card.click();
  const dialog = page.getByRole('dialog', { name: 'Edit job', exact: true });
  await dialog.waitFor();
  assert.equal(await page.locator('[name="url"]').evaluate(node => node === document.activeElement), true);
  await dialog.locator('[name="notes"]').fill('Draft survives failed refresh');
  await page.route('**/api/state', route => route.fulfill({ status: 503, json: { error: { message: 'Offline fixture' } } }));
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Refresh').click());
  await page.getByText(/Showing previously loaded jobs/).waitFor();
  assert.equal(await dialog.locator('[name="notes"]').inputValue(), 'Draft survives failed refresh');
  await page.unroute('**/api/state');

  const state = await (await fetch(origin + '/api/state', { headers })).json();
  const job = state.jobs.find(job => job.role === 'Next synthetic role');
  const detail = `**/api/jobs/${job.id}`;
  await page.route(detail, route => route.fulfill({ status: route.request().method() === 'PATCH' ? 409 : 503,
    json: { error: { code: 'revision_conflict', message: 'Synthetic conflict' } } }));
  await dialog.getByRole('button', { name: 'Save job', exact: true }).click();
  await dialog.getByText('Unable to load the latest job.', { exact: false }).waitFor();
  assert.equal(await dialog.locator('[name="notes"]').inputValue(), 'Draft survives failed refresh');
  await page.unroute(detail);
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
  await dialog.getByRole('button', { name: 'Refresh latest values', exact: true }).click();
  await refreshed;
  await dialog.getByText('Unable to load the latest job.', { exact: false }).waitFor({ state: 'hidden' });
  assert.equal(await dialog.locator('[name="notes"]').inputValue(), 'Draft survives failed refresh');
  // Navigation refusal preserves the form, including after an unsuccessful save.
  page.once('dialog', prompt => prompt.dismiss());
  await page.evaluate(() => [...document.querySelectorAll('nav button')].find(button => button.textContent.trim() === 'Overview').click());
  assert.equal(await dialog.isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await capture(page, 'job-editor-narrow.png');
  page.once('dialog', prompt => prompt.accept());
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await card.evaluate(node => node === document.activeElement), true);
  await page.setViewportSize({ width: 1280, height: 900 });

  // A vanished record must not leave an apparently saveable stale draft.
  await card.click();
  await dialog.locator('[name="notes"]').fill('Preserve missing-record draft');
  await page.route('**/api/state', route => route.fulfill({ json: { ...state, jobs: [] } }));
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Refresh').click());
  await dialog.getByText('This job is no longer available', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Save job', exact: true }).isDisabled(), true);
  assert.equal(await dialog.locator('[name="notes"]').inputValue(), 'Preserve missing-record draft');
  await page.unroute('**/api/state');
  page.once('dialog', prompt => prompt.accept());
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await card.waitFor();
}

export async function nextLateRead(page) {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { started = resolve; });
  await page.route('**/api/state', async route => {
    started();
    await gate;
    // This response belongs to an unmounted Jobs view and must be ignored.
    await route.fulfill({ json: { jobs: [], resumes: [] } }).catch(() => {});
  });
  const cancelled = page.waitForEvent('requestfailed', {
    predicate: request => new URL(request.url()).pathname === '/api/state',
  });
  await page.getByRole('button', { name: /Next synthetic role/ }).click();
  await page.getByRole('dialog', { name: 'Edit job', exact: true }).getByRole('button', { name: 'Save job', exact: true }).click();
  await intercepted;
  await page.waitForFunction(() => document.querySelector('[data-job-create]')?.disabled === false);
  assert.equal(await page.getByRole('button', { name: 'New job', exact: true }).isDisabled(), false,
    'A confirmed save must release controls before its background refresh completes');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await cancelled;
  await page.unroute('**/api/state');
  release();
  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.getByRole('button', { name: /Next synthetic role/ }).waitFor();
  assert.equal(await page.getByText('No jobs yet.', { exact: false }).count(), 0);
}
