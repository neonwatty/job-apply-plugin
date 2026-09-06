import { spawn } from 'node:child_process';
import { cleanEnvironment } from './git.mjs';

const active = new Set();
let interrupted = false;

export function interruptLocalChecks() {
  interrupted = true;
  for (const stop of active) stop('interrupted');
}

export function runLocalCommand(executable, args, options) {
  if (interrupted) return Promise.resolve({ status: 'failed', exitCode: 130, signal: 'interrupted', durationMs: 0 });
  const started = Date.now();
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries({ ...cleanEnvironment(), ...options.env })
      .filter(([key]) => !key.startsWith('GIT_')));
    const child = spawn(executable, args, { cwd: options.cwd, env,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let reason;
    let finished = false;
    let force;
    let deadline;
    const counts = { stdout: 0, stderr: 0 };
    const finish = (code, signal = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(force);
      active.delete(stop);
      resolve({ status: code === 0 && !reason ? 'passed' : 'failed', exitCode: code,
        signal: reason || signal, durationMs: Date.now() - started });
    };
    function kill(signal) {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', () => {});
      } else {
        try { process.kill(-child.pid, signal); } catch { /* Already exited. */ }
      }
    }
    function stop(cause) {
      if (reason || finished) return;
      reason = cause;
      options.stderr(`[${options.label}] ${cause}; terminating owned process group\n`);
      kill('SIGTERM');
      force = setTimeout(() => {
        kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        finish(cause === 'timeout' ? 124 : 130);
      }, 1000);
    }
    active.add(stop);
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => {
        const cap = options.maxOutputBytes ?? 2 * 1024 * 1024;
        if (counts[stream] + chunk.length > cap) { stop('output-limit'); return; }
        counts[stream] += chunk.length;
        options[stream](`[${options.label}] ${chunk.toString('utf8')}`);
      });
    }
    child.on('error', () => finish(1, 'spawn-error'));
    child.on('close', (code, signal) => { if (!reason) finish(code ?? 1, signal); });
    deadline = setTimeout(() => stop('timeout'), options.timeoutMs ?? 120_000);
  });
}
