import assert from 'node:assert/strict';

// The browser may advertise an agent handoff, but it must never acquire or
// recover an application claim. The agent owns that lifecycle after copy.
export async function claimsBrowser(page, { jobId, claimRequests = [] }) {
    const handoffClaimRequests = [];
    const observeClaimRequest = request => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/claims')) handoffClaimRequests.push({ method: request.method(), path });
    };
    page.on('request', observeClaimRequest);
    try {
        const panel = page.getByRole('region', { name: 'Ready-job handoff', exact: true });
        await panel.getByRole('heading', { name: 'Hand off a Ready job', exact: true }).waitFor();
        assert.equal((await panel.innerText()).includes(jobId), false, 'the handoff does not expose a record ID');
        assert.equal(await panel.getByRole('button', { name: 'Start application', exact: true }).count(), 0);
        assert.equal(await panel.getByRole('button', { name: /Recover expired application/ }).count(), 0);

        await panel.getByRole('button', { name: 'Copy Codex invocation', exact: true }).click();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '$job-apply:job-apply');
        await panel.getByText('Codex invocation copied.', { exact: true }).waitFor();

        const codexCopy = panel.getByRole('button', { name: 'Copy Codex invocation', exact: true });
        const claudeCopy = panel.getByRole('button', { name: 'Copy Claude invocation', exact: true });
        await page.evaluate(() => {
            globalThis.claimsClipboardAttempts = [];
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: { writeText: text => new Promise((resolve, reject) => {
                    globalThis.claimsClipboardAttempts.push({ text, resolve, reject });
                }) },
            });
        });
        await codexCopy.click();
        await claudeCopy.click();
        await page.waitForFunction(() => globalThis.claimsClipboardAttempts.length === 2);
        await page.evaluate(() => globalThis.claimsClipboardAttempts[1].reject(new Error('latest denied')));
        const fallback = panel.getByLabel('Invocation to copy', { exact: true });
        await fallback.waitFor();
        assert.equal(await fallback.inputValue(), '/job-apply:job-apply');
        await page.evaluate(() => globalThis.claimsClipboardAttempts[0].resolve());
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await fallback.inputValue(), '/job-apply:job-apply');

        await codexCopy.click();
        await claudeCopy.click();
        await page.waitForFunction(() => globalThis.claimsClipboardAttempts.length === 4);
        await page.evaluate(() => globalThis.claimsClipboardAttempts[3].resolve());
        await panel.getByText('Claude Code invocation copied.', { exact: true }).waitFor();
        await page.evaluate(() => globalThis.claimsClipboardAttempts[2].reject(new Error('older denied')));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await fallback.count(), 0);
        await panel.getByText('Claude Code invocation copied.', { exact: true }).waitFor();

        await page.reload();
        await page.getByRole('heading', { name: 'Know what to do next.', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Overview', exact: true }).getAttribute('aria-current'), 'page');
        await page.getByRole('button', { name: 'Jobs', exact: true }).click();
        const reloadedPanel = page.getByRole('region', { name: 'Ready-job handoff', exact: true });
        await reloadedPanel.getByRole('button', { name: 'Copy Claude invocation', exact: true }).click();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '/job-apply:job-apply');
        assert.deepEqual(handoffClaimRequests, [],
            'navigation, copy, and reload must not create or touch an application claim');
        assert.deepEqual(claimRequests, [], 'the production browser journey must not call the claims API');
    } finally {
        page.off('request', observeClaimRequest);
    }
}
