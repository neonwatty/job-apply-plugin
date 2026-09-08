import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
async function browserAtRoot(root) {
    const temporary = await mkdtemp(join(tmpdir(), 'hybrid-browser-store-'));
    const child = spawn(process.env.PYTHON || 'python3', [join(root, 'scripts/job-apply-workspace.py'), '--root', temporary, '--port', '0', '--no-open', '--json'], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe']
    });
    let browser, stderr = '';
    child.stderr.on('data', chunk => {
        stderr += chunk;
    });
    async function shutdown() {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null)
            return;
        for (const signal of ['SIGINT', 'SIGKILL']) {
            const stopped = await new Promise(resolve => {
                let timer;
                const done = () => {
                    clearTimeout(timer);
                    child.removeListener('exit', done);
                    child.removeListener('error', done);
                    resolve(child.exitCode !== null || child.signalCode !== null);
                };
                child.once('exit', done);
                child.once('error', done);
                timer = setTimeout(done, 1000);
                child.kill(signal);
            });
            if (stopped)
                return;
        }
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        throw Error('Owned server failed bounded shutdown');
    }
    try {
        const startup = await new Promise((resolve, reject) => {
            let output = '';
            const timer = setTimeout(() => reject(Error(`startup timeout: ${stderr}`)), 5000);
            child.once('error', error => {
                clearTimeout(timer);
                reject(error);
            });
            child.once('exit', code => {
                clearTimeout(timer);
                reject(Error(`startup exit ${code}: ${stderr}`));
            });
            child.stdout.on('data', chunk => {
                output += chunk;
                if (!output.includes('\n'))
                    return;
                clearTimeout(timer);
                try {
                    resolve(JSON.parse(output.split('\n')[0]));
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        browser = await chromium.launch({
            headless: true, timeout: 10000
        });
        const page = await browser.newPage();
        page.setDefaultTimeout(8000);
        const errors = [], failed = [], loaded = [];
        await page.addInitScript(() => {
            globalThis.hybridCspViolations = [];
            document.addEventListener('securitypolicyviolation', event => globalThis.hybridCspViolations.push({
                directive: event.violatedDirective, blocked: event.blockedURI
            }));
        });
        page.on('pageerror', error => errors.push(String(error)));
        page.on('requestfailed', request => failed.push(new URL(request.url()).pathname));
        page.on('response', response => {
            if (new URL(response.url()).pathname.startsWith('/runtime/workspace-ui/lib/'))
                loaded.push({
                    response, body: response.body()
                });
        });
        const boot = page.waitForResponse(response => new URL(response.url()).pathname === '/api/boot');
        await page.goto(startup.url, {
            waitUntil: 'networkidle', timeout: 15000
        });
        assert.deepEqual(await (await boot).json(), {
            status: 'ready', code: 'ready'
        });
        await page.getByText('Canonical store connected', {
            exact: true
        }).waitFor();
        assert.equal(await page.locator('#overview-workspace').isVisible(), true);
        await page.locator('#nav-jobs').click();
        assert.equal(await page.locator('#jobs-workspace').isVisible(), true);
        await page.locator('#nav-facts').click();
        assert.equal(await page.locator('#facts-workspace').isVisible(), true);
        await page.locator('#nav-overview').click();
        assert.equal(await page.locator('#overview-workspace').isVisible(), true);
        await page.locator('#nav-jobs').click();
        await page.locator('#new-job').click();
        await page.locator('#job-form [name="url"]').fill('https://example.invalid/hybrid-smoke');
        await page.locator('#job-form [name="role"]').fill('Hybrid synthetic role');
        await page.locator('#save-job').click();
        await page.locator('#job-dialog').waitFor({
            state: 'hidden'
        });
        await page.getByRole('button', {
            name: /Hybrid synthetic role/
        }).click();
        await page.locator('#job-form [name="notes"]').fill('Unsaved synthetic draft');
        const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
        await page.evaluate(() => document.querySelector('#refresh').click());
        await refreshed;
        assert.equal(await page.locator('#job-form [name="notes"]').inputValue(), 'Unsaved synthetic draft');
        const token = new URLSearchParams(new URL(startup.url).hash.slice(1)).get('token');
        const apiHeaders = {
            Authorization: `Bearer ${token}`, Origin: new URL(startup.url).origin
        };
        const canonical = await (await page.request.get(new URL('/api/state', startup.url).href, {
            headers: apiHeaders
        })).json();
        const job = canonical.jobs.find(item => item.role === 'Hybrid synthetic role');
        assert.ok(job);
        const concurrent = await page.request.patch(new URL(`/api/jobs/${encodeURIComponent(job.id)}`, startup.url).href, {
            headers: apiHeaders, data: {
                patch: {
                    company: 'Concurrent canonical company'
                }, expectedRevision: job.revision
            }
        });
        assert.equal(concurrent.status(), 200);
        const conflict = page.waitForResponse(response => response.request().method() === 'PATCH' && response.status() === 409);
        await page.locator('#save-job').click();
        await conflict;
        await page.locator('#conflict').waitFor({
            state: 'visible'
        });
        assert.equal(await page.locator('#job-form [name="notes"]').inputValue(), 'Unsaved synthetic draft');
        assert.match(await page.locator('#conflict-latest').textContent(), /Concurrent canonical company/);
        await page.locator('#rebase-draft').click();
        assert.equal(await page.locator('#job-form [name="company"]').inputValue(), 'Concurrent canonical company');
        assert.equal(await page.locator('#job-form [name="notes"]').inputValue(), 'Unsaved synthetic draft');
        await page.locator('#save-job').click();
        await page.locator('#job-dialog').waitFor({
            state: 'hidden'
        });
        const preReloadCsp = await page.evaluate(() => globalThis.hybridCspViolations);
        await page.reload({
            waitUntil: 'networkidle'
        });
        await page.locator('#nav-jobs').click();
        await page.getByRole('button', {
            name: /Hybrid synthetic role/
        }).click();
        assert.equal(await page.locator('#job-form [name="notes"]').inputValue(), 'Unsaved synthetic draft');
        assert.equal(await page.locator('#job-form [name="company"]').inputValue(), 'Concurrent canonical company');
        const persisted = await (await page.request.get(new URL(`/api/jobs/${encodeURIComponent(job.id)}`, startup.url).href, {
            headers: apiHeaders
        })).json();
        assert.equal(persisted.notes, 'Unsaved synthetic draft');
        assert.equal(persisted.revision, job.revision + 2);
        assert.equal(new Set(loaded.map(({ response }) => new URL(response.url()).pathname)).size, 5);
        for (const { response, body } of loaded) {
            const path = new URL(response.url()).pathname;
            assert.equal(response.status(), 200);
            assert.equal(response.headers()['content-type'], 'text/javascript; charset=utf-8');
            assert.deepEqual(await body, await readFile(join(root, path.slice(1))));
        }
        const identity = await page.evaluate(async () => {
            const bridge = await import('/lib/helpers.js'), original = await import('/lib/helpers-original.js');
            const leaves = await Promise.all(['answer', 'profile', 'resume', 'trash', 'activity'].map(name => import(`/runtime/workspace-ui/lib/${name}-view.js`)));
            return {
                names: Object.keys(bridge).sort(), originalNames: Object.keys(original).sort(), runtimeMatches: leaves.every(leaf => Object.entries(leaf).every(([name, value]) => bridge[name] === value)), fileReaderMatches: bridge.fileToBase64 === original.fileToBase64
            };
        });
        assert.deepEqual(identity.names, identity.originalNames);
        assert.equal(identity.names.length, 36);
        assert.equal(identity.runtimeMatches, true);
        assert.equal(identity.fileReaderMatches, true);
        assert.deepEqual(errors, []);
        assert.deepEqual(failed, []);
        const cspViolations = [...preReloadCsp, ...await page.evaluate(() => globalThis.hybridCspViolations)];
        assert.deepEqual(cspViolations, []);
        return {
            passed: true, editing: true, draftRefresh: true, revisionConflict: true, rebase: true, persistedReload: true, cspViolations, browser: browser.version(), modules: loaded.map(({ response }) => new URL(response.url()).pathname).sort(), boot: 'ready', navigation: ['overview', 'jobs', 'facts', 'overview'], exports: identity.names.length, runtimeIdentity: true, legacyFileReaderIdentity: true, pageErrors: errors, failedRequests: failed
        };
    }
    finally {
        try {
            if (browser)
                await browser.close({
                    reason: 'isolated smoke complete'
                });
        }
        finally {
            try {
                await shutdown();
            }
            finally {
                await rm(temporary, {
                    recursive: true, force: true
                });
            }
        }
    }
}
export async function hybridBrowser() {
    const current = await browserAtRoot(REPO_ROOT);
    const temporary = await mkdtemp(join(tmpdir(), 'hybrid-package-'));
    try {
        const archive = join(temporary, 'fixture.tar');
        const target = join(temporary, 'package');
        const { mkdir } = await import('node:fs/promises');
        await mkdir(target);
        const excluded = ['./.git', './.qa-private', './qa/runs', './.job-apply-qa',
            './node_modules', './coverage', './dist', './build', '__pycache__', '*.py[co]',
            './.worktrees', './docs/goals', './test_resumes'];
        await execute('tar', [...excluded.map(path => `--exclude=${path}`), '-cf', archive, '-C', REPO_ROOT, '.'], {
            timeout: 20000, maxBuffer: 1048576
        });
        await execute('tar', ['-xf', archive, '-C', target], {
            timeout: 20000, maxBuffer: 1048576
        });
        await execute(process.env.PYTHON || 'python3', [join(REPO_ROOT, 'scripts/smoke/fixture_build.py'), 'verify', target], {
            timeout: 20000, maxBuffer: 1048576
        });
        const packaged = await browserAtRoot(target);
        return {
            current, packaged
        };
    }
    finally {
        await rm(temporary, {
            recursive: true, force: true
        });
    }
}
