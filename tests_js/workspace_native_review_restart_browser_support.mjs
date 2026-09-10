import assert from 'node:assert/strict';
import { readyPacket } from './workspace_native_claims_support.mjs';

// Disposable native fixture only. Prepare review with the real authenticated API.
export async function reviewRestartBrowser(page, jobId) {
    const authorization = await page.evaluate(() => `Bearer ${sessionStorage.getItem('jobApplyWorkspaceToken')}`);
    async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
        const response = await page.request.fetch(new URL(path, page.url()).href, {
            method, headers: { Authorization: authorization, Origin: new URL(page.url()).origin }, data: body,
        });
        assert.equal(response.status(), 200, await response.text());
        return response.json();
    }
    let job = await api(`/api/jobs/${jobId}`);
    job = (await api('/api/claims/select', { jobId, expectedRevision: job.revision, ownerConfirmed: true })).job;
    const first = await api('/api/claims/acquire', { jobId, expectedRevision: job.revision, ownerLabel: 'Review fixture' });
    const reviewed = await api('/api/claims/handoff', { jobId, token: first.token, status: 'awaiting_review',
        expectedRevision: first.job.revision, session: { status: 'review', readinessInput: readyPacket(first.job.revision) } });
    assert.equal(reviewed.job.status, 'awaiting_review');
    await page.reload();
    const panel = page.getByRole('region', { name: 'Active application', exact: true });
    const choice = panel.getByRole('combobox', { name: 'Job for application work', exact: true });
    await panel.getByText('No active application claim.', { exact: true }).waitFor();
    await choice.selectOption(jobId);
    const restart = panel.getByRole('button', { name: 'Restart reviewed application', exact: true });

    // Missing confirmation, or sending a request on cancellation, can restart an owner-submitted application.
    let requests = 0;
    const countRequest = request => { if (request.url().endsWith('/api/claims/review-restart')) requests++; };
    page.on('request', countRequest);
    let confirmation;
    page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss(); });
    await restart.click({ timeout: 5000 });
    assert.match(confirmation, /not submitted/i);
    assert.equal(requests, 0);
    assert.deepEqual(await api(`/api/jobs/${jobId}`), reviewed.job);
    assert.equal((await api('/api/claims')).claim, null);

    // Another attempt can reach review while this view still has the old revision.
    const concurrent = await api('/api/claims/review-restart', {
        jobId, expectedRevision: reviewed.job.revision, ownerLabel: 'Concurrent owner', ownerConfirmedNotSubmitted: true,
    });
    const updated = (await api('/api/claims/handoff', {
        jobId, token: concurrent.token, expectedRevision: concurrent.job.revision, status: 'awaiting_review',
        session: { status: 'review', readinessInput: readyPacket(concurrent.job.revision) },
    })).job;
    const conflict = page.waitForResponse(response => response.url().endsWith('/api/claims/review-restart'));
    page.once('dialog', dialog => dialog.accept());
    await restart.click();
    assert.equal((await conflict).status(), 409);
    await panel.getByRole('alert').waitFor();
    assert.deepEqual(await api(`/api/jobs/${jobId}`), updated);
    assert.equal((await api('/api/claims')).claim, null);
    await page.reload();
    await panel.getByText('No active application claim.', { exact: true }).waitFor();
    await choice.selectOption(jobId);

    const acquired = page.waitForResponse(response => response.url().endsWith('/api/claims/review-restart'));
    page.once('dialog', dialog => dialog.accept());
    await restart.click();
    const response = await acquired;
    assert.equal(response.status(), 200);
    assert.deepEqual(response.request().postDataJSON(), {
        jobId, ownerLabel: 'Companion owner', expectedRevision: updated.revision, ownerConfirmedNotSubmitted: true,
    });
    const result = await response.json();
    assert.equal(result.job.status, 'in_progress');
    assert.notEqual(result.token, first.token);
    assert.equal(typeof result.token, 'string');
    await panel.getByRole('button', { name: 'Return for owner input', exact: true }).waitFor();
    assert.equal((await page.locator('body').innerText()).includes(result.token), false);
    assert.equal(await page.evaluate(secret => [...Object.values(localStorage), ...Object.values(sessionStorage)]
        .some(value => value.includes(secret)), result.token), false);
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Resumes', exact: true }).click();
    await panel.getByRole('button', { name: 'Return for owner input', exact: true }).waitFor();
    const handoff = page.waitForResponse(response => response.url().endsWith('/api/claims/handoff'));
    await panel.getByRole('button', { name: 'Return for owner input', exact: true }).click();
    const handedOff = await handoff;
    assert.equal(handedOff.status(), 200);
    assert.equal(handedOff.request().postDataJSON().token, result.token);
    assert.equal(handedOff.request().postDataJSON().expectedRevision, result.job.revision);
    assert.equal((await handedOff.json()).job.status, 'needs_info');
    await panel.getByText('No active application claim.', { exact: true }).waitFor();
    page.off('request', countRequest);
    return { cancellation: true, revisionConflict: true, memoryOnlyCredential: true, navigationGuard: true, handoff: true };
}
