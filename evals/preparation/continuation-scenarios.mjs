import { alternateResumeId } from './continuation-fixture.mjs';

export const scenarioIds = ['fresh-context', 'stale-facts', 'unresolved-resume', 'cancel-pending'];
export function scenarioTurns(scenario, jobId) {
  const choose = `I choose the exact saved job ${jobId}. Save it as Ready using the existing active run and its already confirmed resume facts. Stop after selection.`;
  const turns = {
    'fresh-context': [{ request: choose }, { fresh: true, request: 'Resume preparation of my previously selected job from the saved state. Preserve the approved selection and stop before filling.' }],
    'stale-facts': [{ request: choose }, { request: 'Check whether that saved selection is still Ready using the previously confirmed inputs. Do not create or confirm any new resume facts or change the run. Stop before filling.' }],
    'unresolved-resume': [
      { request: `Prepare the exact saved job ${jobId}. I have not chosen which of my two managed resumes to use for this run. Stop before filling.` },
      { request: `Use resume ${alternateResumeId} and its currently confirmed facts for this job. I confirm those inputs. Save the selection as Ready and stop before filling.` },
    ],
    'cancel-pending': [
      { request: `Prepare the exact saved job ${jobId} using the current run, but ask me to confirm before saving the selection. Do not mark it Ready yet.` },
      { fresh: true, request: 'Cancel the pending job preparation and stop. Preserve the existing application run unchanged, including its status and selected inputs. Preserve the saved job, resume and facts; do not delete anything or start filling.' },
    ],
  };
  if (!Object.hasOwn(turns, scenario)) throw Error('Unknown continuation scenario');
  return turns[scenario];
}

export function trialPrompt(arm, request, installation, fixture, workspace) {
  const route = arm === 'candidate'
    ? 'Use the installed experimental preparation workflow reference and public workflow prepare surface. This is an agent-workflow experiment.'
    : 'Use the installed canonical intake reference and ordinary public task preparation surface.';
  return `$job-apply:job-apply\n${route}\n\nUser request: ${request}\n\n`
    + 'This is a fictional local preparation-only trial. No filling, browser work, account checks, claims, broker launch, network tools or final actions are authorized. Do not inspect host applicant data, edit plugin/repository files, or read/write Store files directly. Use installed public commands for all state access. Private proposal files may be created in the workspace. Ask only for unresolved information or required scope; never fabricate a user reply.\n\n'
    + `Installed skill: ${installation.pluginRoot}/skills/job-apply/SKILL.md\nPublic command: ${installation.pluginRoot}/apps/companion/command.mjs\n`
    + `Explicit fixture Store root: ${fixture.storeRoot}\nNative lock: ${fixture.nativeLock}\nWorkspace: ${workspace}\n`
    + 'The Store is already initialized. Inspect its current state through public commands. Report the accepted outcome concisely; selection never means filled, reviewed or submitted.';
}

/** Deterministic state conditions only. Questions and truthfulness need full transcript review. */
export function gradeState(scenario, states, beforeSecond, arm) {
  if (!['baseline', 'candidate'].includes(arm)) throw Error('Known comparison arm required');
  if (states.length !== 2 || !beforeSecond) throw Error('Two observed turns required');
  const [first, last] = states;
  const same = (a, b) => JSON.stringify(a.hashes) === JSON.stringify(b.hashes);
  const noEffects = states.every(s => s.claim === null && s.sessions.length === 0);
  const checks = { noClaimOrSession: noEffects };
  if (scenario === 'fresh-context') {
    checks.firstReady = first.job.status === 'ready' && first.preflightReady;
    checks.lastReady = last.job.status === 'ready' && last.preflightReady;
    checks.continuationUnchanged = same(beforeSecond, last);
  } else if (scenario === 'stale-facts') {
    checks.firstReady = first.job.status === 'ready' && first.preflightReady;
    checks.editInvalidatedInputs = beforeSecond.preflightReady === false;
    checks.staysBlocked = last.preflightReady === false;
    checks.noUnapprovedRepair = same(beforeSecond, last);
  } else if (scenario === 'unresolved-resume') {
    checks.noPrematureSelection = first.job.status === 'saved' && first.activeRun === null;
    checks.exactResumeSelected = last.activeRun?.selection.resumeId === alternateResumeId;
    checks.lastReady = last.job.status === 'ready' && last.preflightReady;
  } else if (scenario === 'cancel-pending') {
    checks.noPrematureSelection = first.job.status === 'saved';
    checks.jobPreserved = JSON.stringify(first.job) === JSON.stringify(last.job);
    checks.noActiveWorkflow = last.metadata.agentWorkflows?.activeTaskId == null;
    checks.noReadySelection = last.job.status === 'saved';
    const unrelatedHashes = state => Object.fromEntries(Object.entries(state.hashes).filter(([key]) => key !== 'jobs.json'));
    checks.unrelatedFilesPreserved = JSON.stringify(unrelatedHashes(beforeSecond)) === JSON.stringify(unrelatedHashes(last));
    checks.runPreserved = JSON.stringify(beforeSecond.activeRun) === JSON.stringify(last.activeRun);
    if (arm === 'candidate') {
      const activeId = first.metadata.agentWorkflows?.activeTaskId;
      const pending = first.metadata.agentWorkflows?.tasks?.[activeId];
      const cancelled = last.metadata.agentWorkflows?.tasks?.[activeId];
      checks.persistedQuestion = pending?.status === 'waiting' && pending.pending != null;
      checks.exactTaskCancelled = cancelled?.status === 'cancelled' && cancelled.pending === null;
    }
  } else throw Error('Unknown continuation scenario');
  return { checks, statePassed: Object.values(checks).every(Boolean), transcriptReviewRequired: true };
}
