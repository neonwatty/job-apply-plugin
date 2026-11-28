import { clickCompanionNav } from './workspace_companion_nav_support.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { plain, readyPacket, setup } from './workspace_native_claims_support.mjs';
import { spawnOwnedCompanion } from './workspace_next_process_support.mjs';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
import { JobTransitionsService } from '../runtime/workspace-core/job-transitions.js';
import { ResumeFactsService } from '../runtime/workspace-core/resume-facts.js';

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
        await panel.getByRole('heading', { name: 'Continue in Codex or Claude Code', exact: true }).waitFor();
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
        await page.getByRole('heading', { name: 'Jobs', exact: true }).waitFor();
        assert.equal(await page.locator('#workspace-navigation button[aria-label="Jobs"]').getAttribute('aria-current'), 'page');
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

export async function overviewHandoffBrowser(buildRoot) {
    const fixture = await nativeFixture();
    let launcher, browser;
    try {
        const { root, repository, claims, jobs, run } = await setup(fixture, 'overview-handoff');
        const facts = new ResumeFactsService(repository);
        const runs = new ApplicationRunsService(repository);
        const transitions = new JobTransitionsService(repository);
        const draft = plain(await facts.createDraft('resume', fromJSON({name:'Synthetic Candidate'}), 1n, null));
        const confirmed = plain(await facts.confirm('resume', BigInt(draft.revision), draft.contentRevision));
        await runs.complete(run.runId, BigInt(run.revision));
        await runs.start('resume', 1n, BigInt(confirmed.revision), true, fromJSON({jobIds:['job','other']}));
        const job = plain(await jobs.update('job', fromJSON({role:'Ready fixture role', company:'Northstar Studio'}), 1n));
        const other = plain(await jobs.update('other', fromJSON({role:'Review fixture role', company:'Fieldwork'}), 1n));
        const ready = plain(await claims.select('job', BigInt(job.revision), true)).job;
        launcher = await spawnOwnedCompanion(buildRoot, root, ['--writer', 'native-fixture', '--native-lock', fixture.receipt.artifact],
            { leaseArtifact: fixture.receipt.artifact });
        const startup = createInterface({input:launcher.child.stdout});
        const [line] = await once(startup, 'line', {signal:AbortSignal.timeout(20_000)});
        startup.close();
        const {url} = JSON.parse(line);
        browser = await chromium.launch();
        const context = await browser.newContext({viewport:{width:390,height:844}});
        await context.grantPermissions(['clipboard-read','clipboard-write'], {origin:new URL(url).origin});
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        const requests = [];
        page.on('request', request => {
            if (request.method() !== 'GET' || new URL(request.url()).pathname.startsWith('/api/claims')) {
                requests.push(request.method());
            }
        });

        await page.goto(url);
        const action = page.getByRole('button', {name:'Continue in Codex or Claude Code',exact:true});
        await action.click();
        const panel = page.getByRole('region', {name:'Ready-job handoff',exact:true});
        const heading = panel.getByRole('heading', {name:'Continue in Codex or Claude Code',exact:true});
        await page.waitForFunction(() => document.activeElement?.textContent === 'Continue in Codex or Claude Code'
            && document.activeElement?.tagName === 'H2');
        const codexCopy = panel.getByRole('button', {name:'Copy Codex invocation',exact:true});
        await page.waitForFunction(() => {
            const copy = document.querySelector('.application-invocations button:enabled');
            const bounds = copy?.getBoundingClientRect();
            return bounds && bounds.top >= 0 && bounds.bottom <= innerHeight;
        });
        await page.keyboard.press('Tab');
        assert.equal(await codexCopy.evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '$job-apply:job-apply');
        await panel.getByText(/paste it in chat, then confirm which job to prepare/).waitFor();
        const readyRow = page.getByRole('button', {name:/Ready fixture role.*Ready for agent/});
        await readyRow.getByText('Ready for agent', {exact:true}).waitFor();

        // An Overview card can age while open. Landing in Jobs must recheck its saved state.
        await clickCompanionNav(page, 'Overview');
        await action.waitFor();
        const saved = plain(await transitions.transition('job', 'saved', BigInt(ready.revision)));
        await action.click();
        await panel.getByText(/No jobs are currently marked Ready for agent/).waitFor();
        assert.equal(await codexCopy.isDisabled(), true);
        assert.equal(await heading.evaluate(element => element === document.activeElement), true);

        const selected = plain(await claims.select('job', BigInt(saved.revision), true)).job;
        const acquired = plain(await claims.acquire('job', text('Synthetic fixture'), BigInt(selected.revision)));
        const blocked = plain(await claims.handoff('job', text(acquired.token), 'needs_info', fromJSON({
            status:'active', pendingFields:[{question:'Synthetic pending prompt?',state:'sensitive',sensitive:true}],
        }), BigInt(acquired.job.revision)));
        await claims.select('job', BigInt(blocked.job.revision), true);
        const otherReady = plain(await claims.select('other', BigInt(other.revision), true)).job;
        const otherAttempt = plain(await claims.acquire('other', text('Synthetic fixture'), BigInt(otherReady.revision)));
        await claims.handoff('other', text(otherAttempt.token), 'awaiting_review',
            fromJSON({status:'review',readinessInput:readyPacket(otherAttempt.job.revision)}), BigInt(otherAttempt.job.revision));

        await page.getByRole('button', {name:'Refresh',exact:true}).click();
        await readyRow.getByText('Live confirmation needed', {exact:true}).waitFor();
        await page.getByRole('button', {name:/Review fixture role.*Awaiting your review/}).waitFor();
        const filters = page.getByRole('button', {name:'Filters',exact:true});
        if (await filters.isVisible()) await filters.click();
        await page.getByRole('combobox', {name:'Status',exact:true}).selectOption({label:'Ready for agent'});
        assert.equal(await page.getByRole('button', {name:/Review fixture role/}).count(), 0);
        await readyRow.click();
        await page.getByRole('region', {name:'Live confirmation needed',exact:true})
            .getByText(/confirm the choice against the live form/).waitFor();
        assert.equal(await page.getByText('Synthetic pending prompt?', {exact:true}).count(), 0);
        assert.deepEqual(requests, [], 'navigation and copy must be read-only and avoid the claims API');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        return {overviewHandoff:true, focus:true, staleReadyDisabled:true, liveReconfirmation:true, copyOnly:true};
    } finally {
        await browser?.close();
        await launcher?.stop();
        await fixture.cleanup();
    }
}
