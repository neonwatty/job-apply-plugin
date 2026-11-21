import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function windowsNodeCache() {
  const cache = process.env.npm_config_devdir ?? join(process.env.LOCALAPPDATA ?? '', 'node-gyp', 'Cache');
  return join(cache, process.versions.node);
}

/** Explicit development build only. Never called by a runtime loader or launcher. */
export async function buildNativeLock({ outputDirectory, headers, nodeLib, compiler }) {
  const windows = process.platform === 'win32';
  if (!['darwin', 'linux', 'win32'].includes(process.platform) || (windows && process.arch !== 'x64')) {
    throw new Error('Native lock build requires macOS, Linux, or Windows x64');
  }
  if (!isAbsolute(outputDirectory)) throw new TypeError('An absolute, new output directory is required');
  const source = join(root, 'native', windows ? 'windows' : 'posix', 'flock.c');
  const executable = await realpath(process.execPath);
  const cache = windows ? windowsNodeCache() : dirname(dirname(executable));
  const include = headers ?? join(cache, 'include', 'node');
  if (!isAbsolute(include)) throw new TypeError('Node headers must use an absolute path');
  const importLibrary = windows ? nodeLib ?? join(cache, 'x64', 'node.lib') : undefined;
  if (windows && (!isAbsolute(importLibrary) || !(await lstat(importLibrary).catch(() => null))?.isFile())) {
    throw new Error('Windows x64 node.lib is unavailable. Install Node development files with node-gyp install.');
  }
  const headerHashes = {};
  for (const name of ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h']) {
    const path = join(include, name);
    if (!(await lstat(path)).isFile()) throw new Error('Node-API development headers are unavailable');
    headerHashes[name] = hash(await readFile(path));
  }
  const inputs = windows ? [source, join(dirname(source), 'store-metadata.h')] : [source];
  const sourceBytes = await Promise.all(inputs.map(path => readFile(path)));
  // Fail on an existing directory; this build never overwrites a caller's artifact.
  await mkdir(outputDirectory, { mode: 0o700 });
  const artifact = join(outputDirectory, 'flock.node');
  let scratch;
  try {
    const linkage = process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC'];
    let args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-DNAPI_VERSION=8',
      ...linkage, '-I', include, source, '-o', artifact];
    if (windows) {
      scratch = await mkdtemp(join(tmpdir(), 'job-apply-native-lock-'));
      args = ['/nologo', '/LD', '/O2', '/W4', '/WX', '/I', include, source, `/Fo${join(scratch, 'flock.obj')}`,
        `/Fe${artifact}`, '/link', '/MACHINE:X64', `/IMPLIB:${join(scratch, 'flock.lib')}`, importLibrary, 'advapi32.lib', 'ntdll.lib'];
    }
    const run = spawnSync(compiler ?? (windows ? 'cl' : 'cc'), args, {
      cwd: scratch ?? root, encoding: 'utf8', timeout: windows ? 120000 : 30000, maxBuffer: 1024 * 1024,
    });
    if (run.error || run.status !== 0) {
      throw new Error(`Native lock compilation failed: ${run.error?.message ?? (windows ? run.stdout + run.stderr : run.stderr)}`);
    }
    const confirmed = await Promise.all(inputs.map(path => readFile(path)));
    if (sourceBytes.some((bytes, index) => !bytes.equals(confirmed[index]))) throw new Error('Native source changed during compilation');
    if (!(await lstat(artifact)).isFile()) throw new Error('Compiler did not emit a regular native addon');
    return { schemaVersion: 1, platform: process.platform, arch: process.arch,
      nodeVersion: process.versions.node, nodeApiVersion: 8, sourceSha256: hash(Buffer.concat(sourceBytes)),
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
