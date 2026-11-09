import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { child, nativeFixture } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';

const fixed = '2026-09-09T12:00:00Z';
const names = ['answers.json', 'sessions/job.json', 'coordinator.json', 'coordinator-journal.json'];
const moduleUrl = path => new URL(`../runtime/${path}.js`, import.meta.url).href;
const imports = `
import { relative, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { NativeJobsRepository } from ${JSON.stringify(moduleUrl('store/native-jobs'))};
import { loadPosixFlockProvider } from ${JSON.stringify(moduleUrl('store/posix-flock'))};
import { atomicWritePointJson } from ${JSON.stringify(moduleUrl('store/point-persistence'))};
import { AnswerMergeService } from ${JSON.stringify(moduleUrl('workspace-core/answer-merges'))};
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
await new AnswerMergeService(repository, () => ${JSON.stringify(fixed)}).merge('winner', 'source', 1n, 1n);
throw Error('Writer unexpectedly passed its kill boundary');
`;
const recoveryScript = imports + `
const repository = new NativeJobsRepository(root, loadPosixFlockProvider(addon));
await repository.transaction(async () => {});
const bytes = {};
for (const name of ${JSON.stringify(names)}) bytes[name] = await readFile(join(root, name), 'utf8');
console.log(JSON.stringify(bytes));
`;

test('SIGKILL at every durable answer merge boundary recovers once before ordinary Jobs access', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  try {
    const directory = await realpath(fixture.root);
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    for (const boundary of ['journal', 'answers.json', 'sessions/job.json', 'coordinator.json', 'clear']) {
      await t.test(boundary, async () => {
        const root = join(directory, boundary.replaceAll('/', '-'));
        await initializeJobsFixture(root);
        const service = new AnswersService(new NativeJobsRepository(root, provider), () => '2026-09-08T00:00:00Z');
        await service.put(fromJSON({ key: 'winner', question: 'Favorite editor?', state: 'confirmed', value: 'winner-private' }));
        await service.put(fromJSON({ key: 'source', question: 'Preferred editor?', state: 'confirmed', value: 'source-private' }));
        const session = { schemaVersion: 1, applicationId: 'job', status: 'active', answerKeys: ['source'], pendingFields: [],
          approvals: [{ reference: `pending_${'a'.repeat(32)}`, answerKey: 'source', currentUse: true, remember: false,
            policyMode: 'strict', useAuthority: 'per_use', eligible: true, confidenceBand: 'exact',
            reasonCodes: ['reuse_eligible'], answerRevision: 1 }],
          createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z' };
        await atomicWritePointJson(join(root, 'sessions/job.json'), fromJSON(session), { pathProfile: '3.12', intMaxStrDigits: 4300 });
        const writer = child(writerScript, [root, fixture.receipt.artifact, boundary]);
        let intended;
        try {
          await writer.line('durable-boundary');
          intended = JSON.parse(writer.lines.find(line => line.startsWith('{'))).intended;
          assert.equal(intended.kind, 'answer_merge');
          assert.equal(intended.at, fixed);
          assert.equal(writer.process.kill('SIGKILL'), true);
          assert.deepEqual(await writer.exited, { code: null, signal: 'SIGKILL' });
        } finally { await writer.stop(); }
        const restarted = child(recoveryScript, [root, fixture.receipt.artifact]);
        let bytes;
        try {
          await restarted.success();
          bytes = JSON.parse(restarted.lines.find(line => line.startsWith('{')));
        } finally { await restarted.stop(); }
        const answers = JSON.parse(bytes['answers.json']);
        assert.equal(answers.answers.winner.revision, 2);
        assert.equal(answers.answers.winner.value, 'winner-private');
        assert.equal(answers.answers.winner.updatedAt, intended.at);
        assert.equal(answers.metadata.updatedAt, intended.at);
        assert.ok(!Object.hasOwn(answers.answers, 'source'));
        assert.deepEqual(answers.redirects.source, { targetKey: 'winner', mergedAt: intended.at });
        const recoveredSession = JSON.parse(bytes['sessions/job.json']);
        assert.deepEqual(recoveredSession, intended.sessions[0]);
        assert.deepEqual(recoveredSession.answerKeys, ['winner']);
        assert.deepEqual(recoveredSession.approvals, []);
        assert.equal(recoveredSession.updatedAt, intended.at);
        assert.deepEqual(JSON.parse(bytes['coordinator.json']), { schemaVersion: 1, claim: null });
        assert.deepEqual(JSON.parse(bytes['coordinator-journal.json']), { schemaVersion: 1, operation: null });
        await new NativeJobsRepository(root, provider).transaction(async () => {});
        for (const name of names) assert.equal(await readFile(join(root, name), 'utf8'), bytes[name], `${boundary}: second replay changed ${name}`);
      });
    }
  } finally { await fixture.cleanup(); }
});
