import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildDogfoodPackage, verifyDogfoodPackage } from '../tools/dogfood-package.mjs';
import { FIXED_CRITICAL_FILES, CRITICAL_TREES } from '../runtime/package/installed-artifacts.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dogfood-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'repo');
  await mkdir(repository);
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  for (const path of FIXED_CRITICAL_FILES) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), path.endsWith('.json') ? JSON.stringify({ name: 'job-apply', version: '1.3.5', plugins: [{ source: {} }] }) : 'manual submission only\n');
  }
  for (const path of CRITICAL_TREES) {
    await mkdir(join(repository, path), { recursive: true });
    await writeFile(join(repository, path, 'fixture.txt'), 'committed fixture\n');
  }
  await mkdir(join(repository, 'src'), { recursive: true });
  await writeFile(join(repository, 'src/bootstrap.ts'), 'export const bootstrap = true;\n');
  await writeFile(join(repository, 'package-lock.json'), '{"lockfileVersion": 3}');
  await writeFile(join(repository, 'tsconfig.json'), '{}');
  await writeFile(join(repository, 'private-note.txt'), 'excluded even when committed');
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return { root, repository, ref: git(['rev-parse', 'HEAD']), output: join(root, 'package') };
}
const nativePackager = async root => {
  await mkdir(join(root, 'native/packaged-lock'), { recursive: true });
  await writeFile(join(root, 'native/packaged-lock/test.node'), 'fake-native');
  return { platform: process.platform, arch: process.arch, artifactSha256: 'test' };
};

test('package uses committed critical artifacts and preserves stable manifest versions', async t => {
  const options = await fixture(t);
  await writeFile(join(options.repository, 'skills/job-apply/SKILL.md'), 'dirty unreviewed');
  const receipt = await buildDogfoodPackage({ ...options, nativePackager });
  assert.equal(receipt.sourceCommit, options.ref);
  assert.equal(receipt.pluginVersion, '1.3.5');
  assert.equal(await readFile(join(options.output, 'plugin/src/bootstrap.ts'), 'utf8'), 'export const bootstrap = true;\n');
  assert.equal(await readFile(join(options.output, 'plugin/package-lock.json'), 'utf8'), '{"lockfileVersion": 3}');
  assert.equal(await readFile(join(options.output, 'plugin/tsconfig.json'), 'utf8'), '{}');
  assert.equal(await readFile(join(options.output, 'plugin/skills/job-apply/SKILL.md'), 'utf8'), 'manual submission only\n');
  await assert.rejects(readFile(join(options.output, 'plugin/private-note.txt')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(options.output, 'plugin/.claude-plugin/marketplace.json'))).plugins[0].source, './');
  assert.equal((await verifyDogfoodPackage(options.output)).sourceCommit, options.ref);
  await assert.rejects(buildDogfoodPackage({ ...options, nativePackager }), /exist/i);
});

test('verification rejects changed, extra, and symlinked package artifacts', async t => {
  const options = await fixture(t);
  await buildDogfoodPackage({ ...options, nativePackager });
  const file = join(options.output, 'plugin/skills/job-apply/SKILL.md');
  await writeFile(file, 'tampered');
  await assert.rejects(verifyDogfoodPackage(options.output), /mismatch/);
  await writeFile(file, 'manual submission only\n');
  await writeFile(join(options.output, 'plugin/extra.txt'), 'unexpected');
  await assert.rejects(verifyDogfoodPackage(options.output), /inventory/);
  await rm(join(options.output, 'plugin/extra.txt'));
  await rm(file);
  await symlink(join(options.repository, 'skills/job-apply/SKILL.md'), file);
  await assert.rejects(verifyDogfoodPackage(options.output), /symlink/);
});

test('failed native packaging leaves no output and does not touch source files', async t => {
  const options = await fixture(t);
  await assert.rejects(buildDogfoodPackage({ ...options, nativePackager: async () => { throw Error('native unavailable'); } }), /native unavailable/);
  await assert.rejects(readFile(join(options.output, 'receipt.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(options.repository, 'skills/job-apply/SKILL.md'), 'utf8'), 'manual submission only\n');
});
