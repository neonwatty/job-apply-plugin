import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execute } from '../preparation/support.mjs';

export async function repositoryIdentity(repository) {
  const head = await execute('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const status = await execute('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repository });
  if (head.code !== 0 || status.code !== 0 || head.failure || status.failure || status.stdout.trim()) throw Error('Model trials require a clean repository');
  return head.stdout.trim();
}
export async function packageFingerprint(repository, pluginRoot, revision) {
  const listing = await execute('git', ['ls-tree', '-r', '--name-only', revision, '--',
    'runtime', 'skills', 'apps/companion', '.codex-plugin', '.claude-plugin', 'native/packaged-lock'], { cwd: repository });
  if (listing.code !== 0 || listing.failure) throw Error('Cannot enumerate installed package');
  const digest = createHash('sha256');
  for (const path of listing.stdout.trim().split('\n').filter(Boolean).sort()) {
    digest.update(path).update('\0').update(createHash('sha256').update(await readFile(join(pluginRoot, path))).digest('hex')).update('\n');
  }
  return digest.digest('hex');
}
export async function captureHarness(repository, output) {
  const sources = {};
  const files = ['attempt/run.mjs', 'attempt/scenarios.mjs', 'attempt/fixture.mjs', 'attempt/broker.mjs', 'attempt/host.mjs',
    'attempt/baseline-broker.mjs', 'attempt/evidence.mjs', 'preparation/support.mjs',
    'preparation/fixture.mjs', 'preparation/continuation-fixture.mjs'];
  for (const name of files) {
    const bytes = await readFile(join(repository, 'evals', name)), path = join(output, 'executed-harness', name);
    sources[name] = createHash('sha256').update(bytes).digest('hex');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
  }
  return sources;
}
