import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The caller supplies a disposable v9 fixture with synthetic preflight-ready facts/resume.
export async function taskCliBrowser(page, root, fixture, buildRoot) {
  const execute = promisify(execFile);
  async function cli(command, args = [], payload, expectedCode = 0) {
    if (payload !== undefined) {
      const input = join(fixture.root, 'task-wrapper-browser-input.json');
      await writeFile(input, JSON.stringify(payload), { mode: 0o600 });
      args = [...args, '--input', input];
    }
    let result;
    try {
      result = await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-task.js'),
        '--root', root, '--native-lock', fixture.receipt.artifact, command, ...args], { env: { PATH: '' } });
      assert.equal(expectedCode, 0);
    } catch (error) {
      assert.equal(error.code, expectedCode);
      result = error;
    }
    assert.equal(result.stderr, '');
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, expectedCode === 0);
    if (value.ok) assert.equal(value.command, command);
    assert.doesNotMatch(result.stdout, /PRIVATE-WRAPPER-BROWSER|private=wrapper|tokenHash/);
    return value;
  }
  const role = 'Task wrapper browser role';
  const created = await cli('intake', [], { role, company: 'Task wrapper company',
    url: 'https://example.invalid/task-wrapper?private=wrapper', description: 'PRIVATE-WRAPPER-BROWSER' });
  assert.equal(created.action, 'create');
  const id = created.job.id;
  assert.deepEqual((await cli('snapshot')).snapshot.jobs.find(job => job.id === id), created.job);
  const navigation = page.getByRole('navigation', { name: 'Workspace sections' });
  await navigation.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(role) }).click();
  const modal = page.getByRole('dialog', { name: 'Edit job', exact: true });
  assert.equal(await modal.locator('[name="company"]').inputValue(), 'Task wrapper company');
  const panel = modal.getByRole('region', { name: 'Job activity', exact: true });
  await panel.getByText(/Status: saved/i).waitFor();
  const initialActivity = await cli('activity', ['--id', id]);
  assert.equal(initialActivity.jobId, id);
  assert.equal(initialActivity.activity.job.status, 'saved');
  const jobsPath = join(root, 'jobs.json');
  const before = await readFile(jobsPath, 'utf8');
  const selectArgs = ['--id', id, '--expected-revision', String(created.job.revision)];
  const denied = await cli('select', selectArgs, undefined, 2);
  assert.deepEqual(denied, { ok: false, error: { code: 'owner_confirmation_required',
    message: 'Explicit owner confirmation is required.' } });
  assert.equal(await readFile(jobsPath, 'utf8'), before);
  const selected = await cli('select', [...selectArgs, '--owner-confirmed']);
  assert.equal(selected.action, 'ready');
  assert.equal(selected.job.status, 'ready');
  assert.equal(selected.job.revision, created.job.revision + 1);
  const activity = await cli('activity', ['--id', id]);
  assert.equal(activity.activity.job.status, 'ready');
  assert.equal(activity.activity.job.revision, selected.job.revision);
  assert.deepEqual((await cli('snapshot')).snapshot.jobs.find(job => job.id === id), selected.job);
  // Reload closes the old editor and loads the canonical revision before reopening.
  await page.reload();
  await navigation.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(role) })
    .filter({ hasText: new RegExp(`revision ${selected.job.revision}$`) }).click();
  await panel.getByText(/Status: ready/i).waitFor();
  assert.equal(await modal.locator('[name="company"]').inputValue(), 'Task wrapper company');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await modal.getByRole('button', { name: 'Close job details', exact: true }).click();
  return { intakeVisible: true, envelopes: true, ownerConfirmationRequired: true,
    canonicalReload: true, activitySnapshotAgreement: true, pythonAbsentFromPath: true };
}
