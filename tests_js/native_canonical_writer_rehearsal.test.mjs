import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { prepareCanonicalStoreClone } from '../runtime/store/native-store-clone.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { parseWriterOptions, resolveWriterRoute } from '../apps/companion/writer-route.mjs';
import { packageNativeLock } from '../scripts/smoke/package_native_lock.mjs';

const execute = promisify(execFile), fixed = '2026-09-14T12:00:00Z';
const repositoryRoot = new URL('../', import.meta.url).pathname;
const companionRoot = join(repositoryRoot, 'apps/companion');
const python = `
import sys,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('writer_reference','scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.utc_now=lambda:'${fixed}'
s=m.Store(Path(sys.argv[1]));s.initialize()
s.create_job({'id':'canonical-job','url':'https://example.invalid/canonical','role':'Canonical Engineer'})
`;

async function snapshot(root) {
  const result = {};
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), metadata = await stat(path);
    if (metadata.isDirectory()) {
      for (const child of (await readdir(path)).sort()) result[`${name}/${child}`] = await readFile(join(path, child), 'base64');
    } else result[name] = await readFile(path, 'base64');
  }
  return result;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(createdAt|updatedAt|lastSeenAt)$/.test(key) ? '<timestamp>' : normalize(item)]));
}

async function invoke(command, args, options = {}) {
  try { return { ...await execute(command, args, { cwd: repositoryRoot, encoding: 'utf8', timeout: 15000, ...options }), code: 0 }; }
  catch (error) { if (typeof error.code !== 'number') throw error; return error; }
}

async function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = '', errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  const startup = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`writer rehearsal startup timed out: ${errors}`)), 10000);
    const fail = () => { clearTimeout(timer); reject(Error(`writer rehearsal startup failed: ${errors}`)); };
    child.once('error', fail); child.once('exit', fail);
    child.stdout.on('data', bytes => {
      output += bytes;
      if (output.length > 16384) return fail();
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(output.split('\n')[0])); } catch { fail(); }
    });
  });
  return { child, startup };
}

async function stop(running) {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return;
  const exited = once(running.child, 'exit'); running.child.kill('SIGTERM');
  const timer = setTimeout(() => running.child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function request(running, method, path, body) {
  const origin = running.startup.origin;
  const token = new URLSearchParams(new URL(running.startup.url).hash.slice(1)).get('token');
  const response = await fetch(origin + path, { method, body,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {
      Origin: origin, 'Content-Type': 'application/json',
    }) }, signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}

test('canonical clone rehearses Store CLI, task CLI, HTTP mutation and server restart', { timeout: 120000 }, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const root = await realpath(fixture.root), source = join(root, 'canonical-source');
  await execute('python3', ['-c', python, source], { cwd: repositoryRoot });
  const original = await snapshot(source), provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const nativeRoot = join(root, 'native-writer'), pythonRoot = join(root, 'python-writer');
  await prepareCanonicalStoreClone(source, nativeRoot, provider, fixed);
  await prepareCanonicalStoreClone(source, pythonRoot, provider, fixed);
  const pythonRoute = await resolveWriterRoute(parseWriterOptions([
    '--writer', 'python', '--root', source,
  ], companionRoot));
  assert.equal(pythonRoute.writer, 'python');
  assert.deepEqual(pythonRoute.argv.slice(-2), ['--root', source]);
  const nativeRoute = await resolveWriterRoute(parseWriterOptions([
    '--writer', 'native-clone', '--root', nativeRoot, '--native-lock', fixture.receipt.artifact,
  ], companionRoot));
  assert.equal(nativeRoute.writer, 'native-clone');
  assert.deepEqual(nativeRoute.argv.slice(-4), ['--root', nativeRoot, '--native-lock', fixture.receipt.artifact]);
  await assert.rejects(resolveWriterRoute(parseWriterOptions([
    '--writer', 'python', '--root', nativeRoot,
  ], companionRoot)), /Python writer cannot use a native-owned Store/);
  await assert.rejects(resolveWriterRoute(parseWriterOptions([
    '--writer', 'native-clone', '--root', source, '--native-lock', fixture.receipt.artifact,
  ], companionRoot)), /Native clone writer ownership is missing/);
  const blockedLauncher = await invoke(process.execPath, [
    'apps/companion/launch.mjs', '--writer', 'python', '--root', nativeRoot,
  ], { env: { ...process.env, PATH: '' } });
  assert.equal(blockedLauncher.code, 1);
  assert.equal(blockedLauncher.stdout, '');
  assert.equal(blockedLauncher.stderr, 'Python writer cannot use a native-owned Store\n');

  const nativeJobs = [process.execPath, ['runtime/cli/native-jobs.js', '--root', nativeRoot,
    '--native-lock', fixture.receipt.artifact, 'job-list'], { env: { PATH: '' } }];
  const pythonJobs = ['python3', ['scripts/job-apply-store.py', '--root', pythonRoot, 'job-list']];
  const [nativeList, pythonList] = await Promise.all([invoke(...nativeJobs), invoke(...pythonJobs)]);
  assert.equal(nativeList.code, 0, nativeList.stderr); assert.equal(pythonList.code, 0, pythonList.stderr);
  assert.deepEqual(JSON.parse(nativeList.stdout), JSON.parse(pythonList.stdout));

  const nativeTask = await invoke(process.execPath, ['runtime/cli/native-task.js', '--root', nativeRoot,
    '--native-lock', fixture.receipt.artifact, 'snapshot'], { env: { PATH: '' } });
  const pythonTask = await invoke('python3', ['scripts/job-apply-task.py', '--root', pythonRoot, 'snapshot']);
  assert.equal(nativeTask.code, 0, nativeTask.stderr); assert.equal(pythonTask.code, 0, pythonTask.stderr);
  assert.deepEqual(JSON.parse(nativeTask.stdout), JSON.parse(pythonTask.stdout));

  const nativeArgs = ['runtime/cli/native-jobs-server.js', '--root', nativeRoot, '--native-lock', fixture.receipt.artifact];
  const pythonArgs = ['scripts/job-apply-workspace.py', '--root', pythonRoot, '--port', '0', '--no-open', '--json'];
  let nativeServer = await start(process.execPath, nativeArgs, { env: { PATH: '' } });
  let pythonServer = await start('python3', pythonArgs);
  t.after(async () => { await Promise.all([stop(nativeServer), stop(pythonServer)]); });
  assert.deepEqual(await request(nativeServer, 'GET', '/api/boot'), {
    status: 200, body: { status: 'ready', mode: 'native-store-clone' },
  });
  for (const [method, path, body] of [
    ['GET', '/api/jobs'], ['GET', '/api/jobs/canonical-job'],
    ['POST', '/api/jobs', JSON.stringify({ job: { id: 'server-job', url: 'https://example.invalid/server', role: 'Server Engineer' } })],
    ['GET', '/api/jobs'],
  ]) {
    const [nativeResult, pythonResult] = await Promise.all([
      request(nativeServer, method, path, body), request(pythonServer, method, path, body),
    ]);
    assert.equal(nativeResult.status, pythonResult.status, `${method} ${path}`);
    assert.deepEqual(normalize(nativeResult.body), normalize(pythonResult.body), `${method} ${path}`);
  }
  const beforeRestart = await request(nativeServer, 'GET', '/api/jobs');
  await Promise.all([stop(nativeServer), stop(pythonServer)]);
  nativeServer = await start(process.execPath, nativeArgs, { env: { PATH: '' } });
  pythonServer = await start('python3', pythonArgs);
  const [nativeRestarted, pythonRestarted] = await Promise.all([
    request(nativeServer, 'GET', '/api/jobs'), request(pythonServer, 'GET', '/api/jobs'),
  ]);
  assert.deepEqual(normalize(nativeRestarted), normalize(pythonRestarted));
  assert.deepEqual(normalize(nativeRestarted), normalize(beforeRestart));
  assert.deepEqual(await snapshot(source), original);
});

test('Companion writer selection defaults to Python and rejects ambiguous overrides', () => {
  assert.equal(parseWriterOptions([], companionRoot).writer, 'python');
  assert.equal(parseWriterOptions(['--native-jobs-fixture', '/tmp/lock'], companionRoot).writer, 'native-fixture');
  for (const args of [
    ['--writer', 'unknown'],
    ['--writer', 'python', '--writer', 'native-clone'],
    ['--writer', 'native-fixture', '--native-jobs-fixture', '/tmp/lock'],
    ['--native-lock', '/tmp/one', '--native-jobs-fixture', '/tmp/two'],
  ]) assert.throws(() => parseWriterOptions(args, companionRoot));
});

async function assembledPackageRoot() {
  const root = await mkdtemp(join(tmpdir(), 'job-apply-package-lock-'));
  await mkdir(join(root, 'native/posix'), { recursive: true });
  await cp(join(repositoryRoot, 'native/posix/flock.c'), join(root, 'native/posix/flock.c'));
  return realpath(root);
}

test('package assembly emits a verified loadable host lock without runtime compilation', async t => {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('POSIX package host required'); return; }
  const root = await assembledPackageRoot();
  try {
    const { resolvePackagedNativeLock } = await import('../runtime/package/native-lock-artifact.js');
    const receipt = await packageNativeLock(root), artifact = await resolvePackagedNativeLock(root);
    assert.equal(artifact, join(receipt.directory, 'flock.node'));
    assert.deepEqual(Object.keys(loadPosixFlockProvider(artifact)).sort(), ['tryLock', 'unlock']);
    await assert.rejects(packageNativeLock(root), /already contains/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packaged lock rejects changed source, artifact, and receipt identity', async t => {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('POSIX package host required'); return; }
  const { resolvePackagedNativeLock } = await import('../runtime/package/native-lock-artifact.js');
  for (const changed of ['source', 'artifact', 'receipt']) {
    const root = await assembledPackageRoot();
    try {
      const packaged = await packageNativeLock(root);
      if (changed === 'source') await writeFile(join(root, 'native/posix/flock.c'), 'changed');
      if (changed === 'artifact') await writeFile(join(packaged.directory, 'flock.node'), 'changed');
      if (changed === 'receipt') {
        const path = join(packaged.directory, 'receipt.json');
        const receipt = JSON.parse(await readFile(path, 'utf8'));
        receipt.arch = `${receipt.arch}-changed`; await writeFile(path, JSON.stringify(receipt) + '\n');
      }
      await assert.rejects(resolvePackagedNativeLock(root), /does not match/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('package assembly removes partial output when package source differs', async t => {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('POSIX package host required'); return; }
  const root = await assembledPackageRoot();
  try {
    await writeFile(join(root, 'native/posix/flock.c'), 'changed');
    await assert.rejects(packageNativeLock(root), /differs/);
    const output = join(root, 'native/packaged-lock', `${process.platform}-${process.arch}-napi8`);
    await assert.rejects(readFile(join(output, 'flock.node')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
