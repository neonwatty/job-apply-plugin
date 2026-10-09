#!/usr/bin/env node
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, hostEnvironment, installRevision, parseTrace, writeJson } from '../preparation/support.mjs';
import { prepareAttemptFixture, observeAttempt, introduceStaleFacts, expireFixtureClaim } from './fixture.mjs';
import { startBroker, cleanupBrokerArtifacts } from './broker.mjs';
import { comparisonArms, scenarioIds, scenarioTurns, trialPrompt, gradeState } from './scenarios.mjs';
import { attemptArguments, attemptContext, validateAttemptContext, fixtureSocket, probeHost } from './host.mjs';
import { repositoryIdentity, packageFingerprint, captureHarness } from './evidence.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const revisions = { baseline: 'f95b4947453ad6c6abc9cc0e81c3e443706d4714', candidate: '0dfe2fb429770efc31436ac649ee2ff0afe66d2f' };
let trials = 3, model = 'gpt-5.6-luna', scenarios = scenarioIds;
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index], value = process.argv[++index];
  if (flag === '--trials') trials = Number(value);
  else if (flag === '--model') model = value;
  else if (flag === '--candidate') revisions.candidate = value;
  else if (flag === '--scenario' && scenarioIds.includes(value)) scenarios = [value];
  else throw Error('Usage: run.mjs [--trials 1..10] [--model MODEL] [--candidate FULL_SHA] [--scenario ID]');
}
if (process.env.CI) throw Error('Authenticated model trials are local-only');
if (!Number.isInteger(trials) || trials < 1 || trials > 10 || !model || !/^[a-f0-9]{40}$/.test(revisions.candidate ?? '')) throw Error('Invalid trial options');
const harnessRevision = await repositoryIdentity(repository);
const version = await execute('codex', ['--version']);
if (version.code !== 0 || version.failure) throw Error('Codex CLI unavailable');
const output = join(repository, '.workflows/local', `attempt-eval-${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const report = { schemaVersion: 1, revisions, model, reasoningEffort: 'medium', cliVersion: version.stdout.trim(),
  hostProfile: 'attempt_eval: workspace plus exact fixture socket, proxy with no allowed domains',
  trials, scenarios, harnessRevision, harnessSources: await captureHarness(repository, output), runs: [], complete: false };
console.log(`Evidence: ${output}`);
try {
  for (const scenario of scenarios) for (let trial = 1; trial <= trials; trial++) {
    for (const arm of comparisonArms(scenario, trial)) {
      const name = `${scenario}-${trial}-${arm}`, evidence = join(output, name);
      await mkdir(evidence, { mode: 0o700 });
      const temporary = await realpath(await mkdtemp(join(tmpdir(), 'job-apply-attempt-eval-')));
      const run = { scenario, trial, arm, revision: revisions[arm], turns: [], brokers: [], cleanupComplete: false };
      report.runs.push(run);
      let installation, fixture;
      const brokers = [];
      try {
        installation = await installRevision(repository, revisions[arm], temporary);
        const workspace = join(temporary, 'workspace');
        await mkdir(workspace, { mode: 0o700 });
        fixture = await prepareAttemptFixture(installation.pluginRoot, workspace);
        run.packageFingerprint = await packageFingerprint(repository, installation.pluginRoot, revisions[arm]);
        brokers.push(await startBroker(installation.pluginRoot, fixture, arm));
        const socket = await fixtureSocket(installation.pluginRoot, fixture);
        run.hostProbe = await probeHost(installation.codexHome, fixture, socket);
        await writeJson(join(evidence, 'host-probe.json'), run.hostProbe);
        if (!run.hostProbe.passed) throw Error('Scoped broker host probe failed');
        run.initial = await observeAttempt(installation.pluginRoot, fixture);
        await writeJson(join(evidence, 'initial-state.json'), run.initial);
        let sessionId, sessionTurns = 0;
        const turns = scenarioTurns(scenario, fixture.jobId);
        for (let turn = 0; turn < turns.length; turn++) {
          if (turn === 1) {
            if (scenario === 'stale-inputs') await introduceStaleFacts(installation.pluginRoot, fixture);
            if (['broker-loss', 'expired-recovery'].includes(scenario)) {
              run.interruption = await brokers.at(-1).stop('SIGKILL');
              if (scenario === 'expired-recovery') await expireFixtureClaim(installation.pluginRoot, fixture);
              brokers.push(await startBroker(installation.pluginRoot, fixture, arm));
            }
          }
          const before = await observeAttempt(installation.pluginRoot, fixture), prefix = join(evidence, `turn-${turn + 1}`);
          await writeJson(`${prefix}-before.json`, before);
          if (turn === 1) run.beforeSecond = before;
          const previousSessionId = sessionId;
          if (turns[turn].fresh) { sessionId = undefined; sessionTurns = 0; }
          const prompt = trialPrompt(arm, turns[turn].request, installation, fixture);
          await writeFile(`${prefix}-prompt.txt`, prompt, { mode: 0o600 });
          const args = attemptArguments({ sessionId, workspace, model, socket });
          await writeJson(`${prefix}-invocation.json`, { command: 'codex', args, cwd: workspace });
          const result = await execute('codex', args, { cwd: workspace, env: hostEnvironment(installation.codexHome, fixture.storeRoot),
            timeout: 360000, input: prompt });
          await writeFile(`${prefix}-trace.jsonl`, result.stdout, { mode: 0o600 });
          await writeFile(`${prefix}-stderr.txt`, result.stderr, { mode: 0o600 });
          const trace = parseTrace(result.stdout), state = await observeAttempt(installation.pluginRoot, fixture);
          const effectiveContext = trace.sessionId ? await attemptContext(installation.codexHome, trace.sessionId) : null;
          const receipt = { turn: turn + 1, fresh: Boolean(turns[turn].fresh), code: result.code, signal: result.signal,
            failure: result.failure, elapsedMs: result.elapsedMs, ...trace, effectiveContext, state };
          run.turns.push(receipt);
          await writeJson(`${prefix}-receipt.json`, receipt);
          await writeJson(join(output, 'report.json'), report);
          console.log(`${name} turn ${turn + 1}: ${result.code}, ${state.job.status}, ${trace.commands.length} shell calls, ${result.elapsedMs}ms`);
          if (result.code !== 0 || result.failure || !trace.completed || !trace.sessionId) throw Error(`Incomplete model turn: ${name}/${turn + 1}`);
          validateAttemptContext(effectiveContext, { workspace, model, turn: ++sessionTurns });
          if (sessionId && sessionId !== trace.sessionId) throw Error('Continuation changed session identity');
          if (turns[turn].fresh && trace.sessionId === previousSessionId) throw Error('Fresh context reused prior session');
          sessionId = trace.sessionId;
          if (await packageFingerprint(repository, installation.pluginRoot, revisions[arm]) !== run.packageFingerprint) throw Error('Installed package changed');
          if (await repositoryIdentity(repository) !== harnessRevision) throw Error('Repository changed during trial');
        }
        run.grade = gradeState(scenario, run.turns.map(turn => turn.state), run.initial, run.beforeSecond, arm);
        console.log(`${name}: deterministic state ${run.grade.statePassed ? 'pass' : 'FAIL'}; transcript review required`);
      } finally {
        // Retain the fixture if cleanup cannot establish that its brokers stopped.
        try {
          const stopped = await Promise.allSettled(brokers.map(async broker => ({ pid: broker.pid, ...await broker.stop() })));
          run.brokers = stopped.map(result => result.status === 'fulfilled' ? result.value : { error: String(result.reason) });
          if (stopped.some(result => result.status === 'rejected')) throw Error('Broker cleanup failed');
          if (installation && fixture) run.removedBrokerArtifacts = await cleanupBrokerArtifacts(installation.pluginRoot, fixture);
          await rm(temporary, { recursive: true, force: true });
          run.cleanupComplete = true;
        } catch (error) { run.retainedTemporaryRoot = temporary; run.cleanupError = String(error); throw error; }
        finally { await writeJson(join(output, 'report.json'), report); }
      }
    }
  }
  report.complete = true;
} finally { await writeJson(join(output, 'report.json'), report); }
console.log(`Completed ${report.runs.length} conversations. State grades do not substitute for transcript review.`);
