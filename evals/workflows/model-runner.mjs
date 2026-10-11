import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { exact, jsonSnapshot, parseProposal, dispatchModelAction, requireIsolation } from './model-contract.mjs';
import { summarizeModelRun, blindedReviewPacket } from './model-report.mjs';

/** Transport is trusted host code; the model only returns text. Never pass host ports to it. */
export async function runModelEvaluation({ identity, prompt, transport, fixture, outputDirectory, maxTurns = 20 }) {
  exact(identity, ['revision', 'scenario', 'model']);
  if (!/^[a-f0-9]{40}$/.test(identity.revision) || typeof identity.scenario !== 'string' || !identity.scenario
    || typeof identity.model !== 'string' || !identity.model || typeof prompt !== 'string' || !prompt
    || !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 100
    || !['live_model', 'recorded_transport'].includes(transport.kind)) throw Error('Invalid evaluation configuration');
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const receipt = { schemaVersion: 1, identity: jsonSnapshot(identity), evidenceKind: transport.kind,
    isolation: null, transcript: [{ role: 'user', content: prompt }], turns: [], calls: [],
    before: null, after: null, canonicalChecks: null, finished: false, failure: null };
  const save = async () => {
    receipt.summary = summarizeModelRun(receipt);
    await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  };
  const started = performance.now(), seen = new Set();
  try {
    if (transport.kind === 'live_model') receipt.isolation = requireIsolation(await transport.verifyIsolation());
    receipt.before = jsonSnapshot(await fixture.readCanonical());
    await save();
    for (let index = 0; index < maxTurns; index++) {
      const turnStart = performance.now();
      const turn = { index, elapsedMs: 0, rawTrace: null, text: null, completed: false };
      receipt.turns.push(turn);
      await save();
      let result;
      // Each transport call must enforce its own process deadline and stop descendants before returning.
      try {
        result = jsonSnapshot(await transport.next({ messages: jsonSnapshot(receipt.transcript, 8 * 1024 * 1024) }),
          8 * 1024 * 1024);
        Object.assign(turn, { rawTrace: result.rawTrace, text: result.text, completed: result.completed });
      } finally {
        turn.elapsedMs = performance.now() - turnStart;
        await save();
      }
      if (Buffer.byteLength(JSON.stringify(receipt.turns)) > 8 * 1024 * 1024) throw Error('Transport evidence limit reached');
      if (result.completed !== true || typeof result.rawTrace !== 'string') throw Error('Incomplete model transport');
      const proposal = parseProposal(result.text);
      receipt.transcript.push({ role: 'assistant', content: proposal.message, action: proposal.action });
      if (proposal.action === null) { receipt.finished = true; break; }
      if (seen.has(proposal.action.id)) throw Error('Duplicate model call identity');
      seen.add(proposal.action.id);
      const call = { ...proposal.action, status: 'pending', elapsedMs: 0, result: null };
      receipt.calls.push(call);
      await save();
      const callStart = performance.now();
      try {
        call.result = jsonSnapshot(await dispatchModelAction(fixture.model, proposal.action));
        call.status = call.result?.ok === false ? 'rejected' : 'completed';
      } catch {
        // Model-visible rejections must not leak paths, bearer values or private host diagnostics.
        call.status = 'rejected'; call.result = { ok: false, error: 'fixture_action_rejected' };
      }
      call.elapsedMs = performance.now() - callStart;
      receipt.transcript.push({ role: 'tool', callId: call.id, content: call.result });
      await save();
    }
    if (!receipt.finished) throw Error('Model turn limit reached');
  } catch (error) {
    receipt.failure = error instanceof Error ? error.message : 'Evaluation failed';
  } finally {
    try {
      receipt.after = jsonSnapshot(await fixture.readCanonical());
      if (receipt.before !== null) {
        const checks = jsonSnapshot(await fixture.gradeCanonical(receipt.before, receipt.after));
        if (!checks || typeof checks !== 'object' || Array.isArray(checks) || !Object.keys(checks).length
          || Object.values(checks).some(value => typeof value !== 'boolean')) throw Error('Invalid canonical checks');
        receipt.canonicalChecks = checks;
      }
    } catch { receipt.failure ??= 'Canonical evidence unavailable'; }
    receipt.elapsedMs = performance.now() - started;
    await save();
    await writeFile(join(outputDirectory, 'review-packet.json'),
      JSON.stringify(blindedReviewPacket(receipt, 'conversation'), null, 2) + '\n', { mode: 0o600 });
  }
  return receipt;
}
