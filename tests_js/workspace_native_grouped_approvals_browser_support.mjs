import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshot } from './workspace_native_claims_support.mjs';

// The caller owns this newly initialized, disposable v9 fixture and its browser.
export async function nativeGroupedApprovalsBrowser(page, root, fixture, buildRoot) {
  const execute = promisify(execFile), id = 'grouped-browser-job', key = 'grouped-browser-answer';
  async function cli(command, args = [], payload) {
    if (payload !== undefined) {
      const input = join(fixture.root, 'grouped-browser-input.json');
      await writeFile(input, JSON.stringify(payload), { mode: 0o600 });
      args = [...args, '--input', input];
    }
    const result = await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-jobs.js'),
      '--root', root, '--native-lock', fixture.receipt.artifact, command, ...args], { env: { PATH: '' } });
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  }
  await cli('answer-put', [], { key, question: 'Grouped fixture authorization?', state: 'confirmed',
    value: 'PRIVATE-GROUPED-BROWSER-VALUE', scope: { ats: 'greenhouse' }, fieldClass: 'authorization' });
  await cli('job-create', [], { id, url: 'https://example.invalid/grouped-browser', ats: 'greenhouse',
    role: 'Grouped fixture role', company: 'Grouped fixture company' });
  await cli('task-select', ['--id', id, '--expected-revision', '1', '--owner-confirmed']);
  const acquired = await cli('job-acquire', ['--id', id, '--expected-revision', '2', '--owner', 'Fixture browser']);
  await cli('claim-handoff', ['--id', id, '--token', acquired.token, '--status', 'needs_info', '--expected-revision', '3'],
    { status: 'active', pendingFields: [{ question: 'Grouped fixture authorization?', state: 'missing',
      answerKey: key, sensitive: false, fieldClass: 'authorization', scope: { ats: 'greenhouse' } }] });
  const sessionPath = join(root, 'sessions', `${id}.json`);
  const session = JSON.parse(await readFile(sessionPath, 'utf8'));
  const activity = await cli('job-activity', ['--id', id]);
  const args = ['--id', id, '--expected-job-revision', String(activity.job.revision),
    '--expected-session-revision', String(activity.session.revision)];
  const payload = { decisions: [{ reference: session.pendingFields[0].reference, answerKey: key,
    currentUse: true, remember: false, policyMode: 'strict', useAuthority: 'accepted_record', allowedSensitiveFieldClasses: [] }] };
  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: /Grouped fixture role/ }).click();
  const modal = page.getByRole('dialog', { name: 'Edit job', exact: true });
  const panel = modal.getByRole('region', { name: 'Job activity', exact: true });
  await panel.getByText('1 pending items · 0 current session approvals', { exact: true }).waitFor();
  const before = await snapshot(root);
  const preview = await cli('approval-preview', args, payload);
  assert.equal(preview.mutated, false);
  assert.equal(preview.approvals[0].eligible, true);
  assert.deepEqual(await snapshot(root), before);
  const approved = await cli('approval-approve', [...args, '--preview-token', preview.previewToken, '--owner-confirmed'], payload);
  assert.equal(approved.approved, true);
  const after = await snapshot(root);
  assert.notEqual(after[`sessions/${id}.json`], before[`sessions/${id}.json`]);
  delete before[`sessions/${id}.json`]; delete after[`sessions/${id}.json`];
  assert.deepEqual(after, before, 'approval writes only the selected session');
  const refreshed = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${id}/activity`));
  await panel.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  const response = await refreshed;
  assert.equal(response.status(), 200);
  const projected = await response.json();
  assert.deepEqual(projected.session.approvals, approved.approvals);
  assert.equal(projected.session.revision, approved.sessionRevision);
  await panel.getByText('1 pending items · 1 current session approvals', { exact: true }).waitFor();
  await panel.getByText(/Current session approval recorded\./).waitFor();
  assert.doesNotMatch(await panel.innerText(), /PRIVATE-GROUPED-BROWSER-VALUE/);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE-GROUPED-BROWSER-VALUE|tokenHash/);
  // A later answer revision makes the persisted approval stale in the existing projection.
  await cli('answer-update', ['--key', key, '--expected-revision', '1'], { source: 'Fixture revision change' });
  await panel.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  await panel.getByText('1 pending items · 0 current session approvals', { exact: true }).waitFor();
  await panel.getByText(/No current session approval\./).waitFor();
  assert.equal(JSON.parse(await readFile(sessionPath, 'utf8')).approvals.length, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await modal.getByRole('button', { name: 'Close job details', exact: true }).click();
  return { previewReadOnly: true, sessionOnlyCommit: true, activityRefresh: true,
    approvalInvalidation: true, valueFree: true, narrow: true, pythonAbsentFromPath: true };
}
