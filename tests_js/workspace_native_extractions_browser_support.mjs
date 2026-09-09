import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const execute = promisify(execFile);

export async function nativeExtractionsBrowser(page, root, fixture, buildRoot) {
  const input = join(fixture.root, 'extraction-browser-input.json');
  const document = async name => JSON.parse(await readFile(join(root, `${name}.json`), 'utf8'));
  async function cli(command, args = [], body) {
    if (body !== undefined) { await writeFile(input, JSON.stringify(body)); args = [...args, '--input', input]; }
    return JSON.parse((await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-jobs.js'),
      '--root', root, '--native-lock', fixture.receipt.artifact, command, ...args], { env: { PATH: '' } })).stdout);
  }
  const resume = Object.values((await document('resumes')).resumes)[0];
  let profile = await document('profile');
  await cli('profile-patch', ['--source', 'user', '--expected-revision', String(profile.metadata.revision)], { employer: ['Existing employer'] });
  await page.getByRole('button', { name: 'Resume extraction', exact: true }).click();
  await page.getByLabel('Resume to extract').selectOption(resume.id);
  await page.getByRole('button', { name: 'Request extraction', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel extraction', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel extraction', exact: true }).click();
  await page.getByText('Extraction request cancelled.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Request extraction', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel extraction', exact: true }).waitFor();
  const request = Object.values((await document('resume-extraction-requests')).requests).find(item => item.status === 'requested');
  profile = await document('profile');
  const result = await cli('resume-extraction-request-complete', ['--id', request.requestId,
    '--expected-request-revision', '1', '--expected-profile-revision', String(profile.metadata.revision)],
  { firstName: 'Extracted name', employer: { title: 'Engineer' }, extractedCity: 'Remote' });
  await page.getByRole('button', { name: 'Refresh extraction status', exact: true }).click();
  await page.getByRole('button', { name: 'Review extraction result', exact: true }).click();
  try { await page.getByLabel('Decision for /firstName', { exact: true }).selectOption('keep_current', { timeout: 5000 }); }
  catch (error) { throw Error(error.message + '\n' + await page.locator('body').innerText()); }
  await page.getByLabel('Decision for /employer/title', { exact: true }).selectOption('use_extracted');
  await page.getByRole('button', { name: 'Save review decisions', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /Confirm replacement/ }).waitFor();
  await page.getByLabel('I confirm replacing /employer for /employer/title.').check();
  profile = await document('profile');
  await cli('profile-patch', ['--source', 'user', '--expected-revision', String(profile.metadata.revision)], { concurrentNote: 'Keep this' });
  await page.getByRole('button', { name: 'Save review decisions', exact: true }).click();
  await page.getByRole('button', { name: 'Reapply my decisions', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Decision for /employer/title', { exact: true }).inputValue(), 'use_extracted');
  await page.getByRole('button', { name: 'Reapply my decisions', exact: true }).click();
  assert.equal(await page.getByLabel('I confirm replacing /employer for /employer/title.').isChecked(), false);
  await page.getByLabel('I confirm replacing /employer for /employer/title.').check();
  await page.getByRole('button', { name: 'Save review decisions', exact: true }).click();
  await page.getByText('Review decisions saved.', { exact: true }).waitFor();
  await page.getByText('This proposal is complete. No further review is needed.', { exact: true }).waitFor();
  profile = await document('profile');
  assert.equal(profile.profile.employer.title, 'Engineer');
  assert.equal(profile.profile.concurrentNote, 'Keep this');
  assert.equal(profile.metadata.factProvenance['/extractedCity'].source, 'resume');
  assert.equal(profile.metadata.factProvenance['/employer/title'].source, 'user');
  assert.equal((await document('resume-extractions')).proposals[result.proposalSummary.id].status, 'completed');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  return { requestCancel: true, cliCompletion: true, replacementConsent: true, conflictReapply: true, provenance: true, narrow: true };
}
