import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changedPaths, git, indexSnapshot, indexTree, pushTargets, resolveCommit } from './git.mjs';
import { runTarget } from './run.mjs';
import { interruptLocalChecks } from './process.mjs';

export async function main(args = process.argv.slice(2)) {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const [mode, ...rest] = args;
  if (mode === 'pre-commit' || mode === 'commit') {
    if (rest.length) throw new Error('Commit checks take no arguments.');
    const target = indexSnapshot(root);
    git(root, ['diff', '--cached', '--check'], { hookIndex: true });
    await runTarget(root, target, { mode: 'commit', paths: [] });
    if (indexTree(root) !== target.tree) {
      throw new Error('Index changed during validation; rerun commit checks.');
    }
    return;
  }
  let targets;
  const baseRef = git(root, ['config', '--get', 'localChecks.baseRef'], { allowFailure: true }).trim() || 'origin/staging';
  if (mode === 'pre-push') {
    if (rest.length !== 2) throw new Error('Expected Git pre-push remote arguments.');
    targets = pushTargets(root, readFileSync(0, 'utf8'), baseRef);
  } else if (mode === 'push' || mode === 'deep') {
    let head = 'HEAD';
    let base;
    let tag = false;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--release') tag = true;
      else if (rest[index] === '--head' && rest[index + 1]) head = rest[++index];
      else if (rest[index] === '--base' && rest[index + 1]) base = rest[++index];
      else throw new Error('Usage: verify:push|verify:deep [--head ref] [--base ref] [--release]');
    }
    const commit = resolveCommit(root, head);
    targets = [{ commit, base: base ? resolveCommit(root, base)
      : git(root, ['merge-base', resolveCommit(root, baseRef), commit]).trim(), tag }];
  } else throw new Error('Unknown local validation tier.');
  for (const target of targets) {
    await runTarget(root, target, { mode: mode === 'deep' ? 'deep' : 'push',
      paths: changedPaths(root, target.base, target.commit) });
  }
  if (!targets.length) console.log('No nondeleted ref updates to validate.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.on('SIGINT', interruptLocalChecks);
  process.on('SIGTERM', interruptLocalChecks);
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
