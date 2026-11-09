import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'native/posix/timestamps.c');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Explicit development build only. Never called by a runtime loader or launcher. */
export async function buildNativeTimestamps({ outputDirectory, headers, compiler = 'cc' }) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Native POSIX timestamp build requires macOS or Linux');
  if (!isAbsolute(outputDirectory)) throw new TypeError('An absolute, new output directory is required');
  const executable = await realpath(process.execPath);
  const include = headers ?? join(dirname(dirname(executable)), 'include/node');
  if (!isAbsolute(include)) throw new TypeError('Node headers must use an absolute path');
  const headerHashes = {};
  for (const name of ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h']) {
    const path = join(include, name);
    if (!(await lstat(path)).isFile()) throw new Error('Node-API development headers are unavailable');
    headerHashes[name] = hash(await readFile(path));
  }
  const sourceBytes = await readFile(source);
  // Fail on an existing directory; this build never overwrites a caller's artifact.
  await mkdir(outputDirectory, { mode: 0o700 });
  const artifact = join(outputDirectory, 'timestamps.node');
  try {
    const linkage = process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC'];
    const run = spawnSync(compiler, ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-DNAPI_VERSION=8',
      ...linkage, '-I', include, source, '-o', artifact], {
      cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    });
    if (run.error || run.status !== 0) throw new Error(`Native timestamp compilation failed: ${run.error?.message ?? run.stderr}`);
    if (!sourceBytes.equals(await readFile(source))) throw new Error('Native source changed during compilation');
    if (!(await lstat(artifact)).isFile()) throw new Error('Compiler did not emit a regular native addon');
    return { schemaVersion: 1, platform: process.platform, arch: process.arch,
      nodeVersion: process.versions.node, nodeApiVersion: 8, sourceSha256: hash(sourceBytes),
      headerHashes, artifactSha256: hash(await readFile(artifact)), artifact };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output' || !isAbsolute(args[1])) {
    process.stderr.write('Usage: node tools/build-native-timestamps.mjs --output /absolute/new/directory\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(JSON.stringify(await buildNativeTimestamps({ outputDirectory: args[1] })) + '\n'); }
    catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
  }
}
