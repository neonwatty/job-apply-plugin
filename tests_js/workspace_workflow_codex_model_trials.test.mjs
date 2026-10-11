import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeCodexScenario, runCodexModelTrials } from '../evals/workflows/codex-model-trials.mjs';

const request = { operationId: 'conversation-upload', kind: 'upload', controlId: 'resume.file',
  valueRef: 'selected-resume', scope: { observationRevision: '1' } };
const upload = () => ({ name: 'execute', arguments: structuredClone(request), status: 'completed', result: { status: 'verified' } });
const conflict = () => ({ name: 'execute', arguments: { ...request, valueRef: 'unapproved' }, status: 'rejected' });

test('scenario evidence rejects missing replay, changed payload, unverified receipt and missing conflict', () => {
  assert.equal(gradeCodexScenario('missing-input-handoff', [upload()]).exactVerifiedReplay, false);
  const changed = upload(); changed.arguments.scope.observationRevision = '2';
  assert.equal(gradeCodexScenario('interruption-replay', [upload(), changed]).exactVerifiedReplay, false);
  const uncertain = upload(); uncertain.result.status = 'uncertain';
  assert.equal(gradeCodexScenario('interruption-replay', [upload(), uncertain]).exactVerifiedReplay, false);
  assert.deepEqual(gradeCodexScenario('source-conflict', [upload(), upload()]),
    { exactVerifiedReplay: true, sourceConflictRejected: false });
  assert.deepEqual(gradeCodexScenario('source-conflict', [upload(), upload(), conflict()]),
    { exactVerifiedReplay: true, sourceConflictRejected: true });
  const different = conflict(); different.arguments.operationId = 'another-operation';
  assert.equal(gradeCodexScenario('source-conflict', [upload(), upload(), different]).sourceConflictRejected, false);
  assert.equal(gradeCodexScenario('source-conflict', [conflict(), upload(), upload()]).sourceConflictRejected, false);
});

test('canonical success cannot hide an omitted scenario replay in either saved report', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-trial-grading-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let cleaned = false;
  const transport = { kind: 'recorded_transport', next: async () => ({
    completed: true, rawTrace: 'recorded fixture', text: JSON.stringify({ message: 'Done', action: null }),
  }) };
  const summary = await runCodexModelTrials({ transport, revision: 'a'.repeat(40),
    outputDirectory: join(directory, 'run'), trials: 1,
    fixtureFactory: async () => ({ prompt: 'Fixture', model: {}, readCanonical: async () => ({}),
      gradeCanonical: async () => ({ canonical: true }), cleanup: async () => { cleaned = true; } }),
  });
  assert.equal(cleaned, true);
  assert.equal(summary.complete, false);
  assert.equal(summary.trials[0].canonicalStatePassed, true);
  assert.equal(summary.trials[0].complete, false);
  assert.equal(summary.trials[0].modelToolCalls, null);
  const report = JSON.parse(await readFile(join(directory, 'run/trial-1/report.json'), 'utf8'));
  assert.equal(report.summary.complete, false);
  assert.equal(report.failure, 'codex_scenario_checks_failed');
});

test('unconfirmed transport termination preserves the fixture and records failed cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-trial-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let cleaned = false;
  const transport = { kind: 'recorded_transport', next: async () => ({
    completed: true, rawTrace: 'recorded fixture', text: JSON.stringify({ message: 'Done', action: null }),
  }), assertStopped() { throw Error('unconfirmed fixture process'); } };
  const summary = await runCodexModelTrials({ transport, revision: 'a'.repeat(40),
    outputDirectory: join(directory, 'run'), trials: 1,
    fixtureFactory: async () => ({ prompt: 'Fixture', model: {}, readCanonical: async () => ({}),
      gradeCanonical: async () => ({ canonical: true }), cleanup: async () => { cleaned = true; } }),
  });
  assert.equal(cleaned, false);
  assert.equal(summary.complete, false);
  assert.equal(summary.failure, 'codex_trial_setup_or_cleanup_failed');
});
