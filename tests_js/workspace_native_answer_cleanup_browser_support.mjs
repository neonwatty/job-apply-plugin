import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function nativeAnswerCleanupBrowser(page, root, cli) {
  const panel = page.getByRole('region', { name: 'Cleanup preview', exact: true });
  await page.getByRole('button', { name: 'Preview cleanup', exact: true }).click();
  await panel.getByText('No clear duplicates found.', { exact: true }).waitFor();
  await cli('answer-put', JSON.stringify({ key: 'cleanup-winner', question: 'Does the applicant have permission to work in this jurisdiction?', state: 'confirmed', value: 'PRIVATE-CLEANUP-BROWSER', fieldClass: 'authorization', sensitivity: 'personal' }), ['--remember-sensitive']);
  await cli('answer-observe', JSON.stringify({ question: 'Is employment authorization available in the country?', state: 'missing', fieldClass: 'authorization', sensitivity: 'personal' }));
  const before = await readFile(join(root, 'answers.json'), 'utf8');
  await page.getByRole('button', { name: 'Preview cleanup', exact: true }).click();
  await panel.getByText('Does the applicant have permission to work in this jurisdiction?', { exact: true }).waitFor();
  await panel.getByText('Is employment authorization available in the country?', { exact: true }).waitFor();
  assert.doesNotMatch(await panel.innerText(), /PRIVATE-CLEANUP-BROWSER|answer-cleanup-v1/);
  assert.equal(await readFile(join(root, 'answers.json'), 'utf8'), before);
  await page.route('**/api/answers/cleanup-preview', route => route.fulfill({ status: 503, body: '{"error":"Preview temporarily unavailable"}', contentType: 'application/json' }));
  await page.getByRole('button', { name: 'Preview cleanup', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  assert.equal(await panel.getByText('Does the applicant have permission to work in this jurisdiction?', { exact: true }).count(), 0);
  await page.unroute('**/api/answers/cleanup-preview');
  await page.getByRole('button', { name: 'Preview cleanup', exact: true }).click();
  await panel.getByText('Does the applicant have permission to work in this jurisdiction?', { exact: true }).waitFor();
  await page.getByLabel('Source', { exact: true }).fill('cleanup-preview-invalidation');
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await page.getByText('Answer saved.', { exact: true }).waitFor();
  await panel.getByText('Does the applicant have permission to work in this jurisdiction?', { exact: true }).waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  return { proposals: true, empty: true, retry: true, valueFree: true, noMutation: true, saveInvalidation: true, narrow: true };
}
