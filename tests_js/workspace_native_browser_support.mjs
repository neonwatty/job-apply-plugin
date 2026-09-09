import { nativeFactsBrowser } from './workspace_native_facts_browser_support.mjs';
import { resumeDraftBrowser } from './workspace_native_resumes_browser_support.mjs';
import { nativeAnswersBrowser } from './workspace_native_answers_browser_support.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { initializeJobsFixture } from '../runtime/store/native-jobs.js';
const execute = promisify(execFile);

export async function nativeJobsBrowser(buildRoot) {
  const fixture = await nativeFixture();
  let child, browser;
  try {
    const root = join(await realpath(fixture.root), 'jobs');
    await initializeJobsFixture(root);
    child = spawn(process.execPath, ['apps/companion/launch.mjs', '--root', root,
      '--native-jobs-fixture', fixture.receipt.artifact], {
      cwd: buildRoot, env: { ...process.env, PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', bytes => { errors += bytes; });
    const startup = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error(`Native startup timed out: ${errors}`)), 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(Error(`Native startup failed: ${errors}`)); });
      child.stdout.on('data', bytes => {
        output += bytes;
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
      });
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    const apiResponses = [];
    page.on('response', async response => {
      if (response.url().includes('/api/')) {
        try { apiResponses.push({ url: response.url(), status: response.status(), body: await response.json() }); } catch {}
      }
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(startup.url);
    await page.getByText(/Synthetic native workspace/).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Open full workspace' }).count(), 0);
    await page.getByRole('button', { name: 'New job', exact: true }).click();
    await page.locator('dialog [name="url"]').fill('https://example.invalid/native');
    await page.locator('dialog [name="role"]').fill('Native fixture role');
    await page.getByRole('button', { name: 'Save job', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'hidden' });
    const stored = JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8'));
    const job = Object.values(stored.jobs)[0];
    assert.equal(job.role, 'Native fixture role');
    await page.getByRole('button', { name: /Native fixture role/ }).click();
    await page.locator('dialog [name="notes"]').fill('Browser draft');
    const cli = join(buildRoot, 'runtime/cli/native-jobs.js');
    const patchFile = join(fixture.root, 'update.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(patchFile, '{"company":"CLI writer"}');
    const cliResult = await execute(process.execPath, [cli, '--root', root, '--native-lock', fixture.receipt.artifact,
      'job-update', '--id', job.id, '--expected-revision', '1', '--input', patchFile], { env: { PATH: '' } });
    assert.equal(JSON.parse(cliResult.stdout).revision, 2);
    await page.getByRole('button', { name: 'Save job', exact: true }).click();
    try { await page.getByText('This job changed elsewhere', { exact: true }).waitFor({ timeout: 5000 }); }
    catch (error) { throw new Error(`${error.message}\n${JSON.stringify(apiResponses)}\n${await page.locator('body').innerText()}`); }
    await page.getByRole('button', { name: 'Reapply my draft', exact: true }).click();
    await page.getByRole('button', { name: 'Save job', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'hidden' });
    await page.reload();
    await page.getByRole('button', { name: /Native fixture role/ }).click();
    assert.equal(await page.locator('dialog [name="notes"]').inputValue(), 'Browser draft');
    assert.equal(await page.locator('dialog [name="company"]').inputValue(), 'CLI writer');
    const facts = await nativeFactsBrowser(page, root, fixture, buildRoot);
    await page.getByRole('button', { name: 'Resumes', exact: true }).click();
    await page.getByRole('button', { name: 'Import resume', exact: true }).click();
    await page.getByLabel('Label', { exact: true }).fill('Browser resume');
    await page.getByLabel('Tags, separated by commas').fill('browser, primary');
    await page.getByLabel('Resume file').setInputFiles({ name: 'browser.txt', mimeType: 'text/plain', buffer: Buffer.from('browser resume') });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Resume imported', { exact: true }).waitFor();
    await page.getByRole('button', { name: /Browser resume · Default/ }).click();
    await page.getByLabel('Label', { exact: true }).fill('Browser resume updated');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Resume details saved', { exact: true }).waitFor();
    await page.getByLabel('Replacement file').setInputFiles({ name: 'updated.txt', mimeType: 'text/plain', buffer: Buffer.from('updated browser resume') });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Resume file replaced', { exact: true }).waitFor();
    const resumeDocument = JSON.parse(await readFile(join(root, 'resumes.json'), 'utf8'));
    const browserResume = Object.values(resumeDocument.resumes)[0];
    assert.equal(browserResume.label, 'Browser resume updated');
    assert.equal(await readFile(join(root, 'resume-files', browserResume.managedFile), 'utf8'), 'updated browser resume');
    await resumeDraftBrowser(page, root, fixture, buildRoot, browserResume.id);
    const answers = await nativeAnswersBrowser(page, root, fixture, buildRoot);
    const token = new URLSearchParams(new URL(startup.url).hash.slice(1)).get('token');
    const unsupported = await fetch(startup.origin + '/api/overview', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(unsupported.status, 501);
    assert.deepEqual(pageErrors, []);
    return { facts, answers, resumes: true, browserHttpTsDisk: true, cliSharesService: true, conflictReapplyReload: true, pythonAbsentFromPath: true };
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Native launcher cleanup timed out')); }, 6000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await fixture.cleanup();
  }
}
