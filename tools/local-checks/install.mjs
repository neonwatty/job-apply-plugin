import { spawnSync } from 'node:child_process';
import { access, chmod, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cleanEnvironment, git } from './git.mjs';

const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
const hooks = resolve(root, '.githooks');
function config(args, optional = false) {
  const result = spawnSync('git', ['config', ...args], { cwd: root,
    env: cleanEnvironment(), encoding: 'utf8', timeout: 3000 });
  if (result.error || (result.status !== 0 && !(optional && result.status === 1))) {
    throw new Error('Unable to configure worktree hooks.');
  }
  return result.stdout.trim();
}
try {
  if (process.argv.length !== 2) throw new Error('hooks:install takes no arguments.');
  const current = config(['--get', 'core.hooksPath'], true);
  if (current && resolve(root, current) !== hooks) {
    throw new Error('An existing hooksPath is configured; integrate these hooks without replacing it.');
  }
  if (!current) {
    const common = resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim());
    let entries = [];
    try { entries = await readdir(resolve(common, 'hooks')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (entries.some((name) => !name.endsWith('.sample'))) {
      throw new Error('Existing default Git hooks found; integrate without disabling them.');
    }
  }
  for (const name of ['pre-commit', 'pre-push']) {
    await access(resolve(hooks, name));
    await chmod(resolve(hooks, name), 0o755);
  }
  // Worktree-specific path avoids pointing sibling checkouts at this checkout.
  if (config(['--get', 'extensions.worktreeConfig'], true) !== 'true') {
    if (config(['--local', '--get', 'core.worktree'], true)
      || config(['--local', '--get', 'core.bare'], true) === 'true') {
      throw new Error('Custom worktree/bare configuration needs explicit hook installation.');
    }
    config(['--local', 'extensions.worktreeConfig', 'true']);
  }
  config(['--worktree', 'core.hooksPath', hooks]);
  console.log('Installed pre-commit/pre-push hooks for this worktree only.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
