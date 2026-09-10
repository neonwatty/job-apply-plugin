import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { child, nativeFixture } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { fromJSON, get, object, set, text } from '../runtime/contracts/workspace/values.js';

const fixed = '2026-09-09T12:00:00Z';
const reference = `pending_${'a'.repeat(32)}`;
const names = ['jobs.json', 'answers.json', 'sessions/job.json', 'coordinator.json', 'coordinator-journal.json'];
const options = { pathProfile: '3.12', intMaxStrDigits: 4300 };
const moduleUrl = path => new URL(`../runtime/${path}.js`, import.meta.url).href;
const imports = `
import { relative, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { NativeJobsRepository } from ${JSON.stringify(moduleUrl('store/native-jobs'))};
import { loadPosixFlockProvider } from ${JSON.stringify(moduleUrl('store/posix-flock'))};
import { atomicWritePointJson } from ${JSON.stringify(moduleUrl('store/point-persistence'))};
import { prepareAnswerResolution, sessionRevision } from ${JSON.stringify(moduleUrl('contracts/workspace/answer-resolution'))};
import { get, serialize } from ${JSON.stringify(moduleUrl('contracts/workspace/values'))};
const [root, addon, boundary] = process.argv.slice(1);
`;
const writerScript = imports + `
let intended;
const repository = new NativeJobsRepository(root, loadPosixFlockProvider(addon), async (path, document, options) => {
  const name = relative(root, path);
  if (name === 'coordinator-journal.json' && get(document, 'operation') !== null) {
    intended = JSON.parse(serialize(get(document, 'operation')));
  }
  await atomicWritePointJson(path, document, options);
  const checkpoint = name === 'coordinator-journal.json'
    ? get(document, 'operation') === null ? 'clear' : 'journal' : name;
  if (checkpoint === boundary) {
    console.log(JSON.stringify({ intended }));
    console.log('durable-boundary');
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
});
await repository.pendingAnswerTransaction(async transaction => {
  const session = transaction.sessions[0];
  const prepared = prepareAnswerResolution(transaction.jobs, transaction.answers, session, {
    jobId: 'job', reference: ${JSON.stringify(reference)}, expectedJobRevision: 1n,
    expectedSessionRevision: sessionRevision(session), expectedAnswerRevision: 1n,
    ownerConfirmed: true, at: ${JSON.stringify(fixed)}, operationId: 'resolution-operation',
  }, true);
  await transaction.commit(prepared.operation);
});
throw Error('Writer unexpectedly passed its kill boundary');
`;
const recoveryScript = imports + `
const repository = new NativeJobsRepository(root, loadPosixFlockProvider(addon));
await repository.transaction(async () => {});
const bytes = {};
for (const name of ${JSON.stringify(names)}) bytes[name] = await readFile(join(root, name), 'utf8');
console.log(JSON.stringify(bytes));
`;

async function seed(root, provider) {
  await initializeJobsFixture(root);
  const repository = new NativeJobsRepository(root, provider);
  await new JobsService(repository, () => fixed).create(fromJSON({ id: 'job', url: 'https://example.invalid/job' }));
  await repository.transaction(async ({ document, save }) => {
    set(object(get(object(get(document, 'jobs'), 'jobs'), 'job'), 'job'), 'status', text('needs_info'));
    await save(document);
  });
  await new AnswersService(repository, () => fixed).put(fromJSON({ key: 'answer', question: 'Preferred city?', state: 'confirmed', value: 'private-city' }));
  const session = { schemaVersion: 1, applicationId: 'job', status: 'active', answerKeys: [],
    pendingFields: [{ reference, answerKey: 'answer', question: 'Preferred city?', state: 'missing' }],
    blockers: [{ type: 'information', code: 'answer-required', reference }], createdAt: fixed, updatedAt: fixed };
  await atomicWritePointJson(join(root, 'sessions/job.json'), fromJSON(session), options);
}
async function killAt(root, addon, boundary) {
  const writer = child(writerScript, [root, addon, boundary]);
  try {
    await writer.line('durable-boundary');
    const intended = JSON.parse(writer.lines.find(line => line.startsWith('{'))).intended;
    assert.equal(writer.process.kill('SIGKILL'), true);
    assert.deepEqual(await writer.exited, { code: null, signal: 'SIGKILL' });
    return intended;
  } finally { await writer.stop(); }
}
async function bytes(root) {
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(join(root, name), 'utf8')])));
}

test('SIGKILL at every durable pending resolution boundary recovers once on fresh ordinary access', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  try {
    const directory = await realpath(fixture.root), provider = loadPosixFlockProvider(fixture.receipt.artifact);
    for (const boundary of ['journal', 'jobs.json', 'sessions/job.json', 'coordinator.json', 'clear']) {
      await t.test(boundary, async () => {
        const root = join(directory, boundary.replaceAll('/', '-'));
        await seed(root, provider);
        const answerBytes = await readFile(join(root, 'answers.json'), 'utf8');
        const intended = await killAt(root, fixture.receipt.artifact, boundary);
        assert.equal(intended.kind, 'answer_resolution');
        assert.equal(intended.at, fixed);
        const restarted = child(recoveryScript, [root, fixture.receipt.artifact]);
        let recovered;
        try {
          await restarted.success();
          recovered = JSON.parse(restarted.lines.find(line => line.startsWith('{')));
        } finally { await restarted.stop(); }
        const jobs = JSON.parse(recovered['jobs.json']);
        assert.equal(jobs.jobs.job.revision, 2);
        assert.equal(jobs.jobs.job.status, 'ready');
        assert.equal(jobs.jobs.job.updatedAt, intended.at);
        const session = JSON.parse(recovered['sessions/job.json']);
        assert.deepEqual(session, intended.session);
        assert.deepEqual(session.pendingFields, []);
        assert.deepEqual(session.blockers, []);
        assert.deepEqual(session.answerKeys, ['answer']);
        assert.equal(recovered['answers.json'], answerBytes, 'resolution does not rewrite reusable answer values');
        assert.deepEqual(JSON.parse(recovered['coordinator.json']), { schemaVersion: 1, claim: null });
        assert.deepEqual(JSON.parse(recovered['coordinator-journal.json']), { schemaVersion: 1, operation: null });
        await new NativeJobsRepository(root, provider).transaction(async () => {});
        assert.deepEqual(await bytes(root), recovered, `${boundary}: replay is byte-idempotent`);
      });
    }
  } finally { await fixture.cleanup(); }
});

test('recovery rejects either mismatching destination before writing any canonical document', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  try {
    const directory = await realpath(fixture.root), provider = loadPosixFlockProvider(fixture.receipt.artifact);
    for (const destination of ['jobs.json', 'sessions/job.json']) {
      await t.test(destination, async () => {
        const root = join(directory, destination.replaceAll('/', '-'));
        await seed(root, provider);
        await killAt(root, fixture.receipt.artifact, 'journal');
        const document = JSON.parse(await readFile(join(root, destination), 'utf8'));
        if (destination === 'jobs.json') document.jobs.job.revision = 99;
        else document.updatedAt = '2026-09-10T00:00:00Z';
        await atomicWritePointJson(join(root, destination), fromJSON(document), options);
        const before = await bytes(root), writes = [];
        const repository = new NativeJobsRepository(root, provider, async (path, value, configuration) => {
          writes.push(path);
          await atomicWritePointJson(path, value, configuration);
        });
        await assert.rejects(repository.transaction(async () => {}), /cannot be reconciled/);
        assert.deepEqual(writes, []);
        assert.deepEqual(await bytes(root), before);
      });
    }
  } finally { await fixture.cleanup(); }
});
