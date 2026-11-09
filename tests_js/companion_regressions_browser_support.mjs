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
import { clickCompanionNav } from './workspace_companion_nav_support.mjs';
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
    await cli('resume-facts-draft', facts, '--resume-id', resume.id, '--expected-resume-revision', '1');
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

    // A cached Jobs page must release its top-layer modal when it navigates to Answers.
    await clickCompanionNav(page, 'Jobs');
    await page.getByRole('button', { name: /Pending regression role/ }).click();
    await page.getByRole('button', { name: 'Open Answers', exact: true }).click();
    await page.getByRole('heading', { name: 'Answers', exact: true, level: 1 }).waitFor();
    assert.equal(await page.locator('dialog:modal').count(), 0);
    await page.getByRole('searchbox', { name: 'Find answers', exact: true }).fill('interaction works');
    await clickCompanionNav(page, 'Jobs');
    await page.getByRole('button', { name: 'Close job details', exact: true }).click();
    assert.equal(await page.locator('dialog:modal').count(), 0);

    await clickCompanionNav(page, 'Resumes');
    await page.getByRole('button', { name: /Fact regression resume/ }).click();
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
    assert.equal(await page.getByRole('button', { name: 'Confirm facts', exact: true }).isDisabled(), true);
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
    await page.getByRole('button', { name: 'Confirm facts', exact: true }).click();
    await page.getByText(/These facts are confirmed for this resume/).waitFor();
    const confirmed = object(parse(await cli('resume-facts-get', undefined, '--resume-id', resume.id)), 'detail');
    assert.equal(string(get(confirmed, 'state')), 'confirmed');
    assert.equal(int(get(object(get(confirmed, 'facts'), 'facts'), 'identifier')), 9007199254740999n);
    assert.equal(serialize(get(object(get(confirmed, 'facts'), 'facts'), 'ratio')), '-0.5');
    await page.getByRole('button', { name: 'Close resume details', exact: true }).click();
    await clickCompanionNav(page, 'Facts');
    const globalRatio = page.getByLabel('ratio', { exact: true });
    await globalRatio.fill('');
    await globalRatio.pressSequentially('0.001', { delay: 50 });
    assert.equal(await globalRatio.inputValue(), '0.001');
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
    return { cachedModalNavigation: true, metadataRefreshRace: true, factConflict: true,
      losslessFacts: true, invalidNumberGuard: true, explicitDiscard: true };
  } finally {
    await browser?.close();
    await launcher?.stop();
    await fixture.cleanup();
  }
}
