import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import * as extraction from './workspace_resume_workflow_support.mjs';
import * as preparation from './workspace_durable_preparation_support.mjs';
export { read, plain } from './workspace_resume_workflow_support.mjs';
export { host, event, pending, readyPacket } from './workspace_durable_claims_support.mjs';

/** Include managed files, sessions and immutable archive segments in no-write assertions. */
export async function snapshot(root) {
  const entries = {};
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name, path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, `${relative}/`);
      else if (entry.isFile()) entries[relative] = (await readFile(path)).toString('base64');
    }
  }
  await visit(root);
  return entries;
}
export async function unchanged(state, operation, pattern) {
  const before = await snapshot(state.root);
  await assert.rejects(operation, pattern);
  assert.deepEqual(await snapshot(state.root), before);
}
export async function setup(fixture, name) {
  const state = await extraction.setup(fixture, name);
  state.clock = { now: '2026-10-10T12:00:00Z' };
  const now = () => state.clock.now;
  state.jobs = new JobsService(state.repository, now);
  state.claims = new ClaimsService(state.repository, now);
  for (const id of ['job', 'other']) await state.jobs.create(fromJSON({
    id, url: `https://example.invalid/${id}`, role: 'Engineer', company: 'Synthetic', ats: 'greenhouse',
  }));
  const profile = await extraction.read(state.root, 'profile.json');
  profile.profile.name = 'UNRELATED PRIVATE PROFILE';
  profile.profile.preferences = { location: 'UNRELATED PRIVATE PREFERENCE' };
  await writeFile(join(state.root, 'profile.json'), JSON.stringify(profile), { mode: 0o600 });
  state.before = await snapshot(state.root);
  state.otherFacts = (await extraction.read(state.root, 'resume-facts.json')).sets.other;
  return state;
}
export async function extractAndStartRun(state) {
  const { workflow } = extraction.runtime(state);
  const start = extraction.start('extract-start');
  const started = await workflow.route(start);
  const propose = extraction.propose(started.receipt.task, 'extract-propose');
  const proposed = await workflow.action(propose);
  const ask = { ...extraction.ask(proposed.receipt.task), operationId: 'extract-review' };
  const waiting = await workflow.action(ask);
  const fresh = extraction.runtime(state).workflow;
  const reply = await extraction.reply(fresh, waiting.receipt.task);
  reply.proposal.operationId = 'extract-reply';
  const accepted = await fresh.route(reply.proposal, reply.attestation);
  const facts = extraction.plain(await state.facts.get('source'));
  assert.equal(facts.state, 'confirmed');
  assert.equal(facts.revision, 2);
  assert.equal(facts.versions.length, 2);
  const runs = new ApplicationRunsService(state.repository, () => state.clock.now);
  state.run = extraction.plain(await runs.start('source', 1n, BigInt(facts.revision), true,
    fromJSON({ jobIds: ['job', 'other'] })));
  return { start, started, propose, proposed, ask, waiting, reply, accepted };
}
export async function prepareJob(state, id = 'job') {
  const { workflow } = preparation.runtime(state);
  const start = { ...preparation.start(`prepare-${id}`), input: { jobId: id, jobRevision: '1' } };
  const started = await workflow.route(start);
  const ask = preparation.ask(started.receipt.task, `prepare-${id}-review`);
  const waiting = await workflow.action(ask);
  const reply = preparation.reply(waiting.receipt.task, 'confirm', `prepare-${id}-reply`);
  const fresh = preparation.runtime(state).workflow;
  const ready = await fresh.route(reply.proposal, reply.attestation);
  assert.equal(ready.receipt.outcome, 'job_ready');
  return { start, started, ask, waiting, reply, ready };
}
export async function assertUnrelatedPreserved(state) {
  const current = await snapshot(state.root);
  assert.equal(current['profile.json'], state.before['profile.json']);
  assert.equal(current['resumes.json'], state.before['resumes.json']);
  for (const [path, value] of Object.entries(state.before)) {
    if (path.startsWith('resumes/')) assert.equal(current[path], value);
  }
  assert.deepEqual((await extraction.read(state.root, 'resume-facts.json')).sets.other, state.otherFacts);
}
/** Seed only capacity, then exercise actual locked native archival publication and replay. */
export async function archivePressure(state, receiptId) {
  const jobs = await extraction.read(state.root, 'jobs.json'), ledger = jobs.metadata.agentWorkflows;
  assert.equal(ledger.schemaVersion, 2);
  let index = 0;
  while (Object.keys(ledger.receipts).length < 253) {
    const operationId = `capacity-${index++}`, receipt = structuredClone(ledger.receipts[receiptId]);
    receipt.receipt.operationId = operationId;
    ledger.receipts[operationId] = receipt;
  }
  await writeFile(join(state.root, 'jobs.json'), JSON.stringify(jobs), { mode: 0o600 });
}
