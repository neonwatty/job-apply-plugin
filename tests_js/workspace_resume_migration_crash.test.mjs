import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture, child } from './exclusive_file_lock_support.mjs';
import { setup, read, snapshot, runtime, start } from './workspace_resume_workflow_support.mjs';
import { fullLedger } from './workspace_workflow_archive_support.mjs';
import { NativeWorkflowArchive } from '../runtime/store/native-workflow-archive.js';
import { NativeStoreBootstrap } from '../runtime/store/native-store-bootstrap.js';
const url = path => new URL(path, import.meta.url).href;
const script = `
import { relative } from 'node:path';
import { NativeJobsRepository } from ${JSON.stringify(url('../runtime/store/native-jobs.js'))};
import { loadPosixFlockProvider } from ${JSON.stringify(url('../runtime/store/posix-flock.js'))};
import { atomicWritePointJson } from ${JSON.stringify(url('../runtime/store/point-persistence.js'))};
import { NativeResumeWorkflowTasks } from ${JSON.stringify(url('../runtime/store/native-resume-workflow-tasks.js'))};
import { ResumeExtractionWorkflow } from ${JSON.stringify(url('../runtime/app/resume-extraction-workflow.js'))};
import { extractionProfile } from ${JSON.stringify(url('../runtime/workflows/resumes/extract.js'))};
import { get } from ${JSON.stringify(url('../runtime/contracts/workspace/values.js'))};
import { start } from ${JSON.stringify(url('./workspace_resume_workflow_support.mjs'))};
const [root, artifact, boundary] = process.argv.slice(1);
async function checkpoint(stage) {
  if (stage === boundary) { console.log('migration-boundary'); await new Promise(() => setInterval(() => {}, 1000)); }
}
const repository = new NativeJobsRepository(root, loadPosixFlockProvider(artifact), async (path, value, options) => {
  await atomicWritePointJson(path, value, options);
  await checkpoint(relative(root, path) === 'resume-extraction-journal.json'
    ? get(value, 'operation') === null ? 'clear' : 'journal' : relative(root, path));
}, checkpoint);
const workflow = new ResumeExtractionWorkflow(new NativeResumeWorkflowTasks(repository),
  () => ({ enabled: [extractionProfile], authorized: [extractionProfile] }));
await workflow.route(start());
throw Error('passed migration kill boundary');
`;

test('first resume migration recovers v1 history at every archive and journal process-kill boundary', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  for (const boundary of ['archive_file_written', 'archive_file_synced', 'archive_segment_published',
    'journal', 'resume-extraction-requests.json', 'jobs.json', 'clear']) await t.test(boundary, async () => {
    const state = await setup(fixture, boundary.replaceAll('.', '-'));
    const jobs = await read(state.root, 'jobs.json');
    const ledger = fullLedger(new NativeWorkflowArchive(state.root)); ledger.schemaVersion = 1; delete ledger.archive;
    jobs.metadata.agentWorkflows = ledger;
    await writeFile(join(state.root, 'jobs.json'), JSON.stringify(jobs), { mode: 0o600 });
    const writer = child(script, [state.root, fixture.receipt.artifact, boundary]);
    try {
      await writer.line('migration-boundary'); assert.equal(writer.process.kill('SIGKILL'), true);
      assert.deepEqual(await writer.exited, { code: null, signal: 'SIGKILL' });
    } finally { await writer.stop(); }
    // Both bootstrap preflight and the ordinary locked Store recovery must accept
    // the old root plus unpublished data without treating that data as authority.
    await new NativeStoreBootstrap(state.root, join(fixture.root, 'absent-legacy')).initialize();
    await state.repository.transaction(async () => {});
    const result = await runtime(state).workflow.route(start());
    assert.equal(result.replayed, ['journal', 'resume-extraction-requests.json', 'jobs.json', 'clear'].includes(boundary));
    const final = (await read(state.root, 'jobs.json')).metadata.agentWorkflows;
    assert.equal(final.schemaVersion, 2); assert.equal(final.archive.segments.length, 1);
    const prepared = await new NativeWorkflowArchive(state.root).prepare(final);
    assert.deepEqual(prepared.history.receipt('op-task-0'), ledger.receipts['op-task-0']);
    assert.equal(Object.keys((await read(state.root, 'resume-extraction-requests.json')).requests).length, 1);
    const before = await snapshot(state.root);
    assert.equal((await runtime(state).workflow.route(start())).replayed, true);
    assert.deepEqual(await snapshot(state.root), before);
  });
});
