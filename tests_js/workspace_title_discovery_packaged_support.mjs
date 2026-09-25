import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { spawnOwnedCompanion } from './workspace_next_process_support.mjs';

const execute = promisify(execFile);
const references = ['SKILL.md', 'references/discovery-workflow.md', 'references/result-format.md'];

async function assertInstalledSkill(root) {
  const skill = join(root, 'skills/job-title-discovery');
  const content = await Promise.all(references.map(name => readFile(join(skill, name), 'utf8')));
  assert.match(content[0], /Job Title Discovery/);
  assert.match(content[0], /Do not write private Store files/);
  assert.match(content[1], /requires login|blocked/);
  assert.match(content[2], /"version": 1/);
}

async function claudeInstalledRoot(configRoot) {
  const versions = join(configRoot, 'plugins/cache/neonwatty-plugins/job-apply');
  const names = await readdir(versions);
  assert.equal(names.length, 1, 'expected one isolated Claude plugin version');
  return join(versions, names[0]);
}

export async function packagedTitleDiscoveryJourney({ codexRoot, claudeConfigRoot, codexHost, claudeHost }) {
  assert.match(codexHost, /^(?:available|unavailable)_unrun$/);
  assert.match(claudeHost, /^(?:available|unavailable)_unrun$/);
  const codexInstalled = codexRoot ? resolve(codexRoot) : null;
  if (codexInstalled) { assert.equal(codexInstalled, codexRoot); await assertInstalledSkill(codexInstalled); }
  const claudeInstalled = claudeConfigRoot ? await claudeInstalledRoot(claudeConfigRoot) : null;
  if (claudeInstalled) await assertInstalledSkill(claudeInstalled);
  const installed = codexInstalled ?? claudeInstalled;
  assert.ok(installed, 'at least one capability-gated packaged host is required for the Companion journey');
  const { initializeJobsFixture } = await import(pathToFileURL(join(installed, 'runtime/store/native-jobs.js')).href);
  const { resolvePackagedNativeLock } = await import(pathToFileURL(join(installed, 'runtime/package/native-lock-artifact.js')).href);
  const lock = await resolvePackagedNativeLock(installed);
  const temporary = await mkdtemp(join(tmpdir(), 'packaged-titles-'));
  const root = join(await realpath(temporary), 'store');
  await initializeJobsFixture(root);
  const launcher = await spawnOwnedCompanion(installed, root, ['--writer', 'native-fixture', '--native-lock', lock], { leaseArtifact: lock });
  let browser;
  try {
    const startup = await new Promise((done, fail) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => fail(Error(`packaged Companion startup timed out: ${stderr}`)), 30000);
      launcher.child.stderr.on('data', bytes => { stderr += bytes.toString(); });
      launcher.child.once('exit', code => { clearTimeout(timer); fail(Error(`packaged Companion exited ${code}: ${stderr}`)); });
      launcher.child.stdout.on('data', bytes => {
        stdout += bytes;
        if (!stdout.includes('\n')) return;
        clearTimeout(timer);
        try { done(JSON.parse(stdout.split('\n')[0])); } catch (error) { fail(error); }
      });
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(startup.url);
    await page.getByRole('button', { name: 'Facts', exact: true }).click();
    const panel = page.locator('#title-discovery');
    await panel.getByText('Saved now: No target titles yet.').waitFor();
    const before = JSON.parse(await readFile(join(root, 'profile.json'), 'utf8'));
    await panel.getByRole('button', { name: 'Discover related titles' }).click();
    await panel.getByLabel(/Role interests, constraints/).fill('Adjacent ML roles');
    await panel.getByRole('button', { name: 'Copy Codex invocation' }).click();
    await panel.getByText(/invocation copied|Clipboard unavailable/).waitFor();
    await panel.getByRole('button', { name: 'Copy Claude Code invocation' }).click();
    await panel.getByText(/invocation copied|Clipboard unavailable/).waitFor();
    await panel.getByRole('button', { name: 'Cancel discovery' }).click();
    assert.deepEqual(JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')), before);
    await panel.getByRole('button', { name: 'Discover related titles' }).click();
    const unavailable = await readFile(new URL('./fixtures/title-discovery/unavailable.json', import.meta.url), 'utf8');
    await panel.getByLabel('Title discovery JSON result packet').fill(unavailable);
    await panel.getByRole('button', { name: 'Review packet' }).click();
    await panel.getByText('Research source: logged out').waitFor();
    assert.deepEqual(JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')), before);
    const observed = await readFile(new URL('./fixtures/title-discovery/observed.json', import.meta.url), 'utf8');
    await panel.getByLabel('Title discovery JSON result packet').fill(observed);
    await panel.getByRole('button', { name: 'Review packet' }).click();
    await panel.locator('.title-discovery-choice').filter({ hasText: 'Staff Machine Learning Engineer' }).getByRole('checkbox').check();
    assert.match(await panel.locator('.title-discovery-preview').innerText(), /Staff Machine Learning Engineer/);
    await panel.getByRole('button', { name: 'Confirm and save exact titles' }).click();
    await panel.getByText(/Target titles saved/).waitFor();
    const saved = JSON.parse(await readFile(join(root, 'profile.json'), 'utf8'));
    assert.deepEqual(saved.profile.preferences.targetTitles, ['Staff Machine Learning Engineer']);
    const { stdout } = await execute(process.execPath, [join(installed, 'runtime/cli/native-jobs.js'), '--root', root,
      '--native-lock', lock, 'profile-inspect']);
    assert.deepEqual(JSON.parse(stdout).profile.preferences.targetTitles, saved.profile.preferences.targetTitles);
    return { codex: { installed: Boolean(codexInstalled), agent: codexHost },
      claude: { installed: Boolean(claudeInstalled), agent: claudeHost },
      packagedBrowser: true, cancel: true, sourceLimit: true, canonicalSave: true };
  } finally {
    await browser?.close();
    await launcher.stop();
    await rm(temporary, { recursive: true, force: true });
  }
}
