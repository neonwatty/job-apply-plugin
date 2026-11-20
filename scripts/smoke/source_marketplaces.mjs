import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertCriticalBytes } from '../../runtime/package/installed-artifacts.js';
import { installedCodex, verifySourceRuntime } from './artifacts.mjs';

/** Exercise the full source checkout, without the assembled-fixture whitelist. */
export async function installSourceCheckouts(source, temporary, run, marketplace = source) {
  if (marketplace === source) {
    // Candidate validation uses only the source checkout under test.
    for (const [path, entry] of [
      ['.agents/plugins/marketplace.json', { source: 'local', path: './' }],
      ['.claude-plugin/marketplace.json', './'],
    ]) {
      const manifestPath = join(source, path);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.plugins.find(plugin => plugin.name === 'job-apply').source = entry;
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
  }
  const codexHome = join(temporary, 'codex-source'), claudeHome = join(temporary, 'claude-source');
  await mkdir(codexHome, { mode: 0o700 });
  await mkdir(claudeHome, { mode: 0o700 });
  await run('codex', ['plugin', 'marketplace', 'add', marketplace, '--json'], { CODEX_HOME: codexHome });
  await run('codex', ['plugin', 'add', 'job-apply@neonwatty-plugins', '--json'], { CODEX_HOME: codexHome });
  const listing = JSON.parse(await run('codex', ['plugin', 'list', '--json'], { CODEX_HOME: codexHome }));
  const codexRoot = await installedCodex(codexHome, listing, source, { sourceCheckout: true });
  await run('claude', ['plugin', 'marketplace', 'add', marketplace], { CLAUDE_CONFIG_DIR: claudeHome });
  await run('claude', ['plugin', 'install', 'job-apply@neonwatty-plugins'], { CLAUDE_CONFIG_DIR: claudeHome });
  const versions = join(claudeHome, 'plugins/cache/neonwatty-plugins/job-apply');
  const names = await readdir(versions);
  assert.equal(names.length, 1, 'one isolated source installation');
  const claudeRoot = join(versions, names[0]);
  await assertCriticalBytes(claudeRoot, source, { profile: '3.12', label: 'source Claude' });
  await verifySourceRuntime(claudeRoot);
  const store = join(temporary, 'source-claude-store');
  await run(process.execPath, [join(claudeRoot, 'apps/companion/command.mjs'), 'store', '--root', store, '--legacy-profile', join(temporary, 'absent-legacy-profile.json'), 'init'],
    { PATH: '', HOME: temporary }, true);
  const profile = await run(process.execPath, [join(claudeRoot, 'apps/companion/command.mjs'), 'store', '--root', store, 'profile-get'],
    { PATH: '', HOME: temporary }, true);
  assert.equal(typeof JSON.parse(profile), 'object');
  return { codexRoot, claudeRoot };
}
