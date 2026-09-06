import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

export function git(root, args, { input, allowFailure = false, hookIndex = false, indexFile } = {}) {
  const env = cleanEnvironment();
  if (hookIndex && process.env.GIT_INDEX_FILE) env.GIT_INDEX_FILE = process.env.GIT_INDEX_FILE;
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && !allowFailure)) {
    throw new Error(`Local checks: git ${args[0]} failed. ${result.stderr?.trim() ?? ''}`);
  }
  return result.status === 0 ? result.stdout : '';
}

export function resolveCommit(root, ref) {
  return git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

export function indexTree(root) {
  const original = resolve(root, process.env.GIT_INDEX_FILE
    || git(root, ['rev-parse', '--git-path', 'index']).trim());
  const temporary = mkdtempSync(join(tmpdir(), 'job-apply-index-'));
  const indexFile = join(temporary, 'index');
  try {
    if (existsSync(original)) copyFileSync(original, indexFile);
    return git(root, ['write-tree'], { indexFile }).trim();
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function indexSnapshot(root) {
  const tree = indexTree(root);
  const parent = git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }).trim();
  // An unreferenced object represents the index; no user branch or index changes.
  const commit = git(root, ['-c', 'user.name=Local checks', '-c', 'user.email=local-checks@invalid',
    '-c', 'commit.gpgsign=false', 'commit-tree', tree, ...(parent ? ['-p', parent] : []),
    '-m', 'Disposable staged verification snapshot']).trim();
  return { tree, commit, base: parent || commit };
}

export async function withSnapshot(root, commit, callback, { dependencies = false } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'job-apply-local-checks-'));
  const snapshot = join(temporary, 'checkout');
  let created = false;
  try {
    git(root, ['worktree', 'add', '--detach', snapshot, commit]);
    created = true;
    if (dependencies) {
      const sourceLock = await readFile(join(root, 'package-lock.json'));
      if (!sourceLock.equals(await readFile(join(snapshot, 'package-lock.json')))) {
        throw new Error('Target dependency lock differs from this checkout; verify from its matching checkout.');
      }
      const modules = await realpath(join(root, 'node_modules'));
      await symlink(modules, join(snapshot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    return await callback(snapshot);
  } finally {
    if (created) git(root, ['worktree', 'remove', '--force', snapshot]);
    await rm(temporary, { recursive: true, force: true });
  }
}

export function changedPaths(root, base, commit) {
  // --no-renames includes both old/new paths; NUL delimiters preserve unusual names.
  return git(root, ['diff', '--name-only', '--no-renames', '-z', base, commit])
    .split('\0').filter(Boolean);
}

export function pushTargets(root, input, baseRef = 'origin/staging') {
  const targets = [];
  for (const line of input.split('\n').filter(Boolean)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) throw new Error('Malformed pre-push ref update.');
    const [localRef, localOid, remoteRef, remoteOid] = parts;
    if (![localOid, remoteOid].every((oid) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
      || !remoteRef.startsWith('refs/')) throw new Error('Malformed pre-push ref update.');
    if (/^0+$/.test(localOid)) continue;
    const commit = resolveCommit(root, localOid);
    const base = /^0+$/.test(remoteOid)
      ? git(root, ['merge-base', resolveCommit(root, baseRef), commit]).trim()
      : resolveCommit(root, remoteOid);
    targets.push({ commit, base, tag: localRef.startsWith('refs/tags/') || remoteRef.startsWith('refs/tags/') });
  }
  return targets;
}
