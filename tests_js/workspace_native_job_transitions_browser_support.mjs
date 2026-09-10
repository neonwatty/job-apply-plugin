import assert from 'node:assert/strict';
import { readyPacket } from './workspace_native_claims_support.mjs';

// Caller owns a disposable native fixture with a preflight-ready job and no claim.
export async function jobTransitionsBrowser(page, { jobId, readJob, prepareInterrupted }) {
  const authorization = await page.evaluate(() => `Bearer ${sessionStorage.getItem('jobApplyWorkspaceToken')}`);
  async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await page.request.fetch(new URL(path, page.url()).href, {
      method, headers: { Authorization: authorization, Origin: new URL(page.url()).origin }, data: body,
    });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  }
  const navigation = page.getByRole('navigation', { name: 'Workspace sections' });
  const modal = page.getByRole('dialog', { name: 'Edit job', exact: true });
  const status = modal.getByRole('region', { name: 'Job status', exact: true });
  const close = modal.getByRole('button', { name: 'Close job details', exact: true });
  async function open() {
    await navigation.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.locator('[data-job-create]:enabled').waitFor();
    await page.getByRole('button', { name: /Native fixture role/ }).click();
    await status.getByRole('group', { name: 'Change local status' }).waitFor();
  }
  const transitionResponse = () => page.waitForResponse(response =>
    response.url().endsWith(`/api/jobs/${jobId}/transition`) && response.request().method() === 'POST');
  async function change(label, target) {
    const response = transitionResponse();
    page.once('dialog', dialog => dialog.accept());
    await status.getByRole('button', { name: label, exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    const record = await result.json();
    assert.equal(record.status, target);
    assert.deepEqual(await readJob(), record);
    await status.getByText(`Local status changed to ${target.replaceAll('_', ' ')}.`, { exact: true }).waitFor();
    await modal.locator('fieldset:enabled').first().waitFor();
    return record;
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  assert.equal((await readJob()).status, 'ready');
  assert.equal(await status.getByRole('button', { name: 'Close job', exact: true }).isDisabled(), true);
  const originalNotes = await modal.locator('[name="notes"]').inputValue();
  await modal.locator('[name="notes"]').fill(`${originalNotes} unsaved transition draft`);
  assert.equal(await status.getByRole('button', { name: 'Mark saved', exact: true }).isDisabled(), true);
  await modal.locator('[name="notes"]').fill(originalNotes);
  await status.getByLabel('Closing outcome').selectOption('withdrawn');
  let requests = 0;
  const count = request => { if (request.url().endsWith(`/api/jobs/${jobId}/transition`)) requests++; };
  page.on('request', count);
  let confirmation;
  const beforeCancel = await readJob();
  page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss(); });
  await status.getByRole('button', { name: 'Close job', exact: true }).click();
  assert.match(confirmation, /local status only/i);
  assert.equal(requests, 0);
  assert.deepEqual(await readJob(), beforeCancel);
  await change('Close job', 'closed');
  assert.equal((await readJob()).closedOutcome, 'withdrawn');
  await change('Reopen as saved', 'saved');
  assert.equal((await readJob()).closedOutcome, null);
  await change('Mark ready', 'ready');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  // A concurrent canonical edit must not cause an automatic retry or lose the outcome choice.
  await status.getByLabel('Closing outcome').selectOption('expired');
  const stale = await readJob();
  const latest = await api(`/api/jobs/${jobId}`, { expectedRevision: stale.revision, patch: { company: 'Transition conflict writer' } }, 'PATCH');
  const conflict = transitionResponse();
  const beforeConflictRequests = requests;
  page.once('dialog', dialog => dialog.accept());
  await status.getByRole('button', { name: 'Close job', exact: true }).click();
  assert.equal((await conflict).status(), 409);
  await status.getByRole('alert').filter({ hasText: /Refresh latest values/ }).waitFor();
  assert.equal(await status.getByLabel('Closing outcome').inputValue(), 'expired');
  assert.equal(requests, beforeConflictRequests + 1);
  assert.deepEqual(await readJob(), latest);
  await close.click();

  // Prepare review through the real claim API; no browser or employer submission occurs.
  const acquired = await api('/api/claims/acquire', { jobId, expectedRevision: latest.revision, ownerLabel: 'Transition fixture' });
  const reviewed = await api('/api/claims/handoff', { jobId, token: acquired.token, status: 'awaiting_review',
    expectedRevision: acquired.job.revision, session: { status: 'review', readinessInput: readyPacket(acquired.job.revision) } });
  assert.equal(reviewed.job.status, 'awaiting_review');
  await page.reload();
  await open();
  const beforeApplied = requests;
  page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss(); });
  await status.getByRole('button', { name: 'Mark applied', exact: true }).click();
  assert.match(confirmation, /I personally submitted/i);
  assert.equal(requests, beforeApplied);
  assert.equal((await readJob()).status, 'awaiting_review');
  const appliedResponse = transitionResponse();
  await change('Mark applied', 'applied');
  assert.equal((await appliedResponse).request().postDataJSON().userConfirmed, true);
  await close.click();

  // This explicitly synthetic crash fixture has an in_progress record and no live claim.
  await prepareInterrupted();
  await page.reload();
  await open();
  await status.getByText(/After an active claim is released/).waitFor();
  await change('Mark needs info', 'needs_info');

  // Hold a write, then hold only its background refresh: write guards must end at acknowledgement.
  let releasePost, postSeen, releaseGet, getSeen;
  const postGate = new Promise(resolve => { releasePost = resolve; });
  const postStarted = new Promise(resolve => { postSeen = resolve; });
  const getGate = new Promise(resolve => { releaseGet = resolve; });
  const getStarted = new Promise(resolve => { getSeen = resolve; });
  const postRoute = async route => { postSeen(); await postGate; await route.continue(); };
  const getRoute = async route => { getSeen(); await getGate; await route.continue().catch(() => {}); };
  await page.route(`**/api/jobs/${jobId}/transition`, postRoute);
  try {
    const acknowledged = transitionResponse();
    page.once('dialog', dialog => dialog.accept());
    await status.getByRole('button', { name: 'Mark saved', exact: true }).click();
    await postStarted;
    assert.equal(await close.isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await modal.isVisible(), true);
    assert.equal(await status.getByRole('button', { name: 'Mark saved', exact: true }).isDisabled(), true);
    await page.route('**/api/state', getRoute);
    releasePost();
    assert.equal((await acknowledged).status(), 200);
    await getStarted;
    await modal.getByRole('button', { name: 'Close job details', exact: true }).waitFor();
    await close.click();
    let navigationPrompts = 0;
    const dismiss = dialog => { navigationPrompts++; return dialog.dismiss(); };
    page.on('dialog', dismiss);
    try {
      await navigation.getByRole('button', { name: 'Overview', exact: true }).click();
      await page.getByRole('heading', { name: 'Your next step', exact: true }).waitFor();
      assert.equal(navigationPrompts, 0);
    } finally { page.off('dialog', dismiss); }
    assert.equal((await readJob()).status, 'saved');
  } finally {
    releasePost(); releaseGet();
    await page.unroute(`**/api/jobs/${jobId}/transition`, postRoute);
    await page.unroute('**/api/state', getRoute);
    page.off('request', count);
  }
  return { closeReopen: true, cancellation: true, dirtyDisabled: true, personallySubmitted: true,
    claimlessRecovery: true, conflictPreserved: true, pendingGuard: true, acknowledgedRefreshClean: true, narrowViewport: true };
}
