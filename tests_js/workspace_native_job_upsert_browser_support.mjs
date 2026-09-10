import assert from 'node:assert/strict';

// The caller owns an isolated native fixture; every upsert uses the native CLI.
export async function jobUpsertBrowser(page, { upsert, readDocument }) {
  const navigation = page.getByRole('navigation', { name: 'Workspace sections' });
  const modal = page.getByRole('dialog', { name: 'Edit job', exact: true });
  const role = 'Native batch capture role';
  const url = 'https://example.invalid/native-batch-capture';
  const payload = { jobs: [{ url, role, company: 'Batch company' }] };
  const expected = { create: 1, update: 0, noop: 0, conflict: 0, invalid: 0 };
  let navigationPrompts = 0;
  const dismiss = dialog => { navigationPrompts++; return dialog.dismiss(); };
  page.on('dialog', dismiss);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const before = await readDocument();
    const preview = await upsert(payload, 'agent');
    assert.equal(preview.committed, false);
    assert.deepEqual(preview.summary, expected);
    assert.match(preview.token, /^job-upsert-v1\.[a-f0-9]{64}$/);
    assert.equal(await readDocument(), before, 'preview leaves canonical Jobs bytes unchanged');
    await navigation.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.locator('[data-job-create]:enabled').waitFor();
    assert.equal(await page.getByRole('button', { name: new RegExp(role) }).count(), 0);

    const committed = await upsert(payload, 'agent', preview.token);
    assert.equal(committed.committed, true);
    assert.deepEqual(committed.summary, preview.summary);
    assert.deepEqual(committed.decisions, preview.decisions);
    const id = committed.decisions[0].id;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(role) }).click();
    assert.equal(await modal.locator('[name="company"]').inputValue(), 'Batch company');
    await modal.locator('[name="company"]').fill('Human-reviewed company');
    await modal.getByRole('button', { name: 'Save job', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    const humanRecord = JSON.parse(await readDocument()).jobs[id];
    assert.equal(humanRecord.company, 'Human-reviewed company');
    assert.equal(humanRecord.provenance['/company'].origin, 'human');

    // ATS is not included in the browser's full editor patch, so it remains
    // unattributed; explicitly human-stamped empty fields must stay protected.
    const incoming = { jobs: [{ url, company: 'Agent replacement', ats: 'Fixture ATS' }] };
    const beforeUpdate = await readDocument();
    const updatePreview = await upsert(incoming, 'agent');
    assert.deepEqual(updatePreview.summary, { create: 0, update: 1, noop: 0, conflict: 0, invalid: 0 });
    assert.deepEqual(updatePreview.decisions, [{ index: 0, action: 'update', id, fields: ['ats'] }]);
    assert.equal(await readDocument(), beforeUpdate);
    const update = await upsert(incoming, 'agent', updatePreview.token);
    assert.equal(update.committed, true);
    assert.deepEqual(update.summary, updatePreview.summary);
    assert.deepEqual(update.decisions, updatePreview.decisions);
    const updated = JSON.parse(await readDocument()).jobs[id];
    assert.equal(updated.company, humanRecord.company);
    assert.deepEqual(updated.provenance['/company'], humanRecord.provenance['/company']);
    assert.equal(updated.ats, 'Fixture ATS');
    assert.equal(updated.provenance['/ats'].origin, 'agent');
    assert.equal(updated.revision, humanRecord.revision + 1);

    await navigation.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByRole('heading', { name: 'Your next step', exact: true }).waitFor();
    await page.reload();
    await navigation.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.locator('[data-job-create]:enabled').waitFor();
    await page.getByRole('button', { name: new RegExp(role) }).click();
    assert.equal(await modal.locator('[name="company"]').inputValue(), 'Human-reviewed company');
    assert.equal(await modal.locator('[name="role"]').inputValue(), role);
    assert.equal(JSON.parse(await readDocument()).jobs[id].ats, 'Fixture ATS');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await modal.getByRole('button', { name: 'Close job details', exact: true }).click();
    await navigation.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByRole('heading', { name: 'Your next step', exact: true }).waitFor();
    assert.equal(navigationPrompts, 0, 'acknowledged CLI/browser writes leave no false unsaved draft');
    return { previewReadOnly: true, cliCommitVisible: true, humanProvenancePreserved: true,
      agentFillsNewField: true, previewCommitAgreement: true, reload: true, cleanNavigation: true, narrowViewport: true };
  } finally {
    page.off('dialog', dismiss);
  }
}
