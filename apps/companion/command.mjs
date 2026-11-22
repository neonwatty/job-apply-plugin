#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activateStoreForCli, validateSupervisorRoot } from './supervise.mjs';
import { storeWriterOwnership } from './writer-route.mjs';
import { parseAttemptArgs } from '../../runtime/cli/attempt-protocol.js';
import { parseInstalledTaskArgs } from '../../runtime/cli/task-runner.js';
import { resolvePackagedNativeLock } from '../../runtime/package/native-lock-artifact.js';
import { activateWindowsStore, canonicalWindowsRoot, UnrecognizedStoreError } from '../../runtime/store/windows-activation.js';

const app = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(app, '../..');
const targets = {
  store: 'native-jobs.js', task: 'native-task.js', attempt: 'native-attempt.js', policy: 'native-final-action-policy.js',
};
function selectedRoot(args) {
  const positions = args.flatMap((value, index) => value === '--root' || value.startsWith('--root=') ? [index] : []);
  if (positions.length) {
    const position = positions.at(-1);
    const value = args[position].startsWith('--root=') ? args[position].slice(7) : args[position + 1];
    if (!value || value.startsWith('--')) throw new Error('missing Store root');
    return resolve(value === '~' || value.startsWith('~/') ? homedir() + value.slice(1) : value);
  }
  const configured = process.env.JOB_APPLY_STORE_DIR;
  return resolve(configured ? configured === '~' || configured.startsWith('~/') ? homedir() + configured.slice(1) : configured
    : join(homedir(), '.job-apply'));
}
async function run() {
  const [surface, ...args] = process.argv.slice(2), target = targets[surface];
  if (!target) throw new Error('unknown Job Apply command surface');
  let command;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root' || args[index] === '--legacy-profile') { index += 1; continue; }
    if (!args[index].startsWith('--')) { command = args[index]; break; }
  }
  const readOnlyAbsent = (surface === 'store' && command === 'paths') || (surface === 'policy' && command === 'status');
  const help = args.includes('--help') || args.includes('-h');
  const windows = process.platform === 'win32';
  if (windows && !help && surface === 'store' && ['legacy-jobs-preview', 'legacy-jobs-commit'].includes(command)) {
    process.stderr.write('Legacy search report import is available on macOS and Linux.\n');
    process.exitCode = 2;
    return;
  }
  let root, invalidRequest = false;
  if (!help && (surface === 'attempt' || (windows && surface === 'task'))) {
    try {
      root = surface === 'attempt' ? parseAttemptArgs(args, process.env, homedir()).root
        : parseInstalledTaskArgs(args).options.get('--root');
    } catch { invalidRequest = true; } // The child preserves its public JSON error envelope.
  } else root = selectedRoot(args);
  const legacyIndex = surface === 'store' ? args.lastIndexOf('--legacy-profile') : -1;
  const legacyProfile = legacyIndex < 0 ? undefined : args[legacyIndex + 1];
  if (legacyIndex >= 0 && (!legacyProfile || legacyProfile.startsWith('--'))) throw new Error('missing legacy profile');
  const windowsInit = windows && surface === 'store' && command === 'init';
  if (!help && !invalidRequest && !windowsInit && !(readOnlyAbsent && !existsSync(root))) {
    if (windows) {
      await activateWindowsStore(await canonicalWindowsRoot(root),
        await resolvePackagedNativeLock(await realpath(pluginRoot)), { legacyProfile });
    } else {
      const ownership = await storeWriterOwnership(root);
      if (ownership === 'fixture') await validateSupervisorRoot(root);
      else await activateStoreForCli({ root, pluginRoot, nativeLock: undefined, legacyProfile });
    }
  }
  const child = spawn(process.execPath, [join(pluginRoot, 'runtime/cli', target), ...args], { stdio: 'inherit', env: process.env });
  const result = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); });
  if (result.signal) process.kill(process.pid, result.signal);
  process.exitCode = result.code ?? 1;
}
try { await run(); }
catch (error) {
  process.stderr.write(error instanceof UnrecognizedStoreError ? `${error.message}\n` : 'Job Apply native Store activation failed\n');
  process.exitCode = 2;
}
