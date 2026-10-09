import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareFixture } from '../preparation/fixture.mjs';
export { introduceStaleFacts } from '../preparation/continuation-fixture.mjs';

export async function services(pluginRoot, fixture) {
  const load = path => import(pathToFileURL(join(pluginRoot, `runtime/${path}.js`)).href);
  const [{ NativeJobsRepository }, { loadPosixFlockProvider }, { ClaimsService },
    { WorkspaceProjectionsService }, values] = await Promise.all([load('store/native-jobs'), load('store/posix-flock'),
    load('workspace-core/claims'), load('workspace-core/workspace-projections'), load('contracts/workspace/values')]);
  const repository = new NativeJobsRepository(fixture.storeRoot, loadPosixFlockProvider(fixture.nativeLock));
  return { repository, claims: new ClaimsService(repository), projections: new WorkspaceProjectionsService(repository), values };
}
export async function prepareAttemptFixture(pluginRoot, workspace) {
  const fixture = { ...await prepareFixture(pluginRoot, workspace), workspace };
  const { claims } = await services(pluginRoot, fixture);
  await claims.select(fixture.jobId, 1n, true);
  return fixture;
}

// Snapshot all durable files under the canonical Store lock, including nested sessions and authority.
async function hashes(root, prefix = '') {
  const result = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(root, name));
    else if (entry.isFile() && /\.(json|jsonl|txt|pdf|docx)$/.test(name)) {
      result[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
export async function observeAttempt(pluginRoot, fixture) {
  const { repository, projections, values: { serialize, get } } = await services(pluginRoot, fixture);
  const plain = value => JSON.parse(serialize(value));
  const state = await repository.claimTransaction(async tx => {
    const jobs = plain(tx.jobs), coordinator = plain(tx.coordinator);
    const claim = coordinator.claim === null ? null : { ...coordinator.claim,
      capabilityFingerprint: createHash('sha256').update(coordinator.claim.tokenHash).digest('hex') };
    if (claim) delete claim.tokenHash;
    const runs = jobs.metadata.applicationRuns;
    return { job: jobs.jobs[fixture.jobId], otherJobs: Object.fromEntries(Object.entries(jobs.jobs).filter(([id]) => id !== fixture.jobId)), metadata: jobs.metadata, claim,
      activeRun: runs?.activeRunId ? runs.runs[runs.activeRunId] : null,
      sessions: tx.sessions.map(plain), history: tx.history.map(plain), hashes: await hashes(fixture.storeRoot) };
  });
  state.preflightReady = get(await projections.preflight(fixture.jobId), 'ready') === true;
  return state;
}

/** Harness-only time intervention, after the owned broker has exited. No model may edit a lease. */
export async function expireFixtureClaim(pluginRoot, fixture) {
  const { repository, values: { get, object, set, text } } = await services(pluginRoot, fixture);
  await repository.claimTransaction(async tx => {
    const claim = object(get(tx.coordinator, 'claim'), 'fixture claim');
    set(claim, 'expiresAt', text('2020-01-01T00:00:00Z'));
    await tx.saveCoordinator(tx.coordinator);
  });
}
