#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const [installedArgument, smokeArgument] = process.argv.slice(2);
if (!installedArgument || !smokeArgument) throw new Error('usage: native_activation.mjs /installed/plugin /smoke/root');
const installed = await realpath(resolve(installedArgument));
const smokeRoot = await realpath(resolve(smokeArgument));
const work = await mkdtemp(join(smokeRoot, 'installed-native-'));
const store = join(work, 'store');
const legacyProfile = join(work, 'absent-legacy-profile.json');
const emptyPath = await mkdtemp(join(work, 'empty-path-'));
const nativeEnv = { ...process.env, PATH: emptyPath };
const command = join(installed, 'apps/companion/command.mjs');
const supervisorPath = join(installed, 'apps/companion/supervise.mjs');

async function startSupervisor() {
  const child = spawn(process.execPath, [supervisorPath, '--plugin-root', installed, '--root', store, '--legacy-profile', legacyProfile], {
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
  }).catch(async error => {
    await stopSupervisor({ child });
    throw error;
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

async function cli(surface, ...args) {
  const result = await execute(process.execPath, [command, surface, '--root', store, ...args],
    { cwd: installed, env: nativeEnv, timeout: 20_000 });
  return JSON.parse(result.stdout);
}

async function writeInput(name, value) {
  const path = join(work, name + '.json');
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

try {
  if ((await readdir(emptyPath)).length) throw new Error('Native runtime PATH must be empty');
  const input = await writeInput('job', { id: 'native-only-job', url: 'https://example.invalid/native', role: 'Native Engineer' });
  const job = await cli('store', '--legacy-profile', legacyProfile, 'job-create', '--input', input);
  const resumePath = join(work, 'resume.txt');
  await writeFile(resumePath, 'Synthetic native engineer', { mode: 0o600 });
  const resume = await cli('store', 'resume-import', '--input', await writeInput('resume', { label: 'Synthetic' }), '--path', resumePath);
  const draft = await cli('store', 'resume-facts-draft', '--resume-id', resume.id, '--expected-resume-revision', String(resume.revision),
    '--input', await writeInput('facts', { skills: ['TypeScript'] }));
  const confirmed = await cli('store', 'resume-facts-confirm', '--resume-id', resume.id,
    '--expected-fact-revision', String(draft.revision), '--expected-content-revision', draft.contentRevision);
  await cli('store', 'application-run-start', '--resume-id', resume.id, '--expected-resume-revision', String(resume.revision),
    '--expected-fact-revision', String(confirmed.revision), '--owner-confirmed', '--input', await writeInput('queue', { jobIds: [job.id] }));
  const selected = await cli('task', 'select', '--id', job.id, '--expected-revision', String(job.revision), '--owner-confirmed');
  const acquired = await cli('attempt', 'start', '--id', job.id, '--owner', 'synthetic', '--expected-revision', String(selected.job.revision));
  if (acquired.event !== 'acquired') throw new Error('installed broker did not acquire the synthetic job');
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
      if ((await cli('attempt', 'heartbeat')).event !== 'heartbeat') throw new Error('Companion interrupted the active broker');
    } finally { await stopSupervisor(running); }
  }
  const handoff = await cli('attempt', 'handoff', '--status', 'needs_info', '--input', await writeInput('handoff', { status: 'active' }));
  if (handoff.event !== 'handed_off') throw new Error('installed broker could not hand off after Companion restart');
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
} finally {
  const pid = Number(await readFile(join(store, '.job-apply-attempt.pid'), 'utf8').catch(() => ''));
  if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await rm(work, { recursive: true, force: true });
}
