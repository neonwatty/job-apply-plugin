import assert from 'node:assert/strict';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { criticalPaths, assertCriticalBytes } from '../../runtime/package/installed-artifacts.js';

export async function copyCritical(source, target) {
  await mkdir(target, { recursive: true });
  for (const relative of await criticalPaths(source, '3.12')) {
    const destination = join(target, relative);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(source, relative), destination, { force: true, preserveTimestamps: true });
  }
}
export async function verifyArtifact(root) {
  for (const name of ['.git', '.qa-private', 'qa/runs', '.job-apply-qa', 'node_modules', 'coverage', 'dist', 'build', '.worktrees', 'docs/goals', 'test_resumes']) {
    assert.equal(await lstat(join(root, name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false, `excluded artifact ${name}`);
  }
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, 'artifact symlink');
      assert.equal(/\.(?:py|pyc|pyo)$/.test(entry.name) || entry.name === '__pycache__', false, 'Python content in artifact');
      if (entry.isDirectory()) await walk(join(directory, entry.name));
    }
  }
  await walk(root);
}
export async function installedCodex(home, listing, source) {
  const installed = listing.installed.find(plugin => plugin.pluginId === 'job-apply@neonwatty-plugins');
  const version = JSON.parse(await readFile(join(source, '.codex-plugin/plugin.json'), 'utf8')).version;
  assert.equal(installed?.enabled, true); assert.equal(installed.version, version);
  const root = join(home, 'plugins/cache/neonwatty-plugins/job-apply', version);
  await assertCriticalBytes(root, source, { profile: '3.12', label: 'installed Codex' });
  const expected = ['account-setup','answer-memory','application-setup','job-apply','job-preferences','job-search','job-title-discovery','job-workspace','saved-jobs'];
  assert.deepEqual((await readdir(join(root, 'skills'))).sort(), expected.sort());
  await verifyArtifact(root);
  return root;
}
export async function preparePrior(root) {
  const manifest = join(root, '.codex-plugin/plugin.json');
  const value = JSON.parse(await readFile(manifest, 'utf8')); value.version = '1.1.0';
  await writeFile(manifest, JSON.stringify(value));
  await writeFile(join(root, 'runtime/cli/native-jobs.js'), '# isolated-old-version-sentinel\n');
}
