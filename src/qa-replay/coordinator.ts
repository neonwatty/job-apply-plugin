import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJobsCli } from '../cli/native-jobs.js';
import { canonical, identifier, platforms, readJson, ReplayError, runIdentifier, scenarios, token, validateFixture, validateState,
  type Fixture, type RunState } from './contracts.js';
import { submissionStatus } from './approved-submission.js';
import { requireIsolatedPath, requireLoopbackOrigin, requireSubmissionRun, submissionFixture, submissionFixturesRoot, submissionInputs,
  runsRoot, submissionMode, submissionScenario, submissionScenariosRoot, withSubmissionLifecycle } from './submission-boundary.js';
import { batchFormRevision } from './submission-batch-store.js';
import { submissionJob } from './submission-jobs.js';
import { evaluateRun } from './oracle.js';
import { identity, request, serverState, shutdown, startServer } from './server-client.js';

const repositoryRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const fixturesRoot = () => resolve(process.env.JOB_APPLY_QA_FIXTURES_ROOT ?? join(repositoryRoot, 'qa/fixtures'));
const scenariosRoot = () => resolve(process.env.JOB_APPLY_QA_SCENARIOS_ROOT ?? join(repositoryRoot, 'qa/scenarios'));
const prompt = 'Use job-apply:job-apply on this approved local {platform} QA fixture: {url}. Use the isolated QA profile already prepared for this run. Operate the visible form normally and stop at final review exactly as you would on a live application.';

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.write-${randomBytes(16).toString('hex')}.tmp`);
  await writeFile(temporary, canonical(value), { mode: 0o600, flag: 'wx' }); await rename(temporary, path);
}
async function sourceDirectory(path: string, diagnostic: string): Promise<void> { try { if (!(await lstat(path)).isDirectory()) throw new Error(); } catch { throw new ReplayError(diagnostic); } }
async function copyRegular(source: string, destination: string, limit: number, diagnostic: string): Promise<void> {
  try { const info = await lstat(source); if (!info.isFile() || info.size > limit) throw new Error(); await copyFile(source, destination); await chmod(destination, 0o600); }
  catch { throw new ReplayError(diagnostic); }
}
async function privateDirectory(path: string, create = false): Promise<void> {
  try { if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const info = await lstat(path); if (!info.isDirectory() || info.mode % 0o1000 !== 0o700) throw new Error(); }
  catch { throw new ReplayError('run directory creation failed'); }
}
function dateStamp(now = new Date()): string { return now.toISOString().slice(0, 10).replaceAll('-', ''); }
async function store(root: string, args: string[]): Promise<unknown> {
  try { return JSON.parse(await runJobsCli(['--root', root, ...args], async () => '')) as unknown; }
  catch (error) { throw new ReplayError('isolated store initialization failed', { cause: error }); }
}
async function loaded(runId: string): Promise<{ root: string; state: RunState; fixture: Fixture }> {
  if (!runIdentifier.test(runId)) throw new ReplayError('invalid run identifier'); const root = join(await realpath(runsRoot()), runId);
  await privateDirectory(root); const state = validateState(await readJson(join(root, 'run.json'), 'invalid run state'), runId, root);
  if (state.mode === submissionMode) requireLoopbackOrigin(state.url);
  return { root, state, fixture: validateFixture(await readJson(join(root, 'fixture.json'), 'invalid fixture package')) };
}
function sameToken(left: string, right: string): boolean { return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
const reportKeys = new Set(['fixtureId', 'scenarioId', 'status', 'assertions', 'missingControlIds', 'failureCategories']);
const assertionNames = new Set(['required-fields-filled', 'resume-uploaded', 'resume-filename-matched', 'review-reached', 'history-started-reviewed',
  'history-not-completed', 'session-present', 'session-value-free', 'final-action-untouched']);
function validSubmissionSummary(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  if (summary.status === 'confirmed_submitted') {
    return Object.keys(summary).length === 2
      && typeof summary.receiptId === 'string' && /^receipt:[a-f0-9]{64}$/.test(summary.receiptId);
  }
  return Object.keys(summary).length === 1 && typeof summary.status === 'string'
    && ['awaiting_approval', 'approved', 'blocked', 'submission_uncertain'].includes(summary.status);
}

const failureCategories = new Set(['required-fields-missing', 'required-upload-missing', 'resume-filename-mismatch', 'review-not-reached', 'history-missing',
  'history-lifecycle-incomplete', 'history-completed', 'session-not-correlated', 'session-missing', 'session-value-present', 'final-action-activated']);
function validReport(value: unknown, state: RunState, fixture: Fixture): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false; const report = value as Record<string, unknown>;
  const assertions = report.assertions, missing = report.missingControlIds, categories = report.failureCategories;
  const required = new Set(fixture.steps.flatMap(step => step.controls).filter(control => control.required).map(control => control.id));
  const keys = state.mode === submissionMode ? new Set([...reportKeys, 'submission']) : reportKeys;
  if (Object.keys(report).length !== keys.size || Object.keys(report).some(key => !keys.has(key))
    || (state.mode === submissionMode && !validSubmissionSummary(report.submission)) || report.fixtureId !== state.fixtureId
    || report.scenarioId !== state.scenarioId || !['passed', 'failed'].includes(String(report.status)) || typeof assertions !== 'object' || assertions === null || Array.isArray(assertions)
    || Object.keys(assertions).length !== assertionNames.size || Object.keys(assertions).some(key => !assertionNames.has(key) || !['passed', 'failed'].includes(String((assertions as Record<string, unknown>)[key])))
    || !Array.isArray(missing) || missing.some(item => typeof item !== 'string' || !required.has(item)) || canonical(missing) !== canonical([...new Set(missing)].sort())
    || !Array.isArray(categories) || categories.some(item => typeof item !== 'string' || !failureCategories.has(item)) || canonical(categories) !== canonical([...new Set(categories)].sort())) return false;
  const passed = Object.values(assertions).every(item => item === 'passed') && missing.length === 0 && categories.length === 0;
  return (report.status === 'passed') === passed;
}
async function sanitize(root: string, retained: Set<string>, prefix = ''): Promise<void> {
  for (const name of await readdir(join(root, prefix))) { const relative = join(prefix, name), path = join(root, relative), info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new ReplayError('run cleanup failed');
    if (info.isDirectory()) await sanitize(root, retained, relative); else if (!retained.has(relative)) await writeFile(path, '', { mode: 0o600 });
  }
}
async function validateSanitized(root: string, retained: Set<string>, prefix = ''): Promise<boolean> {
  try { for (const name of await readdir(join(root, prefix))) { const relative = join(prefix, name), path = join(root, relative), info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return false; if (info.isDirectory()) { if (!await validateSanitized(root, retained, relative)) return false; }
    else if (!retained.has(relative) && info.size !== 0) return false; } return true;
  } catch { return false; }
}

export async function prepare(fixtureId: string, scenarioId: string, mode = 'review_only', jobId?: string,
  companion = false): Promise<Record<string, unknown>> {
  if (mode !== 'review_only' && mode !== submissionMode) throw new ReplayError('invalid replay mode');
  if (jobId !== undefined) {
    if (mode !== submissionMode && !companion) throw new ReplayError('synthetic job selection requires submit after approval');
    submissionJob(jobId);
  }
  const isolatedFixture = companion || mode === submissionMode;
  if (isolatedFixture && (fixtureId !== submissionFixture || scenarioId !== submissionScenario)) {
    throw new ReplayError('synthetic submission fixture is unsupported');
  }
  if (!identifier.test(fixtureId)) throw new ReplayError('invalid fixture identifier');
  if (!identifier.test(scenarioId) || !scenarios.has(scenarioId)) throw new ReplayError('invalid scenario identifier');
  const fixtureDirectory = join(isolatedFixture ? submissionFixturesRoot : fixturesRoot(), fixtureId);
  const scenarioDirectory = join(isolatedFixture ? submissionScenariosRoot : scenariosRoot(), scenarioId);
  await sourceDirectory(fixtureDirectory, 'invalid fixture package'); await sourceDirectory(scenarioDirectory, 'invalid scenario package');
  const fixture = validateFixture(await readJson(join(fixtureDirectory, 'fixture.json'), 'invalid fixture package'));
  const profile = await readJson(join(scenarioDirectory, 'profile.json'), 'invalid scenario package'), expected = await readJson(join(scenarioDirectory, 'expected.json'), 'invalid scenario package');
  if (fixture.id !== fixtureId || !platforms[fixture.platformFamily]) throw new ReplayError(fixture.id !== fixtureId ? 'invalid fixture package' : 'unsupported fixture platform');
  const controlIds = fixture.steps.flatMap(step => step.controls.map(control => control.id));
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile) || typeof expected !== 'object' || expected === null || Array.isArray(expected)
    || canonical(expected) !== canonical({ controlIds, resumeFilename: 'synthetic-resume.pdf' })) throw new ReplayError('invalid scenario package');
  if (isolatedFixture) {
    const selected = runsRoot();
    await requireIsolatedPath(join(await realpath(dirname(selected)), basename(selected)));
  }
  await privateDirectory(runsRoot(), true); let runId = '', runRoot = '';
  for (let attempt = 0; attempt < 10; attempt++) { runId = `qa-run-${dateStamp()}-${randomBytes(4).toString('hex')}`; runRoot = join(runsRoot(), runId); try { await mkdir(runRoot, { mode: 0o700 }); break; } catch { runRoot = ''; } }
  if (!runRoot) throw new ReplayError('run directory creation failed');
  runRoot = await realpath(runRoot);
  let state: RunState | null = null;
  try {
    for (const name of ['fixture.json', 'profile.json', 'synthetic-resume.pdf', 'expected.json']) await copyRegular(
      join(name === 'fixture.json' ? fixtureDirectory : scenarioDirectory, name), join(runRoot, name), name.endsWith('.pdf') ? 10 * 1024 * 1024 : 1024 * 1024,
      name === 'fixture.json' ? 'invalid fixture package' : 'invalid scenario package');
    const storeRoot = join(runRoot, 'store'); await store(storeRoot, ['fixture-init']); const inspected = await store(storeRoot, ['profile-inspect']) as Record<string, unknown>;
    if (!Number.isInteger(inspected.revision) || Number(inspected.revision) < 1) throw new ReplayError('isolated store initialization failed');
    const prepared = { ...(profile as Record<string, unknown>), resumePath: join(runRoot, 'synthetic-resume.pdf') }, preparedPath = join(runRoot, '.prepared-profile.json');
    await atomicJson(preparedPath, prepared); await store(storeRoot, ['profile-replace', '--input', preparedPath, '--expected-revision', String(inspected.revision), '--source', 'resume']); await unlink(preparedPath);
    const shutdownToken = randomBytes(32).toString('hex'), routeToken = randomBytes(32).toString('hex');
    if (isolatedFixture) await submissionInputs(runRoot, fixture);
    const startup = await startServer(join(runRoot, 'fixture.json'), 'synthetic-resume.pdf', shutdownToken,
      mode === submissionMode ? mode : undefined, jobId, companion);
    state = { fixtureId, scenarioId, url: startup.url, storeRoot, fixturePath: join(runRoot, 'fixture.json'), routeToken, shutdownToken,
      lifecycleNonce: randomBytes(32).toString('hex'), createdAt: new Date().toISOString(),
      ...(mode === submissionMode ? { mode } : {}), ...(jobId ? { jobId } : {}) };
    if (startup.fixtureId !== fixtureId) throw new ReplayError('fixture server startup failed');
    await atomicJson(join(runRoot, 'run.json'), state); await atomicJson(join(runRoot, 'lifecycle.json'), { state: 'prepared', nonce: state.lifecycleNonce });
    const url = `${startup.url}#qa-route=${runId}.${routeToken}`;
    return { fixtureId, scenarioId, url, storeRoot, ...(isolatedFixture ? { mode, runId } : {}),
      ...(jobId ? submissionJob(jobId) : {}), suggestedPrompt: prompt.replace('{platform}', platforms[fixture.platformFamily]!).replace('{url}', url) };
  } catch (error) { if (state) await shutdown(state, false); await rm(runRoot, { recursive: true, force: true }); throw error; }
}

export async function resolveRoute(route: string): Promise<Record<string, unknown>> {
  const match = /^(qa-run-20[0-9]{6}-[a-f0-9]{8})\.([a-f0-9]{64})$/.exec(route); if (!match) throw new ReplayError('unknown QA route');
  try { const { root, state } = await loaded(match[1]!); const lifecycle = await readJson(join(root, 'lifecycle.json'), 'invalid run state');
    if (canonical(lifecycle) !== canonical({ state: 'prepared', nonce: state.lifecycleNonce }) || !sameToken(state.routeToken, match[2]!)) throw new Error();
    for (const name of ['completed.json', 'abandoned.json']) try { await stat(join(root, name)); throw new Error(); } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
    return { storeRoot: state.storeRoot };
  } catch { throw new ReplayError('unknown QA route'); }
}

export async function transition(runId: string, name: 'started' | 'reviewed'): Promise<Record<string, unknown>> {
  const { root, state, fixture } = await loaded(runId); const lifecycle = await readJson(join(root, 'lifecycle.json'), 'invalid run state');
  if (canonical(lifecycle) !== canonical({ state: 'prepared', nonce: state.lifecycleNonce }) || await exists(join(root, 'completed.json')) || await exists(join(root, 'abandoned.json'))) throw new ReplayError('run is terminal'); await identity(state);
  if (name === 'reviewed') { const observed = await serverState(state), reviews = new Set(fixture.steps.filter(step => step.kind === 'review').map(step => step.id));
    if (!observed.events.some(event => event.type === 'reviewed' && event.controlId === '' && reviews.has(String(event.stepId))) || observed.finalActionActivations !== 0 || observed.events.some(event => event.type === 'final-action')) throw new ReplayError('replay review event not observed'); }
  let result: unknown; try { result = await store(state.storeRoot, ['replay-transition', '--id', runId, '--transition', name, '--ats', fixture.platformFamily]); }
  catch { throw new ReplayError('isolated lifecycle transition failed'); }
  if (typeof result !== 'object' || result === null || Array.isArray(result) || (result as Record<string, unknown>).applicationId !== runId || typeof (result as Record<string, unknown>).changed !== 'boolean') throw new ReplayError('isolated lifecycle transition failed');
  return { runId, transition: name, changed: (result as Record<string, unknown>).changed };
}

/** Owner-only CLI transport. The renderer's same-origin API can only capture a review. */
export async function submissionCommand(runId: string, action: 'preview' | 'approve' | 'submit' | 'cancel' | 'status',
  reviewRevision?: string, batchId?: string): Promise<Record<string, unknown>> {
  const { root, state, fixture } = await loaded(runId);
  if (state.mode !== submissionMode || state.fixtureId !== submissionFixture || state.scenarioId !== submissionScenario) {
    throw new ReplayError('run is in review-only mode');
  }
  const lifecycle = await readJson(join(root, 'lifecycle.json'), 'invalid run state');
  if (canonical(lifecycle) !== canonical({ state: 'prepared', nonce: state.lifecycleNonce })
    || await exists(join(root, 'completed.json')) || await exists(join(root, 'abandoned.json'))) {
    throw new ReplayError('run is terminal');
  }

  await requireSubmissionRun(root);
  const scopedRevision = batchId && reviewRevision ? batchFormRevision(batchId, reviewRevision) : undefined;
  if (action === 'status') {
    return withSubmissionLifecycle(root, async () => {
      if (await exists(join(root, 'completed.json')) || await exists(join(root, 'abandoned.json'))) {
        throw new ReplayError('run is terminal');
      }
      return submissionStatus(root, state.shutdownToken, scopedRevision);
    });
  }
  await identity(state);
  if (action !== 'cancel') {
    await submissionInputs(root, fixture);
    const observed = await serverState(state);
    const evidence = await evaluateRun(fixture, state.scenarioId, observed.events, state.storeRoot, runId);
    if (evidence.status !== 'passed') throw new ReplayError('verified synthetic review is required');
  }

  let response: Response;
  try {
    const endpoint = action === 'submit' && batchId ? 'batch-submit' : action;
    response = await request(`${state.url}/__qa/approved-submission/${endpoint}`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-QA-Run-Token': state.shutdownToken },
      body: JSON.stringify({ ...(reviewRevision ? { reviewRevision } : {}), ...(batchId ? { batchId } : {}) }),
    });
  } catch {
    if (action === 'submit') {
      return withSubmissionLifecycle(root, async () => {
        const reconciled = await submissionStatus(root, state.shutdownToken, scopedRevision);
        if (scopedRevision ? reconciled.status !== 'confirmed_submitted' : reconciled.status === 'approved') {
          return { status: 'submission_uncertain' };
        }
        return reconciled;
      });
    }
    throw new ReplayError('synthetic submission service is unavailable');
  }
  const output = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new ReplayError(typeof output.error === 'string' ? output.error : 'synthetic submission operation failed');
  return output;
}

export async function evaluate(runId: string): Promise<{ code: number; report: Record<string, unknown> }> {
  const { root, state, fixture } = await loaded(runId);
  const inspect = () => finishEvaluation(root, state, fixture);
  return state.mode === submissionMode ? withSubmissionLifecycle(root, inspect) : inspect();
}

async function finishEvaluation(root: string, state: RunState, fixture: Fixture): Promise<{ code: number; report: Record<string, unknown> }> {
  const reportPath = join(root, 'report.json');
  try { await stat(reportPath); const cached = await readJson(reportPath, 'invalid run report'); if (!validReport(cached, state, fixture)) throw new ReplayError('invalid run report');
    return { code: cached.status === 'passed' ? 0 : 1, report: cached }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const lock = await open(join(root, '.evaluate.lock'), 'wx', 0o600).catch(() => { throw new ReplayError('evaluation already in progress'); });
  let authenticated = false;
  try { const lifecycle = await readJson(join(root, 'lifecycle.json'), 'invalid run state'); if (canonical(lifecycle) !== canonical({ state: 'prepared', nonce: state.lifecycleNonce })) throw new ReplayError('run is abandoned');
    await identity(state); authenticated = true; const observed = await serverState(state); const report = await evaluateRun(fixture, state.scenarioId, observed.events, state.storeRoot);
    if (state.mode === submissionMode) report.submission = await submissionStatus(root, state.shutdownToken);
    await shutdown(state, true); authenticated = false; await atomicJson(reportPath, report); await atomicJson(join(root, 'completed.json'), { state: 'completed', nonce: state.lifecycleNonce });
    return { code: report.status === 'passed' ? 0 : 1, report };
  } catch (error) { await atomicJson(join(root, 'abandoned.json'), { state: 'abandoned', nonce: state.lifecycleNonce }).catch(() => {}); throw error; }
  finally { if (authenticated) await shutdown(state, false); await lock.close(); await unlink(join(root, '.evaluate.lock')).catch(() => {}); }
}

export async function cleanup(runId: string): Promise<Record<string, unknown>> {
  if (!runIdentifier.test(runId)) throw new ReplayError('invalid run identifier'); const candidate = join(await realpath(runsRoot()), runId);
  try { const existing = await readJson(join(candidate, 'tombstone.json'), 'invalid cleanup state') as Record<string, unknown>;
    const retained = new Set(['tombstone.json', ...(existing.reportRetained === true ? ['report.json'] : [])]), keys = ['runId', 'state', 'reportRetained', 'lifecycleNonce', 'fixtureId', 'scenarioId', 'reportSha256', 'mac'];
    let digestValid = existing.reportRetained !== true && existing.reportSha256 === null;
    if (existing.reportRetained === true) { const report = await readJson(join(candidate, 'report.json'), 'invalid run report'); digestValid = existing.reportSha256 === createHash('sha256').update(canonical(report)).digest('hex'); }
    if (Object.keys(existing).length === keys.length && keys.every(key => Object.hasOwn(existing, key)) && existing.runId === runId && ['completed', 'abandoned'].includes(String(existing.state))
      && existing.reportRetained === (existing.state === 'completed') && token.test(String(existing.lifecycleNonce)) && identifier.test(String(existing.fixtureId))
      && scenarios.has(String(existing.scenarioId)) && token.test(String(existing.mac)) && digestValid && await validateSanitized(candidate, retained))
      return { runId, state: existing.state, reportRetained: existing.reportRetained };
  } catch { /* An active run has no tombstone. */ }
  const { root, state, fixture } = await loaded(runId);
  const retire = () => retireRun(runId, root, state, fixture);
  return state.mode === submissionMode ? withSubmissionLifecycle(root, retire) : retire();
}

async function retireRun(runId: string, root: string, state: RunState, fixture: Fixture): Promise<Record<string, unknown>> {
  let cleanupState = 'abandoned', reportRetained = false, report: unknown = null;
  if (await exists(join(root, 'completed.json'))) {
    const marker = await readJson(join(root, 'completed.json'), 'invalid run state'); if (canonical(marker) !== canonical({ state: 'completed', nonce: state.lifecycleNonce })) throw new ReplayError('invalid run state');
    report = await readJson(join(root, 'report.json'), 'invalid run report'); if (!validReport(report, state, fixture)) throw new ReplayError('invalid run report'); cleanupState = 'completed'; reportRetained = true;
  } else { await shutdown(state, false); await atomicJson(join(root, 'abandoned.json'), { state: 'abandoned', nonce: state.lifecycleNonce }); }
  const fields = { runId, state: cleanupState, reportRetained, lifecycleNonce: state.lifecycleNonce, fixtureId: state.fixtureId, scenarioId: state.scenarioId,
    reportSha256: report === null ? null : createHash('sha256').update(canonical(report)).digest('hex') };
  const key = Buffer.concat([Buffer.from(state.routeToken, 'hex'), Buffer.from(state.shutdownToken, 'hex')]); const tombstone = { ...fields, mac: createHmac('sha256', key).update(canonical(fields)).digest('hex') };
  await atomicJson(join(root, 'tombstone.json'), tombstone); const retain = new Set(['tombstone.json', ...(reportRetained ? ['report.json'] : [])]); await sanitize(root, retain);
  return { runId, state: cleanupState, reportRetained };
}
