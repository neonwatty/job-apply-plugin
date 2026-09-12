import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { cli, plain, read, setup, snapshot, write } from './workspace_native_claims_support.mjs';
import { AccountOperationService } from '../runtime/workspace-core/account-operation.js';
import { AccountsService } from '../runtime/workspace-core/accounts.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { text } from '../runtime/contracts/workspace/values.js';

const portal = 'https://example.wd1.myworkdayjobs.com/en-US/careers/job/42';

test('native account operation status and recovery fail stranded work closed', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  try {
    const state = await setup(fixture, 'account-operation');
    const { root, repository, jobs, claims, clock } = state;
    const operationPath = join(root, 'account-operation-journal.json');
    assert.equal((await stat(operationPath)).mode & 0o777, 0o600);
    const service = new AccountOperationService(repository, () => clock.now);

    await t.test('idle projections are read-only across service, HTTP, and CLI', async () => {
      const before = await snapshot(root);
      assert.deepEqual(plain(await service.status()), { status: 'idle', operation: null });
      assert.deepEqual(plain(await service.recover()), { status: 'idle', recovered: false });
      const get = await jobsHttp(jobs, repository, 'GET', '/api/account-operation');
      assert.deepEqual(JSON.parse(get.body), { status: 'idle', operation: null });
      const post = await jobsHttp(jobs, repository, 'POST', '/api/account-operation/recover', '{}');
      assert.deepEqual(JSON.parse(post.body), { status: 'idle', recovered: false });
      assert.equal((await jobsHttp(jobs, repository, 'POST', '/api/account-operation/recover', '{"extra":true}')).status, 400);
      assert.deepEqual(await cli(fixture, root, 'employer-account-operation-status'), { status: 'idle', operation: null });
      assert.deepEqual(await snapshot(root), before);
    });

    await t.test('pending status is redacted and recovery marks account ambiguous and hands off the live job', async () => {
      await claims.select('job', 1n, true);
      const acquired = plain(await claims.acquire('job', text('Synthetic owner'), 2n));
      const account = plain(await new AccountsService(repository, () => clock.now).create(portal));
      const operation = {
        operationId: 'operation-recovery', jobId: 'job', jobRevision: acquired.job.revision,
        claimId: acquired.claim.claimId, realmRef: account.realmRef, accountRevision: account.revision,
        settingsRevision: 1, stage: 'prepared', outcomeCode: 'observed_pending', startedAt: clock.now,
      };
      await write(root, 'account-operation-journal.json', { schemaVersion: 1, operation });
      const status = plain(await service.status());
      assert.deepEqual(status, { status: 'recovery_required', operation: {
        operationId: operation.operationId, jobId: 'job', realmRef: account.realmRef,
        stage: 'prepared', outcomeCode: 'observed_pending',
      } });
      assert.doesNotMatch(JSON.stringify(status), new RegExp(operation.claimId));
      assert.doesNotMatch(JSON.stringify(status), /jobRevision|accountRevision|settingsRevision/);

      const recovered = plain(await service.recover());
      assert.equal(recovered.status, 'ambiguous');
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.retryAllowed, false);
      assert.equal(recovered.account.lifecycleState, 'ambiguous');
      assert.equal(recovered.account.revision, 2);
      assert.deepEqual(recovered.job, { id: 'job', status: 'needs_info', revision: 4 });
      assert.equal((await read(root, 'account-operation-journal.json')).operation, null);
      assert.equal((await read(root, 'coordinator.json')).claim, null);
      assert.equal((await read(root, 'jobs.json')).jobs.job.status, 'needs_info');
      const session = await read(root, 'sessions/job.json');
      assert.equal(session.step, 'account_automation_denied:ambiguous_recovery');
      assert.deepEqual(session.blockers, [{ type: 'browser_handoff', code: 'browser-state-uncertain' }]);
      const history = (await readFile(join(root, 'applications.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(history.at(-1).event, 'job-blocked');
      assert.deepEqual(await cli(fixture, root, 'employer-account-operation-recover'), { status: 'idle', recovered: false });
    });

    await t.test('identity mismatch and unavailable jobs preserve the pending journal', async () => {
      const accounts = await read(root, 'employer-accounts.json');
      const realmRef = Object.keys(accounts.accounts)[0];
      const operation = { operationId: 'operation-missing', jobId: 'missing', jobRevision: 1,
        claimId: 'claim-private', realmRef, accountRevision: accounts.accounts[realmRef].revision,
        settingsRevision: 1, stage: 'signup_in_progress', outcomeCode: 'ambiguity', startedAt: clock.now };
      await write(root, 'account-operation-journal.json', { schemaVersion: 1, operation });
      const before = await readFile(operationPath);
      await assert.rejects(repository.accountOperationTransaction(tx => tx.clearOperation('other')), /changed before completion/);
      assert.deepEqual(await readFile(operationPath), before);
      await assert.rejects(service.recover(), /job is unavailable/);
      assert.deepEqual(await readFile(operationPath), before);
    });
  } finally { await fixture.cleanup(); }
});
