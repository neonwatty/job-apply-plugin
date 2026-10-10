import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, writeFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, start, propose, ask, snapshot, read } from './workspace_resume_workflow_support.mjs';
const execute = promisify(execFile);

test('installed fixture host resumes extraction and requires exact explicit user-event attestation', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const state = await setup(fixture, 'installed'), plugin = join(await realpath(fixture.root), 'plugin'), home = join(await realpath(fixture.root), 'unused-home');
    await cp(new URL('../runtime/', import.meta.url), join(plugin, 'runtime'), { recursive: true });
    await mkdir(home);
    await writeFile(join(plugin, 'package.json'), '{"type":"module"}');
    const script = join(plugin, 'runtime/cli/experimental-resume-workflow.js');
    let serial = 0;
    async function cli(command, payload, extra = [], scoped = true) {
      const args = [command, ...(scoped ? ['--root', state.root, '--native-lock', fixture.receipt.artifact] : []), ...extra];
      if (payload !== undefined) {
        const input = join(fixture.root, `input-${++serial}.json`);
        await writeFile(input, JSON.stringify(payload), { mode: 0o600 }); args.push('--input', input);
      }
      let result;
      try { result = { ...await execute(process.execPath, [script, ...args], { cwd: plugin, env: { PATH: '', HOME: home }, timeout: 15000 }), code: 0 }; }
      catch (error) { if (typeof error.code !== 'number') throw error; result = error; }
      assert.equal(result.stderr, ''); assert.ok([0, 2].includes(result.code));
      assert.doesNotMatch(result.stdout, /PRIVATE|private\.txt|unused-home|stack/);
      return JSON.parse(result.stdout);
    }
    const before = await snapshot(state.root);
    assert.equal((await cli('context', undefined, [], false)).ok, false);
    assert.deepEqual(await snapshot(state.root), before);
    assert.deepEqual(await readdir(home), []);
    const started = await cli('route', start()); assert.equal(started.ok, true);
    const proposed = await cli('action', propose(started.result.receipt.task)); assert.equal(proposed.ok, true);
    const waiting = await cli('action', ask(proposed.result.receipt.task)); assert.equal(waiting.ok, true);
    const context = await cli('context'); assert.equal(context.result.approvalEvidence, 'host_attestation');
    const task = waiting.result.receipt.task;
    const event = { kind: 'continue', operationId: 'accept', taskId: task.taskId, expectedRevision: task.revision,
      event: { ...context.result.review, decision: 'accept' } };
    const paused = await snapshot(state.root);
    assert.equal((await cli('route', event)).error, 'user_event_required');
    assert.equal((await cli('reply', event)).error, 'user_event_required');
    assert.deepEqual(await snapshot(state.root), paused);
    const accepted = await cli('reply', event, ['--host-user-event']);
    assert.equal(accepted.result.receipt.outcome, 'extraction_accepted');
    const after = await snapshot(state.root);
    assert.equal((await cli('reply', event, ['--host-user-event'])).result.replayed, true);
    assert.deepEqual(await snapshot(state.root), after);
    assert.equal((await read(state.root, 'resume-facts.json')).sets.source.versions.at(-1).state, 'confirmed');
    await writeFile(join(state.root, '.native-jobs-fixture'), 'wrong\n', { mode: 0o600 });
    assert.equal((await cli('context')).ok, false);
  } finally { await fixture.cleanup(); }
});
