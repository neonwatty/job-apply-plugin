import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyCritical } from './artifacts.mjs';
import { installSourceCheckouts } from './source_marketplaces.mjs';

export async function smokeGitMarketplaces(source, temporary, run) {
  const repository = join(temporary, 'git-release-source');
  const stable = join(temporary, 'git-stable-source');
  const url = 'https://github.com/example/job-apply-release-fixture.git';
  const git = (args) => run('git', [
    '-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Release Smoke',
    '-c', 'user.email=release@example.test', '-c', 'commit.gpgsign=false', ...args,
  ], {}, true);

  await copyCritical(source, repository);
  await git(['init', '-b', 'main']);
  await git(['add', '--', '.']);
  await git(['commit', '-m', 'Stable fixture']);
  await git(['branch', 'stable']);
  await git(['worktree', 'add', '--detach', stable, 'stable']);

  for (const path of ['runtime/cli/native-jobs.js', 'apps/companion/launch.mjs']) {
    await appendFile(join(repository, path), '\n// Preview Git source fixture\n');
    await git(['add', '--', path]);
  }
  await git(['commit', '-m', 'Preview fixture']);

  // Hosts use Git normally. This rewrite confines their remote fetch to the fixture.
  const transport = {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(repository)}.insteadOf`,
    GIT_CONFIG_VALUE_0: url,
    GIT_CONFIG_KEY_1: 'protocol.file.allow',
    GIT_CONFIG_VALUE_1: 'always',
  };
  const runAgainstFixture = (command, args, environment, quiet) =>
    run(command, args, { ...transport, ...environment }, quiet);

  for (const [ref, expected] of [['stable', stable], ['main', repository]]) {
    const state = join(temporary, `git-channel-${ref}`);
    const catalog = join(state, 'catalog');
    for (const path of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
      const target = join(catalog, path);
      const manifest = JSON.parse(await readFile(join(source, path), 'utf8'));
      manifest.plugins.find(plugin => plugin.name === 'job-apply').source = { source: 'url', url, ref };
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(manifest));
    }
    await installSourceCheckouts(expected, state, runAgainstFixture, catalog);
  }
  console.log('Git-backed marketplace installs matched their stable and preview refs in both hosts');
}
