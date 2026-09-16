#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const [installedArgument, smokeArgument] = process.argv.slice(2);
if (!installedArgument || !smokeArgument) throw new Error('usage: native_activation.mjs /installed/plugin /smoke/root');
const installed = await realpath(resolve(installedArgument));
const smokeRoot = await realpath(resolve(smokeArgument));
const work = await mkdtemp(join(smokeRoot, 'installed-native-'));
const store = join(work, 'store');
const emptyPath = await mkdtemp(join(work, 'empty-path-'));
const nativeEnv = { ...process.env, PATH: emptyPath };
const command = join(installed, 'apps/companion/command.mjs');
const supervisorPath = join(installed, 'apps/companion/supervise.mjs');

async function startSupervisor() {
  const child = spawn(process.execPath, [supervisorPath, '--plugin-root', installed, '--root', store], {
    cwd: installed, env: nativeEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stderr.on('data', bytes => { errors += bytes.toString('utf8'); });
  const line = await new Promise((resolveLine, rejectLine) => {
    const timer = setTimeout(() => rejectLine(new Error(`installed supervisor startup timed out: ${errors}`)), 20_000);
    const finish = (error, value) => { clearTimeout(timer); child.stdout.off('data', onData); child.off('exit', onExit); error ? rejectLine(error) : resolveLine(value); };
    const onExit = code => finish(new Error(`installed supervisor exited before readiness (${code}): ${errors}`));
    const onData = bytes => {
      output += bytes.toString('utf8');
      const newline = output.indexOf('\n');
      if (newline >= 0) finish(null, output.slice(0, newline));
    };
    child.stdout.on('data', onData); child.once('exit', onExit);
  });
  return { child, line };
}

async function stopSupervisor(running) {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return;
  const exited = new Promise(resolveExit => running.child.once('exit', resolveExit));
  running.child.kill('SIGTERM');
  const timer = setTimeout(() => running.child.kill('SIGKILL'), 10_000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function request(running, method, path, value) {
  const startup = JSON.parse(running.line), origin = startup.origin;
  const token = new URLSearchParams(new URL(startup.url).hash.slice(1)).get('token');
  const body = value === undefined ? undefined : JSON.stringify(value);
  const response = await fetch(origin + path, { method, body, headers: {
    Authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
  }, signal: AbortSignal.timeout(5000) });
  const type = response.headers.get('content-type') ?? '';
  return { status: response.status, body: type.includes('application/json') ? await response.json() : await response.text() };
}

try {
  for (const name of ['python', 'python3']) {
    await execute(name, ['--version'], { env: nativeEnv, timeout: 1000 }).then(
      () => { throw new Error('Python is unexpectedly available on the installed artifact PATH'); },
      error => { if (error.code !== 'ENOENT') throw error; },
    );
  }
  const input = join(work, 'job.json');
  await writeFile(input, JSON.stringify({ id: 'native-only-job', url: 'https://example.invalid/native', role: 'Native Engineer' }));
  await execute(process.execPath, [command, 'store', '--root', store, 'job-create', '--input', input], { cwd: installed, env: nativeEnv, timeout: 20000 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const running = await startSupervisor();
    try {
      const page = await request(running, 'GET', '/');
      if (page.status !== 200 || !/<html[\s>]/i.test(page.body)) throw new Error('installed Companion did not serve HTML');
      const boot = await request(running, 'GET', '/api/boot');
      if (boot.status !== 200 || boot.body.mode !== 'native-store-clone') throw new Error('installed native Store did not activate');
      const jobs = await request(running, 'GET', '/api/jobs');
      const ids = jobs.body.jobs?.map(job => job.id) ?? jobs.body.map?.(job => job.id) ?? [];
      if (jobs.status !== 200 || !ids.includes('native-only-job')) throw new Error('installed native mutation did not survive restart');
    } finally { await stopSupervisor(running); }
  }
  const forbidden = [];
  async function inspect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await inspect(join(directory, entry.name), relative);
      else if (entry.name.endsWith('.py') || entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) forbidden.push(relative);
    }
  }
  await inspect(installed);
  if (forbidden.length) throw new Error(`installed artifact contains Python files: ${forbidden.join(', ')}`);
  process.stdout.write('Installed Python-free native CLI, Companion startup, mutation, restart, and artifact scan passed\n');
} finally { await rm(work, { recursive: true, force: true }); }
