import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const source = fileURLToPath(new URL('./broker-directory.c', import.meta.url));

export async function buildBrokerDirectory() {
  if (!['darwin', 'linux'].includes(process.platform)) throw Error('Recorder requires macOS or Linux');
  const executable = await realpath(process.execPath);
  const headers = join(dirname(dirname(executable)), 'include/node');
  const workspace = await mkdtemp(join(tmpdir(), 'job-apply-recorder-native-'));
  const artifact = join(workspace, 'recorder-directory.node');
  const cleanup = () => rm(workspace, { recursive: true, force: true });
  try {
    const linkage = process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC'];
    await execute('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-DNAPI_VERSION=8',
      ...linkage, '-I', headers, source, '-o', artifact], { timeout: 8000, maxBuffer: 64 * 1024 });
    return { artifact, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function loadBrokerDirectory(artifact) {
  return require(artifact);
}
