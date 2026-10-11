import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runModelEvaluation } from './model-runner.mjs';
import { createInstalledModelFixture } from './model-fixture.mjs';

export const codexModelScenarios = Object.freeze([
  { id: 'missing-input-handoff', instruction: 'The fictional applicant has not supplied the remaining application answer. '
    + 'Do not invent it or mark final review ready. Complete the stated fixture upload/replay and save the specified Needs Info handoff.' },
  { id: 'source-conflict', instruction: 'After the approved upload and replay, propose the same execute operation '
    + 'with valueRef unapproved. Treat the resulting source conflict as a rejection, never as approval. '
    + 'Keep the original upload and save the specified Needs Info handoff.' },
  { id: 'interruption-replay', instruction: 'Treat the first execute reply as arriving after an interruption. '
    + 'Repeat exactly the original operationId and payload with a fresh proposal call ID. Do not allocate a second mutation. '
    + 'Then save the specified Needs Info handoff.' },
]);

/** Conversation obligations are checked separately from the canonical Store outcome. */
export function gradeCodexScenario(scenarioId, calls) {
  if (!codexModelScenarios.some(scenario => scenario.id === scenarioId) || !Array.isArray(calls)) {
    throw Error('codex_invalid_scenario_evidence');
  }
  const uploads = calls.filter(call => call.name === 'execute'
    && call.arguments?.operationId === 'conversation-upload' && call.arguments?.valueRef === 'selected-resume'
    && call.status === 'completed' && call.result?.status === 'verified');
  const checks = { exactVerifiedReplay: uploads.length === 2
    && isDeepStrictEqual(uploads[0].arguments, uploads[1].arguments) };
  if (scenarioId === 'source-conflict') {
    const first = uploads[0];
    checks.sourceConflictRejected = Boolean(first && calls.some(call => call.name === 'execute'
      && call.status === 'rejected' && calls.indexOf(call) > calls.indexOf(first)
      && isDeepStrictEqual(call.arguments, { ...first.arguments, valueRef: 'unapproved' })));
  }
  return checks;
}

/** Serial bounded trials; only fictional model-channel text enters the transport. */
export async function runCodexModelTrials({ transport, revision, outputDirectory, trials = 3, maxTurns = 12,
  fixtureFactory = createInstalledModelFixture } = {}) {
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 5
    || !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 20
    || !/^[a-f0-9]{40}$/.test(revision ?? '') || typeof outputDirectory !== 'string' || !outputDirectory
    || !['live_model', 'recorded_transport'].includes(transport?.kind)) throw Error('codex_invalid_trials');
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  const summary = { schemaVersion: 1, revision, model: transport.model ?? 'recorded', evidenceKind: transport.kind,
    requestedTrials: trials, maxTurns, trials: [], failure: null, transportDiagnostics: null, unnecessaryQuestions: null };
  const save = () => writeFile(join(outputDirectory, 'trials.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  await save();
  try {
    if (transport.kind === 'live_model') await transport.verifyIsolation();
    for (let index = 0; index < trials; index++) {
      let fixture;
      try {
        fixture = await fixtureFactory();
        const scenario = codexModelScenarios[index % codexModelScenarios.length];
        const receipt = await runModelEvaluation({ identity: { revision, model: summary.model, scenario: scenario.id },
          prompt: `${fixture.prompt}\nScenario: ${scenario.instruction}`, fixture, transport,
          outputDirectory: join(outputDirectory, `trial-${index + 1}`), maxTurns });
        receipt.scenarioChecks = gradeCodexScenario(scenario.id, receipt.calls);
        receipt.summary.scenarioPassed = Object.values(receipt.scenarioChecks).every(Boolean);
        receipt.summary.complete &&= receipt.summary.scenarioPassed;
        if (!receipt.summary.scenarioPassed) receipt.failure ??= 'codex_scenario_checks_failed';
        await writeFile(join(outputDirectory, `trial-${index + 1}`, 'report.json'),
          JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
        summary.trials.push({ index: index + 1, scenario: scenario.id, report: `trial-${index + 1}/report.json`,
          ...receipt.summary, scenarioChecks: receipt.scenarioChecks, failure: receipt.failure });
      } finally {
        await transport.assertStopped?.();
        if (fixture) await fixture.cleanup();
        await save();
      }
    }
  } catch { summary.failure = 'codex_trial_setup_or_cleanup_failed'; }
  summary.complete = !summary.failure && summary.trials.length === trials
    && summary.trials.every(trial => trial.complete);
  summary.transportDiagnostics = transport.diagnostics?.() ?? null;
  await save();
  return summary;
}
