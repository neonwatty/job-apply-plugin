import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ReplayError, type ReplayEvent, type RunState } from './contracts.js';

type Startup = { url: string; port: number; fixtureId: string };

export async function startServer(fixturePath: string, expectedFilename: string, shutdownToken: string, mode?: string,
  jobId?: string, companion = false): Promise<Startup> {
  const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));
  const child = spawn(process.execPath, [serverPath, '--fixture', fixturePath, '--port', '0',
    '--expected-resume-filename', expectedFilename, ...(mode ? ['--mode', mode] : []),
    ...(jobId ? ['--job', jobId] : []), ...(companion ? ['--companion', 'true'] : [])], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), detached: !companion,
    stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, JOB_APPLY_QA_SHUTDOWN_TOKEN: shutdownToken },
  });
  return new Promise((accept, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); failed(); }, 10000);
    function failed() {
      clearTimeout(timer);
      reject(new ReplayError('fixture server startup failed'));
    }
    child.once('error', failed);
    child.once('exit', failed);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', chunk => {
      output += String(chunk);
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      child.off('exit', failed);
      child.stdout!.destroy();
      child.unref();
      try {
        const value = JSON.parse(output.slice(0, newline)) as Startup;
        if (value.url !== `http://127.0.0.1:${value.port}` || !Number.isInteger(value.port) || !value.fixtureId) throw new Error();
        accept(value);
      } catch {
        child.kill('SIGKILL');
        failed();
      }
    });
  });
}

export async function request(url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
}

export async function identity(state: RunState): Promise<void> {
  try {
    const response = await request(`${new URL(state.url).origin}/__qa/identity`, {
      headers: { 'X-QA-Run-Token': state.shutdownToken },
    });
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok || value.fixtureId !== state.fixtureId || value.jobId !== state.jobId) throw new Error();
  } catch {
    throw new ReplayError('fixture server identity mismatch');
  }
}

export async function shutdown(state: RunState, required: boolean): Promise<void> {
  try {
    const response = await request(`${new URL(state.url).origin}/__qa/shutdown`, {
      method: 'POST', headers: { 'X-QA-Run-Token': state.shutdownToken },
    });
    if (response.status !== 204) throw new Error();
  } catch {
    if (required) throw new ReplayError('fixture server shutdown failed');
  }
}

export async function serverState(state: RunState): Promise<{ events: ReplayEvent[]; finalActionActivations: number }> {
  try {
    const response = await request(`${new URL(state.url).origin}/__qa/state`);
    const value = await response.json() as { events: ReplayEvent[]; finalActionActivations: number };
    if (!response.ok || !Array.isArray(value.events) || !Number.isInteger(value.finalActionActivations)) throw new Error();
    return value;
  } catch {
    throw new ReplayError('fixture server state unavailable');
  }
}
