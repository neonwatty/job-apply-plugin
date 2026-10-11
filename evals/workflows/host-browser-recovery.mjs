import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialValues, expectedValues as expectedTabValues } from './host-browser-page.mjs';
import { digest, gradeHostBrowser } from './host-browser-grade.mjs';

export const recoveryScenarios = ['broker-restart', 'tab-closed', 'browser-tool-reconnect'];
const browserLossKinds = ['tab-closed', 'browser-tool-reconnect'];
const fail = message => { throw Object.assign(Error(message), { status: 400 }); };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function validateInjection(input) {
  if (!exactKeys(input, ['kind', 'signal']) || input.kind !== 'broker-restart'
    || !['SIGTERM', 'SIGKILL'].includes(input.signal)) fail('invalid_injection');
}

/** Handles only children spawned here, never a supplied PID or PID-file target. */
export function ownedBrokerLifecycle(state) {
  const owned = new Set();
  let current, closing = false, closePromise;
  let pending = Promise.resolve();
  const enqueue = operation => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  async function stop(broker = current, signal = 'SIGTERM') {
    if (!broker || !owned.has(broker)) return;
    let timer;
    try {
      if (broker.child.exitCode === null && broker.child.signalCode === null) broker.child.kill(signal);
      await Promise.race([broker.exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Owned broker shutdown unconfirmed; fixture preserved')), 15000);
      })]);
      owned.delete(broker);
      if (broker.errors) throw Error(broker.errors);
    } finally { clearTimeout(timer); }
  }
  async function start() {
    if (closing) throw Error('Owned broker lifecycle closed');
    const child = spawn(process.execPath, [join(state.plugin, 'apps/companion/command.mjs'), 'workflow', 'attempt', 'serve',
      '--root', state.root, '--native-lock', state.nativeLock], {
      cwd: state.plugin, env: { PATH: '', HOME: join(state.directory, 'home') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const broker = { child, errors: '', exited: new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    }) };
    // Register before readiness so a failed replacement is also cleaned up.
    owned.add(broker); current = broker;
    child.stdout.resume(); child.stderr.on('data', bytes => { broker.errors += bytes; });
    try {
      let ready = false;
      for (let tries = 0; tries < 100; tries++) {
        if ((await readFile(join(state.root, '.job-apply-attempt.pid'), 'utf8').catch(() => '')).trim() === String(child.pid)) {
          ready = true; break;
        }
        if (child.exitCode !== null || child.signalCode !== null) throw Error('Owned attempt broker exited before ready');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!ready) throw Error('Owned attempt broker did not become ready');
      // Read-only handshake clears startup idle timeout, without acquiring a claim.
      broker.startupContext = await state.call('workflow', ['attempt', 'context'], undefined, ['--job-id', 'job']);
      return broker;
    } catch (error) { await stop(broker); throw error; }
  }
  return {
    start: () => enqueue(start),
    stop: (broker, signal) => enqueue(() => stop(broker, signal)),
    get current() { return current; },
    close() {
      closing = true;
      closePromise ??= enqueue(async () => { for (const broker of [...owned]) await stop(broker); });
      return closePromise;
    },
  };
}

export function latestLoss(receipts) {
  return receipts.findLast(receipt => browserLossKinds.includes(receipt.kind) || receipt.kind === 'broker-restart');
}
function resetObservedBeforeWrites(loss, page) {
  const events = page?.events?.slice(loss?.page?.events?.length);
  return Boolean(events?.some(event => event.kind === 'page-load'))
    && !events.some(event => ['input', 'change'].includes(event.kind))
    && isDeepStrictEqual(page.values, initialValues);
}
export function recoveryCheckpoint(input, receipts, snapshot, url) {
  if (exactKeys(input, ['kind']) && browserLossKinds.includes(input.kind)) {
    return { ...input, sequence: receipts.length + 1, evidenceKind: 'host_attested_loss', ...snapshot };
  }
  if (!exactKeys(input, ['kind', 'lossSequence', 'evidence']) || input.kind !== 'recovery-observation') fail('invalid_checkpoint');
  const loss = latestLoss(receipts);
  if (!loss || input.lossSequence !== loss.sequence) fail('invalid_loss_sequence');
  if (!receipts.slice(loss.sequence).some(receipt => receipt.command === 'host-browser-context' && receipt.result?.hostBrowser)) fail('fresh_context_required');
  const evidence = input.evidence;
  if (!exactKeys(evidence, ['source', 'url', 'title', 'values']) || evidence.source !== 'native_host_browser'
    || evidence.url !== url || evidence.title !== 'Fictional host browser acceptance'
    || !exactKeys(evidence.values, Object.keys(snapshot.page.values))
    || !Object.entries(snapshot.page.values).every(([key, value]) => evidence.values[key] === value)) fail('invalid_observation');
  if (loss.kind === 'tab-closed' && !receipts.slice(loss.sequence).some(receipt => receipt.kind === 'recovery-observation'
    && receipt.lossSequence === loss.sequence) && !resetObservedBeforeWrites(loss, snapshot.page)) fail('reset_observation_required');
  return { ...input, sequence: receipts.length + 1, evidenceKind: 'agent_attested', ...snapshot };
}
export function reportNeedsObservation(input, receipts) {
  if (input.command !== 'host-browser-report') return false;
  const loss = latestLoss(receipts);
  if (!loss) return false;
  // A label alone never authorizes replay. Only an exact previously successful report can bypass observation.
  if (receipts.some(receipt => receipt.command === 'host-browser-report' && receipt.result?.receipt
    && receipt.result?.ok !== false && isDeepStrictEqual(receipt.payload, input.payload))) return false;
  return !receipts.slice(loss.sequence).some(receipt => receipt.kind === 'recovery-observation'
    && receipt.lossSequence === loss.sequence);
}

export function gradeHostBrowserRecovery(before, after, scenario) {
  const base = gradeHostBrowser(before, after, 'controls-handoff');
  const receipts = after.receipts;
  const loss = latestLoss(receipts);
  const lossIndex = receipts.indexOf(loss);
  const observationIndex = receipts.findIndex((receipt, index) => index > lossIndex && receipt.kind === 'recovery-observation'
    && receipt.lossSequence === loss?.sequence && receipt.evidenceKind === 'agent_attested'
    && receipt.evidence?.source === 'native_host_browser' && receipt.evidence?.title === 'Fictional host browser acceptance'
    && /^http:\/\/127\.0\.0\.1:[0-9]+\/$/.test(receipt.evidence?.url ?? '')
    && exactKeys(receipt.evidence?.values, Object.keys(receipt.page?.values ?? {}))
    && Object.entries(receipt.page?.values ?? {}).every(([key, value]) => receipt.evidence.values[key] === value));
  const observation = receipts[observationIndex];
  const contextIndex = receipts.findIndex((receipt, index) => index > lossIndex && index < observationIndex
    && receipt.command === 'host-browser-context' && receipt.result?.hostBrowser);
  const successful = receipt => receipt.command === 'host-browser-report' && receipt.result?.receipt && receipt.result?.ok !== false;
  const lossPage = loss?.beforePage ?? loss?.page;
  const recoveryChecks = {
    lossRecorded: lossIndex >= 0 && loss.kind === scenario,
    freshContextAndObservation: contextIndex > lossIndex && observationIndex > contextIndex,
    ...(scenario !== 'broker-restart' ? {
      reportAfterObservation: observationIndex >= 0 && receipts.slice(observationIndex + 1).some(successful)
        && !receipts.slice(lossIndex + 1, Math.max(lossIndex + 1, observationIndex)).some(receipt => successful(receipt) && !receipt.result?.replayed),
    } : {}),
    ...(scenario === 'broker-restart' ? {
      ownedBrokerReplaced: loss?.status === 'completed' && loss.evidenceKind === 'fixture_owned_process'
        && ['SIGTERM', 'SIGKILL'].includes(loss.signal) && Number.isInteger(loss.oldPid) && Number.isInteger(loss.newPid)
        && loss.oldPid > 0 && loss.newPid > 0 && loss.oldPid !== loss.newPid,
      durableStorePreserved: Boolean(loss?.beforeDurableDigest) && loss.beforeDurableDigest === loss.afterDurableDigest,
      canonicalAndDraftPreserved: Boolean(loss?.beforeCanonical) && digest(loss.beforeCanonical) === digest(loss.afterCanonical)
        && digest(loss.beforePage) === digest(loss.afterPage),
      liveClaimPreserved: Boolean(loss?.beforeCanonical?.coordinator?.claim) && after.canonical.claimActive
        && digest(loss.beforeCanonical) === digest(after.canonical),
      noPostLossWrites: Boolean(lossPage) && digest(lossPage) === digest(after.page),
      oldReportRejected: observationIndex >= 0 && receipts.slice(observationIndex + 1).some(receipt =>
        receipt.command === 'host-browser-report' && receipt.result?.ok === false && receipt.result?.error === 'request_rejected'
        && digest(receipt.beforeCanonical) === digest(receipt.afterCanonical) && digest(receipt.beforePage) === digest(receipt.afterPage)
        && receipts.slice(0, lossIndex).some(context => context.command === 'host-browser-context'
          && context.result?.guidance?.actions?.some(action => {
            if (action.kind !== 'progress') return false;
            const { kind, ...input } = action.input;
            return typeof receipt.payload?.operationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(receipt.payload.operationId)
              && !receipt.payload.operationId.includes('..')
              && isDeepStrictEqual(receipt.payload, { ...input, operationId: receipt.payload.operationId, evidenceKind: 'agent_attested', outcome: 'progress' });
          }))),
      noNewReportAccepted: !receipts.slice(lossIndex + 1).some(receipt => successful(receipt) && !receipt.result?.replayed),
      restartDidNotAcquire: loss?.startupContext?.brokerAvailable === false
        && Array.isArray(loss.startupContext.guidance?.actions) && !loss.startupContext.guidance.actions.some(action => action.kind === 'acquire'),
    } : {}),
    ...(scenario === 'tab-closed' ? {
      reopenedPageObserved: resetObservedBeforeWrites(loss, observation?.page),
      reconstructionAfterObservation: Boolean(observation?.page) && Object.keys(expectedTabValues).every(field =>
        after.page.events.slice(observation.page.events.length).some(event => ['input', 'change'].includes(event.kind) && event.field === field)),
    } : {
      reobservedWithoutRepeatedWrite: Boolean(lossPage && observation?.page) && digest(lossPage) === digest(observation.page),
    }),
  };
  const canonicalChecks = { ...base.canonicalChecks };
  const scenarioChecks = { ...base.scenarioChecks };
  if (scenario === 'broker-restart') {
    delete canonicalChecks.needsInfoReleasedClaim;
    delete scenarioChecks.hostReportRecorded;
  }
  return { ...base, scenario, canonicalChecks, scenarioChecks, recoveryChecks,
    recoveryOutcome: scenario === 'broker-restart' ? 'blocked_safely' : 'completed_handoff',
    passed: [...Object.values(base.pageChecks), ...Object.values(canonicalChecks), ...Object.values(scenarioChecks), ...Object.values(recoveryChecks)].every(Boolean),
    evidenceLimitations: ['Browser loss and DOM observations are host attestations requiring a native tool transcript.',
      'Recovery gates cover fixture HTTP commands only; direct installed CLI and arbitrary host tools are outside enforcement.'] };
}
