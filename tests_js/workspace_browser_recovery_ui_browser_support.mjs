import assert from 'node:assert/strict';

/** Runs inside the existing production Companion fixture, never an owner's browser. */
export async function nativeBrowserRecoveryUi(page, workspace, selectedJob) {
  const panel = workspace.locator('.browser-recovery-panel');
  const refresh = panel.getByRole('button', { name: 'Refresh browser status', exact: true });
  const readyText = panel.getByText(/No unresolved browser actions are recorded/);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/browser-recovery')
    && response.request().method() === 'GET');
  await refresh.click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  const canonical = await response.json();
  assert.equal(canonical.available, true);
  assert.equal(canonical.guidance.status, 'ready');
  assert.equal('unresolvedOperationId' in canonical.guidance, false);
  await readyText.waitFor();

  const application = workspace.locator('.application-automation-panel');
  const duration = application.getByLabel('Duration in minutes', { exact: true });
  const mode = application.getByRole('combobox');
  assert.equal(await mode.count(), 1, 'application mode is the single dropdown in this panel');
  const originalDuration = await duration.inputValue();
  const originalMode = await mode.inputValue();
  const viewport = page.viewportSize();
  await duration.fill('121');
  await mode.selectOption('campaign_to_review');
  const requests = [];
  const observe = request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.method());
  };
  page.on('request', observe);
  let fixture = { ...canonical, guidance: { ...canonical.guidance,
    status: 'reconciliation_required', nextAction: 'reconcile_or_handoff' } };
  let fail = false;
  let hold = null;
  const pattern = '**/api/browser-recovery';
  const handler = async route => {
    if (hold) await hold;
    await route.fulfill(fail
      ? { status: 503, json: { error: { code: 'unavailable', message: 'private-failure-details' } } }
      : { status: 200, json: fixture });
  };
  await page.route(pattern, handler);
  try {
    await refresh.click();
    await panel.getByText('An earlier browser action has an uncertain outcome.', { exact: true }).waitFor();
    assert.equal(await readyText.count(), 0);
    assert.match(await panel.innerText(), /blocked across this workspace/);
    assert.match(await panel.innerText(), /active protected browser host/);
    assert.match(await panel.innerText(), /stop automation and take over manually/);
    assert.equal(await panel.getByRole('button').count(), 1);
    assert.equal(await selectedJob.isChecked(), true);
    assert.equal(await duration.inputValue(), '121');
    assert.equal(await mode.inputValue(), 'campaign_to_review');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

    fixture = { ...canonical, guidance: { ...canonical.guidance,
      status: 'capacity_reached', nextAction: 'handoff_capacity', archiveSegmentsRemaining: 0 } };
    await refresh.click();
    await panel.getByText('Saved browser action history is full.', { exact: true }).waitFor();
    assert.match(await panel.innerText(), /Do not delete saved history or retry the write/);
    assert.equal(await panel.getByRole('button').count(), 1);

    fixture = { available: false, reason: 'unsupported_store' };
    await refresh.click();
    await panel.getByText(/Browser recovery status is unavailable/).waitFor();
    assert.equal(await panel.getByLabel('Saved browser action counts').count(), 0);
    fail = true;
    await refresh.click();
    await panel.getByRole('alert').waitFor();
    assert.doesNotMatch(await panel.innerText(), /private-failure-details|No unresolved browser actions/);

    fail = false;
    fixture = canonical;
    await refresh.click();
    await readyText.waitFor();
    let release;
    hold = new Promise(resolve => { release = resolve; });
    try {
      await refresh.click();
      await panel.getByText('Checking saved browser actions…', { exact: true }).waitFor();
      assert.equal(await readyText.count(), 0);
      assert.equal(await refresh.isDisabled(), true);
    } finally {
      hold = null;
      release();
    }
    await readyText.waitFor();
    assert.equal(await selectedJob.isChecked(), true);
    assert.equal(await duration.inputValue(), '121');
    assert.equal(await mode.inputValue(), 'campaign_to_review');
    assert.ok(requests.length >= 6);
    assert.equal(requests.every(method => method === 'GET'), true, 'recovery refresh must never mutate');
  } finally {
    page.off('request', observe);
    await page.unroute(pattern, handler);
    await duration.fill(originalDuration);
    await mode.selectOption(originalMode);
    if (viewport) await page.setViewportSize(viewport);
  }
  return { realReadProjection: true, uncertainty: true, capacity: true, unavailable: true,
    error: true, loadingHidesReady: true, draftsPreserved: true, readOnly: true, narrowViewport: 390 };
}
