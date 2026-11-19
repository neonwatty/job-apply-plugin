import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, process.platform === 'win32' ? 'native/windows/flock.c' : 'native/posix/flock.c');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** node-gyp's header cache; Windows Node installs ship neither headers nor node.lib. */
function nodeGypCache() {
  const base = process.env.npm_config_devdir ?? join(process.env.LOCALAPPDATA ?? '', 'node-gyp/Cache');
  return join(base, process.versions.node);
}

/** Explicit development build only. Never called by a runtime loader or launcher. */
export async function buildNativeLock({ outputDirectory, headers, nodeLib, compiler }) {
  const windows = process.platform === 'win32';
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new Error('Native lock build requires macOS, Linux, or Windows');
  if (!isAbsolute(outputDirectory)) throw new TypeError('An absolute, new output directory is required');
  compiler ??= windows ? 'cl' : 'cc';
  const executable = await realpath(process.execPath);
  const include = headers ?? (windows ? join(nodeGypCache(), 'include/node') : join(dirname(dirname(executable)), 'include/node'));
  const importLibrary = windows ? nodeLib ?? join(nodeGypCache(), process.arch, 'node.lib') : undefined;
  if (windows && !(await lstat(importLibrary).catch(() => null))?.isFile()) {
    throw new Error('node.lib is unavailable; run "npx node-gyp install" from a Visual Studio x64 developer prompt');
  }
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
  const artifact = join(outputDirectory, 'flock.node');
  // MSVC writes object, import-library, and export files; keep them out of the artifact directory.
  const scratch = windows ? await mkdtemp(join(tmpdir(), 'job-apply-native-lock-')) : undefined;
  try {
    const linkage = process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC'];
    const argv = windows
      ? ['/nologo', '/LD', '/O2', '/W4', '/WX', '/DNAPI_VERSION=8', '/I', include, source, `/Fo${join(scratch, 'flock.obj')}`,
        `/Fe${artifact}`, '/link', `/IMPLIB:${join(scratch, 'flock.lib')}`, importLibrary, 'advapi32.lib']
      : ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-DNAPI_VERSION=8', ...linkage, '-I', include, source, '-o', artifact];
    const run = spawnSync(compiler, argv, {
      cwd: scratch ?? root, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
    });
    if (run.error || run.status !== 0) throw new Error(`Native lock compilation failed: ${run.error?.message ?? run.stderr}`);
    if (!sourceBytes.equals(await readFile(source))) throw new Error('Native source changed during compilation');
    if (!(await lstat(artifact)).isFile()) throw new Error('Compiler did not emit a regular native addon');
    return { schemaVersion: 1, platform: process.platform, arch: process.arch,
      nodeVersion: process.versions.node, nodeApiVersion: 8, sourceSha256: hash(sourceBytes),
      headerHashes, artifactSha256: hash(await readFile(artifact)), artifact };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output' || !isAbsolute(args[1])) {
    process.stderr.write('Usage: node tools/build-native-lock.mjs --output /absolute/new/directory\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(JSON.stringify(await buildNativeLock({ outputDirectory: args[1] })) + '\n'); }
    catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
  }
}
