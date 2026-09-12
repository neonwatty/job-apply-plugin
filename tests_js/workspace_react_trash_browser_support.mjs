import assert from 'node:assert/strict';

// Caller provides a production Companion page connected only to a disposable Python Store.
export async function reactTrashBrowser(page, { origin, headers }) {
    async function api(path, body) {
        const response = await page.request.fetch(origin + path, {
            method: body === undefined ? 'GET' : 'POST', headers, data: body
        });
        assert.equal(response.status(), 200, await response.text());
        return response.json();
    }
    const job = await api('/api/jobs', { job: { role: 'React Trash synthetic job', url: 'https://example.invalid/react-trash-private', notes: 'PRIVATE-TRASH-NOTES' } });
    // Keep an active default for jobs created by the surrounding production walkthrough.
    await api('/api/resumes/import', { metadata: { label: 'Retained synthetic default' }, filename: 'default.txt', content: Buffer.from('Retained default resume bytes').toString('base64') });
    const resume = await api('/api/resumes/import', { metadata: { label: 'React Trash synthetic resume' }, filename: 'private-fixture.txt', content: Buffer.from('Synthetic resume bytes').toString('base64') });
    const answer = await api('/api/answers', { answer: { question: 'React Trash synthetic answer?', state: 'confirmed', value: 'PRIVATE-TRASH-ANSWER' } });
    const fixtures = [
        { type: 'job', collection: 'jobs', id: job.id, record: job, label: job.role },
        { type: 'resume', collection: 'resumes', id: resume.id, record: resume, label: resume.label },
        { type: 'answer', collection: 'answers', id: answer.key, record: answer, label: answer.question }
    ];
    const path = (fixture, action) => `/api/${fixture.collection}/${encodeURIComponent(fixture.id)}/${action}`;
    for (const fixture of fixtures) await api(path(fixture, 'trash'), { expectedRevision: fixture.record.revision });
    const navigation = page.getByRole('navigation', { name: 'Workspace sections' });
    await navigation.getByRole('button', { name: 'Trash', exact: true }).click();
    const workspace = page.locator('.trash-workspace');
    const refresh = page.getByRole('button', { name: 'Refresh Trash', exact: true });
    await workspace.getByText('1 jobs · 1 resumes · 1 answers', { exact: true }).waitFor();
    assert.doesNotMatch(await workspace.innerText(), /PRIVATE-TRASH|react-trash-private|private-fixture/);
    for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    }
    const filter = workspace.getByLabel('Record type');
    const card = fixture => workspace.locator('.trash-card').filter({ has: page.getByRole('heading', { name: fixture.label, exact: true }) });
    const modal = page.getByRole('dialog');
    async function reload() {
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trash');
        await refresh.click();
        await response;
        await page.waitForFunction(() => !document.getElementById('trash-refresh').disabled);
    }
    for (const fixture of fixtures) {
        await filter.selectOption(fixture.type);
        assert.equal(await workspace.locator('.trash-card').count(), 1);
        await card(fixture).getByRole('button', { name: 'Restore', exact: true }).click();
        await modal.getByRole('button', { name: 'Cancel', exact: true }).focus();
        await page.keyboard.press('Escape');
        await modal.waitFor({ state: 'hidden' });
        assert.equal(await card(fixture).getByRole('button', { name: 'Restore', exact: true }).evaluate(el => el === document.activeElement), true);
        await card(fixture).getByRole('button', { name: 'Restore', exact: true }).click();
        await modal.getByRole('button', { name: 'Restore', exact: true }).click();
        await card(fixture).waitFor({ state: 'hidden' });
        const restored = await api(`/api/${fixture.collection}/${encodeURIComponent(fixture.id)}`);
        assert.equal(restored.deletedAt, null);
        await api(path(fixture, 'trash'), { expectedRevision: restored.revision });
        await reload();
    }
    const target = fixtures[0];
    await filter.selectOption('job');
    // A storage error can follow a committed change. Require reconciliation, never replay.
    let uncertainWrites = 0;
    await page.route(`**${path(target, 'restore')}`, async route => {
        ++uncertainWrites;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"storage_error"}}' });
    });
    await card(target).getByRole('button', { name: 'Restore', exact: true }).click();
    await modal.getByRole('button', { name: 'Restore', exact: true }).click();
    await workspace.getByRole('alert').filter({ hasText: 'could not be confirmed' }).waitFor();
    assert.equal(uncertainWrites, 1);
    assert.equal(await card(target).getByRole('button', { name: 'Restore', exact: true }).isDisabled(), true);
    await page.unroute(`**${path(target, 'restore')}`);
    await reload();
    await card(target).waitFor({ state: 'hidden' });
    const uncertainRestored = await api(`/api/jobs/${encodeURIComponent(target.id)}`);
    assert.equal(uncertainRestored.deletedAt, null);
    await api(path(target, 'trash'), { expectedRevision: uncertainRestored.revision });
    await reload();
    await card(target).getByRole('button', { name: 'Delete permanently…', exact: true }).click();
    const confirm = modal.getByRole('button', { name: 'Delete permanently', exact: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await modal.evaluate(element => element.getBoundingClientRect().right <= innerWidth), true);
    await page.keyboard.press('Tab');
    assert.equal(await modal.evaluate(element => element.contains(document.activeElement)), true);
    assert.equal(await confirm.isDisabled(), true);
    await modal.getByLabel(/Type DELETE JOB/).fill('delete job');
    assert.equal(await confirm.isDisabled(), true);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    // Another writer changes the exact revision after the list was read.
    const current = (await api('/api/trash')).items.find(item => item.id === target.id);
    const restored = await api(path(target, 'restore'), { expectedRevision: current.revision });
    await api(path(target, 'trash'), { expectedRevision: restored.revision });
    let writes = 0;
    const countWrites = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === path(target, 'delete')) ++writes; };
    page.on('request', countWrites);
    await card(target).getByRole('button', { name: 'Delete permanently…', exact: true }).click();
    await modal.getByLabel(/Type DELETE JOB/).fill('DELETE JOB');
    await confirm.click();
    await workspace.getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
    assert.equal(writes, 1);
    assert.equal(await card(target).getByRole('button', { name: 'Restore', exact: true }).isDisabled(), true);
    await reload();
    // Synthetic redacted reference envelope: no replay, no incidental message exposure.
    await page.route(`**${path(target, 'delete')}`, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'history_reference_blocked', counts: { history: 1 }, message: 'PRIVATE-SERVER-PATH' } }) }));
    await card(target).getByRole('button', { name: 'Delete permanently…', exact: true }).click();
    await modal.getByLabel(/Type DELETE JOB/).fill('DELETE JOB');
    await confirm.click();
    await workspace.getByRole('alert').filter({ hasText: '1 protected reference' }).waitFor();
    assert.doesNotMatch(await workspace.innerText(), /PRIVATE-SERVER-PATH/);
    await page.unroute(`**${path(target, 'delete')}`);
    await reload();
    // Real deletion succeeds, then an injected refresh failure cannot invite replay.
    await card(target).getByRole('button', { name: 'Delete permanently…', exact: true }).click();
    await modal.getByLabel(/Type DELETE JOB/).fill('DELETE JOB');
    await page.route('**/api/trash', route => route.fulfill({ status: 503, body: '{}' }));
    await confirm.click();
    await workspace.getByRole('alert').filter({ hasText: 'could not be refreshed' }).waitFor();
    await workspace.getByRole('status').filter({ hasText: 'The change was saved' }).waitFor();
    assert.equal(await card(target).getByRole('button', { name: 'Delete permanently…', exact: true }).isDisabled(), true);
    await page.unroute('**/api/trash');
    await reload();
    assert.equal((await api('/api/trash')).items.some(item => item.id === target.id), false);
    page.off('request', countWrites);
    for (const fixture of fixtures.slice(1)) {
        await filter.selectOption(fixture.type);
        await card(fixture).getByRole('button', { name: 'Delete permanently…', exact: true }).click();
        if (fixture.type === 'resume') assert.match(await modal.innerText(), /managed resume file/);
        await modal.getByLabel(new RegExp(`Type DELETE ${fixture.type.toUpperCase()}`)).fill(`DELETE ${fixture.type.toUpperCase()}`);
        await confirm.click();
        await card(fixture).waitFor({ state: 'hidden' });
    }
    await filter.selectOption('');
    await workspace.getByText('Trash is empty.', { exact: true }).waitFor();
    for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    }
    // Native capability and failed-first-load UI checks use only intercepted synthetic projections.
    await page.route('**/api/boot', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ready","mode":"native-jobs-fixture"}' }));
    let firstLoad = true;
    await page.route('**/api/trash', route => {
        if (firstLoad) { firstLoad = false; return route.fulfill({ status: 503, body: '{}' }); }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
            items: fixtures.map(fixture => ({ type: fixture.type, id: fixture.id, label: fixture.label,
                revision: 2, deletedAt: '2026-09-11T00:00:00Z', blockerCounts: {} })),
            total: 3, counts: { job: 1, resume: 1, answer: 1 }
        }) });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await navigation.getByRole('button', { name: 'Trash', exact: true }).click();
    await workspace.getByRole('alert').waitFor();
    assert.equal(await workspace.getByText('Trash is empty.', { exact: true }).count(), 0);
    await reload();
    for (const fixture of fixtures) {
        const actions = card(fixture).getByRole('button');
        assert.equal(await actions.nth(0).isDisabled(), false);
        assert.equal(await actions.nth(1).isDisabled(), false);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.unroute('**/api/boot');
    await page.unroute('**/api/trash');
    return { compatibilityRestoreAndDeleteAllTypes: true, exactTypedConfirmation: true, conflictNoRetry: true,
        referencePrivacy: true, savedButRefreshFailed: true, keyboardFocus: true, nativeAllActionsEnabled: true,
        failedLoadNotEmpty: true, errorAfterCommitReconciled: true, layouts: [390, 1280] };
}
