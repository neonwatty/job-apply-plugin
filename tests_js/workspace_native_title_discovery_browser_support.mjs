import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
const execute = promisify(execFile);

export async function nativeTitleDiscoveryBrowser(page, root, fixture, buildRoot) {
  const profilePath = join(root, 'profile.json');
  if (!await page.getByLabel('firstName', { exact: true }).count()) {
    await page.getByRole('button', { name: 'Add a fact', exact: true }).click();
    await page.getByLabel('Fact name', { exact: true }).fill('firstName');
    await page.getByRole('button', { name: 'Add fact', exact: true }).click();
  }
  await page.getByLabel('firstName', { exact: true }).fill('Unsent facts draft');
  const before = JSON.parse(await readFile(profilePath, 'utf8'));
  const panel = page.locator('#title-discovery');
  await panel.getByRole('button', { name: 'Discover related titles' }).click();
  await panel.getByLabel(/Role interests, constraints/).fill('Adjacent ML roles; no director roles');
  await panel.getByRole('button', { name: 'Copy Codex invocation' }).click();
  await panel.getByText(/invocation copied|Clipboard unavailable/).waitFor();
  await panel.getByRole('button', { name: 'Cancel discovery' }).click();
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), before);

  await panel.getByRole('button', { name: 'Discover related titles' }).click();
  const unavailable = await readFile(new URL('./fixtures/title-discovery/unavailable.json', import.meta.url), 'utf8');
  await panel.getByLabel('Title discovery JSON result packet').fill(unavailable);
  await panel.getByRole('button', { name: 'Review packet' }).click();
  await panel.getByText('Research source: logged out').waitFor();
  assert.equal(await panel.getByText(/No browser evidence was available/).count(), 1);
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), before);
  await panel.getByLabel('Title discovery JSON result packet').fill('{invalid');
  await panel.getByRole('button', { name: 'Review packet' }).click();
  await panel.getByRole('alert').filter({ hasText: 'Paste a valid title discovery JSON packet.' }).waitFor();
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), before);

  const observed = await readFile(new URL('./fixtures/title-discovery/observed.json', import.meta.url), 'utf8');
  await panel.getByLabel('Title discovery JSON result packet').fill(observed);
  await panel.getByRole('button', { name: 'Review packet' }).click();
  const adjacent = panel.locator('.title-discovery-choice').filter({ hasText: 'Staff Machine Learning Engineer' });
  await adjacent.getByRole('checkbox').check();
  await panel.locator('.title-discovery-choice').filter({ hasText: 'Machine Learning Engineer' }).first()
    .getByRole('button', { name: 'Remove Machine Learning Engineer' }).click();
  await panel.locator('.title-discovery-choice').filter({ hasText: 'Director of AI' }).getByRole('textbox', { name: 'Title' }).fill('Director of Applied AI');
  assert.match(await panel.locator('.title-discovery-preview').innerText(), /Staff Machine Learning Engineer/);
  assert.doesNotMatch(await panel.locator('.title-discovery-preview').innerText(), /Director of AI/);

  const current = await page.evaluate(async () => {
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    return (await fetch('/api/profile', { headers: { Authorization: `Bearer ${token}` } })).json();
  });
  const externalPatch = join(fixture.root, 'title-discovery-external-patch.json');
  await writeFile(externalPatch, JSON.stringify({ phone: 'Concurrent phone' }));
  await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-jobs.js'), '--root', root,
    '--native-lock', fixture.receipt.artifact, 'profile-patch', '--input', externalPatch,
    '--expected-revision', String(current.revision), '--source', 'user'], { env: { PATH: '' } });
  await panel.getByRole('button', { name: 'Confirm and save exact titles' }).click();
  await panel.getByRole('button', { name: 'Reload saved titles for review' }).waitFor();
  assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).profile.preferences?.targetTitles, undefined);
  await panel.getByRole('button', { name: 'Reload saved titles for review' }).click();
  await panel.getByText('Your title selections and edits are retained.').waitFor();
  assert.equal(await adjacent.getByRole('checkbox').isChecked(), true);
  assert.equal(await panel.locator('.title-discovery-choice').filter({ hasText: 'Machine Learning Engineer' }).count(), 1);
  assert.equal(await panel.locator('.title-discovery-choice').filter({ hasText: 'Director of Applied AI' }).getByRole('textbox', { name: 'Title' }).inputValue(), 'Director of Applied AI');
  assert.match(await panel.locator('.title-discovery-preview').innerText(), /Staff Machine Learning Engineer/);
  await panel.getByRole('button', { name: 'Confirm and save exact titles' }).click();
  await panel.getByText(/Target titles saved/).waitFor();
  const saved = JSON.parse(await readFile(profilePath, 'utf8'));
  assert.deepEqual(saved.profile.preferences.targetTitles, ['Staff Machine Learning Engineer']);
  assert.equal(saved.profile.preferences.remote, before.profile.preferences?.remote);
  assert.equal(saved.profile.phone, 'Concurrent phone');
  assert.equal(await page.getByLabel('firstName', { exact: true }).inputValue(), 'Unsent facts draft');
  await page.getByRole('button', { name: 'Reapply my facts draft' }).waitFor();

  await panel.getByRole('button', { name: 'Discover related titles' }).click();
  await panel.getByLabel('Title discovery JSON result packet').fill(observed);
  await panel.getByRole('button', { name: 'Review packet' }).click();
  const director = panel.locator('.title-discovery-choice').filter({ hasText: 'Director of AI' });
  await director.getByRole('checkbox').check();
  const revision = await page.evaluate(async () => {
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    return (await fetch('/api/profile', { headers: { Authorization: `Bearer ${token}` } })).json();
  });
  await writeFile(externalPatch, JSON.stringify({ preferences: { targetTitles: ['Concurrent Architect'] } }));
  await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-jobs.js'), '--root', root,
    '--native-lock', fixture.receipt.artifact, 'profile-patch', '--input', externalPatch,
    '--expected-revision', String(revision.revision), '--source', 'user'], { env: { PATH: '' } });
  await panel.getByRole('button', { name: 'Confirm and save exact titles' }).click();
  await panel.getByRole('button', { name: 'Reload saved titles for review' }).click();
  await panel.getByText('Saved target titles changed elsewhere.', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Confirm and save exact titles' }).isDisabled(), true);
  assert.match(await panel.locator('.title-discovery-preview').innerText(), /Director of AI/);
  assert.match(await panel.locator('.title-discovery-preview').innerText(), /Concurrent Architect/);
  await panel.getByRole('button', { name: 'I reviewed the changed titles and exact preview' }).click();
  await panel.getByRole('button', { name: 'Confirm and save exact titles' }).click();
  await panel.getByText(/Target titles saved/).waitFor();
  const reconciled = JSON.parse(await readFile(profilePath, 'utf8'));
  assert.deepEqual(reconciled.profile.preferences.targetTitles,
    ['Staff Machine Learning Engineer', 'Director of AI', 'Concurrent Architect']);
  assert.equal(await page.getByLabel('firstName', { exact: true }).inputValue(), 'Unsent facts draft');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Discard facts changes' }).click();
  return { cancel: true, unavailable: true, exactSave: true, conflictRetry: true, canonicalReconciliation: true, factsDraft: true };
}
