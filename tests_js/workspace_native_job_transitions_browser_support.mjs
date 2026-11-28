import { clickCompanionNav, jobDetailBack } from './workspace_companion_nav_support.mjs';
import assert from 'node:assert/strict';
import { readyPacket } from './workspace_native_claims_support.mjs';

// Caller owns a disposable native fixture with a preflight-ready job and no claim.
export async function jobTransitionsBrowser(page, { jobId, readJob, confirmInputs, prepareInterrupted,
  seedSubmissionAttempt, confirmSubmissionAttempt }) {
  const authorization = await page.evaluate(() => `Bearer ${sessionStorage.getItem('jobApplyWorkspaceToken')}`);
  async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await page.request.fetch(new URL(path, page.url()).href, {
      method, headers: { Authorization: authorization, Origin: new URL(page.url()).origin }, data: body,
    });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  }

  const modal = page.locator('dialog.job-drawer');
  const status = modal.getByRole('region', { name: 'Job status', exact: true });
  const close = jobDetailBack(modal);
  async function open() {
    await clickCompanionNav(page, 'Jobs');
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
  const originalNotes = (await readJob()).notes ?? '';
  await modal.getByRole('button', { name: 'Edit job', exact: true }).click();
  await modal.locator('[name="notes"]').fill(`${originalNotes} unsaved transition draft`);
  assert.equal(await status.getByRole('button', { name: 'Mark saved', exact: true }).count(), 0);
  page.once('dialog', dialog => dialog.accept());
  await modal.getByRole('button', { name: 'Cancel editing', exact: true }).click();
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

  // Exercise recorded browser tasks and the review checkpoint through the synthetic Store.
  const selected = await confirmInputs(latest);
  const pausedAttempt = await api('/api/claims/acquire', {
    jobId, expectedRevision: selected.jobRevision, ownerLabel: 'Transition fixture',
  });
  const paused = await api('/api/claims/handoff', {
    jobId, token:pausedAttempt.token, status:'needs_info', expectedRevision:pausedAttempt.job.revision,
    session:{status:'active', handoffChecklist:['resume_upload'], blockers:[
      {type:'browser_handoff',code:'unsupported-control'}, {type:'information',code:'owner-input-required'},
    ]},
  });
  await api(`/api/jobs/${jobId}`, {expectedRevision:paused.job.revision, patch:{notes:'Synthetic browser handoff note'}}, 'PATCH');
  await clickCompanionNav(page, 'Needs Attention');
  const attention = page.getByRole('region', {name:'Needs Attention',exact:true});
  await attention.getByLabel('Filter by reason').selectOption('browser_action_required');
  await attention.getByRole('button', {name:/Transition conflict writer Native fixture role Browser action required/}).click();
  await attention.getByText(/A browser action was recorded/).waitFor();
  assert.equal(await attention.getByText('To do on form',{exact:true}).count(), 0);
  await attention.getByRole('button', {name:'Open job details',exact:true}).click();
  const readyToUpload = await change('Mark ready', 'ready');
  await close.click();

  const acquired = await api('/api/claims/acquire', {
    jobId, expectedRevision: readyToUpload.revision, ownerLabel: 'Transition fixture',
  });
  const uploadInput = readyPacket(acquired.job.revision);
  uploadInput.observation.uploadCapability = 'external-runtime-unavailable';
  uploadInput.observation.controls.find(control => control.kind === 'upload').state = 'missing';
  const blocked = await api('/api/claims/handoff', {
    jobId, token: acquired.token, status: 'needs_info', expectedRevision: acquired.job.revision,
    session: { status: 'active', readinessInput: uploadInput, handoffChecklist:[] },
  });
  assert.equal(blocked.job.status, 'needs_info');
  assert.equal(blocked.session.browserHandoff.reasonCode, 'owner-upload-required');
  await clickCompanionNav(page, 'Needs Attention');
  await attention.getByRole('button', {name:'Refresh attention',exact:true}).click();
  await attention.getByRole('button', { name: /Transition conflict writer Native fixture role Browser action required/ }).click();
  await attention.getByText('Attach resume', {exact:true}).waitFor();
  await attention.getByRole('button', {name:'See upload steps',exact:true}).click();
  const handoff = modal.locator('.job-handoff');
  await handoff.getByRole('heading', {name:'Attach resume in browser',exact:true}).waitFor();
  assert.equal(await modal.getByRole('button', {name:'Record as submitted',exact:true}).count(), 0);
  const readyJob = await change('Mark ready', 'ready');
  await close.click();

  // An observation that omits the upload cannot establish it is the sole remaining step.
  const incomplete = await api('/api/claims/acquire', {
    jobId, expectedRevision: readyJob.revision, ownerLabel: 'Transition fixture',
  });
  const omittedUpload = readyPacket(incomplete.job.revision);
  omittedUpload.observation.uploadCapability = 'external-runtime-unavailable';
  omittedUpload.observation.controls = omittedUpload.observation.controls.filter(control => control.kind !== 'upload');
  await api('/api/claims/handoff', {
    jobId, token: incomplete.token, status:'needs_info', expectedRevision: incomplete.job.revision,
    session:{status:'active',readinessInput:omittedUpload},
  });
  await clickCompanionNav(page, 'Needs Attention');
  await attention.getByRole('button', {name:/Transition conflict writer Native fixture role Browser action required/}).click();
  await attention.getByText('Attach resume · Review the remaining form checks',{exact:true}).waitFor();
  await attention.getByRole('button', {name:'See browser steps',exact:true}).click();
  await handoff.getByRole('heading', {name:'Browser action required',exact:true}).waitFor();
  await handoff.getByText('Attach resume',{exact:true}).waitFor();
  const readyForReview = await change('Mark ready', 'ready');
  await close.click();
  await clickCompanionNav(page, 'Jobs');

  const resumed = await api('/api/claims/acquire', {
    jobId, expectedRevision: readyForReview.revision, ownerLabel: 'Transition fixture',
  });
  await page.getByRole('button', {name:'Refresh',exact:true}).click();
  const activeJob = page.getByRole('button', {name:/Native fixture role.*in progress/});
  await activeJob.getByText(`revision ${resumed.job.revision}`, {exact:true}).waitFor({state:'attached'});
  await activeJob.click();
  const activity = modal.getByRole('region', {name:'Job activity',exact:true});
  await activity.getByText('active',{exact:true}).waitFor();
  await activity.getByText(/Browser handoff: required · owner upload required/).waitFor();
  assert.equal(await activity.getByText('Attach resume',{exact:true}).count(),0);
  const activityPath = `**/api/jobs/${jobId}/activity`;
  await page.route(activityPath, route => route.fulfill({status:503, json:{}}));
  const reviewInput = readyPacket(resumed.job.revision);
  reviewInput.observation.controls = reviewInput.observation.controls.filter(control => control.controlId !== 'profile.website');
  const reviewed = await api('/api/claims/handoff', {
    jobId, token: resumed.token, status:'awaiting_review', expectedRevision: resumed.job.revision,
    session: { status:'review', readinessInput:reviewInput, handoffChecklist:[] },
  });
  assert.equal(reviewed.job.status, 'awaiting_review');
  assert.deepEqual(reviewed.session.readiness.optionalUnansweredControlIds, ['profile.website']);
  await modal.getByRole('button',{name:'Refresh latest values',exact:true}).click();
  await modal.getByRole('button',{name:'Load latest values',exact:true}).click();
  await modal.getByText('Full job activity',{exact:true}).click();
  await activity.getByRole('button',{name:'Refresh activity',exact:true}).click();
  await activity.getByRole('alert').filter({hasText:/last loaded job data/}).waitFor();
  assert.equal(await handoff.getByRole('button',{name:'Record as submitted',exact:true}).isEnabled(),true);
  await page.unroute(activityPath);
  await close.click();
  await page.reload();
  await clickCompanionNav(page, 'Needs Attention');
  await attention.getByRole('button', {name:/Transition conflict writer Native fixture role Awaiting your review/}).click();
  await attention.getByRole('button', {name:'See review steps',exact:true}).click();
  await handoff.getByRole('heading', {name:'Ready for your review',exact:true}).waitFor();
  await handoff.getByText('Optional fields left blank', {exact:true}).waitFor();
  await handoff.getByText('profile website', {exact:true}).waitFor();
  assert.equal(await modal.evaluate(drawer =>
    Boolean(drawer.querySelector('.job-handoff').compareDocumentPosition(drawer.querySelector('.job-drawer-summary'))
      & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  assert.equal(await modal.getByRole('link', {name:/Open job posting/}).getAttribute('href'), reviewed.job.url);

  // Missing or stale form evidence must never look like a fresh check.
  const disclose = modal.getByText('Full job activity', {exact:true});
  const refresh = modal.getByRole('button', {name:'Refresh activity',exact:true});
  await disclose.click();
  await page.route(activityPath,async route=>{
    const response = await route.fetch();
    const data = await response.json();
    data.session.readiness = null;
    await route.fulfill({response,json:data});
  });
  await refresh.click();
  await handoff.getByRole('heading', {name:'Review details unavailable',exact:true}).waitFor();
  assert.equal(await handoff.getByText('Required fields reported complete', {exact:true}).count(), 0);
  await page.unroute(activityPath);
  await refresh.click();
  await handoff.getByRole('heading', {name:'Ready for your review',exact:true}).waitFor();

  // Changing the saved posting keeps its history, but invalidates the current handoff evidence.
  await modal.getByRole('button', {name:'Edit job',exact:true}).click();
  const correctedUrl = 'https://example.invalid/corrected-posting';
  await modal.getByLabel('Job URL',{exact:true}).fill(correctedUrl);
  await modal.getByRole('button', {name:'Save job',exact:true}).click();
  await modal.waitFor({state:'hidden'});
  const edited = await readJob();
  assert.equal(edited.url, correctedUrl);
  await clickCompanionNav(page, 'Jobs');
  await page.getByRole('button', {name:/Native fixture role.*Awaiting your review/}).click();
  await handoff.getByRole('heading', {name:'Review details unavailable',exact:true}).waitFor();
  assert.equal(await handoff.getByText('Required fields reported complete',{exact:true}).count(), 0);

  // Reloading a conflicting review revision preserves the owner's closing outcome.
  const closeDisclosure = handoff.getByText('Close this job',{exact:true});
  await closeDisclosure.click();
  const closingOutcome = handoff.getByLabel('Closing outcome');
  await closingOutcome.selectOption('withdrawn');
  await api('/api/jobs/' + jobId, {expectedRevision:edited.revision, patch:{notes:'Synthetic review update'}}, 'PATCH');
  const closeConflict = transitionResponse();
  page.once('dialog', dialog => dialog.accept());
  await handoff.getByRole('button',{name:'Close job',exact:true}).click();
  assert.equal((await closeConflict).status(),409);
  await handoff.getByRole('alert').filter({hasText:/closing outcome choice is retained/}).waitFor();
  await modal.getByRole('button',{name:'Refresh latest values',exact:true}).click();
  await modal.getByRole('button',{name:'Load latest values',exact:true}).click();
  await closeDisclosure.click();
  assert.equal(await closingOutcome.inputValue(),'withdrawn');

  // Cancel leaves the exact record intact. Confirm records only the user's local status.
  let externalRequests = 0;
  const rejectExternal = route => { externalRequests++; return route.abort(); };
  const context = page.context();
  const tabsBeforeApply = context.pages().length;
  await context.route('https://example.invalid/**', rejectExternal);
  const beforeApplied = requests;
  const beforeRecord = await readJob();
  await handoff.getByRole('button', {name:'Record as submitted',exact:true}).click();
  await handoff.getByText('Did you personally submit this application on the employer site?').waitFor();
  await handoff.getByRole('button', {name:'Cancel',exact:true}).click();
  assert.equal(requests, beforeApplied);
  assert.deepEqual(await readJob(), beforeRecord);
  // An interrupted synthetic agent send changes the queue and drawer even with the switch off.
  await seedSubmissionAttempt(beforeRecord.revision);
  await close.click();
  await clickCompanionNav(page, 'Needs Attention');
  await attention.getByRole('button', {name:/Transition conflict writer Native fixture role Verify submission status/}).click();
  await attention.getByRole('button', {name:'Open job to verify',exact:true}).click();
  await handoff.getByRole('heading', {name:'Verify submission status',exact:true}).waitFor();
  await modal.getByText('Full job activity', {exact:true}).click();
  await activity.getByRole('heading', {name:'Verify submission status',exact:true}).waitFor();
  assert.equal(await activity.getByRole('button', {name:'Copy repeat-review request',exact:true}).count(), 0);
  await handoff.getByRole('button', {name:'Record as submitted',exact:true}).click();
  await handoff.getByText('Did you verify that the employer received this application?').waitFor();
  const appliedResponse = transitionResponse();
  await handoff.getByRole('button', {name:'Yes, record as submitted',exact:true}).click();
  const submission = await appliedResponse;
  assert.equal(submission.status(), 200, await submission.text());
  assert.deepEqual(submission.request().postDataJSON(), {
    status:'applied', expectedRevision:beforeRecord.revision, userConfirmed:true,
  });
  await modal.getByText('Submission recorded in Companion.', {exact:true}).waitFor();
  assert.equal((await readJob()).status, 'applied');
  await activity.getByText('The agent’s submission attempt had an uncertain outcome.', {exact:true}).waitFor();
  const receipt = await confirmSubmissionAttempt();
  await activity.getByRole('button', {name:'Refresh activity', exact:true}).click();
  await activity.getByRole('heading', {name:'Submission confirmed',exact:true}).waitFor();
  await activity.getByText(receipt.receiptId, {exact:true}).waitFor();
  assert.equal(externalRequests, 0);
  assert.equal(context.pages().length, tabsBeforeApply);
  await context.unroute('https://example.invalid/**', rejectExternal);
  await close.click();
  await clickCompanionNav(page, 'Needs Attention');
  await attention.getByRole('button', {name:/Transition conflict writer Native fixture role/}).waitFor({state:'hidden'});

  // This explicitly synthetic crash fixture has an in_progress record and no live claim.
  await prepareInterrupted();
  await page.reload();
  await open();
  await status.getByText(/After an active claim is released/).waitFor();
  await change('Mark needs info', 'needs_info');
  const attentionCount = (await api('/api/overview')).counts.attentionJobs;
  await page.waitForFunction(count =>
    document.querySelector('#workspace-navigation button[aria-label="Needs Attention"] .nav-count')?.textContent?.trim() === String(count), attentionCount);

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
    await jobDetailBack(modal).waitFor();
    await close.click();
    let navigationPrompts = 0;
    const dismiss = dialog => { navigationPrompts++; return dialog.dismiss(); };
    page.on('dialog', dismiss);
    try {
      await clickCompanionNav(page, 'Overview');
      await page.getByRole('heading', { name: 'Your next move, at a glance.', exact: true }).waitFor();
      assert.equal(navigationPrompts, 0);
    } finally { page.off('dialog', dismiss); }
    assert.equal((await readJob()).status, 'saved');
  } finally {
    releasePost(); releaseGet();
    await page.unroute(`**/api/jobs/${jobId}/transition`, postRoute);
    await page.unroute('**/api/state', getRoute);
    page.off('request', count);
  }
  return { closeReopen: true, cancellation: true, dirtyDisabled: true, verifiedSubmission: true, submissionReceipt: true,
    claimlessRecovery: true, conflictPreserved: true, pendingGuard: true, acknowledgedRefreshClean: true, narrowViewport: true };
}
