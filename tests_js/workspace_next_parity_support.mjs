import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

// Independent synthetic Python Store; no owner data or account operations.
export async function nextParity(forward) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const store = await mkdtemp(join(tmpdir(), 'next-parity-'));
  const child = spawn('python3', [join(root, 'scripts/job-apply-workspace.py'),
    '--root', store, '--port', '0', '--no-open', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  try {
    const startup = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => finish(Error('Parity fixture startup timed out')), 5000);
      function finish(error, value) {
        clearTimeout(timer);
        child.off('error', failed); child.off('exit', failed); child.stdout.off('data', data);
        if (error) reject(error); else resolve(value);
      }
      function failed() { finish(Error('Parity fixture failed to start')); }
      function data(bytes) {
        output += bytes;
        if (output.length > 16384) return failed();
        if (!output.includes('\n')) return;
        try { finish(null, JSON.parse(output.split('\n')[0])); } catch { failed(); }
      }
      child.on('error', failed); child.on('exit', failed); child.stdout.on('data', data);
    });
    const token = new URLSearchParams(new URL(startup.url).hash.slice(1)).get('token');
    const config = { origin: 'http://127.0.0.1:41001', upstream: startup.origin, token };
    function headers(origin, body) {
      return { Host: new URL(origin).host, Authorization: `Bearer ${token}`, Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)) }) };
    }
    const large = JSON.stringify({ metadata: {}, filename: 'synthetic.txt', content: 'YQ=='.repeat(20000) });
    const cases = [
      ['/api/jobs/%zz', 'GET'], ['/api/jobs/%ff', 'GET'], ['/api/jobs?extra=1', 'GET'],
      ['/api/jobs', 'PUT'], ['/api/jobs', 'DELETE'], ['/api/jobs', 'OPTIONS'],
      ['/api/resumes/import', 'POST', large],
      ['/api/resumes/synthetic/replace', 'POST', large],
      ['/api/resumes/synthetic/adopt', 'POST', large],
    ];
    for (const [path, method, body] of cases) {
      const direct = await fetch(config.upstream + path, { method, body,
        headers: headers(config.upstream, body), signal: AbortSignal.timeout(5000) });
      const bridged = await forward(new Request(config.origin + path, { method, body,
        headers: headers(config.origin, body) }), 'api', config);
      assert.equal(bridged.status, direct.status, `${method} ${path}`);
      assert.deepEqual(await bridged.json(), await direct.json(), `${method} ${path} error body`);
      if (path.includes('/resumes/')) assert.equal(bridged.status, 400,
        'Large envelope must reach Python base64 validation, not the 64 KiB proxy limit');
    }
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(store, { recursive: true, force: true });
  }
}
