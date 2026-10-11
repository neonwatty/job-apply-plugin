import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProposal, dispatchModelAction, requireIsolation } from '../evals/workflows/model-contract.mjs';
import { runModelEvaluation } from '../evals/workflows/model-runner.mjs';
import { blindedReviewPacket, validateManualReview } from '../evals/workflows/model-report.mjs';

const proposal = (name = null, args = {}, id = 'call1', message = 'Continuing.') => JSON.stringify({ message,
  action: name === null ? null : { id, name, argumentsJson: JSON.stringify(args) } });
const isolation = () => ({ kind: 'isolated_json_proposals', evidence: 'synthetic-test-probe', checks: {
  noModelComputerTools: true, noModelStoreAccess: true, noModelApprovalAccess: true, noModelNetworkTools: true,
} });
async function fixtureRun(t, steps, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-model-eval-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let value = 0, cursor = 0;
  const model = { context: async () => ({ value }), event: async args => { value += args.increment; return { ok: true }; },
    observe: async () => ({}), execute: async () => ({}), reconcile: async () => ({}) };
  const transport = { kind: 'recorded_transport', next: async () => {
    if (cursor >= steps.length) throw Error('Recorded fixture exhausted');
    return { completed: true, rawTrace: `recorded-step-${cursor}`, text: steps[cursor++] };
  }, ...options.transport };
  const receipt = await runModelEvaluation({ identity: { revision: 'a'.repeat(40), model: 'recorded', scenario: 'fixture' },
    prompt: 'Use the fictional workflow.', transport, outputDirectory: directory, maxTurns: options.maxTurns ?? 10,
    fixture: { model: { ...model, ...options.model }, readCanonical: async () => ({ value }),
      gradeCanonical: (before, after) => ({ incrementedOnce: after.value === before.value + 1 }), ...options.fixture } });
  return { receipt, directory, dispatchedValue: value };
}

test('closed proposals reject host approval methods, extra authority and invalid identities', () => {
  for (const name of ['approve', 'host.review', 'constructor', '__proto__', 'close', 'serve']) {
    assert.throws(() => parseProposal(proposal(name)), /Invalid/);
  }
  assert.throws(() => parseProposal(JSON.stringify({ message: '', action: null, approvals: true })));
  assert.throws(() => parseProposal(proposal('context', { root: '/owner/store' })));
  assert.throws(() => parseProposal(proposal('event', [], 'call1')));
  assert.throws(() => parseProposal(proposal('event', {}, '../approval')));
});

test('dispatcher routes only model channel and rejects inherited or invented ports', async () => {
  let approved = false;
  const model = { context: async jobId => ({ jobId }), reconcile: async (binding, operationId) => ({ binding, operationId }),
    approvals: { approve: () => { approved = true; } } };
  assert.deepEqual(await dispatchModelAction(model, parseProposal(proposal('context', { jobId: 'job' })).action), { jobId: 'job' });
  assert.deepEqual(await dispatchModelAction(model, parseProposal(proposal('reconcile', { binding: {}, operationId: 'op' })).action),
    { binding: {}, operationId: 'op' });
  await assert.rejects(dispatchModelAction(model, { name: 'approvals', arguments: {} }));
  assert.equal(approved, false);
});

test('recorded transport captures full dialogue and canonical state without inventing live metrics', async t => {
  const { receipt, directory } = await fixtureRun(t, [proposal('event', { increment: 1 }), proposal(null, {}, '', 'Done?')]);
  assert.equal(receipt.summary.complete, true);
  assert.equal(receipt.summary.modelToolCalls, null);
  assert.equal(receipt.summary.modelLatencyMs, null);
  assert.equal(receipt.summary.unnecessaryQuestions, null);
  assert.equal(receipt.calls.length, 1);
  assert.deepEqual(receipt.transcript.map(item => item.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(receipt.turns[0].rawTrace, 'recorded-step-0');
  const persisted = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  assert.deepEqual(persisted.before, { value: 0 });
  assert.deepEqual(persisted.after, { value: 1 });
});

test('assistant completion claims cannot override failed canonical evidence', async t => {
  const { receipt } = await fixtureRun(t, [proposal(null, {}, '', 'Everything succeeded.')]);
  assert.equal(receipt.finished, true);
  assert.equal(receipt.summary.complete, false);
  assert.equal(receipt.summary.canonicalStatePassed, false);
});

test('model cannot re-dispatch a duplicate call identity', async t => {
  const { receipt, dispatchedValue } = await fixtureRun(t, [proposal('event', { increment: 1 }), proposal('event', { increment: 1 })]);
  assert.equal(dispatchedValue, 1);
  assert.match(receipt.failure, /Duplicate/);
  assert.equal(receipt.summary.complete, false);
});

test('invalid proposal is persisted before parser failure without any dispatch', async t => {
  const { receipt } = await fixtureRun(t, [proposal('approve')]);
  assert.equal(receipt.turns.length, 1);
  assert.equal(receipt.calls.length, 0);
  assert.match(receipt.failure, /Invalid model action/);
});

test('tool failure returns a sanitized rejection and remains visible in call counts', async t => {
  const { receipt } = await fixtureRun(t, [proposal('execute'), proposal()], {
    model: { execute: async () => { throw Error('private bearer and Store path'); } },
  });
  assert.equal(receipt.summary.rejectedProposalCalls, 1);
  assert.equal(JSON.stringify(receipt).includes('private bearer'), false);
  assert.deepEqual(receipt.calls[0].result, { ok: false, error: 'fixture_action_rejected' });
});

test('live transport cannot start before isolation proof passes', async t => {
  let invoked = false;
  const { receipt } = await fixtureRun(t, [], { transport: { kind: 'live_model',
    verifyIsolation: async () => ({ ...isolation(), checks: { ...isolation().checks, noModelApprovalAccess: false } }),
    next: async () => { invoked = true; throw Error('must not run'); } } });
  assert.equal(invoked, false);
  assert.equal(receipt.summary.complete, false);
  assert.match(receipt.failure, /isolation unavailable/);
  assert.equal(receipt.before, null);
  assert.throws(() => requireIsolation({ ...isolation(), trustMe: true }));
});

test('turn limits preserve partial canonical evidence and incomplete status', async t => {
  const { receipt } = await fixtureRun(t, [proposal('event', { increment: 1 })], { maxTurns: 1 });
  assert.equal(receipt.canonicalChecks.incrementedOnce, true);
  assert.equal(receipt.summary.complete, false);
  assert.match(receipt.failure, /turn limit/);
});

test('manual review binds specific assistant messages and transcript digest', async t => {
  const { receipt } = await fixtureRun(t, [proposal(null, {}, '', 'What next?')]);
  const packet = blindedReviewPacket(receipt, 'anonymous17');
  assert.equal(Object.hasOwn(packet, 'identity'), false);
  const review = { packetId: packet.packetId, transcriptDigest: packet.transcriptDigest, reviewer: 'human',
    unnecessaryQuestions: [{ messageIndex: 1, reason: 'The supplied task already specifies next action.' }], notes: '' };
  assert.deepEqual(validateManualReview(review, packet), review);
  assert.throws(() => validateManualReview({ ...review, transcriptDigest: 'wrong' }, packet));
  assert.throws(() => validateManualReview({ ...review, unnecessaryQuestions: [{ messageIndex: 0, reason: 'User text' }] }, packet));
});

test('transport failure retains the attempted turn and partial state without live metrics', async t => {
  const { receipt } = await fixtureRun(t, [], { transport: { next: async () => { throw Error('fixture transport timeout'); } } });
  assert.equal(receipt.turns.length, 1);
  assert.equal(receipt.turns[0].completed, false);
  assert.equal(receipt.turns[0].rawTrace, null);
  assert.equal(receipt.summary.complete, false);
  assert.equal(receipt.summary.modelLatencyMs, null);
  assert.match(receipt.failure, /timeout/);
});

test('blocked default adapter reports no executed model metrics', async t => {
  const { unavailableLiveTransport } = await import('../evals/workflows/model-cli.mjs');
  const { receipt } = await fixtureRun(t, [], { transport: unavailableLiveTransport() });
  assert.equal(receipt.turns.length, 0);
  assert.equal(receipt.summary.modelToolCalls, null);
  assert.equal(receipt.summary.modelLatencyMs, null);
  assert.equal(receipt.summary.complete, false);
});
