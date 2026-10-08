import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

// Use an isolated Codex configuration, with only the host login made available.
// Never print or copy credential contents into a receipt.
export function hostEnvironment(codexHome, storeRoot) {
  const environment = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return { ...environment, CODEX_HOME: codexHome, NO_COLOR: '1', JOB_APPLY_STORE_DIR: storeRoot };
}

export function execute(command, args, { cwd, env = process.env, timeout = 120000, input = '' } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    let stdout = '', stderr = '', failure = null, killTimer, closed = null, escalating = false;
    const started = Date.now();
    const kill = signal => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const stop = reason => {
      if (failure) return;
      failure = reason;
      escalating = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => {
        kill('SIGKILL');
        escalating = false;
        finish();
      }, 5000);
    };
    const finish = () => {
      if (!closed || escalating) return;
      resolvePromise({ ...closed, failure, elapsedMs: Date.now() - started,
        stdout: stdout + stdoutDecoder.end(), stderr: stderr + stderrDecoder.end() });
    };
    const timer = setTimeout(() => stop('timeout'), timeout);
    child.stdout.on('data', bytes => {
      if (stdout.length < 16 * 1024 * 1024) stdout += stdoutDecoder.write(bytes);
      else stop('output_limit');
    });
    child.stderr.on('data', bytes => {
      if (stderr.length < 4 * 1024 * 1024) stderr += stderrDecoder.write(bytes);
      else stop('output_limit');
    });
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      closed = { code, signal };
      // A direct child can exit before a descendant that ignores SIGTERM.
      // Finish escalation before returning control to fixture cleanup.
      finish();
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop('stdin_error'); });
    child.stdin.end(input);
  });
}

async function requireSuccess(command, args, options) {
  const result = await execute(command, args, options);
  if (result.code !== 0 || result.failure) throw Error(`${command} failed: ${result.failure ?? result.code}: ${result.stderr}`);
  return result.stdout;
}

export async function installRevision(repository, revision, directory) {
  const marketplace = join(directory, 'marketplace'), codexHome = join(directory, 'codex-home');
  await mkdir(marketplace, { mode: 0o700 });
  await mkdir(codexHome, { mode: 0o700 });
  const hostHome = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  await symlink(join(hostHome, 'auth.json'), join(codexHome, 'auth.json'));
  const archive = join(directory, 'source.tar');
  await requireSuccess('git', ['archive', '--format=tar', `--output=${archive}`, revision], { cwd: repository });
  await requireSuccess('tar', ['-xf', archive, '-C', marketplace]);
  const manifestPath = join(marketplace, '.claude-plugin/marketplace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.plugins[0].source = './';
  await writeJson(manifestPath, manifest);
  const env = hostEnvironment(codexHome, join(directory, 'unused-store'));
  await requireSuccess('codex', ['plugin', 'marketplace', 'add', marketplace, '--json'], { env });
  await requireSuccess('codex', ['plugin', 'add', 'job-apply@neonwatty-plugins', '--json'], { env });
  const version = JSON.parse(await readFile(join(marketplace, '.codex-plugin/plugin.json'), 'utf8')).version;
  const pluginRoot = await realpath(join(codexHome, 'plugins/cache/neonwatty-plugins/job-apply', version));
  return { codexHome, pluginRoot, version };
}

// Deliberately does not infer question counts or truthfulness from punctuation.
// Keep complete assistant messages for a separately recorded human/code review.
export function parseTrace(stdout) {
  const events = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const completed = events.filter(event => event.type === 'item.completed').map(event => event.item);
  const commands = completed.filter(item => item.type === 'command_execution');
  return {
    sessionId: events.find(event => event.type === 'thread.started')?.thread_id ?? null,
    completed: events.some(event => event.type === 'turn.completed') && !events.some(event => event.type === 'turn.failed' || event.type === 'error'),
    messages: completed.filter(item => item.type === 'agent_message').map(item => item.text),
    commands: commands.map(item => ({ command: item.command, exitCode: item.exit_code, status: item.status })),
    otherItems: completed.filter(item => !['command_execution', 'agent_message', 'reasoning'].includes(item.type)),
    usage: events.find(event => event.type === 'turn.completed')?.usage ?? null,
  };
}

export function agentArguments({ sessionId, workspace, model }) {
  return ['exec', ...(sessionId ? ['resume', sessionId] : ['-C', workspace]),
    '--skip-git-repo-check', '--ignore-rules', '--model', model,
    '--config', 'sandbox_mode="workspace-write"', '--config', 'model_reasoning_effort="medium"',
    '--config', 'approval_policy="never"', '--config', 'web_search="disabled"', '--json', '-'];
}

export async function sessionContext(codexHome, sessionId) {
  const root = join(codexHome, 'sessions');
  const files = (await readdir(root, { recursive: true })).filter(name => name.endsWith(`${sessionId}.jsonl`));
  if (files.length !== 1) throw Error('Expected one persisted evaluation session');
  const events = (await readFile(join(root, files[0]), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const contexts = events.filter(event => event.type === 'turn_context').map(event => event.payload);
  const last = contexts.at(-1);
  if (!last) throw Error('Missing effective host turn configuration');
  return { count: contexts.length, cwd: last.cwd, sandbox: last.sandbox_policy, model: last.model, effort: last.effort };
}

export function validateContext(actual, { workspace, model, turn }) {
  if (actual.count !== turn || actual.cwd !== workspace || actual.model !== model || actual.effort !== 'medium'
    || actual.sandbox?.type !== 'workspace-write' || actual.sandbox.network_access !== false) {
    throw Error('Effective host configuration changed; exclude this run from comparison');
  }
}
