#!/usr/bin/env node
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentArguments, execute, hostEnvironment, installRevision, parseTrace, sessionContext, validateContext, writeJson } from './support.mjs';
import { observeFixture, prepareFixture } from './fixture.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const revisions = { baseline: 'f95b4947453ad6c6abc9cc0e81c3e443706d4714', candidate: '4551524d45fbe90ae52dd231cfe739a9b2a43bae' };
let trials = 3, model = 'gpt-5.6-luna';
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--trials') trials = Number(process.argv[++index]);
  else if (process.argv[index] === '--model') model = process.argv[++index];
  else throw Error('Usage: node evals/preparation/run.mjs [--trials 1..10] [--model MODEL]');
}
if (process.env.CI) throw Error('Authenticated model trials are local-only');
if (!Number.isInteger(trials) || trials < 1 || trials > 10 || !model) throw Error('Invalid trial count or model');
const version = await execute('codex', ['--version']);
if (version.code !== 0) throw Error('Codex CLI unavailable');
const output = join(repository, '.workflows/local', `preparation-eval-${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const report = { schemaVersion: 1, scenario: 'exact-selection-confirmation-repeat', revisions, model,
  reasoningEffort: 'medium', cliVersion: version.stdout.trim(), trials, runs: [], complete: false };
console.log(`Evidence: ${output}`);

function initialPrompt(arm, installation, fixture, workspace) {
  const route = arm === 'candidate'
    ? 'This is an agent-workflow experiment: use the installed experimental preparation workflow reference and public workflow prepare surface.'
    : 'Use the installed canonical intake reference and ordinary public task preparation surface.';
  return `$job-apply:job-apply\n${route}\n\n`
    + `User request: I choose the exact saved job ${fixture.jobId} (Synthetic Application Tester at Fictional Local Systems). Save my selection as Ready using the existing active run and its already confirmed resume facts. Stop after job selection.\n\n`
    + `This is a fictional, local preparation-only trial. No application filling, browser work, account checks, claim acquisition, broker launch, network tools, final action, or other jobs are authorized. Do not edit plugin or repository files, inspect host applicant data, or read/write Store files directly. Use the installed public command for state access; private proposal files may be created in the workspace. Ask only when required by the installed preparation contract. Do not fabricate user replies.\n\n`
    + `Installed skill: ${installation.pluginRoot}/skills/job-apply/SKILL.md\nPublic command: ${installation.pluginRoot}/apps/companion/command.mjs\n`
    + `Explicit fixture Store root: ${fixture.storeRoot}\nNative lock: ${fixture.nativeLock}\nWorkspace: ${workspace}\n`
    + 'The Store is already initialized and contains one saved job in an active run with one managed resume and current confirmed facts. Scope every command to this fixture. Report the accepted state concisely; selection never means filled, reviewed, or submitted.';
}

try {
  for (let trial = 1; trial <= trials; trial++) {
    // Alternate order to reduce a consistent warm-up/service-load bias.
    for (const arm of trial % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      const name = `${trial}-${arm}`, evidence = join(output, name);
      await mkdir(evidence, { mode: 0o700 });
      const temporary = await realpath(await mkdtemp(join(tmpdir(), 'job-apply-preparation-eval-')));
      const run = { trial, arm, revision: revisions[arm], turns: [] };
      report.runs.push(run);
      try {
        const installation = await installRevision(repository, revisions[arm], temporary);
        const workspace = join(temporary, 'workspace');
        await mkdir(workspace, { mode: 0o700 });
        const fixture = await prepareFixture(installation.pluginRoot, workspace);
        run.pluginVersion = installation.version;
        run.initial = await observeFixture(fixture.storeRoot);
        await writeJson(join(evidence, 'initial-state.json'), run.initial);
        const prompts = [initialPrompt(arm, installation, fixture, workspace),
          `Yes, I confirm the exact job ${fixture.jobId} and the existing run's selected resume and confirmed facts. Save the selection and stop before filling.`,
          `Yes, I confirm the exact job ${fixture.jobId} and the existing run's selected resume and confirmed facts. Save the selection and stop before filling.`];
        let sessionId;
        for (let turn = 0; turn < prompts.length; turn++) {
          const prefix = join(evidence, `turn-${turn + 1}`);
          await writeFile(`${prefix}-prompt.txt`, prompts[turn], { mode: 0o600 });
          const args = agentArguments({ sessionId, workspace, model });
          await writeJson(`${prefix}-invocation.json`, { command: 'codex', args, cwd: workspace });
          const result = await execute('codex', args, { cwd: workspace, env: hostEnvironment(installation.codexHome, fixture.storeRoot),
            timeout: 360000, input: prompts[turn] });
          await writeFile(`${prefix}-trace.jsonl`, result.stdout, { mode: 0o600 });
          await writeFile(`${prefix}-stderr.txt`, result.stderr, { mode: 0o600 });
          const trace = parseTrace(result.stdout), state = await observeFixture(fixture.storeRoot);
          const effectiveContext = trace.sessionId ? await sessionContext(installation.codexHome, trace.sessionId) : null;
          const receipt = { turn: turn + 1, code: result.code, signal: result.signal, failure: result.failure,
            elapsedMs: result.elapsedMs, ...trace, effectiveContext, state };
          run.turns.push(receipt);
          await writeJson(`${prefix}-receipt.json`, receipt);
          await writeJson(join(output, 'report.json'), report);
          console.log(`${name} turn ${turn + 1}: ${result.code}, ${state.job.status}, ${trace.commands.length} shell calls, ${result.elapsedMs}ms`);
          if (result.code !== 0 || result.failure || !trace.completed || !trace.sessionId) throw Error(`Incomplete model turn: ${name}/${turn + 1}`);
          validateContext(effectiveContext, { workspace, model, turn: turn + 1 });
          if (sessionId && sessionId !== trace.sessionId) throw Error('Continuation changed session identity');
          sessionId = trace.sessionId;
          if (state.claim !== null || state.sessions.length) throw Error('Preparation exceeded claim/session scope');
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }
  report.complete = true;
} finally {
  await writeJson(join(output, 'report.json'), report);
}
console.log(`Completed ${report.runs.length} conversations. Question/replay/truthfulness review is still required.`);
