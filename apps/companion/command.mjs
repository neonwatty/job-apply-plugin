#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activateStoreForCli, validateSupervisorRoot } from './supervise.mjs';
import { storeWriterOwnership } from './writer-route.mjs';

const app = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(app, '../..');
const targets = {
  store: 'native-jobs.js', task: 'native-task.js', attempt: 'native-attempt.js', policy: 'native-final-action-policy.js',
};
function selectedRoot(args) {
  const positions = args.flatMap((value, index) => value === '--root' ? [index] : []);
  if (positions.length) {
    const value = args[positions.at(-1) + 1];
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
    if (args[index] === '--root') { index += 1; continue; }
    if (!args[index].startsWith('--')) { command = args[index]; break; }
  }
  const readOnlyAbsent = (surface === 'store' && command === 'paths') || (surface === 'policy' && command === 'status');
  const help = args.includes('--help') || args.includes('-h');
  const root = selectedRoot(args);
  if (!help && !(readOnlyAbsent && !existsSync(root))) {
    const ownership = await storeWriterOwnership(root);
    if (ownership === 'fixture') await validateSupervisorRoot(root);
    else await activateStoreForCli({ root, pluginRoot, nativeLock: undefined });
  }
  const child = spawn(process.execPath, [join(pluginRoot, 'runtime/cli', target), ...args], { stdio: 'inherit', env: process.env });
  const result = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); });
  if (result.signal) process.kill(process.pid, result.signal);
  process.exitCode = result.code ?? 1;
}
try { await run(); }
catch {
  process.stderr.write('Job Apply native Store activation failed\n'); process.exitCode = 2;
}
