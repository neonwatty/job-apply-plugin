import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOperatorApprovalSession } from '../runtime/integrations/host/approval-session.js';
import { createTerminalApprovalSurface } from '../runtime/integrations/host/terminal-approval.js';
import { createUserEventAuthority } from '../runtime/harness/user-events.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setupHost, host, event, read, snapshot } from './workspace_host_browser_support.mjs';
const deployment = { modelTransport: 'json_proposals_only', operatorChannel: 'host_private_terminal' };
const denied = /user_event_required/;

function authorityFixture() {
  let at = 0;
  const authority = createUserEventAuthority(() => at);
  const review = { event: event('acquire'), binding: { eventFingerprint: 'a'.repeat(64), inputRevision: 'b'.repeat(64) } };
  const session = createOperatorApprovalSession({ approvals: authority.approvals, review: async () => review }, deployment, () => at);
  return { session, review, verifier: authority.verifier, advance: value => { at = value; } };
}

test('operator challenges are immutable, bounded, single-use and separate from idempotent grants', async () => {
  const { session, review, verifier, advance } = authorityFixture();
  const challenge = await session.challenge(review.event, 100);
  assert.throws(() => { challenge.review.event.jobId = 'changed'; }, TypeError);
  await assert.rejects(session.challenge(review.event), denied);
  await assert.rejects(session.decide('wrong-challenge', 'approve'), denied);
  assert.equal((await session.decide(challenge.challengeId, 'approve')).status, 'approved');
  await assert.rejects(session.decide(challenge.challengeId, 'approve'), denied);
  verifier.require(review.binding); verifier.require(review.binding);
  session.revoke(challenge.challengeId);
  assert.throws(() => verifier.require(review.binding), denied);
  const expired = await session.challenge(review.event, 10); advance(10);
  await assert.rejects(session.decide(expired.challengeId, 'approve'), denied);
  const revoked = await session.challenge(review.event, 10); session.revoke(revoked.challengeId);
  await assert.rejects(session.decide(revoked.challengeId, 'approve'), denied);
  const refused = await session.challenge(review.event, 10);
  assert.equal((await session.decide(refused.challengeId, 'deny')).status, 'denied');
  assert.throws(() => verifier.require(review.binding), denied);
  const valid = await session.challenge(review.event, 10);
  await session.decide(valid.challengeId, 'approve'); advance(9);
  await assert.rejects(session.challenge(review.event), denied);
  assert.throws(() => verifier.require(review.binding), denied);
  for (const lifetime of [0, -1, 0.5, 300001, NaN, Infinity]) {
    await assert.rejects(authorityFixture().session.challenge(review.event, lifetime), denied);
  }
});

test('concurrent close/revocation and expiry during re-review cannot issue a grant', async () => {
  for (const action of ['close', 'revoke', 'expire']) {
    let at = 0, release, reviews = 0;
    const authority = createUserEventAuthority(() => at);
    const review = { event: event('acquire'), binding: { eventFingerprint: 'a'.repeat(64), inputRevision: 'b'.repeat(64) } };
    const session = createOperatorApprovalSession({ approvals: authority.approvals,
      review: async () => { if (++reviews === 2) await new Promise(resolve => { release = resolve; }); return review; },
    }, deployment, () => at);
    const challenge = await session.challenge(review.event, 10);
    const decision = session.decide(challenge.challengeId, 'approve');
    if (action === 'close') session.close();
    else if (action === 'revoke') session.revoke(challenge.challengeId);
    else at = 10;
    release();
    await assert.rejects(decision, denied);
    assert.throws(() => authority.verifier.require(review.binding), denied);
  }
});

test('competing asynchronous challenge reviews keep only the latest immutable review', async () => {
  const fixture = authorityFixture(), releases = [];
  const session = createOperatorApprovalSession({ approvals: { approve: () => assert.fail('unexpected approval'), revoke() {} },
    review: async () => { await new Promise(resolve => releases.push(resolve)); return fixture.review; },
  }, deployment);
  const first = session.challenge(fixture.review.event), second = session.challenge(fixture.review.event);
  releases[0](); await assert.rejects(first, denied);
  releases[1](); const current = await second;
  assert.equal((await session.decide(current.challengeId, 'deny')).status, 'denied');
  session.close();
});

test('a real canonical browser host rejects model self-approval, changed scope, stale tasks and revoked grants', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setupHost(fixture, 'operator-session');
  const ports = host(state); t.after(() => ports.host.close());
  const session = createOperatorApprovalSession(ports.host, deployment); t.after(() => session.close());
  const request = event('acquire'), before = await snapshot(state.root);
  await assert.rejects(ports.model.event(request), denied);
  assert.equal('approvals' in ports.model, false);
  const changed = await session.challenge(request);
  await assert.rejects(ports.model.event({ ...request, approval: changed.challengeId }), /invalid_event/);
  assert.deepEqual(await snapshot(state.root), before);
  const jobs = await read(state.root, 'jobs.json'), run = jobs.metadata.applicationRuns.runs[state.run.runId];
  run.revision++; run.queueVersions.push({ ...run.queueVersions.at(-1), revision: run.revision });
  await writeFile(join(state.root, 'jobs.json'), JSON.stringify(jobs), { mode: 0o600 });
  const changedBytes = await snapshot(state.root);
  await assert.rejects(session.decide(changed.challengeId, 'approve'), denied);
  assert.deepEqual(await snapshot(state.root), changedBytes);
  await assert.rejects(ports.model.event(request), denied);
  const approved = await session.challenge(request);
  await session.decide(approved.challengeId, 'approve');
  await assert.rejects(ports.model.event({ ...request, operationId: 'different' }), denied);
  const task = (await ports.model.event(request)).receipt.task;
  assert.equal((await ports.model.event(request)).replayed, true);
  const cancel = event('cancel', task), stale = await session.challenge(cancel);
  const current = (await ports.model.event(event('progress', task))).receipt.task;
  await assert.rejects(session.decide(stale.challengeId, 'approve'), /task_conflict/);
  const next = event('cancel', current), renewed = await session.challenge(next);
  await session.decide(renewed.challengeId, 'approve'); session.revoke(renewed.challengeId);
  await assert.rejects(ports.model.event(next), denied);
  await ports.model.event(event('handoff', current));
  assert.equal((await read(state.root, 'coordinator.json')).claim, null);
});

function simulatedTerminal(reply) {
  // Fixture-only stand-in for operator typing. This is not evidence of a human approval.
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; output.isTTY = true; output.columns = 120;
  let text = '', sent = false;
  output.on('data', bytes => {
    text += bytes.toString();
    const match = text.match(/Type approve ([a-f0-9-]{36}) or deny/);
    if (match && !sent) { sent = true; setImmediate(() => input.write(`${reply(match[1])}\n`)); }
  });
  return { input, output, text: () => text };
}

test('dedicated terminal feeds exact decisions into the real host without publishing an approval model tool', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setupHost(fixture, 'operator-terminal'), ports = host(state);
  t.after(() => ports.host.close());
  const session = createOperatorApprovalSession(ports.host, deployment);
  const terminal = simulatedTerminal(id => `approve ${id}`);
  const surface = createTerminalApprovalSurface(session, terminal.input, terminal.output);
  t.after(() => surface.close());
  const request = event('acquire');
  await assert.rejects(ports.model.event(request), denied);
  const decision = await surface.review(request);
  assert.equal(decision.status, 'approved');
  assert.match(terminal.text(), /"inputRevision": "[a-f0-9]{64}"/);
  assert.match(terminal.text(), /"jobRevision": "2"/);
  const task = (await ports.model.event(request)).receipt.task;
  surface.close();
  await assert.rejects(ports.model.event(request), denied);
  await ports.model.event(event('handoff', task));
});

test('unrestricted deployment, non-terminal streams, JSON assertions and terminal closure fail closed', async () => {
  const fixture = authorityFixture();
  for (const config of [undefined, {}, { ...deployment, modelTransport: 'shell' }]) {
    assert.throws(() => createOperatorApprovalSession({}, config), /broker_unavailable/);
  }
  assert.throws(() => createTerminalApprovalSurface(fixture.session, new PassThrough(), new PassThrough()), /broker_unavailable/);
  const terminal = simulatedTerminal(id => JSON.stringify({ challengeId: id, decision: 'approve', user: true }));
  const surface = createTerminalApprovalSurface(fixture.session, terminal.input, terminal.output);
  await assert.rejects(surface.review(fixture.review.event), denied);
  assert.throws(() => fixture.verifier.require(fixture.review.binding), denied);
  surface.close();
  await assert.rejects(surface.review(fixture.review.event), /broker_unavailable/);
});


test('simulated terminal EOF revokes an existing grant and rejects the pending question', async () => {
  const fixture = authorityFixture();
  const earlier = await fixture.session.challenge(fixture.review.event);
  await fixture.session.decide(earlier.challengeId, 'approve');
  fixture.verifier.require(fixture.review.binding);
  // Simulated stream EOF exercises readline closure; it is not human provenance.
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; output.isTTY = true; output.columns = 120;
  let text = '', ended = false;
  output.on('data', bytes => {
    text += bytes.toString();
    if (text.includes('Type approve') && !ended) { ended = true; setImmediate(() => input.end()); }
  });
  const surface = createTerminalApprovalSurface(fixture.session, input, output);
  try {
    await assert.rejects(surface.review(fixture.review.event), error => error.name === 'AbortError');
    assert.throws(() => fixture.verifier.require(fixture.review.binding), denied);
    await assert.rejects(surface.review(fixture.review.event), /broker_unavailable/);
  } finally { surface.close(); }
});

test('simulated terminal timeout issues no grant and consumes its unanswered challenge', async () => {
  const fixture = authorityFixture();
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; output.isTTY = true; output.columns = 120;
  let text = ''; output.on('data', bytes => { text += bytes.toString(); });
  const surface = createTerminalApprovalSurface(fixture.session, input, output);
  try {
    await assert.rejects(surface.review(fixture.review.event, 30), error => error.name === 'AbortError');
    const id = text.match(/Type approve ([a-f0-9-]{36}) or deny/)?.[1];
    assert.ok(id, 'the fixture question was displayed before its unanswered timeout');
    await assert.rejects(fixture.session.decide(id, 'approve'), denied);
    assert.throws(() => fixture.verifier.require(fixture.review.binding), denied);
    const next = await fixture.session.challenge(fixture.review.event);
    assert.equal((await fixture.session.decide(next.challengeId, 'deny')).status, 'denied');
  } finally { surface.close(); }
});

test('close or revocation while the first canonical challenge review awaits prevents publication', async () => {
  for (const action of ['close', 'revoke']) {
    const fixture = authorityFixture();
    let release;
    const session = createOperatorApprovalSession({
      approvals: { approve: () => assert.fail('unexpected grant'), revoke() {} },
      review: async () => { await new Promise(resolve => { release = resolve; }); return fixture.review; },
    }, deployment);
    const challenge = session.challenge(fixture.review.event);
    if (action === 'close') session.close();
    else session.revoke('prior-operator-decision');
    release(); await assert.rejects(challenge, denied);
    session.close();
  }
});
