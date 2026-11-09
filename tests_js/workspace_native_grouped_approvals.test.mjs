import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, revisions, preview, differential, unchanged, plain, read, write, snapshot, at } from './workspace_native_grouped_approvals_support.mjs';
import { cli } from './workspace_native_claims_support.mjs';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { GroupedApprovalsService } from '../runtime/workspace-core/grouped-approvals.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';

test('native grouped approvals preserve Python policy, privacy and revision contracts', {timeout:120000}, async t => {
  const fixture = await nativeFixture();
  try {
    await t.test('preview is deterministic and approval stores only field decisions', async () => {
      const state = await setup(fixture, 'parity');
      const before = await snapshot(state.root);
      const initial = await preview(state);
      assert.equal(initial.mutated, false);
      assert.ok(initial.approvals.every(item => item.eligible));
      assert.deepEqual(await preview(state, [...state.decisions].reverse()), initial);
      assert.deepEqual(await snapshot(state.root), before);
      await differential(state, join(fixture.root, 'parity-python'), [
        {decisions:state.decisions},
        {decisions:[state.decisions[0]], approve:true},
        {decisions:[state.decisions[1]], approve:true},
        {decisions:[{...state.decisions[0], currentUse:false, useAuthority:'none', remember:true}], approve:true},
      ]);
      const session = await read(state.root, 'sessions/job.json');
      assert.equal(session.approvals.length, 2);
      const denied = session.approvals.find(item => item.reference === state.decisions[0].reference);
      assert.equal(denied.currentUse, false); assert.equal(denied.eligible, false); assert.equal(denied.remember, true);
      assert.equal((await stat(join(state.root, 'sessions/job.json'))).mode & 0o777, 0o600);
      assert.doesNotMatch(await readFile(join(state.root, 'sessions/job.json'), 'utf8'), /PRIVATE-/);
    });
    await t.test('malformed, stale and owner-unconfirmed decisions are unchanged differential failures', async () => {
      const state = await setup(fixture, 'errors'), first = state.decisions[0];
      await differential(state, join(fixture.root, 'errors-python'), [
        {decisions:[]}, {decisions:[first,first]},
        {decisions:[{...first, extra:'PRIVATE-INVALID'}]},
        {decisions:[{...first, answerKey:''}]},
        {decisions:[{...first, reference:`pending_${'f'.repeat(32)}`}]},
        {decisions:[{...first, currentUse:1}]},
        {decisions:[{...first, currentUse:false}]},
        {decisions:[{...first, answerKey:'absent'}]},
        {decisions:[{...first, answerKey:'second'}]},
        {decisions:[{...first, policyMode:'PRIVATE-INVALID'}]},
        {decisions:[{...first, allowedSensitiveFieldClasses:'invalid'}]},
        {decisions:[first], jobRevision:1},
        {decisions:[first], sessionRevision:1},
        {decisions:[first], approve:true, token:'tampered'},
        {decisions:[first], approve:true, confirmed:false},
      ]);
    });
    await t.test('scope and sensitive-field restrictions cannot be overridden by current use', async () => {
      const state = await setup(fixture, 'policy');
      const session = await read(state.root, 'sessions/job.json');
      session.pendingFields[0].scopeFingerprint = '0'.repeat(64);
      session.pendingFields[1].sensitive = true;
      await write(state.root, 'sessions/job.json', session);
      await differential(state, join(fixture.root, 'policy-python'), [
        {decisions:state.decisions}, {decisions:state.decisions, approve:true},
      ]);
      const result = await preview(state);
      assert.equal(result.approvals.find(item => item.reference === state.decisions[0].reference).eligible, false);
      assert.ok(result.approvals.find(item => item.reference === state.decisions[0].reference).reasonCodes.includes('scope_mismatch'));
      assert.equal(result.approvals.find(item => item.reference === state.decisions[1].reference).eligible, false);
    });
    await t.test('partial approval prunes obsolete answer revisions and retains current decisions', async () => {
      const state = await setup(fixture, 'retention');
      const initial = await preview(state);
      await state.service.approve('job', ...await revisions(state), fromJSON(state.decisions), initial.previewToken, true);
      const answers = await read(state.root, 'answers.json');
      answers.answers.first.revision += 1;
      await write(state.root, 'answers.json', answers);
      await differential(state, join(fixture.root, 'retention-python'), [
        {decisions:[state.decisions[0]]},
        {decisions:[state.decisions[1]], approve:true},
      ]);
      const session = await read(state.root, 'sessions/job.json');
      assert.deepEqual(session.approvals.map(item => item.answerKey).sort(), ['second','third']);
    });
    await t.test('retired answer identities resolve to the current canonical answer', async () => {
      const state = await setup(fixture, 'redirect');
      const answers = await read(state.root, 'answers.json');
      answers.redirects = {...answers.redirects, retired:{targetKey:'first', mergedAt:at}};
      await write(state.root, 'answers.json', answers);
      const session = await read(state.root, 'sessions/job.json');
      session.pendingFields[0].answerKey = 'retired';
      await write(state.root, 'sessions/job.json', session);
      const decision = {...state.decisions[0], answerKey:'retired'};
      await differential(state, join(fixture.root, 'redirect-python'), [{decisions:[decision]}, {decisions:[decision], approve:true}]);
      assert.equal((await read(state.root, 'sessions/job.json')).approvals[0].answerKey, 'first');
    });
    await t.test('answer changes between preview and commit are rejected under the second lock', async () => {
      const state = await setup(fixture, 'answer-race'), current = await preview(state), revs = await revisions(state);
      const before = await readFile(join(state.root, 'sessions/job.json'), 'utf8');
      const service = new GroupedApprovalsService(state.repository, () => at);
      const original = service.preview.bind(service);
      service.preview = async (...args) => {
        const result = await original(...args);
        await state.answers.update('first', fromJSON({aliases:['First authorization field']}), 1n);
        return result;
      };
      await assert.rejects(() => service.approve('job', ...revs, fromJSON(state.decisions), current.previewToken, true), /grouped approval state changed/);
      assert.equal(await readFile(join(state.root, 'sessions/job.json'), 'utf8'), before);
    });
    await t.test('an active coordinator claim remains intact during owner approval', async () => {
      const state = await setup(fixture, 'claimed', {claimed:true});
      const before = await readFile(join(state.root, 'coordinator.json'), 'utf8');
      await differential(state, join(fixture.root, 'claimed-python'), [{decisions:state.decisions, approve:true}]);
      assert.equal(await readFile(join(state.root, 'coordinator.json'), 'utf8'), before);
    });
    await t.test('competing approvals accept one session revision and reject the stale writer', async () => {
      const state = await setup(fixture, 'concurrent'), current = await preview(state), revs = await revisions(state);
      const reopened = new GroupedApprovalsService(new NativeJobsRepository(state.root, state.provider), () => at);
      const result = await Promise.allSettled([state.service, reopened].map(service => service.approve(
        'job', ...revs, fromJSON(state.decisions), current.previewToken, true)));
      assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
      assert.match(result.find(item => item.status === 'rejected').reason.message, /session revision conflict/);
      assert.equal((await read(state.root, 'sessions/job.json')).approvals.length, 3);
    });
    await t.test('write errors propagate without a successful result or partial session change', async () => {
      const state = await setup(fixture, 'write-failure'), current = await preview(state), revs = await revisions(state);
      const repository = new NativeJobsRepository(state.root, state.provider, async () => {throw Error('fixture write failed');});
      const service = new GroupedApprovalsService(repository, () => at);
      assert.deepEqual(plain(await service.preview('job', ...revs, fromJSON(state.decisions))), current);
      await unchanged(state.root, () => service.approve('job', ...revs, fromJSON(state.decisions), current.previewToken, true), /fixture write failed/);
    });
    await t.test('CLI previews and commits using the native fixture with Python absent', async () => {
      const state = await setup(fixture, 'cli'), revs = await revisions(state);
      const flags = ['--id','job','--expected-job-revision',String(revs[0]),'--expected-session-revision',String(revs[1])];
      const current = await cli(fixture, state.root, 'approval-preview', flags, {decisions:state.decisions});
      assert.deepEqual(current, await preview(state));
      const approved = await cli(fixture, state.root, 'approval-approve', [...flags,'--preview-token',current.previewToken,'--owner-confirmed'], {decisions:state.decisions});
      assert.equal(approved.approved, true);
      assert.equal(approved.approvals.length, 3);
      assert.doesNotMatch(JSON.stringify(approved), /PRIVATE-|tokenHash/);
    });
  } finally { await fixture.cleanup(); }
});
