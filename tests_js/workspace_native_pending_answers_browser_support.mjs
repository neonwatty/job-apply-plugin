import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function nativePendingAnswersBrowser(page, root, cli) {
  const key = 'pending-browser-answer';
  await cli('answer-put', JSON.stringify({ key, question: 'Pending browser location?', state: 'confirmed', value: 'PRIVATE-PENDING-BROWSER' }));
  const job = await cli('job-create', JSON.stringify({ id: 'pending-browser-job', url: 'https://example.invalid/pending-browser', role: 'Pending fixture role', company: 'Pending fixture company' }));
  const jobsPath = join(root, 'jobs.json');
  const jobs = JSON.parse(await readFile(jobsPath, 'utf8'));
  jobs.jobs[job.id].status = 'needs_info';
  await writeFile(jobsPath, JSON.stringify(jobs), { mode: 0o600 });
  const reference = `pending_${'c'.repeat(32)}`;
  const sensitiveReference = `pending_${'d'.repeat(32)}`;
  const sessionPath = join(root, 'sessions', `${job.id}.json`);
  const session = {
    schemaVersion: 1, applicationId: job.id, status: 'active', updatedAt: '2026-09-09T12:00:00Z',
    pendingFields: [
      { reference, answerKey: key, question: 'Pending browser location?', state: 'missing' },
      { reference: sensitiveReference, answerKey: key, question: 'Sensitive pending confirmation?', state: 'sensitive', sensitive: true },
    ],
    blockers: [
      { type: 'information', code: 'answer-required', reference },
      { type: 'information', code: 'answer-required', reference: sensitiveReference },
    ],
  };
  await writeFile(sessionPath, JSON.stringify(session), { mode: 0o600 });
  const panel = page.getByRole('region', { name: 'Pending questions', exact: true });
  const refresh = panel.getByRole('button', { name: 'Refresh pending questions', exact: true });
  await refresh.click();
  await panel.getByText('Pending fixture role · Pending fixture company', { exact: true }).waitFor();
  const eligible = panel.getByRole('listitem').filter({ has: page.getByText('Pending browser location?', { exact: true }) }).last();
  const sensitive = panel.getByRole('listitem').filter({ has: page.getByText('Sensitive pending confirmation?', { exact: true }) }).last();
  assert.equal(await sensitive.getByRole('button', { name: 'Resolve question', exact: true }).isDisabled(), true);
  assert.doesNotMatch(await panel.innerText(), /PRIVATE-PENDING-BROWSER/);
  await eligible.getByRole('button', { name: 'Open saved answer', exact: true }).click();
  await page.getByLabel('Answer value', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Answer value', { exact: true }).inputValue(), 'PRIVATE-PENDING-BROWSER');
  await page.getByLabel('Source', { exact: true }).fill('unsaved pending guard');
  assert.equal(await eligible.getByRole('button', { name: 'Resolve question', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await page.getByText('Answer saved.', { exact: true }).waitFor();
  await panel.getByText('Pending browser location?', { exact: true }).waitFor({ state: 'hidden' });
  await refresh.click();
  await eligible.getByRole('button', { name: 'Resolve question', exact: true }).waitFor();
  const before = await readFile(sessionPath, 'utf8');
  page.once('dialog', dialog => dialog.dismiss());
  await eligible.getByRole('button', { name: 'Resolve question', exact: true }).click();
  assert.equal(await readFile(sessionPath, 'utf8'), before);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const start = new Promise(resolve => { entered = resolve; });
  await page.route('**/resolve-pending-answer', async route => { entered(); await gate; await route.continue(); });
  page.once('dialog', dialog => dialog.accept());
  await eligible.getByRole('button', { name: 'Resolve question', exact: true }).click();
  await start;
  await page.locator('fieldset[disabled]').waitFor();
  assert.equal(await page.getByLabel('Question', { exact: true }).isDisabled(), true);
  release();
  await page.getByText('Pending question resolved. Refresh pending questions to check remaining information.', { exact: true }).waitFor();
  await page.unroute('**/resolve-pending-answer');
  assert.equal(await page.getByLabel('Question', { exact: true }).count(), 0);
  const updated = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.deepEqual(updated.pendingFields.map(field => field.reference), [sensitiveReference]);
  assert.deepEqual(updated.answerKeys, [key]);
  assert.equal(JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8')).jobs[job.id].status, 'needs_info');
  await refresh.click();
  await panel.getByText('Sensitive pending confirmation?', { exact: true }).waitFor();
  assert.equal(await panel.getByText('Pending browser location?', { exact: true }).count(), 0);
  assert.doesNotMatch(await panel.innerText(), /PRIVATE-PENDING-BROWSER/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  return { list: true, openSavedAnswer: true, dirtyGuard: true, saveInvalidation: true, declinedConfirmation: true, resolution: true, busyEditorGuard: true, sensitiveIneligible: true, valueFree: true, narrow: true };
}
