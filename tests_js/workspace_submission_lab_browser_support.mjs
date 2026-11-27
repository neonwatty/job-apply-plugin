import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clickCompanionNav } from './workspace_companion_nav_support.mjs';

const fictionalJobs = ['Synthetic Greenhouse application', 'ML Engineer'];
const labApi = '/api/submission-lab';

async function openForm(page, role) {
  const [form] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('link', { name: `Open test form for ${role}`, exact: true }).click(),
  ]);
  assert.match(form.url(), /^http:\/\/127\.0\.0\.1:\d+\/$/);
  return form;
}

async function reviewForm(form, sponsorship) {
  await form.getByRole('button', { name: 'Load fictional answers and résumé', exact: true }).click();
  await form.getByRole('status').filter({ hasText: 'Fictional answers and résumé loaded.' }).waitFor();
  if (sponsorship) await form.getByLabel('Will you require employment visa sponsorship?').selectOption(sponsorship);
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await form.getByRole('heading', { name: 'Review application', exact: true }).waitFor();
  assert.equal(await form.getByRole('button', { name: 'Submit application', exact: true }).isDisabled(), true);
}

async function prepareBatch(page) {
  await page.getByRole('switch', { name: 'Submit after approval', exact: true }).check();
  await page.getByRole('checkbox', { name: /Synthetic Greenhouse application/ }).check();
  await page.getByRole('checkbox', { name: /ML Engineer/ }).check();
  await page.getByRole('button', { name: 'Prepare test applications', exact: true }).click();
  const forms = [];
  for (const role of fictionalJobs) {
    const form = await openForm(page, role);
    await reviewForm(form);
    forms.push(form);
  }
  await page.getByRole('button', { name: 'Review batch', exact: true }).click();
  return forms;
}

async function pauseNextExecution(page) {
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  await page.route('**/api/submission-lab/execute', async route => {
    started.resolve();
    await resume.promise;
    await route.continue();
  }, { times: 1 });
  return { started: started.promise, resume: resume.resolve };
}

export async function submissionLabBrowser(page, startup, store) {
  const paths = ['jobs.json', 'profile.json'].map(name => join(store, name));
  const original = await Promise.all(paths.map(path => readFile(path)));
  const origin = startup.origin, token = new URLSearchParams(new URL(startup.url).hash.slice(1)).get('token');
  const headers = { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' };
  const post = (action, body, supplied = headers) => fetch(origin + labApi + '/' + action, {
    method: 'POST', headers: supplied, body: JSON.stringify(body),
  });
  assert.equal((await fetch(origin + labApi)).status, 401);
  assert.equal((await post('start', {}, { ...headers, Origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await post('start', { jobIds: ['https://outside.invalid'] })).status, 409);
  assert.equal((await post('start', { mode: 'submit_after_approval', jobIds: ['greenhouse-demo'] })).status, 409);

  await clickCompanionNav(page, 'Submission lab');
  const mode = page.getByRole('switch', { name: 'Submit after approval', exact: true });
  await mode.waitFor();
  assert.equal(await mode.isChecked(), false);
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === labApi + '/set-approval' && response.ok()),
    mode.check(),
  ]);
  await page.reload();
  await clickCompanionNav(page, 'Submission lab');
  await mode.waitFor();
  assert.equal(await mode.isChecked(), true);
  assert.equal((await (await fetch(origin + labApi, { headers })).json()).session, null);
  await mode.uncheck();
  await page.getByRole('checkbox', { name: /Synthetic Greenhouse application/ }).check();
  await page.getByRole('button', { name: 'Prepare test applications', exact: true }).click();
  const reviewFormOnly = await openForm(page, fictionalJobs[0]);
  await reviewForm(reviewFormOnly);
  await page.getByRole('button', { name: 'Check reviews', exact: true }).click();
  await page.getByText('All selected jobs reached Review.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Review batch', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Approve and submit', exact: true }).count(), 0);
  assert.match(await (await post('preview', {})).text(), /Submit after approval is off/);
  await mode.check();
  await page.getByRole('button', { name: 'Review batch', exact: true }).click();
  await page.getByRole('region', { name: 'Approval preview', exact: true }).waitFor();
  const single = await (await fetch(origin + labApi, { headers })).json();
  assert.equal(single.report.jobs.length, 1);
  assert.equal(single.report.status, 'awaiting_approval');
  await mode.uncheck();
  await page.getByText('Batch stopped.', { exact: true }).waitFor();
  assert.equal(await page.getByText('Review reached', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Approve and submit', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'End lab session', exact: true }).click();
  await reviewFormOnly.close();
  await mode.waitFor();

  const forms = await prepareBatch(page);
  const preview = page.getByRole('region', { name: 'Approval preview', exact: true });
  await preview.getByText('avery.replay@example.com', { exact: true }).first().waitFor();
  const resume = await preview.getByRole('link', { name: 'synthetic-resume.pdf', exact: true }).getAttribute('href');
  assert.ok(resume?.startsWith(new URL(forms[0].url()).origin));
  const pdf = await fetch(resume);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal((await pdf.text()).slice(0, 4), '%PDF');
  const before = await (await fetch(origin + labApi, { headers })).json();
  assert.equal(before.report.status, 'awaiting_approval');
  assert.equal((await post('execute', { batchId: before.report.batchId })).status, 409);
  assert.doesNotMatch(JSON.stringify(before), /shutdownToken|routeToken|storeRoot/);
  const edit = await pauseNextExecution(page);
  try {
    await page.getByRole('button', { name: 'Approve and submit', exact: true }).click();
    await edit.started;
    assert.equal((await (await fetch(origin + labApi, { headers })).json()).report.status, 'approved');
    await forms[1].reload();
    await reviewForm(forms[1], 'Yes');
  } finally { edit.resume(); }
  await page.getByText('Batch finished.', { exact: true }).waitFor();
  const outcomes = page.getByRole('region', { name: 'Batch outcomes', exact: true });
  await outcomes.getByText('Submitted', { exact: true }).waitFor();
  await outcomes.getByText('Needs attention', { exact: true }).waitFor();
  await outcomes.getByText('The application changed after approval.', { exact: true }).waitFor();
  await outcomes.getByText('Receipt', { exact: true }).click();
  await outcomes.getByText(/^receipt:[a-f0-9]{64}$/).waitFor();
  await page.reload();
  await clickCompanionNav(page, 'Submission lab');
  await outcomes.getByText('Submitted', { exact: true }).waitFor();
  await outcomes.getByText('Needs attention', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'End lab session', exact: true }).click();
  for (const form of forms) await form.close();
  await mode.waitFor();
  await page.getByRole('button', { name: 'Prepare test applications', exact: true }).waitFor();
  assert.equal(await mode.isChecked(), true);

  const stoppedForms = await prepareBatch(page);
  const stopped = await pauseNextExecution(page);
  try {
    await page.getByRole('button', { name: 'Approve and submit', exact: true }).click();
    await stopped.started;
    await mode.uncheck();
    await outcomes.getByText('Stopped', { exact: true }).first().waitFor();
  } finally { stopped.resume(); }
  await page.getByText('Batch stopped.', { exact: true }).waitFor();
  assert.equal(await outcomes.getByText('Stopped', { exact: true }).count(), 2);
  assert.equal(await page.getByRole('button', { name: 'Resume approved submission', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'End lab session', exact: true }).click();
  for (const form of stoppedForms) await form.close();
  await mode.waitFor();
  assert.equal(await mode.isChecked(), false);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), original);
  return { defaultOff: true, globalSetting: true, singleJob: true, exactPreview: true,
    singleApprovalAction: true, splitOutcomes: true, globalOffStops: true, storeUntouched: true };
}
