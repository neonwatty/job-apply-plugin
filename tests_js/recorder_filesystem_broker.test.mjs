import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { BrokerClient } from '../qa/recorder/broker-client.mjs';
import { buildBrokerDirectory, loadBrokerDirectory } from '../qa/recorder/broker-build.mjs';
import { boundedLines, responseFor } from '../qa/recorder/broker-protocol.mjs';
import { SessionBroker } from '../qa/recorder/broker-session.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'recorder-broker-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parent = join(directory, '.qa-private');
  await mkdir(parent, { mode: 0o700 });
  return { directory, parent, session: join(parent, 'qa-session-synthetic') };
}

async function native(t) {
  const addon = await buildBrokerDirectory();
  t.after(addon.cleanup);
  return loadBrokerDirectory(addon.artifact);
}

test('recorder broker serializes durable private writes and hashes only completed checkpoints', async t => {
  const { session } = await workspace(t);
  const broker = await BrokerClient.start(session);
  t.after(() => broker.close());
  const checkpoint = 'checkpoints/0001-review-reached';
  await broker.request('mkdir', { path: 'checkpoints' });
  await broker.request('mkdir', { path: 'checkpoints/.tmp-synthetic' });
  await broker.write('write-exclusive', 'events.jsonl', 'first');
  await broker.write('append', 'events.jsonl', ' second');
  await broker.write('atomic-replace', 'recording-summary.json', '{}');
  await broker.write('atomic-replace', 'recording-summary.json', '{"updated":true}');
  const files = ['checkpoint.json', 'controls.json', 'page.html', 'page.png'];
  for (const name of files) await broker.write('write-exclusive', 'checkpoints/.tmp-synthetic/' + name, 'synthetic ' + name);
  assert.deepEqual(Object.keys(await broker.request('hash-source-files')), ['events.jsonl', 'recording-summary.json']);
  await broker.request('rename-no-replace', { source: 'checkpoints/.tmp-synthetic', destination: checkpoint });
  await broker.request('mkdir', { path: 'checkpoints/.tmp-second' });
  await assert.rejects(broker.request('rename-no-replace', { source: 'checkpoints/.tmp-second', destination: checkpoint }), /filesystem operation rejected/);
  assert.deepEqual(await broker.request('list', { path: checkpoint }), files);
  const hashes = await broker.request('hash-source-files');
  assert.deepEqual(Object.keys(hashes), ['events.jsonl', 'recording-summary.json', ...files.map(name => checkpoint + '/' + name)]);
  for (const [relative, sha256] of Object.entries(hashes)) {
    const file = join(session, relative);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), sha256);
  }
  assert.equal((await stat(session)).mode & 0o777, 0o700);
  assert.equal((await stat(join(session, checkpoint))).mode & 0o777, 0o700);
  assert.equal(await readFile(join(session, 'events.jsonl'), 'utf8'), 'first second');
  assert.equal(await readFile(join(session, 'recording-summary.json'), 'utf8'), '{"updated":true}');
  assert.equal((await broker.request('stat-budget')).entries, 9);
  await broker.request('remove-tree', { path: 'checkpoints' });
  await broker.request('remove-tree', { path: 'checkpoints' });
  assert.deepEqual(await broker.request('list', { path: '' }), ['events.jsonl', 'recording-summary.json']);
});

test('recorder broker holds the original private directory and refuses unsafe entries', async t => {
  const { directory, parent, session } = await workspace(t);
  const addon = await native(t);
  await chmod(parent, 0o755);
  assert.throws(() => new SessionBroker(session, addon), /unsafe-root/);
  await assert.rejects(access(session), { code: 'ENOENT' });
  await chmod(parent, 0o700);
  const broker = new SessionBroker(session, addon);
  t.after(() => broker.close());
  await chmod(parent, 0o755);
  assert.throws(() => broker.list(), /root-changed/);
  await chmod(parent, 0o700);

  const original = join(parent, 'moved');
  const unrelated = join(directory, 'unrelated');
  await mkdir(unrelated, { mode: 0o700 });
  await rename(session, original);
  await symlink(unrelated, session, 'dir');
  broker.writeExclusive('events.jsonl', Buffer.from('synthetic'));
  assert.equal(await readFile(join(original, 'events.jsonl'), 'utf8'), 'synthetic');
  await assert.rejects(access(join(unrelated, 'events.jsonl')), { code: 'ENOENT' });

  await symlink(unrelated, join(original, 'escape'), 'dir');
  assert.throws(() => broker.mkdir('escape/child'), /unsafe-path/);
  assert.throws(() => broker.removeTree('escape'), /unsafe-path/);
  assert.throws(() => broker.hashSourceFiles(), /unsafe-path/);
  for (const path of ['/absolute', 'double//slash', '../up', 'invalid\\separator', 'line\nbreak']) {
    assert.throws(() => broker.mkdir(path), /unsafe-path/);
  }
  await assert.rejects(access(join(unrelated, 'child')), { code: 'ENOENT' });
  broker.close();
  assert.throws(() => broker.list(), /broker-closed/);
});

test('recorder broker rejects file and session budgets without creating new entries', async t => {
  const { session } = await workspace(t);
  const broker = new SessionBroker(session, await native(t));
  t.after(() => broker.close());
  assert.throws(() => broker.writeExclusive('too-large', Buffer.alloc(8 * 1024 * 1024 + 1)), /file-budget/);
  assert.deepEqual(broker.list(), []);
  const sparse = join(session, 'sparse');
  await writeFile(sparse, '', { mode: 0o600 });
  await truncate(sparse, 64 * 1024 * 1024);
  assert.throws(() => broker.writeExclusive('over-budget', Buffer.from('x')), /session-budget/);
  assert.deepEqual(broker.list(), ['sparse']);
  assert.equal(broker.budget().bytes, 64 * 1024 * 1024);
});

test('broker protocol rejects excess bytes and closed-schema violations with value-free diagnostics', async () => {
  const chunks = [Buffer.from('too-'), Buffer.from('long-request\nva'), Buffer.from('lid\npartial')];
  const lines = [];
  for await (const line of boundedLines(chunks, 7)) lines.push(line?.toString() ?? null);
  assert.deepEqual(lines, [null, 'valid', 'partial']);
  const rejected = [
    [null, null, 'request-budget'],
    [Buffer.from([255]), null, 'invalid-request'],
    [Buffer.from('{"id":3,"command":["list"],"path":""}'), 3, 'invalid-request'],
    [Buffer.from('{"id":1,"command":"list","path":"","private":"SYNTHETIC VALUE"}'), 1, 'invalid-request'],
    [Buffer.from('{"id":2,"command":"write-exclusive","path":"control.json","data":"!SYNTHETIC VALUE!"}'), 2, 'invalid-data'],
  ];
  const broker = { list: () => { throw Error('Unexpected list'); } };
  for (const [body, id, code] of rejected) assert.deepEqual(responseFor(broker, body), { id, ok: false, code });
});

test('recorder removes control state on EOF, terminal signals, and broker or guardian loss', { timeout: 25_000 }, async t => {
  for (const signal of [null, 'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'guardian loss']) await t.test(signal ?? 'EOF', async t => {
    const { session } = await workspace(t);
    const child = spawn(process.execPath, ['qa/recorder/broker-server.mjs', '--root', session], {
      cwd: new URL('../', import.meta.url), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { stderr += text; });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    });
    assert.deepEqual(JSON.parse((await lines.next()).value), { ready: true });
    const control = join(session, 'control.json');
    child.stdin.write(JSON.stringify({ id: 1, command: 'write-exclusive', path: 'control.json', data: 'c3ludGhldGlj' }) + '\n');
    assert.deepEqual(JSON.parse((await lines.next()).value), { id: 1, ok: true, result: null });
    assert.equal(await readFile(control, 'utf8'), 'synthetic');
    if (signal === 'guardian loss') {
      const processes = execFileSync('ps', ['-e', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' });
      const descendants = processes.trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
      const guardians = descendants.filter(([, parent]) => parent === child.pid);
      assert.equal(guardians.length, 1);
      process.kill(guardians[0][0], 'SIGKILL');
      child.stdin.end();
    } else if (signal) process.kill(-child.pid, signal);
    else child.stdin.end();
    const expectedExit = signal === 'guardian loss' ? 1 : 0;
    assert.deepEqual(await closed, signal === 'SIGKILL' ? [null, signal] : [expectedExit, null]);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await access(control); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      await pause(20);
    }
    await assert.rejects(access(control), { code: 'ENOENT' });
    assert.equal(stderr, expectedExit ? 'filesystem broker failed\n' : '');
  });
});
