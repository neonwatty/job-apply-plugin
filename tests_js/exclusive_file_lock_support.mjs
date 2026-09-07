import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildNativeLock } from '../tools/build-native-lock.mjs';

export async function nativeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ts-native-lock-'));
  try {
    const receipt = await buildNativeLock({ outputDirectory: join(root, 'addon') });
    return { root, receipt, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export const providerModule = pathToFileURL(fileURLToPath(new URL('../runtime/store/posix-flock.js', import.meta.url))).href;
export const lockModule = pathToFileURL(fileURLToPath(new URL('../runtime/store/exclusive-file-lock.js', import.meta.url))).href;

export function child(script, args = []) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '' },
  });
  let output = '';
  let errors = '';
  const pending = new Set();
  const lines = [];
  process.stderr.on('data', bytes => { errors += bytes; });
  process.stdout.on('data', bytes => {
    output += bytes;
    let index;
    while ((index = output.indexOf('\n')) !== -1) {
      const line = output.slice(0, index); output = output.slice(index + 1);
      lines.push(line);
      for (const waiter of [...pending]) waiter();
    }
  });
  const exited = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code, signal) => {
      for (const waiter of [...pending]) waiter(new Error(`Child exited ${code}/${signal}: ${errors}`));
      resolve({ code, signal });
    });
  });
  return {
    process, exited, lines,
    line(expected, milliseconds = 8000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(check); reject(new Error(`Missing child message ${expected}: ${errors}`)); }, milliseconds);
        function check(error) {
          if (lines.includes(expected)) { clearTimeout(timer); pending.delete(check); resolve(); }
          else if (error) { clearTimeout(timer); pending.delete(check); reject(error); }
        }
        pending.add(check); check();
      });
    },
    async success() { const result = await exited; assert.equal(result.code, 0, errors); },
    async stop() { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); await exited; },
  };
}
