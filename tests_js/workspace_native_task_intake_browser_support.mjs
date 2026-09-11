import assert from 'node:assert/strict';

// The caller owns a synthetic Store and invokes intake through the native CLI.
export async function taskIntakeBrowser(page, { intake, snapshot, readDocument }) {
  const navigation = page.getByRole('navigation', { name: 'Workspace sections' });
  const modal = page.getByRole('dialog', { name: 'Edit job', exact: true });
  const role = 'Native single-task capture role';
  const url = 'https://example.invalid/native-task-capture?private=fixture';
  const payload = { url, role, company: 'Task company', description: 'Private fixture description' };
  let navigationPrompts = 0;
  const dismiss = dialog => { navigationPrompts++; return dialog.dismiss(); };
  page.on('dialog', dismiss);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const created = await intake(payload);
    assert.equal(created.action, 'create');
    assert.deepEqual(Object.keys(created).sort(), ['action', 'job']);
    const id = created.job.id;
    const checkProjection = async result => {
      assert.deepEqual((await snapshot()).jobs.find(job => job.id === id), result.job);
      for (const key of ['url', 'normalizedUrl', 'description', 'notes', 'provenance', 'legacySources', 'claimToken']) {
        assert.equal(Object.hasOwn(result.job, key), false, `${key} must not appear in task output`);
      }
      assert.equal(JSON.stringify(result).includes('Private fixture description'), false);
      assert.equal(JSON.stringify(result).includes('private=fixture'), false);
    };
    await checkProjection(created);
    const beforeRepeat = await readDocument();
    const repeated = await intake(payload);
    assert.equal(repeated.action, 'noop');
    assert.deepEqual(repeated.job, created.job);
    assert.equal(await readDocument(), beforeRepeat);

    await navigation.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.locator('[data-job-create]:enabled').waitFor();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(role) }).click();
    assert.equal(await modal.locator('[name="company"]').inputValue(), 'Task company');
    await modal.locator('[name="company"]').fill('Human task company');
    await modal.getByRole('button', { name: 'Save job', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    const human = JSON.parse(await readDocument()).jobs[id];
    assert.equal(human.provenance['/company'].origin, 'human');

    // ATS is absent from the editor patch and remains eligible for agent intake.
    const incoming = { url, company: 'Agent task replacement', ats: 'Task fixture ATS' };
    const updated = await intake(incoming, 'agent');
    assert.equal(updated.action, 'update');
    assert.equal(updated.job.id, id);
    assert.equal(updated.job.company, human.company);
    await checkProjection(updated);
    const stored = JSON.parse(await readDocument()).jobs[id];
    assert.equal(stored.ats, 'Task fixture ATS');
    assert.equal(stored.revision, human.revision + 1);
    assert.deepEqual(stored.provenance['/company'], human.provenance['/company']);
    const beforeNoop = await readDocument();
    assert.equal((await intake(incoming)).action, 'noop');
    assert.equal(await readDocument(), beforeNoop);
    assert.equal(Object.values(JSON.parse(beforeNoop).jobs).filter(job => job.id === id).length, 1);

    await page.reload();
    await navigation.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.locator('[data-job-create]:enabled').waitFor();
    await page.getByRole('button', { name: new RegExp(role) }).click();
    assert.equal(await modal.locator('[name="company"]').inputValue(), 'Human task company');
    assert.equal(await modal.locator('[name="role"]').inputValue(), role);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await modal.getByRole('button', { name: 'Close job details', exact: true }).click();
    await navigation.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByRole('heading', { name: 'Your next step', exact: true }).waitFor();
    assert.equal(navigationPrompts, 0);
    return { cliIntakeVisible: true, duplicateNoop: true, humanProvenancePreserved: true,
      redactedSnapshotAgreement: true, reload: true, cleanNavigation: true, narrowViewport: true };
  } finally {
    page.off('dialog', dismiss);
  }
}
