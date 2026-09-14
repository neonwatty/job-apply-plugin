#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const [installedArgument, smokeArgument] = process.argv.slice(2);
if (!installedArgument || !smokeArgument) throw new Error('usage: native_activation.mjs /installed/plugin /smoke/root');
const installed = await realpath(resolve(installedArgument));
const smokeRoot = await realpath(resolve(smokeArgument));
const { resolvePackagedNativeLock } = await import(pathToFileURL(join(installed, 'runtime/package/native-lock-artifact.js')));
const { loadPosixFlockProvider } = await import(pathToFileURL(join(installed, 'runtime/store/posix-flock.js')));
const { prepareCanonicalStoreClone } = await import(pathToFileURL(join(installed, 'runtime/store/native-store-clone.js')));
const { parseWriterOptions, resolveWriterRoute } = await import(pathToFileURL(join(installed, 'apps/companion/writer-route.mjs')));

async function fileSnapshot(root) {
  const rows = [];
  async function visit(directory, relative = '') {
    for (const name of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, name.name), child = relative ? `${relative}/${name.name}` : name.name;
      if (name.isDirectory()) await visit(path, child);
      else rows.push([child, createHash('sha256').update(await readFile(path)).digest('hex')]);
    }
  }
  await visit(root);
  return rows;
}

async function start(route) {
  const child = spawn(route.command, route.argv, { cwd: installed, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const startup = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`installed writer startup timed out: ${stderr}`)), 15000);
    const failed = () => { clearTimeout(timer); reject(new Error(`installed writer startup failed: ${stderr}`)); };
    child.once('error', failed); child.once('exit', failed);
    child.stdout.on('data', bytes => {
      stdout += bytes;
      if (!stdout.includes('\n')) return;
      clearTimeout(timer);
      try { done(JSON.parse(stdout.split('\n')[0])); } catch { failed(); }
    });
  });
  return { child, startup };
}

async function stop(running) {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return;
  const exited = once(running.child, 'exit');
  running.child.kill('SIGTERM');
  const timer = setTimeout(() => running.child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function request(running, method, path, value) {
  const origin = running.startup.origin;
  const token = new URLSearchParams(new URL(running.startup.url).hash.slice(1)).get('token');
  const body = value === undefined ? undefined : JSON.stringify(value);
  const response = await fetch(origin + path, { method, body, headers: {
    Authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
  }, signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}

const work = await mkdtemp(join(smokeRoot, 'installed-native-'));
const source = join(work, 'canonical-source'), clone = join(work, 'native-clone');
const input = join(work, 'canonical-job.json');
await writeFile(input, JSON.stringify({ id: 'canonical-job', url: 'https://example.invalid/canonical', role: 'Canonical Engineer' }));
await execute('python3', [join(installed, 'scripts/job-apply-store.py'), '--root', source, 'job-create', '--input', input], {
  cwd: installed, encoding: 'utf8', timeout: 15000,
});
const canonical = await fileSnapshot(source);
const addon = await resolvePackagedNativeLock(installed);
await prepareCanonicalStoreClone(source, clone, loadPosixFlockProvider(addon), '2026-09-14T12:00:00Z');

const app = join(installed, 'apps/companion');
const nativeRoute = await resolveWriterRoute(parseWriterOptions([
  '--plugin-root', installed, '--writer', 'native-clone', '--root', clone,
], app));
if (nativeRoute.argv.at(-1) !== addon) throw new Error('installed native route did not select its packaged lock');
const native = await start(nativeRoute);
try {
  const boot = await request(native, 'GET', '/api/boot');
  if (boot.status !== 200 || boot.body.mode !== 'native-store-clone') throw new Error('installed native clone did not activate');
  const created = await request(native, 'POST', '/api/jobs', {
    job: { id: 'native-only-job', url: 'https://example.invalid/native', role: 'Native Engineer' },
  });
  if (created.status !== 200 || created.body.id !== 'native-only-job') throw new Error('installed native clone mutation failed');
} finally { await stop(native); }

const pythonRoute = await resolveWriterRoute(parseWriterOptions([
  '--plugin-root', installed, '--writer', 'python', '--root', source,
], app));
const python = await start(pythonRoute);
try {
  const jobs = await request(python, 'GET', '/api/jobs');
  const ids = jobs.body.jobs?.map(job => job.id) ?? jobs.body.map?.(job => job.id) ?? [];
  if (jobs.status !== 200 || !ids.includes('canonical-job') || ids.includes('native-only-job')) {
    throw new Error('installed Python rollback did not reopen the untouched canonical Store');
  }
} finally { await stop(python); }
if (JSON.stringify(await fileSnapshot(source)) !== JSON.stringify(canonical)) {
  throw new Error('installed native activation changed canonical Store bytes');
}
process.stdout.write('Installed native activation and Python rollback rehearsal passed\n');
