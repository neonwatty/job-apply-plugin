import { clickCompanionNav, jobDetailBack } from './workspace_companion_nav_support.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

async function capture(page, name) {
  const directory = process.env.JOB_APPLY_UX_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name), fullPage: true, animations: 'disabled' });
}

export async function nextSetupAndLoading(page, url) {
  await page.getByRole('heading', { name: 'Ready to apply?', exact: true }).waitFor();
  await capture(page, 'overview-desktop.png');
  await page.setViewportSize({ width: 820, height: 1024 });
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Expand sidebar', exact: true }).getAttribute('aria-expanded'), 'false');
  await page.setViewportSize({ width: 320, height: 568 });
  const phone = page.getByRole('navigation', { name: 'Mobile workspace sections', exact: true });
  await phone.waitFor();
  assert.deepEqual(await phone.getByRole('button').allTextContents().then(labels => labels.map(label => label.trim().replace(/\d+$/, ''))),
    ['Needs Attention', 'Jobs', 'More']);
  for (const button of await phone.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    assert.ok(bounds.height >= 44 && bounds.y + bounds.height <= 568);
  }
  await clickCompanionNav(page, 'More');
  await page.getByRole('heading', { name: 'More', exact: true }).waitFor();
  assert.equal(await phone.getByRole('button', { name: 'More' }).getAttribute('aria-current'), 'page');
  await capture(page, 'mobile-navigation.png');
  await clickCompanionNav(page, 'Settings');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.goBack();
  await page.getByRole('heading', { name: 'More', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => scrollTo(0, 0));
  await clickCompanionNav(page, 'Answers');
  assert.equal(await page.evaluate(() => scrollY), 0,
    'workspace navigation moves focus without pulling the page down to main');
  await clickCompanionNav(page, 'Overview');
  for (const [label, section] of [['Edit Facts', 'facts'], ['Manage Resumes', 'resumes']]) {
    const control = page.getByRole('button', { name: label, exact: true });
    await control.waitFor();
    await control.click();
    await page.locator(`#workspace-navigation button[aria-label="${section[0].toUpperCase() + section.slice(1)}"][aria-current="page"]`).waitFor({ state: 'attached' });
    await page.goto(url, { waitUntil: 'networkidle' });
    await clickCompanionNav(page, 'Overview');
  }
  // A slow native boot must not override a destination the user chose meanwhile.
  let bootRelease;
  const bootGate = new Promise(resolve => { bootRelease = resolve; });
  await page.route('**/api/boot', async route => { await bootGate; await route.continue(); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await clickCompanionNav(page, 'Facts');
  await page.locator('#workspace-navigation button[aria-label="Facts"][aria-current="page"]').waitFor({ state: 'attached' });
  bootRelease();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#workspace-navigation button[aria-label="Facts"]').getAttribute('aria-current'), 'page');
  await page.unroute('**/api/boot');
  await page.goto(url, { waitUntil: 'networkidle' });
  const boot = '**/api/boot';
  await page.route(boot, route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic boot failure' } } }));
  await page.reload();
  await page.getByText('Connection unavailable', { exact: true }).waitFor();
  await page.unroute(boot);
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await page.getByRole('status', { name: 'Local data connected', exact: true }).waitFor();
  await clickCompanionNav(page, 'Overview');

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/state', async route => {
    await gate;
    await route.fulfill({ status: 503, json: { error: { message: 'Synthetic list failure' } } });
  });
  await clickCompanionNav(page, 'Jobs');
  await page.getByText('Loading jobs…', { exact: true }).waitFor();
  assert.equal(await page.getByText('No jobs saved yet.', { exact: true }).count(), 0);
  release();
  await page.getByText(/Jobs could not be loaded/).waitFor();
  assert.equal(await page.getByText('No jobs saved yet.', { exact: true }).count(), 0);
  await page.unroute('**/api/state');
  await page.getByRole('button', { name: 'Retry loading jobs' }).click();
  await page.getByText('No jobs saved yet.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Pipeline summary', { exact: true }).count(), 0,
    'an empty pipeline does not repeat three zero-value metrics');
}

export async function nextDraftAndRecovery(page, origin, headers) {
  await page.getByLabel('Search jobs', { exact: true }).fill('does-not-match-any-job');
  await page.getByText('No jobs match these filters.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByLabel('Search jobs', { exact: true }).fill('Next synthetic');
  await clickCompanionNav(page, 'Overview');
  await page.locator('#workspace-navigation button[aria-label="Overview"][aria-current="page"]').waitFor({ state: 'attached' });
  await clickCompanionNav(page, 'Jobs');
  await page.locator('#workspace-navigation button[aria-label="Jobs"][aria-current="page"]').waitFor({ state: 'attached' });
  assert.equal(await page.getByLabel('Search jobs', { exact: true }).inputValue(), 'Next synthetic',
    'returning to Jobs keeps its loaded list and filter');
  await clickCompanionNav(page, 'Overview');
  const recentJobs = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
  await clickCompanionNav(page, 'Jobs');
  await recentJobs;
  assert.equal(await page.getByLabel('Search jobs', { exact: true }).inputValue(), 'Next synthetic',
    'Jobs checks for external changes on return without resetting its filter');
  await page.evaluate(() => {
    window.__originalDateNow = Date.now;
    Date.now = () => window.__originalDateNow() + 31_000;
  });
  await clickCompanionNav(page, 'Overview');
  const refreshedJobs = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
  await clickCompanionNav(page, 'Jobs');
  await refreshedJobs;
  assert.equal(await page.getByLabel('Search jobs', { exact: true }).inputValue(), 'Next synthetic',
    'a data refresh after the old eviction interval retains the Jobs filter');
  await page.evaluate(() => { Date.now = window.__originalDateNow; delete window.__originalDateNow; });
  const card = page.getByRole('button', { name: /Next synthetic role/ });
  await card.click();
  await capture(page, 'job-details-desktop.png');
  await page.getByRole('button', { name: 'Edit job', exact: true }).click();
  const dialog = page.locator('dialog.job-drawer');
  await dialog.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'url');
  const drawerBounds = await dialog.boundingBox();
  await page.mouse.click(drawerBounds.x + 8, drawerBounds.y + drawerBounds.height - 8);
  assert.equal(await dialog.isVisible(), true, 'clicking inside drawer padding keeps the job open');
  await dialog.locator('[name="notes"]').fill('Draft survives failed refresh');
  await page.route('**/api/state', route => route.fulfill({ status: 503, json: { error: { message: 'Offline fixture' } } }));
  await page.evaluate(() => [...document.querySelectorAll('.workspace-page:not([hidden]) .jobs-workspace button')].find(button => button.textContent.trim() === 'Refresh').click());
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
  const detailUrl = page.url();
  assert.equal(new URL(detailUrl).searchParams.get('job'), job.id);
  page.once('dialog', prompt => prompt.dismiss());
  await page.goBack();
  await page.waitForURL(detailUrl);
  assert.equal(await dialog.locator('[name="notes"]').inputValue(), 'Draft survives failed refresh');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await capture(page, 'job-editor-narrow.png');
  page.once('dialog', prompt => prompt.accept());
  await dialog.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await jobDetailBack(dialog).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-workspace-focus')?.startsWith('job:'));
  assert.equal(await card.evaluate(node => node === document.activeElement), true);
  assert.equal(await page.getByLabel('Search jobs', { exact: true }).inputValue(), 'Next synthetic');
  await page.goForward();
  await dialog.getByRole('heading', { name: 'Next synthetic role', exact: true }).waitFor();
  await jobDetailBack(dialog).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1280, height: 900 });

  // A vanished record must not leave an apparently saveable stale draft.
  await card.click();
  await page.getByRole('button', { name: 'Edit job', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'url');
  await dialog.locator('[name="notes"]').fill('Preserve missing-record draft');
  assert.equal(await dialog.locator('[name="notes"]').inputValue(), 'Preserve missing-record draft');
  await page.route('**/api/state', route => route.fulfill({ json: { ...state, jobs: [] } }));
  await page.evaluate(() => [...document.querySelectorAll('.workspace-page:not([hidden]) .jobs-workspace button')].find(button => button.textContent.trim() === 'Refresh').click());
  await dialog.getByText('This job is no longer available', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Save job', exact: true }).isDisabled(), true);
  assert.equal(await dialog.locator('[name="notes"]').inputValue(), 'Preserve missing-record draft');
  await page.unroute('**/api/state');
  page.once('dialog', prompt => prompt.accept());
  await jobDetailBack(dialog).click();
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
    // This response belongs to a hidden Jobs view and must be ignored.
    await route.fulfill({ json: { jobs: [], resumes: [] } }).catch(() => {});
  });
  const cancelled = page.waitForEvent('requestfailed', {
    predicate: request => new URL(request.url()).pathname === '/api/state',
  });
  await page.getByRole('button', { name: /Next synthetic role/ }).click();
  await page.getByRole('button', { name: 'Edit job', exact: true }).click();
  await page.locator('dialog.job-drawer').getByRole('button', { name: 'Save job', exact: true }).click();
  await intercepted;
  await page.waitForFunction(() => document.querySelector('[data-job-create]')?.disabled === false);
  assert.equal(await page.getByRole('button', { name: 'New job', exact: true }).isDisabled(), false,
    'A confirmed save must release controls before its background refresh completes');
  await clickCompanionNav(page, 'Overview');
  await cancelled;
  await page.unroute('**/api/state');
  release();
  await clickCompanionNav(page, 'Jobs');
  await page.getByRole('button', { name: /Next synthetic role/ }).waitFor();
  assert.equal(await page.getByText('No jobs saved yet.', { exact: true }).count(), 0);
}
