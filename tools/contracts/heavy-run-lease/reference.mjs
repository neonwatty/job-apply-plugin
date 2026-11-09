/** Disposable native ownership witnesses, not a production lease implementation. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNativeLock } from '../../build-native-lock.mjs';

const self = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const readCommand = path => existsSync(path) ? readFileSync(path, 'utf8') : '';

function grandchild(mode, directory) {
  let previous = '';
  let stopped = false;
  const inherited = mode !== 'dropped-descriptor';
  function finish(timedOut = false) {
    if (stopped) return;
    stopped = true;
    clearInterval(poll); clearTimeout(deadline);
    if (inherited) closeSync(3);
    emit({ event: timedOut ? 'grandchild-timeout' : 'grandchild-stopped' });
    process.exitCode = timedOut ? 1 : 0;
  }
  const poll = setInterval(() => {
    const command = readCommand(join(directory, 'grandchild-command'));
    if (!command || command === previous) return;
    previous = command;
    if (command === 'stop') finish();
    else emit({ event: 'grandchild-ack', command });
  }, 10);
  const deadline = setTimeout(() => finish(true), 8000);
  emit({ event: 'grandchild-ready', inherited });
}

function holder(mode, artifact, directory) {
  const native = require(artifact);
  const descriptor = openSync(join(directory, 'synthetic.lock'), 'a+');
  let open = true;
  assert.equal(native.tryLock(descriptor), true);
  emit({ event: 'holder-locked' });
  const child = spawn(process.execPath, [self, 'grandchild', mode, artifact, directory], {
    env: { PATH: '' }, stdio: ['ignore', 1, 2, mode === 'dropped-descriptor' ? 'ignore' : descriptor],
  });
  let previous = '';
  const poll = setInterval(() => {
    const command = readCommand(join(directory, 'holder-command'));
    if (!command || command === previous) return;
    previous = command;
    if (command === 'close' && open) {
      closeSync(descriptor); open = false; emit({ event: 'holder-closed' });
    } else if (command === 'unlock') {
      native.unlock(descriptor); emit({ event: 'holder-unlocked' });
    }
  }, 10);
  child.once('error', error => { clearInterval(poll); throw error; });
  child.once('close', code => {
    clearInterval(poll);
    if (open) closeSync(descriptor);
    process.exitCode = code === 0 ? 0 : 1;
  });
}

function contender(artifact, directory) {
  const descriptor = openSync(join(directory, 'synthetic.lock'), 'a+');
  try { emit({ event: 'contender-result', acquired: require(artifact).tryLock(descriptor) }); }
  finally { closeSync(descriptor); }
}

function launch(args, detached = false) {
  const child = spawn(process.execPath, [self, ...args], {
    env: { PATH: '' }, detached, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = [];
  const waiters = new Set();
  let pending = '', stderr = '', ended = false;
  function notify() { for (const check of [...waiters]) check(); }
  child.stdout.on('data', bytes => {
    pending += bytes;
    if (pending.length > 65536) throw new Error('Synthetic witness exceeded output limit');
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      events.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1);
    }
    notify();
  });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-65536); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { ended = true; notify(); resolve({ code, signal, stderr }); });
  });
  return { child, events, exited, closed,
    wait(event, command) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Missing ${event}: ${stderr}`)), 5000);
        function finish(error, row) {
          clearTimeout(timer); waiters.delete(check);
          if (error) reject(error); else resolve(row);
        }
        function check() {
          const row = events.find(item => item.event === event && (command === undefined || item.command === command));
          if (row) finish(null, row);
          else if (ended) finish(new Error(`Witness exited before ${event}: ${stderr}`));
        }
        waiters.add(check); check();
      });
    },
  };
}

async function compete(artifact, directory) {
  const process = launch(['contender', 'unused', artifact, directory]);
  const row = await process.wait('contender-result');
  assert.deepEqual(await process.closed, { code: 0, signal: null, stderr: '' });
  assert.deepEqual(process.events, [row]);
  return row.acquired;
}

async function scenario(mode, artifact, root) {
  const directory = await mkdtemp(join(root, `${mode}-`));
  const process = launch(['holder', mode, artifact, directory], true);
  const events = [];
  const killedParent = mode === 'parent-death' || mode === 'dropped-descriptor';
  const command = (who, value) => writeFileSync(join(directory, `${who}-command`), value);
  try {
    await process.wait('holder-locked'); events.push('holder-locked');
    const ready = await process.wait('grandchild-ready');
    assert.equal(ready.inherited, mode !== 'dropped-descriptor');
    events.push('grandchild-ready');
    const initiallyAcquired = await compete(artifact, directory);
    events.push('initial-contender-observed');
    if (killedParent) {
      assert.equal(process.child.kill('SIGKILL'), true);
      assert.deepEqual(await process.exited, { code: null, signal: 'SIGKILL' });
      events.push('holder-killed');
    } else {
      const operation = mode === 'explicit-unlock' ? 'unlock' : 'close';
      command('holder', operation);
      await process.wait(operation === 'unlock' ? 'holder-unlocked' : 'holder-closed');
      events.push(operation === 'unlock' ? 'holder-unlocked' : 'holder-closed');
    }
    command('grandchild', 'before-contender');
    await process.wait('grandchild-ack', 'before-contender'); events.push('grandchild-before');
    const whileGrandchildAlive = await compete(artifact, directory);
    events.push('live-contender-observed');
    command('grandchild', 'after-contender');
    await process.wait('grandchild-ack', 'after-contender'); events.push('grandchild-after');
    command('grandchild', 'stop');
    await process.wait('grandchild-stopped'); events.push('grandchild-stopped');
    const closed = await process.closed;
    assert.equal(closed.stderr, '');
    assert.equal(closed.code, killedParent ? null : 0);
    assert.equal(closed.signal, killedParent ? 'SIGKILL' : null);
    events.push('owned-output-closed');
    const afterCompletion = await compete(artifact, directory);
    events.push('final-contender-observed');
    return { id: mode, inherited: ready.inherited, initiallyAcquired,
      whileGrandchildAlive, afterCompletion, events };
  } finally {
    command('grandchild', 'stop');
    // The only grandchild has a fixed self-expiry; normal stop closes its descriptor.
    // No stale PID/group lookup or signalling is used for cleanup.
    await process.closed;
  }
}

export async function captureHeavyRunLeaseReference() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('This reference currently requires native darwin arm64; other platform cells are open');
  }
  const root = await mkdtemp(join(tmpdir(), 'heavy-run-reference-'));
  try {
    const receipt = await buildNativeLock({ outputDirectory: join(root, 'addon') });
    const artifactBytes = await readFile(receipt.artifact);
    assert.equal(hash(artifactBytes), receipt.artifactSha256);
    const cases = [];
    for (const mode of ['parent-close', 'parent-death', 'dropped-descriptor', 'explicit-unlock']) {
      cases.push(await scenario(mode, receipt.artifact, root));
    }
    const executablePath = realpathSync(process.execPath);
    return { schemaVersion: 1, scope: 'disposable-flock-descriptor-inheritance-only',
      profile: { platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
        executablePath, executableSha256: hash(readFileSync(executablePath)) },
      build: receipt, artifactObservedSha256: hash(artifactBytes), cases,
      cleanup: { temporaryRoot: root, descendantsCompleted: true, removed: true } };
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] === self) {
  const [role, mode, artifact, directory] = process.argv.slice(2);
  if (role === 'holder') holder(mode, artifact, directory);
  else if (role === 'grandchild') grandchild(mode, directory);
  else if (role === 'contender') contender(artifact, directory);
  else { process.stderr.write('Invoke through the fixed reference test; no public command interface\n'); process.exitCode = 2; }
}
