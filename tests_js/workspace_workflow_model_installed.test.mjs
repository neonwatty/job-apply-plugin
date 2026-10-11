import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInstalledModelFixture, gradeInstalledModelFixture, immutableInputsDigest } from '../evals/workflows/model-fixture.mjs';
import { runModelEvaluation } from '../evals/workflows/model-runner.mjs';

const turn = (name, args, id, message) => ({ completed: true, rawTrace: 'recorded transport fixture',
  text: JSON.stringify({ message, action: name ? { name, argumentsJson: JSON.stringify(args), id } : null }) });

test('installed evaluation detects managed byte changes and deletions with unchanged metadata', () => {
  const before = { 'profile.json': 'same profile', 'resumes.json': 'same metadata',
    'resume-files/source.pdf': 'original PDF bytes', 'jobs.json': 'before' };
  assert.notEqual(immutableInputsDigest(before), immutableInputsDigest({
    ...before, 'resume-files/source.pdf': 'changed PDF bytes',
  }));
  const deleted = { ...before };
  delete deleted['resume-files/source.pdf'];
  assert.notEqual(immutableInputsDigest(before), immutableInputsDigest(deleted));
  assert.equal(immutableInputsDigest(before), immutableInputsDigest({ ...before, 'jobs.json': 'after' }));
});

test('recorded controller uses installed protected workflow and grades actual upload/replay/handoff evidence', {
  skip: !['darwin', 'linux'].includes(process.platform), timeout: 90000,
}, async () => {
  const fixture = await createInstalledModelFixture();
  const output = await mkdtemp(join(tmpdir(), 'installed-model-report-'));
  try {
    // The recorded transport has only the same request text and replies a future model would receive.
    let step = 0, mutation;
    const transport = { kind: 'recorded_transport', async next({ messages }) {
      const request = messages[0].content;
      const binding = JSON.parse(request.match(/Current binding: (\{[^\n]+?\})\./)[1]);
      const handoff = JSON.parse(request.match(/Needs Info handoff: (\{[^\n]+?\})\. Current/)[1]);
      const last = messages.at(-1).content;
      switch (step++) {
        case 0: return turn('observe', binding, 'observe1', 'Inspecting the current form.');
        case 1:
          mutation = { operationId: 'conversation-upload', kind: 'upload', controlId: 'resume.file', valueRef: 'selected-resume',
            scope: { ...binding, form: last.form, observationRevision: last.observationRevision } };
          return turn('execute', mutation, 'write1', 'Uploading the approved fixture resume.');
        case 2: return turn('execute', mutation, 'replay1', 'Checking the same operation after interruption.');
        case 3: return turn('execute', { ...mutation, valueRef: 'unapproved' }, 'conflict1', 'Recorded adversarial source-conflict probe.');
        case 4: return turn('event', handoff, 'handoff1', 'Saving Needs Info without submitting.');
        default: return turn(null, null, null, 'The fixture is waiting for information; submission remains untouched.');
      }
    } };
    const receipt = await runModelEvaluation({ identity: { revision: 'a'.repeat(40), scenario: 'installed-protected-browser', model: 'recorded' },
      prompt: fixture.prompt, fixture, transport, outputDirectory: output });
    assert.equal(receipt.failure, null);
    assert.equal(receipt.summary.complete, true, JSON.stringify(receipt.canonicalChecks));
    assert.equal(receipt.summary.proposalCalls, 5);
    assert.equal(receipt.summary.rejectedProposalCalls, 1);
    assert.equal(receipt.summary.modelToolCalls, null);
    assert.equal(receipt.summary.modelLatencyMs, null);
    assert.equal(receipt.after.stats.writes, 1);
    assert.equal(receipt.after.claimActive, false);
    assert.ok(Object.values(receipt.canonicalChecks).every(Boolean));
    assert.equal(Object.hasOwn(fixture.model, 'approvals'), false);
    assert.equal(Object.hasOwn(fixture.model, 'readCanonical'), false);
    const corrupted = structuredClone(receipt.after);
    corrupted.stats.writes++;
    corrupted.observation.finalAction = 'activated';
    corrupted.job.status = 'awaiting_review';
    corrupted.immutableDigest = 'changed';
    const rejected = gradeInstalledModelFixture(receipt.before, corrupted);
    for (const key of ['exactlyOneBrowserWrite', 'finalActionUntouched', 'needsInfoHandoffReleasedClaim',
      'profileAndManagedResumePreserved', 'noInventedFinalReview']) assert.equal(rejected[key], false);
  } finally {
    await fixture.cleanup();
    await rm(output, { recursive: true, force: true });
  }
});
