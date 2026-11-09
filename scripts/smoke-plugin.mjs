import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyCritical, installedCodex, preparePrior, verifyArtifact } from './smoke/artifacts.mjs';
import { packagedTitleDiscoveryJourney } from '../tests_js/workspace_title_discovery_packaged_support.mjs';

const execute = promisify(execFile);
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'job-apply-native-package-')));
async function run(command, args, environment = {}, quiet = false) {
  const result = await execute(command, args, { cwd: root, env: { ...process.env, ...environment },
    timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout && !quiet) process.stdout.write(result.stdout);
  return result.stdout;
}
try {
  await run('claude', ['plugin', 'validate', root]);
  await run(process.execPath, ['tools/build-runtime.mjs', '--check']);
  const source = join(temporary, 'source'); await mkdir(source);
  const paths = (await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {}, true)).split('\0').filter(Boolean);
  for (const path of new Set(paths)) {
    if (/^(?:\.git\/|\.qa-private\/|qa\/runs\/|\.job-apply-qa\/|node_modules\/|\.worktrees\/|docs\/goals\/|test_resumes\/)/.test(path)) continue;
    await mkdir(join(source, path, '..'), { recursive: true });
    await cp(join(root, path), join(source, path), { recursive: true });
  }
  await run(process.execPath, ['scripts/smoke/source_bootstrap.mjs', source, temporary]);
  const fixture = join(temporary, 'package'); await copyCritical(source, fixture); await verifyArtifact(fixture);
  // Cache replacement is independent of actual Python Store migration acceptance.
  const prior = join(temporary, 'prior'), upgradeHome = join(temporary, 'codex-upgrade');
  await copyCritical(fixture, prior); await preparePrior(prior); await mkdir(upgradeHome, { mode: 0o700 });
  await run('codex', ['plugin', 'marketplace', 'add', prior, '--json'], { CODEX_HOME: upgradeHome });
  await run('codex', ['plugin', 'add', 'job-apply@neonwatty-plugins', '--json'], { CODEX_HOME: upgradeHome });
  assert.equal(await readFile(join(upgradeHome, 'plugins/cache/neonwatty-plugins/job-apply/1.1.0/runtime/cli/native-jobs.js'), 'utf8'), '# isolated-old-version-sentinel\n');
  await copyCritical(fixture, prior);
  await run('codex', ['plugin', 'add', 'job-apply@neonwatty-plugins', '--json'], { CODEX_HOME: upgradeHome });
  await installedCodex(upgradeHome, JSON.parse(await run('codex', ['plugin', 'list', '--json'], { CODEX_HOME: upgradeHome })), fixture);
  await run(process.execPath, ['--test', '--test-concurrency=1', 'tests_js/required_companion.test.mjs'], { JOB_WORKSPACE_TEST_ROOT: source });
  const marketplace = join(fixture, '.claude-plugin/marketplace.json');
  const manifest = JSON.parse(await readFile(marketplace, 'utf8')); manifest.plugins[0].source = './';
  await writeFile(marketplace, JSON.stringify(manifest));
  const claudeHome = join(temporary, 'claude'), codexHome = join(temporary, 'codex');
  await mkdir(claudeHome, { mode: 0o700 }); await mkdir(codexHome, { mode: 0o700 });
  await run('claude', ['plugin', 'marketplace', 'add', fixture], { CLAUDE_CONFIG_DIR: claudeHome });
  await run('claude', ['plugin', 'install', 'job-apply@neonwatty-plugins'], { CLAUDE_CONFIG_DIR: claudeHome });
  const claudeList = await run('claude', ['plugin', 'list', '--json'], { CLAUDE_CONFIG_DIR: claudeHome });
  assert.match(claudeList, /job-apply@neonwatty-plugins/);
  await run('codex', ['plugin', 'marketplace', 'add', fixture, '--json'], { CODEX_HOME: codexHome });
  await run('codex', ['plugin', 'add', 'job-apply@neonwatty-plugins', '--json'], { CODEX_HOME: codexHome });
  const installed = await installedCodex(codexHome, JSON.parse(await run('codex', ['plugin', 'list', '--json'], { CODEX_HOME: codexHome })), fixture);
  await run(process.execPath, ['scripts/smoke/native_activation.mjs', installed, temporary]);
  console.log(JSON.stringify(await packagedTitleDiscoveryJourney({ codexRoot: installed, claudeConfigRoot: claudeHome,
    codexHost: 'available_unrun', claudeHost: 'available_unrun' })));
  console.log('TypeScript-only installed package, cache upgrade, browser and restart checks passed');
} finally { await rm(temporary, { recursive: true, force: true }); }
