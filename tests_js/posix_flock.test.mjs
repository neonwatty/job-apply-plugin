import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildNativeLock } from '../tools/build-native-lock.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

test('native nonblocking flock binds descriptors, validates arguments and preserves kernel ownership', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('Native POSIX compiler/host required'); return; }
  const fixture = await nativeFixture();
  const handles = [];
  try {
    assert.equal(fixture.receipt.nodeApiVersion, 8);
    assert.equal(fixture.receipt.artifactSha256, createHash('sha256').update(await readFile(fixture.receipt.artifact)).digest('hex'));
    await assert.rejects(buildNativeLock({ outputDirectory: join(fixture.root, 'addon') }), { code: 'EEXIST' });
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    const path = join(fixture.root, 'synthetic.lock');
    const first = await open(path, 'a+'); handles.push(first);
    const second = await open(path, 'a+'); handles.push(second);
    assert.equal(provider.tryLock(first.fd), true);
    assert.equal(provider.tryLock(second.fd), false);
    assert.equal(provider.tryLock(first.fd), true);
    let ticks = 0;
    const interval = setInterval(() => { ticks += 1; }, 1);
    try {
      for (let index = 0; index < 20; index += 1) {
        assert.equal(provider.tryLock(second.fd), false);
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      assert.ok(ticks > 0, 'Contended calls must not block the event loop');
    } finally { clearInterval(interval); }
    provider.unlock(first.fd);
    assert.equal(provider.tryLock(second.fd), true);
    provider.unlock(second.fd);
    for (const invalid of [NaN, Infinity, 1.5, '1', null, undefined, {}, 2 ** 40]) {
      assert.throws(() => provider.tryLock(invalid));
      assert.throws(() => provider.unlock(invalid));
    }
    const closed = second.fd;
    await second.close(); handles.pop();
    assert.throws(() => provider.tryLock(closed), error => error.code === 'EBADF' && error.name === 'OSError');
  } finally {
    for (const handle of handles) await handle.close();
    await fixture.cleanup();
  }
});

const { validateRequiredCellResult, runLocalMacPersistenceCells, observeLocalMacNativeAddon } =
  await import('../tools/migration/local-mac-required-cells.mjs');
const { spawnSync } = await import('node:child_process');
const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { parseTaskTap } = await import('../tools/migration/tap-evidence.mjs');
const requiredCells = JSON.parse(await readFile(new URL('../docs/migration/evidence/s04/implementation-spec.json', import.meta.url), 'utf8')).cells;
const sha256 = value => createHash('sha256').update(value).digest('hex');
function syntheticObservation(cell, stdout) {
  return { id: cell.id, command: [...cell.command], stdout, stderr: '',
    stdoutSha256: sha256(stdout), stderrSha256: sha256(''), exitCode: 0, signal: null,
    timedOut: false, durationMs: 10, outputBytes: Buffer.byteLength(stdout), names: [...cell.testNames],
    tests: cell.testNames.length, failures: 0, skips: 0, cancelled: 0, todo: 0 };
}
function syntheticTap(names) {
  return ['TAP version 13', ...names.flatMap((name, index) => [`# Subtest: ${name}`, `ok ${index + 1} - ${name}`]),
    `1..${names.length}`, `# tests ${names.length}`, '# suites 0', `# pass ${names.length}`, '# fail 0',
    '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 1', ''].join('\n');
}
function decodeDiagnostic(line) {
  assert.ok(line.startsWith('# {'));
  return JSON.parse(line.slice(2).replace(/\\([\\#])/g, '$1'));
}

test('P05 required cells reject skipped nested malformed and incomplete evidence', async () => {
  const cell = requiredCells[0];
  const good = syntheticTap(cell.testNames);
  assert.doesNotThrow(() => validateRequiredCellResult(cell, syntheticObservation(cell, good)));
  for (const text of [
    good.replace('ok 1 -', 'not ok 1 -'),
    good.replace(cell.testNames[0] + '\n', cell.testNames[0] + ' # SKIP unavailable\n'),
    good.replace('# skipped 0', '# skipped 1'),
    good.replace('# todo 0', '# todo 1'),
    good.replace('# cancelled 0', '# cancelled 1'),
    good.replace('TAP version 13\n', 'TAP version 13\n    # Subtest: child\n    ok 1 - child # SKIP unavailable\n    1..1\n'),
    good.replaceAll(cell.testNames[0], 'renamed witness'),
    syntheticTap(cell.testNames.slice(1)),
    good.slice(0, good.indexOf('1..8')),
    good.replace('1..8', '1..9'),
    good + '# tests 8\n',
    'not a TAP stream',
  ]) assert.throws(() => validateRequiredCellResult(cell, syntheticObservation(cell, text)));
  for (const mutate of [
    value => { value.exitCode = 1; },
    value => { value.signal = 'SIGTERM'; },
    value => { value.timedOut = true; },
    value => { value.stderr = 'unexpected diagnostic'; },
    value => { value.stdoutSha256 = '0'.repeat(64); },
    value => { value.outputBytes += 1; },
    value => { value.durationMs = cell.timeoutMs + 1; },
    value => { value.durationMs = NaN; },
    value => { value.tests -= 1; },
    value => { value.names.reverse(); },
    value => { value.skips = 1; },
    value => { value.extra = 'foreign'; },
    value => { value.command[2] = 'foreign.test.mjs'; },
  ]) {
    const value = syntheticObservation(cell, good);
    mutate(value);
    assert.throws(() => validateRequiredCellResult(cell, value));
  }
  const tooLarge = good.replace('1..8', '# ' + 'x'.repeat(cell.maxOutputBytes) + '\n1..8');
  assert.throws(() => validateRequiredCellResult(cell, syntheticObservation(cell, tooLarge)));
  assert.throws(() => validateRequiredCellResult({ ...cell, timeoutMs: cell.timeoutMs + 1 }, syntheticObservation(cell, good)));
  const directory = await mkdtemp(join(tmpdir(), 'p05-diagnostic-roundtrip-'));
  try {
    const sample = 'LF\nCR\rtab\tliteral\\n quote" hash# Unicodeλ😀 final\n';
    const file = join(directory, 'diagnostic.test.mjs');
    await writeFile(file, `import test from 'node:test';\ntest('transport', t => t.diagnostic(JSON.stringify(${JSON.stringify({ stdout: sample, sha256: sha256(sample), bytes: Buffer.byteLength(sample) })})));\n`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const result = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', env, shell: false,
      timeout: 10000, maxBuffer: 65536 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(parseTaskTap(result.stdout));
    const decoded = decodeDiagnostic(result.stdout.split('\n').find(line => line.startsWith('# {')));
    assert.equal(decoded.stdout, sample);
    assert.equal(sha256(decoded.stdout), decoded.sha256);
    assert.equal(Buffer.byteLength(decoded.stdout), decoded.bytes);
    assert.notEqual(sha256(decoded.stdout.trim()), decoded.sha256);
    assert.notEqual(sha256(decoded.stdout.replace(/\r/g, '')), decoded.sha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('P05 local Mac native addon binds compiler and actual owned kernel operations', async t => {
  let evidence;
  try { evidence = await observeLocalMacNativeAddon(); }
  catch (error) {
    if (error.code === 'LOCAL_MAC_HOST_MISMATCH') {
      t.skip('Frozen Mac dogfood host required; no native acceptance');
      return;
    }
    throw error;
  }
  assert.equal(evidence.scope, 'mac-dogfood-native-addon');
  assert.deepEqual(evidence.hostBefore, evidence.hostAfter);
  assert.equal(evidence.compiler, evidence.hostBefore.compiler.resolved);
  assert.equal(evidence.artifactBytesSha256, evidence.build.artifactSha256);
  assert.deepEqual(evidence.operations, ['first descriptor lock succeeds', 'second descriptor contention returns false',
    'unlock first', 'second descriptor lock succeeds', 'unlock second']);
  const sdk = {};
  for (const [key, argument] of [['path', '--show-sdk-path'], ['version', '--show-sdk-version']]) {
    const probe = spawnSync('/usr/bin/xcrun', [argument], { encoding: 'utf8', shell: false,
      timeout: 10000, maxBuffer: 65536 });
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stderr, '');
    sdk[key] = probe.stdout.trim();
    assert.ok(sdk[key]);
  }
  assert.equal(process.env.SDKROOT, sdk.path, 'Native witness requires the fixed xcrun SDK selection');
  t.diagnostic(JSON.stringify({ kind: 'actual-local-mac-sdk', ...sdk }));
  t.diagnostic(JSON.stringify({ kind: 'actual-local-mac-native-addon', ...evidence }));
});

test('P05 local Mac persistence cells preserve all frozen witnesses and raw output', async t => {
  let evidence;
  try { evidence = await runLocalMacPersistenceCells(); }
  catch (error) {
    if (error.code === 'LOCAL_MAC_HOST_MISMATCH') {
      t.skip('Frozen Mac dogfood host required; no persistence acceptance');
      return;
    }
    if (error.observation) t.diagnostic(JSON.stringify({ kind: 'failed-required-cell', observation: error.observation, previousCells: error.previousCells }));
    throw error;
  }
  assert.equal(evidence.scope, 'mac-dogfood-persistence');
  assert.deepEqual(evidence.hostBefore, evidence.hostAfter);
  assert.equal(evidence.cells.length, requiredCells.length);
  evidence.cells.forEach((cell, index) => validateRequiredCellResult(requiredCells[index], cell));
  t.diagnostic(JSON.stringify({ kind: 'actual-local-mac-required-cells', ...evidence }));
});
