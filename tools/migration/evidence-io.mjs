import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const text = value => typeof value === 'string' && value.trim().length > 0;
export const safePath = value => text(value) && !value.startsWith('/') && !/[\\:\x00-\x1f\x7f*?\[\]{}]/.test(value)
  && !value.split('/').some(part => ['', '.', '..', '.git'].includes(part));
export const closed = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
export const strings = (value, empty = false) => Array.isArray(value) && (empty || value.length > 0)
  && value.every(text) && new Set(value).size === value.length;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const equal = (a, b) => canonical(a) === canonical(b);
export const physicalLines = bytes => bytes.length ? bytes.toString('utf8').split('\n').length - (bytes[bytes.length - 1] === 10 ? 1 : 0) : 0;

// Fixed read-only operations. No argv, executable or shell text comes from receipts.
export async function createEvidenceIO(root) {
  const canonicalRoot = await realpath(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = args => execFileSync('git', ['--no-pager', '--no-replace-objects', ...args], { cwd: canonicalRoot, env, timeout: 5000,
    maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  // Cache only successful reads addressed by immutable object IDs. Copy buffers on
  // return so callers cannot poison later observations. Bound retained cache bytes.
  const immutableCache = new Map(), negativeAncestry = new Set();
  let cachedBytes = 0;
  const immutableGit = args => {
    const key = JSON.stringify(args);
    if (immutableCache.has(key)) return Buffer.from(immutableCache.get(key));
    const value = git(args);
    if (immutableCache.size >= 4096 || cachedBytes + value.length > 8 * 1024 * 1024) { immutableCache.clear(); cachedBytes = 0; }
    immutableCache.set(key, Buffer.from(value)); cachedBytes += value.length;
    return value;
  };
  async function readRepositoryFile(path) {
    if (!safePath(path)) throw new Error('Unsafe prerequisite file path');
    let current = canonicalRoot;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      current = resolve(current, parts[index]);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || (index < parts.length - 1 ? !metadata.isDirectory() : !metadata.isFile())) {
        throw new Error('Prerequisite evidence must use real repository files');
      }
      if (index === parts.length - 1 && metadata.size > 8 * 1024 * 1024) throw new Error('Evidence exceeds reader budget');
    }
    return readFile(current);
  }
  function revision(value) {
    if (!sha(value)) return false;
    try { return immutableGit(['rev-parse', '--verify', `${value}^{commit}`]).toString().trim() === value; }
    catch { return false; }
  }
  function fileAt(commit, path) {
    if (!sha(commit) || !safePath(path)) throw new Error('Unsafe immutable evidence binding');
    const entries = immutableGit(['ls-tree', '-r', '-t', '-z', commit]).toString().split('\0')
      .filter(entry => entry.slice(entry.indexOf('\t') + 1) === path);
    if (!entries.length) return null;
    const entry = entries[0];
    if (entries.length !== 1 || !/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry)
      || entry.slice(entry.indexOf('\t') + 1) !== path) throw new Error('Immutable evidence must be a regular tracked file');
    return immutableGit(['cat-file', 'blob', entry.slice(12, 52)]);
  }
  return { root: canonicalRoot, readRepositoryFile, revision, fileAt,
    changes: path => { if (!safePath(path)) throw new Error('Unsafe history path'); return git(['log', '--full-history', '--reverse', '--topo-order', '--format=%H', 'HEAD', '--', path]).toString().trim().split('\n').filter(Boolean); },
    pathsAt: commit => { if (!sha(commit)) throw new Error('Invalid tree revision'); return immutableGit(['ls-tree', '-r', '--name-only', '-z', commit]).toString().split('\0').filter(Boolean); },
    head: () => git(['rev-parse', '--verify', 'HEAD']).toString().trim(),
    tree: commit => { if (!sha(commit)) throw new Error('Invalid subject revision'); return immutableGit(['rev-parse', `${commit}^{tree}`]).toString().trim(); },
    clean: () => git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).length === 0,
    ancestor: (base, head) => {
      if (!sha(base) || !sha(head)) return false;
      const key = `${base}:${head}`;
      if (negativeAncestry.has(key)) return false;
      try { immutableGit(['merge-base', '--is-ancestor', base, head]); return true; }
      catch (error) {
        if (error.status === 1 && revision(base) && revision(head)) {
          if (negativeAncestry.size >= 4096) negativeAncestry.clear();
          negativeAncestry.add(key);
        }
        return false;
      }
    },
    diff: (base, subject) => {
      if (!sha(base) || !sha(subject)) throw new Error('Invalid diff revisions');
      const tokens = immutableGit(['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', base, subject, '--']).toString().split('\0');
      const result = [];
      while (tokens[0]) {
        const status = tokens.shift();
        if (/^R\d+$/.test(status)) result.push({ status: 'R', oldPath: tokens.shift(), path: tokens.shift() });
        else result.push({ status, oldPath: null, path: tokens.shift() });
      }
      return result;
    },
  };
}
