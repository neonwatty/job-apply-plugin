import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertCriticalBytes } from '../../runtime/package/installed-artifacts.js';
import { installedCodex, verifySourceRuntime } from './artifacts.mjs';

/** Exercise the full source checkout, without the assembled-fixture whitelist. */
export async function installSourceCheckouts(source, temporary, run) {
  // Redirect only the fixture marketplace address, so Claude does not fetch main.
  const manifestPath = join(source, '.claude-plugin/marketplace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.plugins[0].source = './';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const codexHome = join(temporary, 'codex-source'), claudeHome = join(temporary, 'claude-source');
  await mkdir(codexHome, { mode: 0o700 });
  await mkdir(claudeHome, { mode: 0o700 });
  await run('codex', ['plugin', 'marketplace', 'add', source, '--json'], { CODEX_HOME: codexHome });
  await run('codex', ['plugin', 'add', 'job-apply@neonwatty-plugins', '--json'], { CODEX_HOME: codexHome });
  const listing = JSON.parse(await run('codex', ['plugin', 'list', '--json'], { CODEX_HOME: codexHome }));
  const codexRoot = await installedCodex(codexHome, listing, source, { sourceCheckout: true });
  await run('claude', ['plugin', 'marketplace', 'add', source], { CLAUDE_CONFIG_DIR: claudeHome });
  await run('claude', ['plugin', 'install', 'job-apply@neonwatty-plugins'], { CLAUDE_CONFIG_DIR: claudeHome });
  const versions = join(claudeHome, 'plugins/cache/neonwatty-plugins/job-apply');
  const names = await readdir(versions);
  assert.equal(names.length, 1, 'one isolated source installation');
  const claudeRoot = join(versions, names[0]);
  await assertCriticalBytes(claudeRoot, source, { profile: '3.12', label: 'source Claude' });
  await verifySourceRuntime(claudeRoot);
  const store = join(temporary, 'source-claude-store');
  await run(process.execPath, [join(claudeRoot, 'apps/companion/command.mjs'), 'store', '--root', store, 'init'],
    { PATH: '', HOME: temporary }, true);
  const profile = await run(process.execPath, [join(claudeRoot, 'apps/companion/command.mjs'), 'store', '--root', store, 'profile-get'],
    { PATH: '', HOME: temporary }, true);
  assert.equal(typeof JSON.parse(profile), 'object');
  return { codexRoot, claudeRoot };
}
