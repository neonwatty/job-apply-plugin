#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { agentArguments, execute, hostEnvironment, installRevision, parseTrace, sessionContext, validateContext, writeJson } from './support.mjs';
import { prepareContinuationFixture, observeContinuation, introduceStaleFacts } from './continuation-fixture.mjs';
import { scenarioIds, scenarioTurns, trialPrompt, gradeState } from './continuation-scenarios.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const revisions = { baseline: 'f95b4947453ad6c6abc9cc0e81c3e443706d4714', candidate: '9f940d64bbd2c9aec657b6933b596b8de0387be4' };
let trials = 3, model = 'gpt-5.6-luna', scenarios = scenarioIds;
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index], value = process.argv[++index];
  if (flag === '--trials') trials = Number(value);
  else if (flag === '--model') model = value;
  else if (flag === '--candidate') revisions.candidate = value;
  else if (flag === '--scenario' && scenarioIds.includes(value)) scenarios = [value];
  else throw Error('Usage: continuation-run.mjs [--trials 1..10] [--model MODEL] [--candidate FULL_SHA] [--scenario ID]');
}
if (process.env.CI) throw Error('Authenticated model trials are local-only');
if (!Number.isInteger(trials) || trials < 1 || trials > 10 || !model || !/^[a-f0-9]{40}$/.test(revisions.candidate ?? '')) throw Error('Invalid trial options');
async function repositoryIdentity() {
  const head = await execute('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const status = await execute('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repository });
  if (head.code !== 0 || status.code !== 0 || head.failure || status.failure || status.stdout.trim()) throw Error('Model trials require a clean repository');
  return head.stdout.trim();
}
const harnessRevision = await repositoryIdentity();
const version = await execute('codex', ['--version']);
if (version.code !== 0 || version.failure) throw Error('Codex CLI unavailable');
const output = join(repository, '.workflows/local', `continuation-eval-${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const report = { schemaVersion: 1, revisions, model, reasoningEffort: 'medium', cliVersion: version.stdout.trim(),
  trials, scenarios, harnessRevision, harnessSources: {}, runs: [], complete: false };
await mkdir(join(output, 'executed-harness'), { mode: 0o700 });
for (const name of ['continuation-run.mjs', 'continuation-fixture.mjs', 'continuation-scenarios.mjs', 'support.mjs', 'fixture.mjs']) {
  const source = await readFile(join(repository, 'evals/preparation', name));
  report.harnessSources[name] = createHash('sha256').update(source).digest('hex');
  await writeFile(join(output, 'executed-harness', name), source, { mode: 0o600 });
}
console.log(`Evidence: ${output}`);

async function packageFingerprint(pluginRoot, revision) {
  const listing = await execute('git', ['ls-tree', '-r', '--name-only', revision, '--',
    'runtime', 'skills', 'apps/companion', '.codex-plugin', '.claude-plugin', 'native/packaged-lock'], { cwd: repository });
  if (listing.code !== 0 || listing.failure) throw Error('Cannot enumerate installed package sources');
  const digest = createHash('sha256');
  for (const path of listing.stdout.trim().split('\n').filter(Boolean).sort()) {
    digest.update(path).update('\0').update(createHash('sha256').update(await readFile(join(pluginRoot, path))).digest('hex')).update('\n');
  }
  return digest.digest('hex');
}

try {
  for (const scenario of scenarios) for (let trial = 1; trial <= trials; trial++) {
    for (const arm of trial % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      const name = `${scenario}-${trial}-${arm}`, evidence = join(output, name);
      await mkdir(evidence, { mode: 0o700 });
      const temporary = await realpath(await mkdtemp(join(tmpdir(), 'job-apply-continuation-eval-')));
      const run = { scenario, trial, arm, revision: revisions[arm], turns: [], cleanupComplete: false };
      report.runs.push(run);
      try {
        const installation = await installRevision(repository, revisions[arm], temporary);
        const workspace = join(temporary, 'workspace');
        await mkdir(workspace, { mode: 0o700 });
        const fixture = await prepareContinuationFixture(installation.pluginRoot, workspace, scenario);
        run.packageFingerprint = await packageFingerprint(installation.pluginRoot, revisions[arm]);
        run.initial = await observeContinuation(installation.pluginRoot, fixture);
        await writeJson(join(evidence, 'initial-state.json'), run.initial);
        const turns = scenarioTurns(scenario, fixture.jobId);
        let sessionId, sessionTurns = 0;
        for (let turn = 0; turn < turns.length; turn++) {
          if (turn === 1 && scenario === 'stale-facts') await introduceStaleFacts(installation.pluginRoot, fixture);
          const before = await observeContinuation(installation.pluginRoot, fixture);
          const prefix = join(evidence, `turn-${turn + 1}`);
          await writeJson(`${prefix}-before.json`, before);
          if (turn === 1) run.beforeSecond = before;
          const previousSessionId = sessionId;
          if (turns[turn].fresh) { sessionId = undefined; sessionTurns = 0; }
          const prompt = trialPrompt(arm, turns[turn].request, installation, fixture, workspace);
          await writeFile(`${prefix}-prompt.txt`, prompt, { mode: 0o600 });
          const args = agentArguments({ sessionId, workspace, model });
          await writeJson(`${prefix}-invocation.json`, { command: 'codex', args, cwd: workspace });
          const result = await execute('codex', args, { cwd: workspace, env: hostEnvironment(installation.codexHome, fixture.storeRoot),
            timeout: 360000, input: prompt });
          await writeFile(`${prefix}-trace.jsonl`, result.stdout, { mode: 0o600 });
          await writeFile(`${prefix}-stderr.txt`, result.stderr, { mode: 0o600 });
          const trace = parseTrace(result.stdout), state = await observeContinuation(installation.pluginRoot, fixture);
          const effectiveContext = trace.sessionId ? await sessionContext(installation.codexHome, trace.sessionId) : null;
          const receipt = { turn: turn + 1, fresh: Boolean(turns[turn].fresh), code: result.code, signal: result.signal,
            failure: result.failure, elapsedMs: result.elapsedMs, ...trace, effectiveContext, state };
          run.turns.push(receipt);
          await writeJson(`${prefix}-receipt.json`, receipt);
          await writeJson(join(output, 'report.json'), report);
          console.log(`${name} turn ${turn + 1}: ${result.code}, ${state.job.status}, preflight ${state.preflightReady}, ${trace.commands.length} shell calls, ${result.elapsedMs}ms`);
          if (result.code !== 0 || result.failure || !trace.completed || !trace.sessionId) throw Error(`Incomplete model turn: ${name}/${turn + 1}`);
          validateContext(effectiveContext, { workspace, model, turn: ++sessionTurns });
          if (sessionId && sessionId !== trace.sessionId) throw Error('Continuation changed session identity');
          if (turns[turn].fresh && trace.sessionId === previousSessionId) throw Error('Fresh context reused prior session');
          sessionId = trace.sessionId;
          if (await packageFingerprint(installation.pluginRoot, revisions[arm]) !== run.packageFingerprint) throw Error('Installed package changed during model execution');
          if (await repositoryIdentity() !== harnessRevision) throw Error('Repository changed during model execution');
          if (state.claim !== null || state.sessions.length) throw Error('Preparation exceeded claim/session scope');
        }
        run.grade = gradeState(scenario, run.turns.map(t => t.state), run.beforeSecond, arm);
        console.log(`${name}: deterministic state ${run.grade.statePassed ? 'pass' : 'FAIL'}; transcript review required`);
      } finally {
        await rm(temporary, { recursive: true, force: true });
        run.cleanupComplete = true;
        await writeJson(join(output, 'report.json'), report);
      }
    }
  }
  report.complete = true;
} finally { await writeJson(join(output, 'report.json'), report); }
console.log(`Completed ${report.runs.length} conversations. State grades do not substitute for transcript review.`);
