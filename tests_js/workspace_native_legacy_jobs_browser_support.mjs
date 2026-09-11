import assert from 'node:assert/strict';

// All report mutations and CLI calls are scoped to the caller's synthetic HOME.
export async function legacyJobsBrowser(page, { legacy, writeReport, readDocument }) {
  const navigation = page.getByRole('navigation', { name: 'Workspace sections' });
  const modal = page.getByRole('dialog', { name: 'Edit job', exact: true });
  const role = 'Native legacy report role';
  const originalUrl = 'https://example.invalid/native-legacy-original';
  const report = url => `# Synthetic legacy report\n### 1. ${role} — Legacy company\n- **URL**: ${url}\n`;
  await writeReport(report(originalUrl));
  const before = await readDocument();
  const discovery = await legacy('legacy-jobs-preview', []);
  assert.equal(discovery.items.length, 1);
  const itemId = discovery.items[0].itemId;
  const preview = await legacy('legacy-jobs-preview', [itemId]);
  assert.equal(preview.committed, false);
  assert.equal(preview.summary.create, 1);
  assert.match(preview.token, /^legacy-jobs-v1\.[a-f0-9]{64}$/);
  assert.equal(await readDocument(), before, 'discovery and selected preview are read-only');
  await navigation.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.locator('[data-job-create]:enabled').waitFor();
  assert.equal(await page.getByRole('button', { name: new RegExp(role) }).count(), 0);
  const committed = await legacy('legacy-jobs-commit', [itemId], preview.token);
  assert.equal(committed.committed, true);
  assert.deepEqual(committed.decisions, preview.decisions);
  const id = committed.decisions[0].id;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(role) }).click();
  assert.equal(await modal.locator('[name="company"]').inputValue(), 'Legacy company');
  await modal.locator('[name="company"]').fill('Human legacy company');
  await modal.getByRole('button', { name: 'Save job', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  const human = JSON.parse(await readDocument()).jobs[id];
  assert.equal(human.provenance['/company'].origin, 'human');
  assert.equal(human.provenance['/url'].origin, 'migration');

  await writeReport(report('https://example.invalid/native-legacy-refreshed'));
  const beforeRefresh = await readDocument();
  const refreshPreview = await legacy('legacy-jobs-preview', [itemId]);
  assert.equal(refreshPreview.decisions[0].id, id, 'stable locator survives report URL changes');
  assert.equal(await readDocument(), beforeRefresh);
  const refresh = await legacy('legacy-jobs-commit', [itemId], refreshPreview.token);
  assert.equal(refresh.committed, true);
  const updated = JSON.parse(await readDocument()).jobs[id];
  assert.equal(updated.company, 'Human legacy company');
  assert.deepEqual(updated.provenance['/company'], human.provenance['/company']);
  // Only changed fields transfer ownership; the imported URL remains refreshable.
  assert.equal(updated.url, 'https://example.invalid/native-legacy-refreshed');
  assert.equal(updated.provenance['/url'].origin, 'migration');
  assert.equal(updated.legacySources.length, 1);
  assert.equal(updated.legacySources[0].entryId, human.legacySources[0].entryId);
  assert.notEqual(updated.legacySources[0].sourceSha256, human.legacySources[0].sourceSha256);
  const stale = await legacy('legacy-jobs-preview', [itemId]);
  await writeReport(report('https://example.invalid/native-legacy-refreshed') + '\nReport changed after preview\n');
  const beforeRejected = await readDocument();
  await assert.rejects(legacy('legacy-jobs-commit', [itemId], stale.token), /drifted/);
  assert.equal(await readDocument(), beforeRejected);

  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  // Refresh retains old cards while loading. Open only the acknowledged CLI revision.
  await page.getByRole('button', { name: new RegExp(role) })
    .filter({hasText: new RegExp(`revision ${updated.revision}$`)}).click();
  assert.equal(await modal.locator('[name="company"]').inputValue(), 'Human legacy company');
  assert.equal(await modal.locator('[name="url"]').inputValue(), updated.url);
  await modal.locator('[name="url"]').fill('https://example.invalid/human-legacy-url');
  await modal.getByRole('button', { name: 'Save job', exact: true }).click();
  await modal.waitFor({state:'hidden'});
  const humanUrlBytes = await readDocument();
  const conflictPreview = await legacy('legacy-jobs-preview', [itemId]);
  assert.equal(conflictPreview.decisions[0].action, 'conflict');
  const conflict = await legacy('legacy-jobs-commit', [itemId], conflictPreview.token);
  assert.equal(conflict.committed, false);
  assert.equal(await readDocument(), humanUrlBytes, 'human-owned URL conflicts leave Jobs unchanged');
  await navigation.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('heading', { name: 'Your next step', exact: true }).waitFor();
  return { discoveryReadOnly: true, previewReadOnly: true, cliCommitVisible: true,
    humanProvenancePreserved: true, sourceLocatorRefreshed: true, humanUrlConflict: true, staleTokenRejected: true };
}
