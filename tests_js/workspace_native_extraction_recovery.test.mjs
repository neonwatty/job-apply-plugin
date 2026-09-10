import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { NativeJobsRepository, initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { NativeExtractionJournal } from '../runtime/store/native-extraction-journal.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { fromJSON, get, object, serialize, set, text } from '../runtime/contracts/workspace/values.js';

const plain = value => JSON.parse(serialize(value));
const now = '2026-09-09T12:00:00Z';
const requestDocument = contentRevision => fromJSON({ schemaVersion: 1, requests: {
  'request-one': { requestId: 'request-one', resumeId: 'resume-one', resumeContentRevision: contentRevision,
    revision: 1, status: 'requested', createdAt: now, updatedAt: now, closedAt: null,
    proposalId: null, failureReason: null, supersedesRequestId: null }
}, metadata: { createdAt: now, updatedAt: now } });
const json = async (root, name) => JSON.parse(await readFile(join(root, `${name}.json`), 'utf8'));

async function seeded(base, provider, name) {
  const root = join(base, name);
  await initializeJobsFixture(root);
  const repository = new NativeJobsRepository(root, provider);
  const resumes = new ResumeService(repository, () => now, () => 'resume-one', () => `content_${'a'.repeat(32)}`);
  const resume = plain(await resumes.import(fromJSON({ id: 'resume-one', label: 'Fixture' }), 'resume.txt', Buffer.from('old bytes')));
  await repository.extractionTransaction(tx => tx.commit('request-create', { requests: requestDocument(resume.contentRevision) }));
  return { root, repository, resumes };
}

test('extraction journals validate the whole transaction and roll forward every write interruption', async () => {
  const proposals = fromJSON({ schemaVersion: 1, proposals: {}, metadata: { createdAt: now, updatedAt: now } });
  const profile = fromJSON({ schemaVersion: 1, profile: { fixture: 'recovered' }, metadata: { revision: 2, createdAt: now, updatedAt: now, factProvenance: {} } });
  const resumes = fromJSON({ schemaVersion: 1, resumes: {}, metadata: { updatedAt: now } });
  const requests = fromJSON({ schemaVersion: 1, requests: {}, metadata: { createdAt: now, updatedAt: now } });
  for (let failAt = 1; failAt <= 6; failAt++) {
    const disk = new Map([['resume-extraction-journal', fromJSON({ schemaVersion: 1, operation: null })]]);
    let count = 0;
    const journal = new NativeExtractionJournal(async () => disk.get('resume-extraction-journal'), async (name, document) => {
      disk.set(name, fromJSON(plain(document)));
      if (++count === failAt) throw Error('crash after durable write');
    });
    await assert.rejects(journal.commit('request-complete', { profile, proposals, requests, resumes }), /crash/);
    const recovery = new NativeExtractionJournal(async () => disk.get('resume-extraction-journal'), async (name, document) => { disk.set(name, document); });
    await recovery.recover();
    assert.deepEqual(plain(disk.get('profile')), plain(profile));
    assert.deepEqual(plain(disk.get('resume-extraction-requests')), plain(requests));
    assert.deepEqual(plain(disk.get('resumes')), plain(resumes));
    assert.equal(plain(disk.get('resume-extraction-journal')).operation, null);
    await recovery.recover();
  }
  const malformed = fromJSON({ schemaVersion: 1, operation: { kind: 'request-complete', operationId: 'extraction-one',
    profileDocument: plain(profile), proposalsDocument: null, requestsDocument: { invalid: true }, resumesDocument: null } });
  let writes = 0;
  await assert.rejects(new NativeExtractionJournal(async () => malformed, async () => { writes++; }).recover());
  assert.equal(writes, 0, 'valid earlier destination must not be written before later invalid destination is checked');
  const legacy = fromJSON({ schemaVersion: 1, operation: { kind: 'review', operationId: 'extraction-legacy',
    profileDocument: plain(profile), proposalsDocument: plain(proposals) } });
  const replayed = [];
  await new NativeExtractionJournal(async () => legacy, async name => { replayed.push(name); }).recover();
  assert.deepEqual(replayed, ['profile', 'resume-extractions', 'resume-extraction-journal']);
  const invalidCases = [
    { schemaVersion: 1, operation: null, extra: true },
    { schemaVersion: 1, operation: { ...plain(legacy).operation, kind: 'request-create' } },
    { schemaVersion: 1, operation: { ...plain(legacy).operation, operationId: '../escape' } },
    { schemaVersion: 1, operation: { ...plain(legacy).operation, requestsDocument: null } },
  ];
  for (const value of invalidCases) {
    await assert.rejects(new NativeExtractionJournal(async () => fromJSON(value), async () => { writes++; }).recover());
  }
  assert.equal(writes, 0);

});

test('resume replacement and extraction closure recover together under the shared Store lock', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  try {
    const base = await realpath(fixture.root);
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    for (const target of ['resume-extraction-journal.json', 'resume-extraction-requests.json', 'resumes.json']) {
      await t.test(`recover replacement interrupted at ${target}`, async () => {
        const { root } = await seeded(base, provider, target.replaceAll('.', '-'));
        let failed = false;
        const failing = new NativeJobsRepository(root, provider, async (file, ...args) => {
          await atomicWritePointJson(file, ...args);
          if (!failed && basename(file) === target) { failed = true; throw Error('injected crash'); }
        });
        const service = new ResumeService(failing, () => now, () => 'unused', () => `content_${'b'.repeat(32)}`);
        await assert.rejects(service.replace('resume-one', 'next.txt', Buffer.from('new bytes'), 1n), /injected crash/);
        const restarted = new NativeJobsRepository(root, provider);
        // A Jobs read must recover extraction and resume file journals too.
        await restarted.transaction(async () => {});
        const request = (await json(root, 'resume-extraction-requests')).requests['request-one'];
        assert.equal(request.status, 'stale');
        assert.equal(request.revision, 2);
        assert.equal((await json(root, 'resumes')).resumes['resume-one'].contentRevision, `content_${'b'.repeat(32)}`);
        assert.equal(await readFile(join(root, 'resume-files/resume-one.txt'), 'utf8'), 'new bytes');
        assert.equal((await json(root, 'resume-extraction-journal')).operation, null);
        assert.equal((await json(root, 'resume-operation')).operation, null);
        await restarted.transaction(async () => {});
        assert.equal((await json(root, 'resume-extraction-requests')).requests['request-one'].revision, 2);
      });
    }
    await t.test('metadata changes retain requests and trash cancels them', async () => {
      const { root, repository, resumes } = await seeded(base, provider, 'metadata');
      await resumes.update('resume-one', fromJSON({ label: 'Renamed' }), 1n);
      assert.equal((await json(root, 'resume-extraction-requests')).requests['request-one'].status, 'requested');
      await repository.resumeTransaction(async tx => {
        const resume = object(get(object(get(tx.document, 'resumes'), 'resumes'), 'resume-one'), 'resume');
        set(resume, 'deletedAt', text(now));
        await tx.save(tx.document);
      });
      assert.equal((await json(root, 'resume-extraction-requests')).requests['request-one'].status, 'cancelled');
    });
    await t.test('malformed extraction journal blocks every read before resume recovery side effects', async () => {
      const { root, repository } = await seeded(base, provider, 'invalid');
      const bytes = await readFile(join(root, 'resumes.json'));
      const malformed = JSON.stringify({ schemaVersion: 1, operation: { kind: 'request-complete', operationId: 'extraction-one',
        profileDocument: null, proposalsDocument: null, requestsDocument: { invalid: true }, resumesDocument: null } });
      await writeFile(join(root, 'resume-extraction-journal.json'), malformed);
      const staged = join(root, 'resume-files/.native-11111111-1111-1111-1111-111111111111.tmp');
      await writeFile(staged, 'untouched staging', { mode: 0o600 });
      for (const call of [() => repository.transaction(async () => {}), () => repository.resumeTransaction(async () => {}),
        () => repository.profileTransaction(async () => {}), () => repository.groupsTransaction(async () => {}),
        () => repository.answerTransaction(async () => {}), () => repository.extractionTransaction(async () => {})]) {
        await assert.rejects(call());
      }
      assert.deepEqual(await readFile(join(root, 'resumes.json')), bytes);
      assert.equal(await readFile(staged, 'utf8'), 'untouched staging');
      assert.equal(await readFile(join(root, 'resume-extraction-journal.json'), 'utf8'), malformed);
    });
    await t.test('transactions serialize detached profile updates', async () => {
      const { repository } = await seeded(base, provider, 'concurrent');
      await Promise.all(Array.from({ length: 5 }, (_, index) => repository.extractionTransaction(async tx => {
        set(object(get(tx.profile, 'profile'), 'profile'), `writer${index}`, text('saved'));
        await tx.commit('review', { profile: tx.profile });
      })));
      await repository.extractionTransaction(async tx => assert.equal(object(get(tx.profile, 'profile'), 'profile').size, 5));
    });
  } finally { await fixture.cleanup(); }
});
