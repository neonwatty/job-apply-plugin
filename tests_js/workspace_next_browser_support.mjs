import { reactTrashBrowser } from './workspace_react_trash_browser_support.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nextSetupAndLoading, nextDraftAndRecovery, nextLateRead } from './workspace_next_ux_support.mjs';
import { nativeJobsBrowser } from './workspace_native_browser_support.mjs';
const execute = promisify(execFile);
const repository = dirname(dirname(fileURLToPath(import.meta.url)));

export async function nextBrowser() {
  // Hook snapshots share node_modules for unit checks. Next standalone tracing
  // needs dependencies physically inside its build root, including workspace
  // links. Build from copied current source with its own locked installation.
  const root = await mkdtemp(join(tmpdir(), 'next-companion-build-'));
  try {
    for (const path of ['apps', 'src', 'runtime', 'scripts', 'workspace', 'native', 'qa',
      'package.json', 'package-lock.json']) {
      await cp(join(repository, path), join(root, path), { recursive: true,
        filter: path => !/(?:^|\/)(?:node_modules|\.next|__pycache__)(?:\/|$)/.test(path)
          && !/(?:^|\/)qa\/runs(?:\/|$)/.test(path)
          && !/\.(?:pyc|tsbuildinfo)$/.test(path) });
    }
    await execute('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: root, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const compatibility = await productionBrowser(root);
    return { ...compatibility, nativeJobs: await nativeJobsBrowser(root) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function productionBrowser(root) {
  await execute('npm', ['run', 'companion:build'], {
    cwd: root, timeout: 90000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  const store = await mkdtemp(join(tmpdir(), 'next-companion-store-'));
  const child = spawn(process.execPath, ['apps/companion/launch.mjs', '--root', store], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  child.stderr.on('data', () => {});
  try {
    const startup = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Companion startup timed out')), 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(Error('Companion exited during startup')); });
      child.stdout.on('data', data => {
        output += data;
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
      });
    });
    const origin = startup.origin;
    const token = new URLSearchParams(new URL(startup.url).hash.slice(1)).get('token');
    const headers = { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' };
    assert.equal((await fetch(origin + '/api/state')).status, 401);
    assert.equal((await fetch(origin + '/api/jobs', { method: 'POST', headers: { ...headers, Origin: 'https://elsewhere.invalid' }, body: '{}' })).status, 403);
    for (const method of ['PUT', 'DELETE', 'OPTIONS']) {
      assert.equal((await fetch(origin + '/api/jobs', { method })).status, 405);
    }
    for (const path of ['/api/jobs/%zz', '/api/jobs/%ff']) {
      assert.equal((await fetch(origin + path, { headers })).status, 400);
    }
    for (const path of ['/api/resumes/import', '/api/resumes/synthetic/replace', '/api/resumes/synthetic/adopt']) {
      const response = await fetch(origin + path, { method: 'POST', headers,
        body: JSON.stringify({ metadata: {}, filename: 'synthetic.txt', content: 'YQ=='.repeat(20000) }) });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.message, 'resume content must be strict base64');
    }
    const html = await fetch(origin);
    assert.equal(html.status, 200);
    assert.equal((await html.text()).includes(token), false);
    assert.match(html.headers.get('content-security-policy'), /script-src 'self' 'nonce-/);
    assert.doesNotMatch(html.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
    browser = await chromium.launch({ headless: true, timeout: 10000 });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], violations = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.exposeFunction('recordCsp', value => violations.push(value));
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
      globalThis.recordCsp({ directive: event.violatedDirective, blocked: event.blockedURI });
    }));
    await page.goto(startup.url, { waitUntil: 'networkidle' });
    await page.getByText('Canonical store connected', { exact: true }).waitFor();
    await nextSetupAndLoading(page, startup.url);
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.getByRole('button', { name: 'New job', exact: true }).click();
    await page.locator('dialog [name="url"]').fill('https://example.invalid/next-smoke');
    await page.locator('dialog [name="role"]').fill('Next synthetic role');
    await page.getByRole('button', { name: 'Save job', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: /Next synthetic role/ }).click();
    await page.locator('dialog [name="notes"]').fill('Preserved React draft');
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh').click());
    await refreshed;
    assert.equal(await page.locator('dialog [name="notes"]').inputValue(), 'Preserved React draft');
    const state = await (await fetch(origin + '/api/state', { headers })).json();
    const job = state.jobs.find(job => job.role === 'Next synthetic role');
    assert.ok(job);
    const concurrent = await fetch(origin + `/api/jobs/${job.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ patch: { company: 'Other writer' }, expectedRevision: job.revision }),
    });
    assert.equal(concurrent.status, 200);
    await page.getByRole('button', { name: 'Save job', exact: true }).click();
    await page.getByText('This job changed elsewhere', { exact: true }).waitFor();
    assert.equal(await page.locator('dialog [name="notes"]').inputValue(), 'Preserved React draft');
    await page.getByRole('button', { name: 'Reapply my draft', exact: true }).click();
    assert.equal(await page.locator('dialog [name="company"]').inputValue(), 'Other writer');
    await page.getByRole('button', { name: 'Save job', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'hidden' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.getByRole('button', { name: /Next synthetic role/ }).click();
    assert.equal(await page.locator('dialog [name="notes"]').inputValue(), 'Preserved React draft');
    assert.equal(await page.locator('dialog [name="company"]').inputValue(), 'Other writer');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await nextDraftAndRecovery(page, origin, headers);
    await nextLateRead(page);
    const trash = await reactTrashBrowser(page, { origin, headers });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Open full workspace', exact: true }).first().click();
    await page.getByText('Canonical store connected', { exact: true }).waitFor();
    await page.locator('#nav-jobs').click();
    await page.getByRole('button', { name: /Next synthetic role/ }).click();
    assert.equal(await page.locator('#job-form [name="notes"]').inputValue(), 'Preserved React draft');
    assert.equal((await page.request.get(origin + '/styles.css')).status(), 200);
    assert.equal((await page.request.get(origin + '/runtime/workspace-ui/lib/activity-view.js')).status(), 200);
    assert.deepEqual(errors, []);
    assert.deepEqual(violations, []);
    // The launcher owns two process groups. An unexpected service exit must
    // terminate the launcher and its sibling, not leave an orphan Store writer.
    const processRows = (await execute('ps', ['-axo', 'pid=,ppid='])).stdout.trim().split('\n')
      .map(row => row.trim().split(/\s+/).map(Number));
    const owned = processRows.filter(([, parent]) => parent === child.pid).map(([pid]) => pid);
    assert.equal(owned.length, 2);
    const stopped = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Launcher did not stop after service failure')), 6000);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    process.kill(owned[0], 'SIGTERM');
    assert.equal(await stopped, 1);
    for (const pid of owned) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(fetch(origin + '/api/boot', { signal: AbortSignal.timeout(1000) }));
    return { trash, productionStandalone: true, browser: browser.version(), editing: true,
      draftRefresh: true, revisionConflict: true, reapply: true, reload: true, legacy: true,
      serviceFailureCleanup: true, httpParity: true, cleanDependencyInstall: true, setupDestinations: true, loadingAndDraftRecovery: true, narrowLayout: true, dialogFocus: true, cancelledStaleRead: true, cspViolations: violations };
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Launcher cleanup timed out')); }, 6000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await rm(store, { recursive: true, force: true });
  }
}
