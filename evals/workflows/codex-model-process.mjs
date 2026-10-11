import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** A detached group is reaped before returning; neither shell interpolation nor inherited credentials. */
async function groupGone(pid) {
  if (!pid) return true;
  if (process.platform === 'win32') return false;
  const until = Date.now() + 1500;
  do {
    try { process.kill(-pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; }
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < until);
  return false;
}

export async function boundedCodexProcess(binary, args, { environment, input = '', timeoutMs = 30000, maxBytes = 1048576 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4194304) throw Error('codex_process_invalid_limits');
  return new Promise(resolve => {
    let stdout = '', stderr = '', bytes = 0, failure = null, closed = false;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const child = spawn(binary, args, { env: environment, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const terminate = () => {
      if (closed || !child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* Process may already have exited. */ }
    };
    const collect = (kind, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { failure = 'codex_process_output_limit'; terminate(); return; }
      if (kind === 'stdout') stdout += decoders.stdout.write(chunk);
      else stderr += decoders.stderr.write(chunk);
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.stdin.on('error', () => {});
    child.on('error', () => { failure = 'codex_process_unavailable'; });
    const timer = setTimeout(() => { failure = 'codex_process_deadline'; terminate(); }, timeoutMs);
    child.on('close', async (code, signal) => {
      // Parent exit does not guarantee descendants exited. Reap its original detached group too.
      terminate(); closed = true; clearTimeout(timer);
      stdout += decoders.stdout.end(); stderr += decoders.stderr.end();
      const cleanupConfirmed = await groupGone(child.pid);
      if (!cleanupConfirmed) failure = 'codex_process_cleanup_unconfirmed';
      resolve({ code, signal, failure, stdout, stderr, bytes, cleanupConfirmed, processId: child.pid ?? null });
    });
    child.stdin.end(input);
  });
}
