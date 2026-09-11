import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, read, snapshot, invoke, input, parity, failure } from './workspace_native_task_cli_support.mjs';
import { setup as groupedSetup, revisions } from './workspace_native_grouped_approvals_support.mjs';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';

// Each oracle runs on a fresh copy: Python and native code never share a writable Store.
test('native task wrapper preserves all ten Python command envelopes and owner boundaries', { timeout: 120000 }, async t => {
  const fixture = await nativeFixture();
  try {
    await t.test('snapshot, activity, intake and selection', async () => {
      const state = await setup(fixture, 'task-jobs');
      const before = await snapshot(state.root);
      for (const args of [['snapshot'], ['activity', '--id', 'job']]) {
        const result = await parity(fixture, state.root, args);
        assert.equal(result.ok, true);
        assert.equal(result.command, args[0]);
      }
      assert.deepEqual(await snapshot(state.root), before);
      failure(await parity(fixture, state.root, ['activity', '--id', 'missing']), 'job_unavailable');
      const intake = ['intake', ...await input(fixture, { url: 'https://example.invalid/job', description: 'PRIVATE-description' })];
      const changed = await parity(fixture, state.root, intake, { mutation: true });
      assert.equal(changed.action, 'update');
      assert.equal((await parity(fixture, state.root, intake)).action, 'noop');
      const args = ['select', '--id', 'job', '--expected-revision', String(changed.job.revision)];
      failure(await parity(fixture, state.root, args), 'owner_confirmation_required');
      const selected = await parity(fixture, state.root, [...args, '--owner-confirmed'], { mutation: true });
      assert.equal(selected.action, 'ready');
      failure(await parity(fixture, state.root, [...args, '--owner-confirmed']), 'stale_revision');
      assert.equal((await parity(fixture, state.root, ['select', '--id', 'job', '--expected-revision',
        String(selected.job.revision), '--owner-confirmed'])).action, 'noop');
    });
    await t.test('semantic lookup and approved cleanup', async () => {
      const state = await setup(fixture, 'task-cleanup');
      const answers = new AnswersService(state.repository, () => '2026-09-10T12:00:00Z');
      await answers.put(fromJSON({ question: 'Does the applicant have permission to work in this jurisdiction?',
        state: 'confirmed', value: 'PRIVATE-ANSWER', scope: {} }));
      await answers.observe(fromJSON({ question: 'Is employment authorization available in the country?', state: 'missing', scope: {} }));
      const lookup = await parity(fixture, state.root, ['semantic-lookup', ...await input(fixture, {
        question: 'Is employment authorization available in the country?', scope: {}, fieldClass: 'general',
        sensitivity: 'none', mode: 'strict', useAuthority: 'accepted_record', limit: 5,
      })]);
      assert.ok(lookup.candidates.length);
      const preview = await parity(fixture, state.root, ['cleanup-preview']);
      assert.ok(preview.proposals.length);
      const proposal = preview.proposals[0];
      const payload = Object.fromEntries(['winnerKey', 'duplicateKey', 'winnerRevision', 'duplicateRevision'].map(key => [key, proposal[key]]));
      payload.previewToken = preview.previewToken;
      const args = ['cleanup-approve', ...await input(fixture, payload)];
      failure(await parity(fixture, state.root, args), 'owner_confirmation_required');
      failure(await parity(fixture, state.root, ['cleanup-approve', '--owner-confirmed',
        ...await input(fixture, { ...payload, previewToken: 'stale' })]), 'stale_revision');
      const approved = await parity(fixture, state.root, [...args, '--owner-confirmed'], { mutation: true });
      assert.equal(approved.approved, true);
    });
    await t.test('grouped approvals and pending answer resolution', async () => {
      const state = await groupedSetup(fixture, 'task-approval');
      const [jobRevision, sessionRevision] = await revisions(state);
      const options = ['--id', 'job', '--expected-job-revision', String(jobRevision),
        '--expected-session-revision', String(sessionRevision), ...await input(fixture, { decisions: state.decisions })];
      const preview = await parity(fixture, state.root, ['approval-preview', ...options]);
      assert.equal(preview.mutated, false);
      const args = ['approval-approve', ...options, '--preview-token', preview.previewToken];
      failure(await parity(fixture, state.root, args), 'owner_confirmation_required');
      failure(await parity(fixture, state.root, ['approval-approve', ...options, '--preview-token', 'stale', '--owner-confirmed']), 'stale_revision');
      assert.equal((await parity(fixture, state.root, [...args, '--owner-confirmed'], { mutation: true })).approved, true);
      const revs = await revisions(state);
      const resolve = ['resolve-pending-answer', '--id', 'job', '--reference', state.decisions[0].reference,
        '--expected-job-revision', String(revs[0]), '--expected-session-revision', String(revs[1]), '--expected-answer-revision', '1'];
      failure(await parity(fixture, state.root, resolve), 'owner_confirmation_required');
      const result = await parity(fixture, state.root, [...resolve, '--owner-confirmed'], { mutation: true });
      assert.equal(result.ok, true);
      assert.equal(result.ready, false);
    });
  } finally { await fixture.cleanup(); }
});

test('native task wrapper redacts malformed requests and keeps input file-only', { timeout: 120000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const state = await setup(fixture, 'task-invalid');
    const before = await snapshot(state.root);
    for (const args of [[], ['unknown'], ['snapshot', '--private-unknown'], ['activity'],
      ['select', '--id', 'job', '--expected-revision', '1.0'],
      ['select', '--id', 'job', '--expected-revision', 'PRIVATE-number'],
      ['intake'], ['intake', '--input', join(fixture.root, 'PRIVATE-missing')],
      ['intake', ...await input(fixture, 'not json PRIVATE-secret')],
      ['intake', ...await input(fixture, Buffer.from([0xff, 0xfe]))],
      ['intake', ...await input(fixture, [])],
      ['intake', ...await input(fixture, '{"url":"https://example.invalid/new","priority":1.0}')],
      ['approval-preview', '--id', 'job', '--expected-job-revision', '1', '--expected-session-revision', '1',
        ...await input(fixture, { decisions: [], extra: 'PRIVATE-secret' })],
    ]) failure(await parity(fixture, state.root, args), 'invalid_request');
    // '-' is an ordinary filename, including when that file happens to exist.
    failure(await parity(fixture, state.root, ['intake', '--input', '-'], { cwd: fixture.root }), 'invalid_request');
    await writeFile(join(fixture.root, '-'), JSON.stringify({ url: 'https://example.invalid/job' }));
    assert.equal((await parity(fixture, state.root, ['intake', '--input', '-'], { cwd: fixture.root })).action, 'noop');
    assert.deepEqual(await snapshot(state.root), before);
    const unavailable = await invoke(fixture, state.root, ['snapshot'], { globals: false });
    assert.equal(unavailable.code, 2);
    assert.equal(unavailable.value.ok, false);
    assert.deepEqual(await snapshot(state.root), before);
  } finally { await fixture.cleanup(); }
});

test('native task wrapper preserves arbitrary integer tokens and Python revision argument syntax', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const state = await setup(fixture, 'task-numbers');
    const jobs = await read(state.root, 'jobs.json');
    const huge = '900719925474099312345';
    // Keep the raw integer lexeme; JSON.parse would erase the precision this protocol promises.
    jobs.jobs.job.revision = 'BIG_REVISION';
    await writeFile(join(state.root, 'jobs.json'), JSON.stringify(jobs).replace('"BIG_REVISION"', huge));
    const activity = await invoke(fixture, state.root, ['activity', '--id', 'job']);
    assert.equal(activity.code, 0);
    assert.match(activity.stdout, new RegExp(`"revision"\\s*:\\s*${huge}`));
    await parity(fixture, state.root, ['activity', '--id', 'job']);
    const selected = await parity(fixture, state.root, ['select', '--id', 'job', '--expected-revision', huge, '--owner-confirmed'], { mutation: true });
    assert.equal(selected.action, 'ready');
    const after = await invoke(fixture, state.root, ['activity', '--id', 'job']);
    assert.match(after.stdout, /"revision"\s*:\s*900719925474099312346/);
    // argparse accepts signs, underscores, whitespace and Unicode decimal digits.
    for (const revision of ['+1', ' 1 ', '١', '1_0', '-1', '0']) {
      await parity(fixture, state.root, ['select', '--id', 'other', '--expected-revision', revision, '--owner-confirmed'], { mutation: true });
    }
  } finally { await fixture.cleanup(); }
});


test('native task bootstrap and addon load failures stay inside the redacted JSON protocol', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const state = await setup(fixture, 'task-bootstrap');
    const before = await snapshot(state.root);
    const isolatedEntry = join(fixture.root, 'PRIVATE-isolated-task.mjs');
    await copyFile(new URL('../runtime/cli/native-task.js', import.meta.url), isolatedEntry);
    const missingRunner = await invoke(fixture, state.root, ['snapshot'], { entry: isolatedEntry });
    const missingAddon = await invoke(fixture, state.root, [
      '--root', state.root, '--native-lock', join(fixture.root, 'PRIVATE-missing-addon.node'), 'snapshot',
    ], { globals: false });
    for (const result of [missingRunner, missingAddon]) {
      assert.equal(result.code, 2);
      assert.deepEqual(result.value, {
        ok: false, error: { code: 'store_unavailable', message: 'The canonical store is unavailable.' },
      });
      assert.equal(result.stdout.includes(fixture.root), false);
    }
    assert.deepEqual(await snapshot(state.root), before);
  } finally { await fixture.cleanup(); }
});
