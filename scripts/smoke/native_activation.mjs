#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
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
const { ProcessOwnedWriterController } = await import(pathToFileURL(join(installed, 'runtime/store/process-owned-writer.js')));
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

async function request(running, method, path, value) {
  const origin = running.startup.origin;
  const token = new URLSearchParams(new URL(running.startup.url).hash.slice(1)).get('token');
  const body = value === undefined ? undefined : JSON.stringify(value);
  const response = await fetch(origin + path, { method, body, headers: {
    Authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
  }, signal: AbortSignal.timeout(5000) });
  const contentType = response.headers.get('content-type') ?? '';
  return { status: response.status, contentType,
    body: contentType.includes('application/json') ? await response.json() : await response.text() };
}

const work = await mkdtemp(join(smokeRoot, 'installed-native-'));
const source = join(work, 'canonical-source'), clone = `${source}.native-candidate`;
const emptyPath = await mkdtemp(join(work, 'empty-path-'));
const nativeEnv = { ...process.env, PATH: emptyPath };
for (const command of ['python', 'python3']) {
  try {
    await execute(command, ['--version'], { env: nativeEnv, timeout: 5000 });
    throw new Error('Python is unexpectedly available on the native phase PATH');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const input = join(work, 'canonical-job.json');
await writeFile(input, JSON.stringify({ id: 'canonical-job', url: 'https://example.invalid/canonical', role: 'Canonical Engineer' }));
await execute('python3', [join(installed, 'scripts/job-apply-store.py'), '--root', source, 'job-create', '--input', input], {
  cwd: installed, encoding: 'utf8', timeout: 15000,
});
const canonical = await fileSnapshot(source);
const addon = await resolvePackagedNativeLock(installed);
const provider = loadPosixFlockProvider(addon);
await prepareCanonicalStoreClone(source, clone, provider, '2026-09-14T12:00:00Z');

const app = join(installed, 'apps/companion');
const nativeRoute = await resolveWriterRoute(parseWriterOptions([
  '--plugin-root', installed, '--writer', 'native-clone', '--root', clone,
], app));
if (nativeRoute.argv.at(-1) !== addon) throw new Error('installed native route did not select its packaged lock');
function startup(controller) {
  if (!controller.startupLine) throw new Error('installed Companion startup response is missing');
  return { startup: JSON.parse(controller.startupLine) };
}
function controller(root, candidate) {
  return new ProcessOwnedWriterController({ active: root, candidate, provider,
    shutdownGraceMilliseconds: 5000,
    createSpec: mode => ({
      command: process.execPath,
      argv: [join(app, 'launch.mjs'), '--plugin-root', installed,
        '--writer', mode === 'native' ? 'native-clone' : 'python', '--root', root],
      cwd: installed,
      env: { ...(mode === 'native' ? nativeEnv : process.env), COMPANION_PROCESS_OWNER: 'process-group-v1' },
      startupTimeoutMilliseconds: 100000,
      ready: line => {
        const value = JSON.parse(line), url = new URL(value.url);
        return value.origin === url.origin && url.hostname === '127.0.0.1';
      },
    }),
  });
}
async function checkCompanion(running) {
  const page = await request(running, 'GET', '/');
  if (page.status !== 200 || !page.contentType.includes('text/html') || !/<html[\s>]/i.test(page.body)) {
    throw new Error('installed Companion did not serve HTML from its Next origin');
  }
  const boot = await request(running, 'GET', '/api/boot');
  if (boot.status !== 200 || boot.body.mode !== 'native-store-clone') throw new Error('installed native clone did not activate');
}
async function checkNativeJobs(running, failure) {
  const jobs = await request(running, 'GET', '/api/jobs');
  const ids = jobs.body.jobs?.map(job => job.id) ?? jobs.body.map?.(job => job.id) ?? [];
  if (jobs.status !== 200 || !ids.includes('canonical-job') || !ids.includes('native-only-job')) {
    throw new Error(failure);
  }
}
const active = controller(source, clone);
try {
  await active.start('python');
  const originalJobs = await request(startup(active), 'GET', '/api/jobs');
  const originalIds = originalJobs.body.jobs?.map(job => job.id) ?? originalJobs.body.map?.(job => job.id) ?? [];
  if (originalJobs.status !== 200 || !originalIds.includes('canonical-job')) {
    throw new Error('process owner did not start the canonical Python writer');
  }
  await active.activate();
  await checkCompanion(startup(active));
  const created = await request(startup(active), 'POST', '/api/jobs', {
    job: { id: 'native-only-job', url: 'https://example.invalid/native', role: 'Native Engineer' },
  });
  if (created.status !== 200 || created.body.id !== 'native-only-job') throw new Error('installed native clone mutation failed');
  await active.restart();
  await checkCompanion(startup(active));
  await checkNativeJobs(startup(active), 'installed native mutation did not persist across Companion restart');
  await active.rollback();
  const jobs = await request(startup(active), 'GET', '/api/jobs');
  const ids = jobs.body.jobs?.map(job => job.id) ?? jobs.body.map?.(job => job.id) ?? [];
  if (jobs.status !== 200 || !ids.includes('canonical-job') || ids.includes('native-only-job')) {
    throw new Error('installed Python rollback did not reopen the untouched canonical Store');
  }
} finally { await active.stop(); }
if (JSON.stringify(await fileSnapshot(source)) !== JSON.stringify(canonical)) {
  throw new Error('installed native activation changed canonical Store bytes');
}

const retained = controller(`${source}.native-retained`);
try {
  await retained.start('native');
  await checkCompanion(startup(retained));
  await checkNativeJobs(startup(retained), 'installed native rollback did not retain post-write state');
} finally { await retained.stop(); }
process.stdout.write('Installed process-owned Python/native quiescence, native mutation/restart without Python, and post-write rollback passed\n');
