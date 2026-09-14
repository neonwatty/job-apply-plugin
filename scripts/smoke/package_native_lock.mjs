import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNativeLock } from '../../tools/build-native-lock.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Add one verified host artifact to a new package copy, never to the repository. */
export async function packageNativeLock(packageRoot) {
  if (!isAbsolute(packageRoot)) throw new TypeError('Package root must be absolute');
  const root = await realpath(packageRoot);
  if (root === await realpath(repository)) throw new Error('Native lock packaging requires a disposable package copy');
  const sourcePath = join(root, 'native/posix/flock.c');
  const sourceMetadata = await lstat(sourcePath).catch(() => null);
  if (!sourceMetadata?.isFile() || sourceMetadata.isSymbolicLink() || await realpath(sourcePath).catch(() => null) !== sourcePath) {
    throw new Error('Package native lock source is unavailable');
  }
  const source = await readFile(sourcePath);
  const parent = join(root, 'native/packaged-lock');
  await mkdir(parent, { recursive: true });
  if (await realpath(parent) !== parent) throw new Error('Package native lock destination is invalid');
  const outputDirectory = join(parent, `${process.platform}-${process.arch}-napi8`);
  if (await lstat(outputDirectory).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
    throw new Error('Package already contains a native lock artifact for this host');
  }
  try {
    const built = await buildNativeLock({ outputDirectory });
    if (built.sourceSha256 !== digest(source)) throw new Error('Package native lock source differs from the reviewed build input');
    const receipt = { schemaVersion: 1, platform: built.platform, arch: built.arch,
      nodeApiVersion: built.nodeApiVersion, sourceSha256: built.sourceSha256,
      artifactSha256: built.artifactSha256 };
    await writeFile(join(outputDirectory, 'receipt.json'), JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o644 });
    return { ...receipt, directory: outputDirectory };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--package-root' || !isAbsolute(args[1])) {
    process.stderr.write('Usage: node tools/package-native-lock.mjs --package-root /absolute/package/copy\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(JSON.stringify(await packageNativeLock(args[1])) + '\n'); }
    catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
  }
}
