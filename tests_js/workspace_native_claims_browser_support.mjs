import assert from 'node:assert/strict';

// The caller owns the disposable fixture and prepares one preflight-ready job.
// expireClaim must adjust only that fixture's lease; never use an owner Store.
export async function claimsBrowser(page, { jobId, expireClaim }) {
    const panel = page.getByRole('region', { name: 'Active application', exact: true });
    await panel.getByText('No active application claim.', { exact: true }).waitFor();
    await panel.getByRole('combobox', { name: 'Job for application work', exact: true }).selectOption(jobId);
    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: 'Select this job', exact: true }).click();
    await panel.getByText('Job selected. Acquisition checks readiness again.', { exact: true }).waitFor();
    const acquired = page.waitForResponse(response => response.url().endsWith('/api/claims/acquire') && response.request().method() === 'POST');
    await panel.getByRole('button', { name: 'Acquire application work', exact: true }).click();
    const response = await acquired;
    assert.equal(response.status(), 200);
    const { token } = await response.json();
    assert.equal(typeof token, 'string');
    await panel.getByText('Application work acquired. You can return it for owner input below.', { exact: true }).waitFor();
    assert.equal((await page.locator('body').innerText()).includes(token), false);
    assert.equal(await page.evaluate(secret => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(secret)), token), false);

    // Leaving loses the ephemeral credential and stops the old component's renewal timer.
    page.once('dialog', dialog => dialog.accept());
    await page.reload();
    await page.getByText('This view does not hold the claim credential. After reload or navigation, wait for expiry, refresh status, and explicitly recover the same job.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Recover expired application', exact: true }).count(), 0);
    await expireClaim(jobId);
    await panel.getByRole('button', { name: 'Refresh application status', exact: true }).click();
    const recovery = page.waitForResponse(result => result.url().endsWith('/api/claims/recover') && result.request().method() === 'POST');
    await panel.getByRole('button', { name: 'Recover expired application', exact: true }).click();
    const recovered = await recovery;
    assert.equal(recovered.status(), 200);
    const recoveredPayload = await recovered.json();
    assert.notEqual(recoveredPayload.token, token);
    assert.equal(recoveredPayload.claim.jobId, jobId);
    const handoff = page.waitForResponse(result => result.url().endsWith('/api/claims/handoff') && result.request().method() === 'POST');
    await panel.getByRole('button', { name: 'Return for owner input', exact: true }).click();
    const handedOff = await handoff;
    assert.equal(handedOff.status(), 200);
    const request = handedOff.request().postDataJSON();
    assert.equal(request.status, 'needs_info');
    assert.deepEqual(request.session.blockers, [{ type: 'information', code: 'owner-input-required' }]);
    await panel.getByText('Application returned for owner input.', { exact: true }).waitFor();
    await panel.getByText('No active application claim.', { exact: true }).waitFor();
    assert.equal((await page.locator('body').innerText()).includes(recoveredPayload.token), false);
}
