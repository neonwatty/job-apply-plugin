import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { collectLocalMacHost, assertLocalMacHostUnchanged } from './local-mac-host.mjs';
import { parseTaskTap } from './tap-evidence.mjs';
import { buildNativeLock } from '../build-native-lock.mjs';
import { loadPosixFlockProvider } from '../../runtime/store/posix-flock.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const declarations = JSON.parse(readFileSync(new URL('../../docs/migration/evidence/s04/implementation-spec.json', import.meta.url), 'utf8')).cells;
const hash = value => createHash('sha256').update(value).digest('hex');
const observationFields = ['id', 'command', 'stdout', 'stderr', 'stdoutSha256', 'stderrSha256',
  'exitCode', 'signal', 'timedOut', 'durationMs', 'outputBytes', 'names', 'tests', 'failures', 'skips', 'cancelled', 'todo'];

/** Validation accepts only the two frozen declarations, never caller-selected commands. */
export function validateRequiredCellResult(declaration, observation) {
  const frozen = declarations.find(cell => cell.id === declaration?.id);
  assert.ok(frozen, 'Unknown required cell');
  assert.deepEqual(declaration, frozen, 'Required cell declaration changed');
  assert.ok(observation && typeof observation === 'object');
  assert.deepEqual(Reflect.ownKeys(observation).sort(), [...observationFields].sort(), 'Observation fields differ');
  assert.equal(observation.id, frozen.id);
  assert.deepEqual(observation.command, frozen.command);
  assert.equal(observation.exitCode, 0);
  assert.equal(observation.signal, null);
  assert.equal(observation.timedOut, false);
  assert.equal(typeof observation.stdout, 'string');
  assert.equal(observation.stderr, '');
  assert.equal(observation.stdoutSha256, hash(Buffer.from(observation.stdout, 'utf8')));
  assert.equal(observation.stderrSha256, hash(Buffer.from(observation.stderr, 'utf8')));
  assert.equal(observation.outputBytes, Buffer.byteLength(observation.stdout) + Buffer.byteLength(observation.stderr));
  assert.ok(observation.outputBytes > 0 && observation.outputBytes <= frozen.maxOutputBytes);
  assert.ok(Number.isFinite(observation.durationMs) && observation.durationMs >= 0
    && observation.durationMs <= frozen.timeoutMs);
  const parsed = parseTaskTap(observation.stdout);
  assert.ok(parsed, 'Required TAP is incomplete, nested, skipped or unsuccessful');
  assert.deepEqual(parsed.names, frozen.testNames);
  assert.deepEqual(observation.names, frozen.testNames);
  assert.equal(observation.tests, frozen.testNames.length);
  assert.equal(parsed.tests, observation.tests);
  assert.ok(parsed.durationMs <= observation.durationMs + 1);
  assert.ok(parsed.durationMs <= frozen.timeoutMs);
  for (const field of ['failures', 'skips', 'cancelled', 'todo']) assert.equal(observation[field], 0);
}

async function unchangedHost(expected) {
  try {
    const actual = await collectLocalMacHost();
    assertLocalMacHostUnchanged(expected, actual);
    return actual;
  } catch (cause) {
    // Only the initial collection can signal an unsupported-host skip.
    throw new Error('Local Mac identity failed or changed during required evidence', { cause });
  }
}

function executeCell(cell) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const stdout = [], stderr = [];
    let outputBytes = 0, timedOut = false, overflow = false, spawnError;
    const environment = { ...process.env };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, cell.command.slice(1), {
      cwd: root, shell: false, detached: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    function stop() {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') spawnError = error; }
    }
    const timer = setTimeout(() => { timedOut = true; stop(); }, cell.timeoutMs);
    function collect(target, bytes) {
      target.push(bytes);
      outputBytes += bytes.length;
      if (outputBytes > cell.maxOutputBytes) { overflow = true; stop(); }
    }
    child.stdout.on('data', bytes => collect(stdout, bytes));
    child.stderr.on('data', bytes => collect(stderr, bytes));
    child.on('error', error => { spawnError = error; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
      let observation;
      try {
        const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        const output = decode(out), errors = decode(err);
        const parsed = parseTaskTap(output);
        observation = { id: cell.id, command: [...cell.command], stdout: output, stderr: errors,
          stdoutSha256: hash(out), stderrSha256: hash(err), exitCode, signal, timedOut,
          durationMs: performance.now() - started, outputBytes, names: parsed?.names ?? [],
          tests: parsed?.tests ?? 0, failures: parsed?.failures ?? 0,
          skips: parsed?.skips ?? 0, cancelled: parsed?.cancelled ?? 0, todo: 0 };
        if (spawnError) throw spawnError;
        assert.equal(overflow, false, 'Required cell output budget exceeded');
        validateRequiredCellResult(cell, observation);
        resolve(observation);
      } catch (cause) {
        const error = new Error(`Required cell failed: ${cell.id}`, { cause });
        // Preserve every observed byte, including a final over-limit read; never trim to pass.
        error.observation = observation ?? { id: cell.id, stdoutBase64: out.toString('base64'),
          stderrBase64: err.toString('base64'), stdoutSha256: hash(out), stderrSha256: hash(err),
          exitCode, signal, timedOut, outputBytes };
        reject(error);
      }
    });
  });
}

export async function runLocalMacPersistenceCells() {
  const hostBefore = await collectLocalMacHost();
  const cells = [];
  let hostAfter = hostBefore;
  for (const declaration of declarations) {
    await unchangedHost(hostBefore);
    let observation, failure;
    try { observation = await executeCell(declaration); }
    catch (error) { failure = error; }
    try { hostAfter = await unchangedHost(hostBefore); }
    catch (error) {
      error.observation = failure?.observation ?? observation;
      error.previousCells = cells;
      throw error;
    }
    if (failure) {
      failure.previousCells = cells;
      throw failure;
    }
    cells.push(observation);
  }
  return { schemaVersion: 1, scope: 'mac-dogfood-persistence', hostBefore, hostAfter, cells };
}

/** Real owned descriptors; source, headers and the loaded binary are independently hashed. */
export async function observeLocalMacNativeAddon() {
  const hostBefore = await collectLocalMacHost();
  const directory = await mkdtemp(join(tmpdir(), 'job-apply-p05-native-'));
  const handles = [];
  let evidence;
  try {
    const source = join(root, 'native/posix/flock.c');
    const include = join(dirname(dirname(hostBefore.node.resolved)), 'include/node');
    const headers = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h'];
    async function sourceIdentity() {
      const headerHashes = {};
      for (const name of headers) headerHashes[name] = hash(await readFile(join(include, name)));
      return { sourceSha256: hash(await readFile(source)), headerHashes };
    }
    const beforeSource = await sourceIdentity();
    const build = await buildNativeLock({ outputDirectory: join(directory, 'addon'),
      compiler: hostBefore.compiler.resolved });
    assert.equal(build.platform, hostBefore.platform);
    assert.equal(build.arch, hostBefore.arch);
    assert.equal(build.nodeVersion, hostBefore.node.version);
    assert.equal(build.nodeApiVersion, 8);
    assert.equal(build.sourceSha256, beforeSource.sourceSha256);
    assert.deepEqual(build.headerHashes, beforeSource.headerHashes);
    const artifactBytesSha256 = hash(await readFile(build.artifact));
    assert.equal(artifactBytesSha256, build.artifactSha256);
    const provider = loadPosixFlockProvider(build.artifact);
    const file = join(directory, 'owned.lock');
    const first = await open(file, 'a+'); handles.push(first);
    const second = await open(file, 'a+'); handles.push(second);
    const operations = [];
    assert.equal(provider.tryLock(first.fd), true);
    operations.push('first descriptor lock succeeds');
    assert.equal(provider.tryLock(second.fd), false);
    operations.push('second descriptor contention returns false');
    provider.unlock(first.fd);
    operations.push('unlock first');
    assert.equal(provider.tryLock(second.fd), true);
    operations.push('second descriptor lock succeeds');
    provider.unlock(second.fd);
    operations.push('unlock second');
    assert.equal(hash(await readFile(build.artifact)), artifactBytesSha256);
    assert.deepEqual(await sourceIdentity(), beforeSource);
    evidence = { schemaVersion: 1, scope: 'mac-dogfood-native-addon', hostBefore,
      hostAfter: await unchangedHost(hostBefore), compiler: hostBefore.compiler.resolved,
      build, artifactBytesSha256, operations, cleanup: 'owned temporary handles/directory closed/removed; no live paths' };
  } finally {
    const closed = await Promise.allSettled(handles.map(handle => handle.close()));
    await rm(directory, { recursive: true, force: true });
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  return evidence;
}
