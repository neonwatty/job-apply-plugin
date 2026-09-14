import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobsError } from '../../contracts/workspace/values.js';
import { ReviewedMacOSHelperIdentity } from './identity.js';

export const reviewedOracleSources = [
  'job_apply_credential_helper.swift', 'job_apply_browser_bridge.swift',
  'OracleExecutableIdentity.swift', 'NativeEmailOnlyBinding.swift', 'AccessibilityTree.swift',
  'ReviewedAccountForm.swift', 'OracleBrowserIdentity.swift', 'MacOSAccessibilityAccountFlowHelper.swift',
  'OracleAccountFlowFixtures.swift', 'job_apply_credential_helper_tests.swift',
  'job_apply_credential_helper_main.swift',
] as const;

async function compile(output: string, sources: string[]): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn('/usr/bin/xcrun', ['swiftc', '-O', '-o', output, ...sources], {
      stdio: ['ignore', 'ignore', 'ignore'], env: {},
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : accept();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new JobsError('reviewed native helper build timed out'));
    }, 60000);
    child.on('error', () => finish(new JobsError('reviewed native helper build failed closed')));
    child.on('exit', code => finish(code === 0
      ? undefined : new JobsError('reviewed native helper build failed closed')));
  });
}

export async function buildReviewedOracleHelper(buildDirectory?: string): Promise<ReviewedMacOSHelperIdentity> {
  if (process.platform !== 'darwin') throw new JobsError('native macOS helper is unavailable on this platform');
  const sourceRoot = fileURLToPath(new URL('../../../native/macos/', import.meta.url));
  const sources = reviewedOracleSources.map(name => join(sourceRoot, name));
  for (const source of sources) {
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new JobsError('reviewed native helper sources are unavailable');
  }
  const root = buildDirectory ? resolve(buildDirectory) : await mkdtemp(join(tmpdir(), 'job-apply-reviewed-oracle-'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const output = join(root, 'job-apply-reviewed-oracle-helper');
  if (dirname(output) !== root) throw new JobsError('reviewed native helper build path is invalid');
  await compile(output, sources);
  return ReviewedMacOSHelperIdentity.pin(output);
}
