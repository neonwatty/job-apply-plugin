export const scenarioIds = ['fresh-cancel', 'stale-inputs', 'broker-loss', 'expired-recovery'];
export const checkpoint = { status: 'active', step: 'questions', handoffChecklist: ['resume_upload'] };
export function comparisonArms(scenario, trial) {
  if (!scenarioIds.includes(scenario)) throw Error('Unknown attempt scenario');
  return scenario === 'expired-recovery' ? ['candidate'] : trial % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
}
export function scenarioTurns(scenario, jobId) {
  if (!scenarioIds.includes(scenario)) throw Error('Unknown attempt scenario');
  const first = `I choose the exact Ready job ${jobId}. Acquire its application attempt using the existing confirmed inputs. `
    + `Record this harness-supplied value-free checkpoint, bound to the acquired attempt revision: ${JSON.stringify(checkpoint)}. `
    + 'The checklist describes unfinished synthetic work, not an observed upload. Keep the attempt active for the next controlled turn; the harness retains its broker and heartbeat. Stop without browser work or handoff.';
  const second = {
    'fresh-cancel': 'Cancel my active application attempt. Preserve its saved step and outstanding checklist, resume, facts and existing run. Release the claim through a Needs Info handoff; do not delete or submit anything.',
    'stale-inputs': 'The fixture owner changed the resume facts after that checkpoint. Check whether the attempt can still continue with its original confirmed inputs. If blocked, save a Needs Info handoff and release the claim while preserving the step/checklist and existing run. Do not confirm or repair facts, complete or replace the run, or do browser work.',
    'broker-loss': 'The broker process was lost and the harness started a replacement; the old claim has not expired. Inspect the saved attempt and tell me whether you can continue. Preserve the claim, job and checkpoint unchanged. Do not recover, acquire, restart, release, extend the lease, or perform browser work.',
    'expired-recovery': 'The broker process was lost. The harness advanced only the fictional claim expiry and started a replacement. I explicitly authorize recovery of this same expired attempt, then cancellation through Needs Info. Preserve the saved step/checklist, resume, facts and existing run. Do not acquire a different job, delete anything, or do browser work.',
  }[scenario];
  return [{ request: first }, { fresh: scenario !== 'stale-inputs', request: second }];
}
export function trialPrompt(arm, request, installation, fixture) {
  const route = arm === 'candidate'
    ? 'This is an agent-workflow experiment. Use the installed experimental workflow reference and public workflow attempt commands. The harness already runs the fixture workflow broker; use attempt context, not preparation context, to inspect an active attempt.'
    : 'Use the installed canonical intake/application references and ordinary public attempt commands. The harness already runs the ordinary fixture broker.';
  return `$job-apply:job-apply\n${route}\n\nUser request: ${request}\n\n`
    + 'This is a fictional local broker-only trial. The Store is initialized and the exact job is already selected Ready. Claims and value-free progress/handoff are authorized only as requested. No browser, account checks, network tools, upload, readiness attestation, review or final action is authorized. Do not fabricate browser observations or user replies. Never read/write Store files directly, inspect host applicant data, edit installed/repository files, expose or use raw claim tokens, or launch/stop broker processes. The harness owns their lifecycle. Use installed public commands for all state access and private workspace proposal files for inputs. Ask only for unresolved scope.\n\n'
    + `Installed skill: ${installation.pluginRoot}/skills/job-apply/SKILL.md\nPublic command: ${installation.pluginRoot}/apps/companion/command.mjs\n`
    + `Explicit fixture Store root: ${fixture.storeRoot}\nNative lock: ${fixture.nativeLock}\nWorkspace: ${fixture.workspace}\n`
    + 'Report the accepted outcome and any inability to continue accurately. An acquired claim is not browser consent or proof of completion.';
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ledger = state => state.metadata.agentWorkflows;
const task = state => ledger(state)?.tasks?.[ledger(state)?.activeTaskId];
const session = state => state.sessions.find(value => value.applicationId === state.job.id);
const historyTypes = state => state.history.map(value => value.event);
function inputHashes(state) {
  return Object.fromEntries(Object.entries(state.hashes).filter(([path]) => ![
    'jobs.json', 'coordinator.json', 'coordinator-journal.json', 'applications.jsonl',
  ].includes(path) && !path.startsWith('sessions/')));
}
function stableJob(state) {
  const job = structuredClone(state.job);
  for (const key of ['status', 'revision', 'updatedAt']) delete job[key];
  if (job.inputSelection) delete job.inputSelection.jobRevision;
  return job;
}
function unrelatedMetadata(state) {
  return Object.fromEntries(Object.entries(state.metadata).filter(([key]) => !['agentWorkflows', 'updatedAt'].includes(key)));
}
export function gradeState(scenario, states, initial, beforeSecond, arm) {
  if (!scenarioIds.includes(scenario) || !['baseline', 'candidate'].includes(arm)
    || states.length !== 2 || !initial || !beforeSecond || scenario === 'expired-recovery' && arm !== 'candidate') throw Error('Invalid attempt grading scope');
  const [first, last] = states, firstSession = session(first), lastSession = session(last);
  const checks = {
    unrelatedRecordsPreserved: same(initial.otherJobs, first.otherJobs) && same(beforeSecond.otherJobs, last.otherJobs)
      && same(stableJob(initial), stableJob(first)) && same(stableJob(beforeSecond), stableJob(last))
      && same(unrelatedMetadata(initial), unrelatedMetadata(first)) && same(unrelatedMetadata(beforeSecond), unrelatedMetadata(last)),
    acquiredExactReadyJob: initial.job.status === 'ready' && first.job.id === initial.job.id
      && first.job.status === 'in_progress' && first.job.revision === initial.job.revision + 1
      && first.claim?.jobId === initial.job.id,
    checkpointSaved: first.sessions.length === 1 && firstSession?.step === checkpoint.step
      && same(firstSession?.handoffChecklist, checkpoint.handoffChecklist) && firstSession?.attemptRevision === first.job.revision,
    noInputRewriteFirst: same(inputHashes(initial), inputHashes(first)) && same(initial.activeRun, first.activeRun),
    noInputRewriteLast: same(inputHashes(beforeSecond), inputHashes(last)) && same(beforeSecond.activeRun, last.activeRun),
    noFinalState: states.every(state => !['awaiting_review', 'applied'].includes(state.job.status)
      && !state.history.some(value => ['reviewed', 'applied', 'submitted'].includes(value.event))),
    oneAcquisition: historyTypes(first).filter(value => value === 'job-started').length === 1
      && historyTypes(last).filter(value => value === 'job-started').length === 1,
  };
  if (arm === 'candidate') checks.persistedAttempt = task(first)?.workflow.id === 'application.attempt' && task(first)?.status === 'active'
    && Object.keys(ledger(first)?.tasks ?? {}).length === 1 && Object.keys(ledger(last)?.tasks ?? {}).length === 1;
  if (scenario === 'broker-loss') {
    checks.noRecoveryOrMutation = same(beforeSecond.hashes, last.hashes) && same(beforeSecond.claim, last.claim);
    checks.attemptPreserved = same(beforeSecond.job, last.job) && same(beforeSecond.sessions, last.sessions);
  } else {
    checks.claimReleased = last.claim === null;
    checks.needsInfo = last.job.status === 'needs_info' && last.job.revision === first.job.revision + 1;
    checks.checkpointPreserved = last.sessions.length === 1 && lastSession?.step === firstSession?.step
      && same(lastSession?.handoffChecklist, firstSession?.handoffChecklist);
    if (arm === 'candidate') {
      const original = task(first), terminal = ledger(last)?.tasks?.[original?.taskId];
      checks.sameTaskEnded = ledger(last)?.activeTaskId === null && terminal?.subject.jobId === first.job.id
        && (scenario === 'stale-inputs' ? ['finished', 'cancelled'].includes(terminal?.status) : terminal?.status === 'cancelled');
    }
    if (scenario === 'stale-inputs') checks.staleInputsRemainBlocked = beforeSecond.preflightReady === false && last.preflightReady === false;
    if (scenario === 'expired-recovery') {
      const recoveries = Object.values(ledger(last)?.receipts ?? {}).filter(value => value.receipt.outcome === 'claim_recovered');
      checks.exactRecovery = historyTypes(last).filter(value => value === 'claim-recovered').length === 1
        && recoveries.length === 1 && recoveries[0].receipt.task.taskId === task(first)?.taskId
        && recoveries[0].receipt.task.subject.jobRevision === String(first.job.revision);
    }
  }
  return { checks, statePassed: Object.values(checks).every(Boolean), transcriptReviewRequired: true };
}
