import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const maximum = 500, baselinePath = '.source-size-baseline.json';
const extensions = new Set(['.py', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.swift', '.sh', '.c', '.h']);
const excluded = new Set(['.git', '.next', '.worktrees', 'build', 'coverage', 'dist', 'node_modules', 'vendor']);
const source = path => extensions.has(extname(path)) && !path.split('/').some(part => excluded.has(part));
function git(root, args, optional = false) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (optional) return null; throw error; }
}
export function physicalLines(bytes) {
  return bytes.length ? [...bytes].filter(byte => byte === 10).length + Number(bytes.at(-1) !== 10) : 0;
}
export function loadBaseline(text) {
  if (text === null) return { files: {} };
  const value = JSON.parse(text);
  if (!value || value.version !== 1 || value.maximumLines !== maximum || !value.files || Array.isArray(value.files)
    || typeof value.files !== 'object') throw Error('invalid source-size baseline');
  for (const [path, entry] of Object.entries(value.files)) {
    if (posix.isAbsolute(path) || path.split('/').includes('..') || posix.normalize(path) !== path || !source(path)
      || !entry || Object.keys(entry).sort().join(',') !== 'ceiling,owner,reason,removalPhase'
      || !Number.isInteger(entry.ceiling) || entry.ceiling <= maximum
      || ['owner', 'reason', 'removalPhase'].some(key => typeof entry[key] !== 'string' || !entry[key].trim())) {
      throw Error(`invalid source-size baseline entry: ${path}`);
    }
  }
  return value;
}
export function checkSize(root, baseRef = 'origin/staging') {
  const base = git(root, ['merge-base', baseRef, 'HEAD']).trim();
  const read = path => { try { return readFileSync(resolve(root, path), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const current = loadBaseline(read(baselinePath)).files;
  const oldText = git(root, ['show', `${base}:${baselinePath}`], true), old = loadBaseline(oldText).files;
  const paths = new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean));
  const counts = new Map();
  for (const path of paths) {
    if (!source(path)) continue;
    try { if (statSync(resolve(root, path)).isFile()) counts.set(path, physicalLines(readFileSync(resolve(root, path)))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const errors = [];
  for (const [path, entry] of Object.entries(current)) {
    if (!Object.hasOwn(old, path) && (oldText !== null || git(root, ['show', `${base}:${path}`], true) === null)) errors.push(`${path}: new baseline entry`);
    if (old[path] && entry.ceiling > old[path].ceiling) errors.push(`${path}: ceiling increased`);
    if (!counts.has(path)) errors.push(`${path}: obsolete baseline entry`);
  }
  for (const path of Object.keys(old)) if (!Object.hasOwn(current, path) && counts.get(path) > maximum) errors.push(`${path}: oversized baseline entry removed`);
  for (const [path, count] of counts) {
    const entry = current[path];
    if (!entry && count > maximum) errors.push(`${path}: ${count} > ${maximum}`);
    if (entry && (count <= maximum || count !== entry.ceiling)) errors.push(`${path}: update baseline ceiling ${entry.ceiling} to ${count}`);
  }
  return errors.sort();
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--base')) throw Error('usage: check-source-size.mjs [--base ref]');
  const errors = checkSize(process.cwd(), args[1]);
  for (const error of errors) console.error(`source-size: ${error}`);
  process.exitCode = errors.length ? 1 : 0;
}
