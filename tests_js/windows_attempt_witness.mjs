import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { acceptPipeClient, attemptPipePath, connectPipeBroker, readAttemptKey } from '../runtime/cli/attempt-pipe.js';
import { requestAttempt, runAttemptBroker } from '../runtime/cli/attempt-broker.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { requireWindowsPrivate, withWindowsStore } from '../runtime/store/windows-store.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { plain, read, readyPacket, write } from './workspace_native_claims_support.mjs';

// Windows attempt broker: authenticated named pipe, Store-private key, lock and PID.
const [mode, artifact, temporary] = process.argv.slice(2);
const root = join(temporary, 'attempt store');
const rejected = { ok: false, error: { code: 'request_rejected' } };
const now = () => '2026-09-10T12:00:00Z';
if (mode === '--broker') {
  // Detached broker process for the crash case; it holds the attempt until killed.
  await withWindowsStore(root, artifact, provider => runAttemptBroker(root,
    new ClaimsService(new NativeJobsRepository(root, provider), now), provider, { idleMilliseconds: 5000 }));
  process.exit(0);
}
const ask = value => requestAttempt(root, fromJSON(value)).then(plain);
async function eventually(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('condition not reached');
}
/** Raw pipe client: what does the broker send back, and does it keep the connection? */
function raw(path, bytes) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let output = Buffer.alloc(0);
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', chunk => { output = Buffer.concat([output, chunk]); });
    socket.on('close', () => resolve(output));
    socket.on('error', error => (error.code === 'EPIPE' || error.code === 'ECONNRESET' ? resolve(output) : reject(error)));
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('raw pipe client was not closed')); });
  });
}

await withWindowsStore(root, artifact, async provider => {
  await initializeJobsFixture(root);
  const repository = new NativeJobsRepository(root, provider);
  const jobs = new JobsService(repository, now), claims = new ClaimsService(repository, now);
  for (const id of ['job', 'other']) {
    await jobs.create(fromJSON({ id, url: `https://example.invalid/${id}`, role: 'Engineer', company: 'Synthetic', ats: 'greenhouse' }));
  }
  const profile = await read(root, 'profile.json'); profile.profile.name = 'PRIVATE-PROFILE';
  await write(root, 'profile.json', profile);
  const resume = plain(await new ResumeService(repository, now).import(
    fromJSON({ id: 'resume', label: 'Synthetic', default: true }), 'resume.txt', Buffer.from('PRIVATE-RESUME')));
  const document = await read(root, 'jobs.json'), run = { runId: 'run-fixture', status: 'active', revision: 1,
    selection: { resumeId: 'resume', contentRevision: resume.contentRevision, factRevision: 1, confirmedAt: now() },
    queueVersions: [{ revision: 1, jobIds: ['job', 'other'], updatedAt: now() }], createdAt: now(), updatedAt: now(), completedAt: null };
  document.metadata.applicationRuns = { activeRunId: run.runId, runs: { [run.runId]: run } };
  await write(root, 'jobs.json', document);

  // Without a running broker there is no key, so a client cannot address any pipe.
  await assert.rejects(requestAttempt(root, fromJSON({ command: 'heartbeat' })), /attempt unavailable/);

  await claims.select('job', 1n, true);
  const running = runAttemptBroker(root, claims, provider, { idleMilliseconds: 5000 });
  await eventually(async () => !!(await stat(join(root, '.job-apply-attempt.pid')).catch(() => null)));
  const key = await readAttemptKey(root), path = attemptPipePath(root, key);
  assert.equal(key.length, 32);
  for (const name of ['.job-apply-attempt.key', '.job-apply-attempt.lock', '.job-apply-attempt.pid']) {
    requireWindowsPrivate(join(root, name), false);
  }
  assert.match(await readFile(join(root, '.job-apply-attempt.pid'), 'utf8'), /^\d+\n$/);

  // A second broker cannot take the lock or rotate the key while the first one runs.
  await assert.rejects(runAttemptBroker(root, claims, provider), /attempt already running/);
  assert.deepEqual(await readAttemptKey(root), key);

  // Clients that cannot prove the key never reach the decoder or the Store.
  const frame = Buffer.from('{"command":"start","expectedRevision":2,"id":"job","owner":"owner"}\n');
  assert.equal((await raw(path, frame)).length, 64, 'an unauthenticated client only receives the challenge');
  const forged = await raw(path, Buffer.concat([randomBytes(32), randomBytes(32), frame]));
  assert.equal(forged.length, 64);
  assert.equal(plain(await claims.status()).claim, null);
  assert.equal((await read(root, 'jobs.json')).jobs.job.status, 'ready');

  const acquired = await ask({ command: 'start', id: 'job', owner: 'owner', expectedRevision: 2 });
  assert.equal(acquired.ok, true); assert.equal(acquired.event, 'acquired');
  assert.doesNotMatch(JSON.stringify(acquired), /token|PRIVATE-/);
  assert.equal((await ask({ command: 'heartbeat' })).event, 'heartbeat');

  // Framing on the pipe: one newline-terminated frame, no trailing bytes.
  for (const bytes of [Buffer.from('{}\n{}'), Buffer.from('[]\n'), Buffer.from([0xff, 10])]) {
    const socket = createConnection(path);
    const reply = await new Promise((resolve, reject) => {
      let output = Buffer.alloc(0);
      socket.once('connect', () => connectPipeBroker(socket, key).then(proven => {
        socket.on('data', chunk => { output = Buffer.concat([output, chunk]); });
        socket.write(Buffer.concat([proven, bytes])); socket.resume();
      }, reject));
      socket.once('close', () => resolve(output.toString('utf8')));
      socket.once('error', reject);
    });
    assert.deepEqual(JSON.parse(reply), rejected);
    assert.equal((await ask({ command: 'heartbeat' })).event, 'heartbeat');
  }

  const input = { status: 'active', pendingFields: [{ question: 'PRIVATE QUESTION', state: 'missing' }] };
  assert.equal((await ask({ command: 'progress', session: input })).event, 'progress_saved');
  const review = { status: 'review', pendingFields: [], readinessInput: readyPacket(3) };
  assert.equal((await ask({ command: 'handoff', status: 'awaiting_review', session: review })).event, 'handed_off');
  await running;
  assert.equal((await read(root, 'jobs.json')).jobs.job.status, 'awaiting_review');
  assert.equal(await stat(join(root, '.job-apply-attempt.pid')).catch(() => null), null);
  await assert.rejects(requestAttempt(root, fromJSON({ command: 'heartbeat' })), /attempt unavailable/);

  // Recovery: a killed broker leaves its PID and an old key. The next broker rotates the
  // key and starts, and the orphaned claim stays exactly as it was for an explicit reset.
  await claims.select('other', 1n, true);
  const crashed = spawn(process.execPath, [process.argv[1], '--broker', artifact, temporary], { stdio: 'ignore', windowsHide: true });
  await eventually(async () => !!(await stat(join(root, '.job-apply-attempt.pid')).catch(() => null)));
  const pid = Number((await readFile(join(root, '.job-apply-attempt.pid'), 'utf8')).trim());
  assert.equal(pid, crashed.pid);
  assert.equal((await ask({ command: 'start', id: 'other', owner: 'owner', expectedRevision: 2 })).event, 'acquired');
  const exited = new Promise(resolve => crashed.once('exit', resolve));
  crashed.kill('SIGKILL'); await exited;
  const stale = await readAttemptKey(root), before = await read(root, 'coordinator.json');
  await assert.rejects(requestAttempt(root, fromJSON({ command: 'heartbeat' })), /attempt unavailable/);
  const recovered = runAttemptBroker(root, claims, provider, { idleMilliseconds: 300 });
  await eventually(async () => !(await readAttemptKey(root)).equals(stale));
  assert.deepEqual(await ask({ command: 'start', id: 'other', owner: 'owner', expectedRevision: 2 }), rejected);
  await recovered;
  assert.deepEqual(await read(root, 'coordinator.json'), before);

  // The Store stays valid and private with the broker's runtime entries in it.
  await repository.transaction(async () => {});
  for (const name of await readdir(root)) requireWindowsPrivate(join(root, name));
});

// A pipe squatter without the key learns only the client's nonce, never a request.
const squatted = attemptPipePath(root, randomBytes(32)), received = [];
const squatter = createServer(socket => {
  socket.on('data', bytes => received.push(bytes));
  socket.on('error', () => {});
  socket.write(randomBytes(64));
});
await new Promise(resolve => squatter.listen(squatted, resolve));
const client = createConnection(squatted);
await new Promise(resolve => client.once('connect', resolve));
await assert.rejects(connectPipeBroker(client, randomBytes(32)), /attempt broker rejected/);
client.destroy();
await new Promise(resolve => squatter.close(resolve));
assert.equal(Buffer.concat(received).length, 32);

// The broker side rejects a proof made with another key.
const pair = attemptPipePath(root, randomBytes(32)), brokerKey = randomBytes(32);
let accepted;
const broker = createServer(socket => { accepted = acceptPipeClient(socket, brokerKey); accepted.catch(() => socket.destroy()); });
await new Promise(resolve => broker.listen(pair, resolve));
const wrong = createConnection(pair);
await new Promise(resolve => wrong.once('connect', resolve));
await assert.rejects(connectPipeBroker(wrong, randomBytes(32)), /attempt broker rejected/);
wrong.destroy();
await assert.rejects(accepted, /handshake incomplete|client rejected/);
await new Promise(resolve => broker.close(resolve));
await writeFile(join(temporary, 'done'), 'ok');
