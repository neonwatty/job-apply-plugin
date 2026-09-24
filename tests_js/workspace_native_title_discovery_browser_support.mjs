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
  const discover = panel.getByRole('button', { name: 'Discover related titles' });
  await discover.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Discover and review target titles');
  await panel.getByLabel(/Role interests, constraints/).fill('Adjacent ML roles; no director roles');
  await panel.getByRole('button', { name: 'Copy Codex invocation' }).click();
  await panel.getByText(/invocation copied|Clipboard unavailable/).waitFor();
  await panel.getByRole('button', { name: 'Cancel discovery' }).click();
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), before);
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Discover related titles');

  await panel.getByRole('button', { name: 'Edit target titles' }).click();
  await panel.getByRole('button', { name: 'Confirm and save exact titles' }).click();
  await panel.getByText('Target titles already match the saved set. No changes were made.').waitFor();
  assert.equal(await page.getByText('Facts changed elsewhere.').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Save facts' }).isEnabled(), true);
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), before);

  await panel.getByRole('button', { name: 'Discover related titles' }).click();
  const unavailable = await readFile(new URL('./fixtures/title-discovery/unavailable.json', import.meta.url), 'utf8');
  await panel.getByLabel('Title discovery JSON result packet').fill(unavailable);
  await panel.getByRole('button', { name: 'Review packet' }).click();
  await panel.getByText('Research source: logged out').waitFor();
  assert.equal(await panel.getByText(/No browser evidence was available/).count(), 1);
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), before);
  await panel.getByLabel('Title discovery JSON result packet').fill(JSON.stringify({
    version: 1, source: { status: 'empty', detail: 'No matching listings were visible for these criteria.' }, suggestions: [],
  }));
  await panel.getByRole('button', { name: 'Review packet' }).click();
  await panel.getByText('Research source: empty').waitFor();
  assert.equal(await panel.locator('.title-discovery-choice').count(), 0);
  await panel.getByRole('button', { name: 'Copy Codex invocation' }).click();
  await panel.getByText(/invocation copied|Clipboard unavailable/).waitFor();
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), before);
  await panel.getByLabel('Title discovery JSON result packet').fill('{invalid');
  await panel.getByRole('button', { name: 'Review packet' }).click();
  await panel.getByRole('alert').filter({ hasText: 'Paste a valid title discovery JSON packet.' }).waitFor();
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), before);

  const observed = await readFile(new URL('./fixtures/title-discovery/observed.json', import.meta.url), 'utf8');
  await panel.getByLabel('Title discovery JSON result packet').fill(observed);
  await panel.getByRole('button', { name: 'Review packet' }).click();
  const adjacent = panel.locator('.title-discovery-choice').filter({ hasText: 'Staff Machine Learning Engineer' });
  await adjacent.getByRole('checkbox').focus();
  await page.keyboard.press('Space');
  assert.equal(await adjacent.getByRole('checkbox').isChecked(), true);
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
  await panel.getByRole('button', { name: 'Remove Concurrent Architect' }).click();
  assert.equal(await panel.getByRole('button', { name: 'Confirm and save exact titles' }).isDisabled(), true);
  await panel.getByRole('button', { name: 'Add title manually' }).click();
  await panel.locator('.title-discovery-choice').last().getByRole('textbox', { name: 'Title' }).fill('Concurrent Architect');
  await panel.getByRole('button', { name: 'I reviewed the changed titles and exact preview' }).click();
  await panel.getByRole('button', { name: 'Confirm and save exact titles' }).click();
  await panel.getByText(/Target titles saved/).waitFor();
  const reconciled = JSON.parse(await readFile(profilePath, 'utf8'));
  assert.deepEqual(reconciled.profile.preferences.targetTitles,
    ['Staff Machine Learning Engineer', 'Director of AI', 'Concurrent Architect']);
  assert.equal(await page.getByLabel('firstName', { exact: true }).inputValue(), 'Unsent facts draft');
  await panel.getByRole('button', { name: 'Discover related titles' }).click();
  await panel.getByRole('button', { name: 'Add title manually' }).click();
  await panel.locator('.title-discovery-choice').last().getByRole('textbox', { name: 'Title' }).fill('Principal ML Engineer');
  assert.match(await panel.locator('.title-discovery-preview').innerText(), /Principal ML Engineer/);
  let patchArrived;
  const interceptedPatch = new Promise(resolve => { patchArrived = resolve; });
  let releasePatch;
  const patchGate = new Promise(resolve => { releasePatch = resolve; });
  const delayPatch = async route => {
    if (route.request().method() === 'PATCH') {
      patchArrived();
      await patchGate;
    }
    await route.continue();
  };
  await page.route('**/api/profile', delayPatch);
  try {
    await panel.getByRole('button', { name: 'Confirm and save exact titles' }).click();
    await interceptedPatch;
    const cancelDuringSave = panel.getByRole('button', { name: 'Cancel discovery' });
    assert.equal(await cancelDuringSave.isDisabled(), true);
    await cancelDuringSave.evaluate(button => button.click());
    assert.equal(await panel.getByText('Saving selected titles…').count(), 1);
    assert.equal(await panel.getByText('Discovery canceled. No titles were saved.').count(), 0);
    assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), reconciled);
    releasePatch();
    await panel.getByText(/Target titles saved/).waitFor();
  } finally {
    releasePatch();
    await page.unroute('**/api/profile', delayPatch);
  }
  const delayedSaved = JSON.parse(await readFile(profilePath, 'utf8'));
  assert.deepEqual(delayedSaved.profile.preferences.targetTitles,
    ['Staff Machine Learning Engineer', 'Director of AI', 'Concurrent Architect', 'Principal ML Engineer']);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Discard facts changes' }).click();
  await panel.getByRole('button', { name: 'Edit target titles' }).click();
  const unchanged = JSON.parse(await readFile(profilePath, 'utf8'));
  await panel.getByRole('button', { name: 'Confirm and save exact titles' }).click();
  await panel.getByText('Target titles already match the saved set. No changes were made.').waitFor();
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), unchanged);
  await panel.getByRole('button', { name: 'Edit target titles' }).click();
  await panel.getByRole('button', { name: 'Add title manually' }).click();
  await panel.locator('.title-discovery-choice').last().getByRole('textbox', { name: 'Title' }).fill('Staff Forward Deployed Engineer');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await panel.locator('.title-discovery-choice').last().getByRole('textbox', { name: 'Title' }).waitFor();
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), unchanged);
  await panel.getByRole('button', { name: 'Cancel discovery' }).click();
  const currentRevision = await page.evaluate(async () => {
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    return (await fetch('/api/profile', { headers: { Authorization: `Bearer ${token}` } })).json();
  });
  await writeFile(externalPatch, JSON.stringify({ preferences: 'legacy search preferences' }));
  await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-jobs.js'), '--root', root,
    '--native-lock', fixture.receipt.artifact, 'profile-patch', '--input', externalPatch,
    '--expected-revision', String(currentRevision.revision), '--source', 'user'], { env: { PATH: '' } });
  const legacy = JSON.parse(await readFile(profilePath, 'utf8'));
  await page.reload();
  await page.getByRole('button', { name: 'Facts', exact: true }).click();
  await panel.getByText('Saved preferences have an unsupported shape. Resolve them before saving target titles.').waitFor();
  await panel.getByRole('button', { name: 'Edit target titles' }).click();
  assert.equal(await panel.getByRole('button', { name: 'Confirm and save exact titles' }).isDisabled(), true);
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), legacy);
  const legacyRevision = await page.evaluate(async () => {
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    return (await fetch('/api/profile', { headers: { Authorization: `Bearer ${token}` } })).json();
  });
  await writeFile(externalPatch, JSON.stringify({ preferences: { targetTitles: [42] } }));
  await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-jobs.js'), '--root', root,
    '--native-lock', fixture.receipt.artifact, 'profile-patch', '--input', externalPatch,
    '--expected-revision', String(legacyRevision.revision), '--source', 'user'], { env: { PATH: '' } });
  await page.reload();
  await page.getByRole('button', { name: 'Facts', exact: true }).click();
  await panel.getByText('Saved now: No target titles yet.').waitFor();
  await panel.getByRole('button', { name: 'Edit target titles' }).click();
  await panel.getByRole('button', { name: 'Confirm and save exact titles' }).click();
  await panel.getByText('Target titles saved. Job Search will use these approved titles.').waitFor();
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')).profile.preferences.targetTitles, []);
  let profileUnavailable = true;
  const failProfileLoads = async route => {
    if (profileUnavailable && route.request().method() === 'GET')
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily unavailable"}' });
    else await route.continue();
  };
  await page.route('**/api/profile', failProfileLoads);
  try {
    await page.reload();
    await page.getByRole('button', { name: 'Facts', exact: true }).click();
    await panel.getByText('Saved target titles are unavailable.').waitFor();
    profileUnavailable = false;
    await panel.getByRole('button', { name: 'Retry loading target titles' }).click();
    await panel.getByText('Saved now: No target titles yet.').waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Discover related titles' }).isEnabled(), true);
  } finally { await page.unroute('**/api/profile', failProfileLoads); }
  return { cancel: true, unavailable: true, emptyRetry: true, keyboardFocus: true, delayedSave: true,
    exactSave: true, conflictRetry: true, canonicalReconciliation: true, factsDraft: true };
}
