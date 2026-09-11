import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Only the caller's disposable native fixture is mutated; Python is absent from PATH.
export async function jobTrashBrowser(page, root, fixture, buildRoot) {
  const execute = promisify(execFile);
  async function cli(command, args = [], payload) {
    if (payload !== undefined) {
      const input = join(fixture.root, 'job-trash-browser-input.json');
      await writeFile(input, JSON.stringify(payload), { mode: 0o600 });
      args = [...args, '--input', input];
    }
    const result = await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-jobs.js'),
      '--root', root, '--native-lock', fixture.receipt.artifact, command, ...args], { env: { PATH: '' } });
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  }
  const authorization = await page.evaluate(() => `Bearer ${sessionStorage.getItem('jobApplyWorkspaceToken')}`);
  async function api(path, body) {
    const response = await page.request.fetch(new URL(path, page.url()).href, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: authorization, Origin: new URL(page.url()).origin }, data: body,
    });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  }
  const role = 'Recoverable native browser job';
  const job = await cli('job-create', [], { role, company: 'Trash fixture company',
    url: 'https://example.invalid/trash-browser?private=trash', notes: 'PRIVATE-TRASH-NOTES' });
  const args = revision => ['--id', job.id, '--expected-revision', String(revision)];
  const navigation = page.getByRole('navigation', { name: 'Workspace sections' });
  const modal = page.getByRole('dialog', { name: 'Edit job', exact: true });
  const card = page.getByRole('button', { name: new RegExp(role) });
  await navigation.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await card.click();
  const company = modal.locator('[name="company"]');
  await company.fill('Unsaved trash browser draft');
  const trashed = await cli('job-trash', args(job.revision));
  assert.equal(trashed.revision, job.revision + 1);
  assert.equal(typeof trashed.deletedAt, 'string');
  assert.equal(await company.inputValue(), 'Unsaved trash browser draft');
  // External lifecycle changes must not replace the owner's current editor draft.
  await company.fill(job.company);
  await modal.getByRole('button', { name: 'Close job details', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  const beforeList = await readFile(join(root, 'jobs.json'), 'utf8');
  const listed = await cli('trash-list');
  assert.deepEqual(await api('/api/trash'), listed);
  assert.equal(await readFile(join(root, 'jobs.json'), 'utf8'), beforeList);
  const item = listed.items.find(value => value.type === 'job' && value.id === job.id);
  assert.deepEqual(item, { type: 'job', id: job.id, revision: trashed.revision,
    deletedAt: trashed.deletedAt, label: role, secondaryLabel: job.company,
    status: job.status, blockerCounts: { claims: 0, nonterminalSessions: 0 } });
  assert.doesNotMatch(JSON.stringify(listed), /PRIVATE-TRASH-NOTES|private=trash/);
  await assert.rejects(cli('job-restore', args(job.revision)), /revision conflict/);
  assert.equal(await readFile(join(root, 'jobs.json'), 'utf8'), beforeList);
  const restored = await api(`/api/jobs/${job.id}/restore`, { expectedRevision: trashed.revision });
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.revision, trashed.revision + 1);
  await page.reload();
  await navigation.getByRole('button', { name: 'Jobs', exact: true }).click();
  await card.filter({ hasText: new RegExp(`revision ${restored.revision}$`) }).click();
  assert.equal(await company.inputValue(), job.company);
  assert.equal(await modal.locator('[name="notes"]').inputValue(), job.notes);
  await modal.getByRole('button', { name: 'Close job details', exact: true }).click();
  const again = await api(`/api/jobs/${job.id}/trash`, { expectedRevision: restored.revision });
  assert.equal(again.revision, restored.revision + 1);
  const final = await cli('job-restore', args(again.revision));
  assert.equal(final.deletedAt, null);
  assert.equal((await api('/api/trash')).items.some(value => value.type === 'job' && value.id === job.id), false);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await card.filter({ hasText: new RegExp(`revision ${final.revision}$`) }).click();
  assert.equal(await company.inputValue(), job.company);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await modal.getByRole('button', { name: 'Close job details', exact: true }).click();
  const deletion = await cli('job-trash', args(final.revision));
  const beforeDelete = await readFile(join(root, 'jobs.json'), 'utf8');
  await assert.rejects(cli('job-delete', args(final.revision)), /revision conflict/);
  assert.equal(await readFile(join(root, 'jobs.json'), 'utf8'), beforeDelete);
  assert.deepEqual(await api(`/api/jobs/${job.id}/delete`, { expectedRevision: deletion.revision }),
    { deleted: true, id: job.id });
  assert.deepEqual(await cli('job-delete', args(deletion.revision)), { deleted: false, id: job.id });
  assert.equal((await api('/api/trash')).items.some(value => value.id === job.id), false);
  await page.reload();
  await navigation.getByRole('button', { name: 'Jobs', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  assert.equal(JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8')).jobs[job.id], undefined);
  return { cliTrashHidden: true, apiRestoreReload: true, apiTrashCliRestore: true,
    apiDeleteCliNoop: true, deletedAbsentAfterReload: true, redactedListingAgreement: true, listingReadOnly: true, staleRevisionRejected: true,
    externalDraftPreserved: true, restoredContentPreserved: true, pythonAbsentFromPath: true };
}
