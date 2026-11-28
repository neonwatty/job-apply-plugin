import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { get, int, object, parse, serialize, string } from '../runtime/contracts/workspace/values.js';
import { spawnOwnedCompanion } from './workspace_next_process_support.mjs';
import { clickCompanionNav, jobDetailBack } from './workspace_companion_nav_support.mjs';
const execute = promisify(execFile);

/** All data and browser sessions are disposable; never touches an owner Store. */
export async function companionRegressionsBrowser(buildRoot) {
  const fixture = await nativeFixture(), root = join(await realpath(fixture.root), 'jobs');
  let launcher, browser;
  try {
    await initializeJobsFixture(root);
    let sequence = 0;
    async function cli(command, payload, ...args) {
      const input = join(fixture.root, `regression-${sequence++}.json`);
      const inputArgs = payload === undefined ? [] : ['--input', input];
      if (payload !== undefined) await writeFile(input, payload, { mode: 0o600 });
      const result = await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-jobs.js'),
        '--root', root, '--native-lock', fixture.receipt.artifact, command, ...inputArgs, ...args], { env: { PATH: '' } });
      return result.stdout;
    }
    await cli('job-create', JSON.stringify({ id: 'pending-regression', url: 'https://example.invalid/regression', role: 'Pending regression role' }));
    const jobsPath = join(root, 'jobs.json'), jobs = JSON.parse(await readFile(jobsPath, 'utf8'));
    jobs.jobs['pending-regression'].status = 'needs_info';
    await writeFile(jobsPath, JSON.stringify(jobs), { mode: 0o600 });
    const reference = `pending_${'c'.repeat(32)}`;
    await writeFile(join(root, 'sessions/pending-regression.json'), JSON.stringify({
      schemaVersion: 1, applicationId: 'pending-regression', status: 'active', updatedAt: '2026-09-09T12:00:00Z',
      pendingFields: [{ reference, answerKey: 'fixture-answer', question: 'Synthetic pending?', state: 'missing' }],
      blockers: [{ type: 'information', code: 'answer-required', reference }],
    }), { mode: 0o600 });
    const resumeFile = join(fixture.root, 'facts.txt');
    await writeFile(resumeFile, 'Synthetic resume regression fixture');
    const resume = JSON.parse(await cli('resume-import', JSON.stringify({ id: 'facts-regression', label: 'Fact regression resume' }), '--path', resumeFile));
    const facts = '{"summary":"Before","skills":[["TypeScript"]],"linkedInUrl":"linkedin.com/in/synthetic","identifier":9007199254740993,"ratio":1.0,"nested":{"exact":9007199254740995}}';
    const request = JSON.parse(await cli('resume-extraction-request-create', undefined,
      '--resume-id', resume.id, '--expected-resume-revision', '1', '--scope', 'resume'));
    await cli('profile-patch', '{"ratio":1.0,"identifier":9007199254740993}',
      '--expected-revision', '1', '--source', 'user');
    let resumeRevision = 1, factRevision = 1;
    async function externalMetadata(label) {
      await cli('resume-update', JSON.stringify({ label }), '--id', resume.id, '--expected-revision', String(resumeRevision++));
    }
    launcher = await spawnOwnedCompanion(buildRoot, root,
      ['--writer', 'native-fixture', '--native-lock', fixture.receipt.artifact], { env: { PATH: '' }, leaseArtifact: fixture.receipt.artifact });
    const startup = await new Promise((resolve, reject) => {
      let output = '', errors = '';
      const timer = setTimeout(() => reject(Error(`Regression startup timed out: ${errors}`)), 30_000);
      const fail = error => { clearTimeout(timer); reject(error); };
      launcher.child.once('error', fail);
      launcher.child.once('exit', () => fail(Error(`Regression startup exited: ${errors}`)));
      launcher.child.stderr.on('data', bytes => { errors += bytes; });
      launcher.child.stdout.on('data', bytes => {
        output += bytes;
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
      });
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(startup.url);
    await page.getByRole('status', { name: 'Local data connected', exact: true }).waitFor();

    const desktop = page.viewportSize();
    await page.setViewportSize({ width: 320, height: 568 });
    await clickCompanionNav(page, 'More');
    const more = page.getByRole('navigation', { name: 'More workspace sections', exact: true });
    const settings = more.getByRole('button', { name: 'Settings', exact: true });
    await settings.waitFor();
    const menu = await more.boundingBox();
    const first = await settings.boundingBox();
    assert.equal(await more.getByRole('button').first().getAttribute('aria-label'), 'Settings');
    assert.ok(first.height >= 44 && first.y + first.height < 504);
    assert.ok(first.width >= menu.width - 2, 'the full settings row is tappable');
    await settings.click();
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    const pageTransitions = page.getByRole('combobox', { name: 'Page transitions', exact: true });
    await pageTransitions.waitFor();
    assert.equal(await pageTransitions.getAttribute('aria-describedby'), 'page-transition-help');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goBack();
    await settings.waitFor();
    for (const [section, opener] of [['Answers', 'New answer'], ['Resumes', /Fact regression resume/]]) {
      await clickCompanionNav(page, section);
      await page.getByRole('button', { name: opener }).click();
      await page.locator('dialog:modal .job-drawer-close:not(:disabled)').waitFor();
      await page.goBack();
      await settings.waitFor();
      assert.equal(await page.locator('dialog:modal').count(), 0);
      await settings.click();
      await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
      await page.goBack();
      await settings.waitFor();
    }
    await page.setViewportSize(desktop);

    const staleJobUrl = new URL(startup.url);
    staleJobUrl.search = 'view=jobs&job=missing-regression-job';
    await page.goto(staleJobUrl.href);
    await page.getByRole('alert').filter({hasText:'This job is unavailable.'}).waitFor();
    await page.getByRole('button', {name:'New job',exact:true}).click();
    const newJob = page.locator('dialog.job-drawer');
    await newJob.getByRole('heading', {name:'New job',exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.has('job'),false);
    await jobDetailBack(newJob).click();
    await newJob.waitFor({state:'hidden'});

    // A cached Jobs page must release its top-layer modal when it navigates to Answers.
    await clickCompanionNav(page, 'Jobs');
    await page.getByRole('button', { name: /Pending regression role/ }).click();
    await page.getByRole('button', { name: 'Open Answers', exact: true }).click();
    await page.getByRole('heading', { name: 'Answers', exact: true, level: 1 }).waitFor();
    assert.equal(await page.locator('dialog:modal').count(), 0);
    await page.getByRole('searchbox', { name: 'Find answers', exact: true }).fill('interaction works');
    await page.goBack();
    const reopenedJob = page.locator('dialog.job-drawer');
    await reopenedJob.getByRole('heading', { name: 'Pending regression role', exact: true }).waitFor();
    await jobDetailBack(reopenedJob).click();
    await reopenedJob.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('dialog:modal').count(), 0);

    await clickCompanionNav(page, 'Resumes');
    const resumeCard = page.getByRole('button', { name: /Fact regression resume/ });
    await resumeCard.getByText('Waiting for agent', { exact: true }).waitFor();
    await resumeCard.click();
    await page.getByRole('button', { name: 'View extraction requests', exact: true }).click();
    await page.getByRole('heading', { name: 'Extraction review', exact: true }).waitFor();
    assert.equal(await page.locator('dialog:modal').count(), 0);
    await page.getByRole('button', { name: 'Copy agent handoff', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to resumes', exact: true }).click();
    await resumeCard.click();
    await cli('resume-extraction-request-complete-scoped', facts, '--id', request.requestId,
      '--expected-request-revision', String(request.revision));
    await page.getByRole('button', { name: 'Check for agent updates', exact: true }).click();
    await page.getByText('Draft to review', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'View extraction requests', exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Close resume details', exact: true }).click();
    await resumeCard.getByText('Draft ready for your review', { exact: true }).waitFor();
    await resumeCard.getByText(/Review facts for this resume/).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await resumeCard.click();
    await page.waitForFunction(() => {
      const heading = document.activeElement;
      return heading?.textContent === 'Facts from Fact regression resume'
        && heading.getBoundingClientRect().bottom <= innerHeight
        && heading.getBoundingClientRect().top >= document.querySelector('.detail-drawer-header').getBoundingClientRect().bottom - 1;
    });
    await page.setViewportSize({ width: 1180, height: 900 });
    const summary = page.getByLabel('Summary', { exact: true }), identifier = page.getByLabel('Identifier', { exact: true });
    const save = page.getByRole('button', { name: 'Save edits as draft', exact: true });
    await summary.waitFor();
    assert.equal(await identifier.inputValue(), '9007199254740993');
    assert.equal(await page.getByLabel('Skills 1 1', { exact: true }).inputValue(), 'TypeScript');

    // Begin a clean metadata refresh, then type before its response arrives.
    await externalMetadata('Concurrent resume label');
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const start = new Promise(resolve => { entered = resolve; });
    await page.route('**/api/resumes', async route => { entered(); await gate; await route.continue(); }, { times: 1 });
    await page.getByRole('button', { name: 'Refresh resume', exact: true }).click();
    await start;
    await summary.fill('Unsaved summary');
    await page.getByLabel('Skills 1 1', { exact: true }).fill('TypeScript advanced');
    release();
    await page.getByText('This resume changed elsewhere. Your draft is preserved.', { exact: true }).waitFor();
    assert.equal(await summary.inputValue(), 'Unsaved summary');
    await page.getByRole('button', { name: 'Reapply my draft', exact: true }).click();
    await page.getByRole('heading', { name: 'Concurrent resume label', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.resume-facts-panel input')?.disabled);
    assert.equal(await summary.inputValue(), 'Unsaved summary');
    await save.click();
    await page.getByText('Fact edits saved as a new draft. Review and confirm it before application use.', { exact: true }).waitFor();
    factRevision++;
    const detail = object(parse(await cli('resume-facts-get', undefined, '--resume-id', resume.id)), 'detail');
    const saved = object(get(detail, 'facts'), 'saved facts');
    assert.equal(string(get(saved, 'summary')), 'Unsaved summary');
    assert.equal(string(get(saved, 'linkedInUrl')), 'linkedin.com/in/synthetic');
    assert.equal(serialize(get(saved, 'skills')), '[["TypeScript advanced"]]');
    assert.equal(int(get(saved, 'identifier')), 9007199254740993n);
    assert.equal(int(get(object(get(saved, 'nested'), 'nested'), 'exact')), 9007199254740995n);
    assert.equal(serialize(get(saved, 'ratio')), '1.0');

    // Invalid numeric drafts stay unsaved, and declining a reload keeps their text.
    await identifier.fill('not a number');
    assert.equal(await save.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Confirm facts for this resume', exact: true }).isDisabled(), true);
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Check for agent updates', exact: true }).click();
    assert.equal(await identifier.inputValue(), 'not a number');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Check for agent updates', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.resume-facts-panel input[inputmode="decimal"]')?.value === '9007199254740993');

    // A newer agent fact revision cannot silently overwrite a draft on metadata rebase.
    await summary.fill('Second local draft');
    await cli('resume-facts-draft', facts.replace('Before', 'Agent summary'), '--resume-id', resume.id,
      '--expected-resume-revision', String(resumeRevision), '--expected-fact-revision', String(factRevision));
    await externalMetadata('Agent changed metadata');
    await page.getByRole('button', { name: 'Refresh resume', exact: true }).click();
    await page.getByRole('button', { name: 'Reapply my draft', exact: true }).click();
    await page.getByText(/These facts changed elsewhere\. Your draft is preserved/).waitFor();
    assert.equal(await summary.inputValue(), 'Second local draft');
    assert.equal(await save.isDisabled(), true);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Check for agent updates', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.resume-facts-panel input')].some(input => input.value === 'Agent summary'));
    assert.equal(await summary.inputValue(), 'Agent summary');
    assert.equal(await identifier.inputValue(), '9007199254740993');
    // Editing and confirming a numeric fact also uses exact, unrounded wire values.
    await identifier.fill('9007199254740999');
    const ratio = page.getByLabel('Ratio', { exact: true });
    await ratio.fill('');
    await ratio.pressSequentially('0.001', { delay: 50 });
    assert.equal(await ratio.inputValue(), '0.001');
    await save.click();
    await page.getByText('Fact edits saved as a new draft. Review and confirm it before application use.', { exact: true }).waitFor();
    const numericDetail = object(parse(await cli('resume-facts-get', undefined, '--resume-id', resume.id)), 'detail');
    assert.equal(int(get(object(get(numericDetail, 'facts'), 'facts'), 'identifier')), 9007199254740999n);
    assert.equal(serialize(get(object(get(numericDetail, 'facts'), 'facts'), 'ratio')), '0.001');
    await ratio.fill('');
    await ratio.pressSequentially('-0.5', { delay: 50 });
    assert.equal(await ratio.inputValue(), '-0.5');
    await save.click();
    await page.getByText('Fact edits saved as a new draft. Review and confirm it before application use.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Confirm facts for this resume', exact: true }).click();
    await page.getByText(/These facts are confirmed for this resume/).waitFor();
    const confirmed = object(parse(await cli('resume-facts-get', undefined, '--resume-id', resume.id)), 'detail');
    assert.equal(string(get(confirmed, 'state')), 'confirmed');
    assert.equal(int(get(object(get(confirmed, 'facts'), 'facts'), 'identifier')), 9007199254740999n);
    assert.equal(serialize(get(object(get(confirmed, 'facts'), 'facts'), 'ratio')), '-0.5');
    await page.getByRole('button', { name: 'Close resume details', exact: true }).click();
    await page.getByRole('button', { name: /Agent changed metadata.*Facts confirmed for this resume/ }).waitFor();
    await clickCompanionNav(page, 'Facts');
    const globalRatio = page.getByLabel('ratio', { exact: true });
    await globalRatio.fill('');
    await globalRatio.pressSequentially('0.001', { delay: 50 });
    assert.equal(await globalRatio.inputValue(), '0.001');
    const savedSource = page.locator('.fact-card').filter({ has: globalRatio });
    await savedSource.getByText(/Saved value source · User entry or approval/).waitFor();
    await page.getByRole('button', { name: 'Save facts', exact: true }).click();
    await page.getByText('Facts saved.', { exact: true }).waitFor();
    const global = object(parse(await cli('profile-get')), 'profile');
    assert.equal(serialize(get(global, 'ratio')), '0.001');
    assert.equal(int(get(global, 'identifier')), 9007199254740993n);
    await globalRatio.fill('');
    await globalRatio.pressSequentially('-0.5', { delay: 50 });
    assert.equal(await globalRatio.inputValue(), '-0.5');
    await page.getByRole('button', { name: 'Save facts', exact: true }).click();
    await page.getByText('Facts saved.', { exact: true }).waitFor();
    assert.equal(serialize(get(object(parse(await cli('profile-get')), 'profile'), 'ratio')), '-0.5');
    assert.deepEqual(errors, []);
    return { cachedModalNavigation: true, scopedResumeReview: true, savedFactSource: true, metadataRefreshRace: true, factConflict: true,
      losslessFacts: true, invalidNumberGuard: true, explicitDiscard: true };
  } finally {
    await browser?.close();
    await launcher?.stop();
    await fixture.cleanup();
  }
}
