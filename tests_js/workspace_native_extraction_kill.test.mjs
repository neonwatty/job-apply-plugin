import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { child, nativeFixture } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { ExtractionService } from '../runtime/workspace-core/extraction.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const moduleUrl = path => new URL(`../runtime/${path}.js`, import.meta.url).href;
const imports = `
import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { NativeJobsRepository } from ${JSON.stringify(moduleUrl('store/native-jobs'))};
import { loadPosixFlockProvider } from ${JSON.stringify(moduleUrl('store/posix-flock'))};
import { atomicWritePointJson } from ${JSON.stringify(moduleUrl('store/point-persistence'))};
import { ExtractionService } from ${JSON.stringify(moduleUrl('workspace-core/extraction'))};
import { fromJSON, get, serialize } from ${JSON.stringify(moduleUrl('contracts/workspace/values'))};
const [root, addon, boundary] = process.argv.slice(1);
`;
const writerScript = imports + `
let intended;
const repository = new NativeJobsRepository(root, loadPosixFlockProvider(addon), async (path, document, options) => {
  const name = basename(path);
  if (name === 'resume-extraction-journal.json' && get(document, 'operation') !== null) {
    intended = JSON.parse(serialize(get(document, 'operation')));
  }
  await atomicWritePointJson(path, document, options);
  const checkpoint = name === 'resume-extraction-journal.json'
    ? get(document, 'operation') === null ? 'clear' : 'journal' : name;
  if (checkpoint === boundary) {
    console.log(JSON.stringify({ intended }));
    console.log('durable-boundary');
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
});
await new ExtractionService(repository, () => '2026-09-09T12:00:00Z', kind => kind + '-completed')
  .completeRequest('request-pending', fromJSON({ name: 'Synthetic applicant', location: 'Remote' }), 1n, 1n);
throw Error('Writer unexpectedly passed its kill boundary');
`;
const recoveryScript = imports + `
const repository = new NativeJobsRepository(root, loadPosixFlockProvider(addon));
await repository.transaction(async () => {});
const documents = {};
for (const name of ['profile', 'resume-extractions', 'resume-extraction-requests', 'resume-extraction-journal']) {
  documents[name] = JSON.parse(await readFile(join(root, name + '.json'), 'utf8'));
}
console.log(JSON.stringify(documents));
`;

test('SIGKILL at each durable completion boundary recovers one coherent extraction transaction', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  try {
    const directory = await realpath(fixture.root);
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    const boundaries = ['journal', 'profile.json', 'resume-extractions.json', 'resume-extraction-requests.json', 'clear'];
    for (const boundary of boundaries) {
      await t.test(boundary, async () => {
        const root = join(directory, boundary);
        await initializeJobsFixture(root);
        const repository = new NativeJobsRepository(root, provider);
        await new ResumeService(repository).import(fromJSON({ id: 'source', label: 'Synthetic source' }), 'source.txt', Buffer.from('Synthetic applicant'));
        await new ExtractionService(repository, () => '2026-09-09T12:00:00Z', () => 'request-pending').createRequest('source', 1n);
        const writer = child(writerScript, [root, fixture.receipt.artifact, boundary]);
        let intended;
        try {
          await writer.line('durable-boundary');
          intended = JSON.parse(writer.lines.find(line => line.startsWith('{'))).intended;
          assert.equal(intended.kind, 'request-complete');
          assert.equal(writer.process.kill('SIGKILL'), true);
          assert.deepEqual(await writer.exited, { code: null, signal: 'SIGKILL' });
        } finally { await writer.stop(); }
        const restarted = child(recoveryScript, [root, fixture.receipt.artifact]);
        let recovered;
        try {
          await restarted.success();
          recovered = JSON.parse(restarted.lines.find(line => line.startsWith('{')));
        } finally { await restarted.stop(); }
        assert.deepEqual(recovered.profile, intended.profileDocument);
        assert.deepEqual(recovered['resume-extractions'], intended.proposalsDocument);
        assert.deepEqual(recovered['resume-extraction-requests'], intended.requestsDocument);
        assert.deepEqual(recovered['resume-extraction-journal'], { schemaVersion: 1, operation: null });
        assert.deepEqual(recovered.profile.profile, { name: 'Synthetic applicant', location: 'Remote' });
        assert.equal(recovered.profile.metadata.revision, 2);
        for (const path of ['/name', '/location']) {
          assert.deepEqual(recovered.profile.metadata.factProvenance[path], { source: 'resume', updatedAt: '2026-09-09T12:00:00Z' });
        }
        const request = recovered['resume-extraction-requests'].requests['request-pending'];
        assert.equal(request.status, 'completed');
        assert.equal(request.revision, 2);
        const proposal = recovered['resume-extractions'].proposals[request.proposalId];
        assert.equal(proposal.status, 'completed');
        assert.equal(proposal.resultProfileRevision, recovered.profile.metadata.revision);
        assert.equal(proposal.resumeContentRevision, request.resumeContentRevision);
        // A second restart is idempotent and does not advance profile/request revisions.
        await new NativeJobsRepository(root, provider).transaction(async () => {});
        for (const [name, document] of Object.entries(recovered)) {
          assert.deepEqual(JSON.parse(await readFile(join(root, `${name}.json`), 'utf8')), document);
        }
      });
    }
  } finally { await fixture.cleanup(); }
});
