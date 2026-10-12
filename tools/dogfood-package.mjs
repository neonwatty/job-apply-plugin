#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { criticalPaths } from '../runtime/package/installed-artifacts.js';
import { packageNativeLock } from '../scripts/smoke/package_native_lock.mjs';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

async function inventory(root, relative = '') {
  const result = {};
  const metadata = await lstat(join(root, relative));
  if (metadata.isSymbolicLink()) throw Error('Package contains a symlink');
  if (!metadata.isDirectory()) throw Error('Package root must be a directory');
  for (const name of (await readdir(join(root, relative))).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    const item = await lstat(join(root, path));
    if (item.isSymbolicLink()) throw Error(`Package contains a symlink: ${path}`);
    if (item.isDirectory()) Object.assign(result, await inventory(root, path));
    else if (item.isFile()) result[path] = hash(await readFile(join(root, path)));
    else throw Error(`Package contains a non-regular file: ${path}`);
  }
  return result;
}

/** Export only committed install artifacts. Never install, launch, or open a Store. */
export async function buildDogfoodPackage({ repository = repositoryRoot, ref, output, nativePackager = packageNativeLock }) {
  if (!ref || !output || !isAbsolute(output)) throw Error('An explicit ref and absolute new output directory are required');
  if (await lstat(output).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))) throw Error('Output already exists');
  const source = await realpath(repository);
  const commit = (await execute('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { cwd: source })).stdout.trim();
  const temporary = await mkdtemp(join(tmpdir(), 'job-apply-dogfood-'));
  let createdOutput = false;
  try {
    const snapshot = join(temporary, 'snapshot');
    await mkdir(snapshot);
    const archive = join(temporary, 'source.tar');
    await execute('git', ['archive', '--format=tar', `--output=${archive}`, commit], { cwd: source });
    await execute('tar', ['-xf', archive, '-C', snapshot]);
    const nativeLock = await nativePackager(snapshot);
    // Fresh marketplace installs bootstrap Companion from committed source.
    const bootstrapSources = Object.keys(await inventory(join(snapshot, 'src'))).map(path => `src/${path}`);
    const paths = [...await criticalPaths(snapshot, '3.14'), 'package-lock.json', 'tsconfig.json', ...bootstrapSources];
    if (paths.some(path => /\.(py|pyc|pyo)$/.test(path))) throw Error('Installed package must be Python-free');
    await mkdir(output, { mode: 0o700 });
    createdOutput = true;
    const plugin = join(output, 'plugin');
    for (const relative of paths) {
      await mkdir(dirname(join(plugin, relative)), { recursive: true });
      await copyFile(join(snapshot, relative), join(plugin, relative));
    }
    const marketplace = join(plugin, '.claude-plugin/marketplace.json');
    const data = JSON.parse(await readFile(marketplace, 'utf8'));
    data.plugins[0].source = './';
    await writeFile(marketplace, json(data));
    const manifest = JSON.parse(await readFile(join(plugin, '.codex-plugin/plugin.json'), 'utf8'));
    const files = await inventory(plugin);
    const receipt = {
      schemaVersion: 1, sourceCommit: commit, pluginVersion: manifest.version,
      platform: process.platform, arch: process.arch,
      nativeLock: { sourceSha256: nativeLock.sourceSha256, artifactSha256: nativeLock.artifactSha256 },
      transformation: 'Claude marketplace source points to local package',
      files, packageSha256: hash(json(files)),
      validation: { installedHost: 'unrun', hostAppDiscovery: 'unrun', liveApplication: 'unrun' },
    };
    await writeFile(join(output, 'receipt.json'), json(receipt), { flag: 'wx' });
    return receipt;
  } catch (error) {
    if (createdOutput) await rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Detect mutation against the retained receipt; this is integrity, not a signature. */
export async function verifyDogfoodPackage(output) {
  const receipt = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8'));
  if (receipt.schemaVersion !== 1 || !/^[a-f0-9]{40,64}$/.test(receipt.sourceCommit)) throw Error('Invalid package receipt');
  const files = await inventory(join(output, 'plugin'));
  if (JSON.stringify(Object.keys(files)) !== JSON.stringify(Object.keys(receipt.files))) throw Error('Package inventory mismatch');
  if (hash(json(files)) !== receipt.packageSha256 || json(files) !== json(receipt.files)) throw Error('Package content mismatch');
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    let receipt;
    if (action === 'build' && args.length === 4 && args[0] === '--ref' && args[2] === '--output') {
      receipt = await buildDogfoodPackage({ ref: args[1], output: args[3] });
    } else if (action === 'verify' && args.length === 1 && isAbsolute(args[0])) {
      receipt = await verifyDogfoodPackage(args[0]);
    } else throw Error('Usage: node tools/dogfood-package.mjs build --ref COMMIT --output /new/directory | verify /package/directory');
    process.stdout.write(json(receipt));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
