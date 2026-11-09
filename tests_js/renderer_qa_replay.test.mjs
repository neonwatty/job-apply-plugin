import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runReplayCli } from '../runtime/cli/native-qa-replay.js';

const root = resolve(import.meta.dirname, '..');
const execute = promisify(execFile);
async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'native-qa-replay-'))), fixtures = join(temporary, 'fixtures'), scenarios = join(temporary, 'scenarios'), runs = join(temporary, 'runs');
  await cp(join(root, 'qa/fixtures/greenhouse-single-page-2026-08-v1'), join(fixtures, 'greenhouse-single-page-2026-08-v1'), { recursive: true });
  await cp(join(root, 'qa/scenarios/greenhouse-complete-profile'), join(scenarios, 'greenhouse-complete-profile'), { recursive: true });
  await mkdir(runs, { mode: 0o700 }); await chmod(runs, 0o700);
  const previous = [process.env.JOB_APPLY_QA_FIXTURES_ROOT, process.env.JOB_APPLY_QA_SCENARIOS_ROOT, process.env.JOB_APPLY_QA_RUNS_ROOT];
  Object.assign(process.env, { JOB_APPLY_QA_FIXTURES_ROOT: fixtures, JOB_APPLY_QA_SCENARIOS_ROOT: scenarios, JOB_APPLY_QA_RUNS_ROOT: runs });
  t.after(async () => { [process.env.JOB_APPLY_QA_FIXTURES_ROOT, process.env.JOB_APPLY_QA_SCENARIOS_ROOT, process.env.JOB_APPLY_QA_RUNS_ROOT] = previous; await rm(temporary, { recursive: true, force: true }); });
  return { runs };
}
async function post(url, event) {
  const base = new URL(url).origin, response = await fetch(`${base}/__qa/event`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(event) });
  assert.equal(response.status, 204, await response.text());
}

test('native replay completes and sanitizes a supervised fixture lifecycle', { timeout: 60000 }, async t => {
  const { runs } = await fixture(t), prepared = (await runReplayCli(['prepare', '--fixture', 'greenhouse-single-page-2026-08-v1', '--scenario', 'greenhouse-complete-profile'])).output;
  const route = new URL(prepared.url).hash.slice('#qa-route='.length), runId = route.split('.')[0], runRoot = join(runs, runId);
  assert.equal((await runReplayCli(['resolve', '--route-token', route])).output.storeRoot, prepared.storeRoot);
  await assert.rejects(runReplayCli(['resolve', '--route-token', `${runId}.${'b'.repeat(64)}`]), /unknown QA route/);
  assert.equal((await runReplayCli(['started', '--run-id', runId])).output.changed, true);
  assert.equal((await runReplayCli(['started', '--run-id', runId])).output.changed, false);
  await assert.rejects(runReplayCli(['reviewed', '--run-id', runId]), /replay review event not observed/);
  const replayFixture = JSON.parse(await readFile(join(runRoot, 'fixture.json'), 'utf8'));
  for (const step of replayFixture.steps) {
    for (const control of step.controls) await post(prepared.url, { type: control.role === 'file' ? 'uploaded' : 'filled', controlId: control.id, stepId: step.id,
      ...(control.role === 'file' ? { expectedFilenameMatched: true } : {}) });
    await post(prepared.url, { type: step.kind === 'review' ? 'reviewed' : 'advanced', controlId: '', stepId: step.id });
  }
  assert.equal((await runReplayCli(['reviewed', '--run-id', runId])).output.changed, true);
  const evaluated = await runReplayCli(['evaluate', '--run-id', runId]); assert.equal(evaluated.exitCode, 0); assert.equal(evaluated.output.status, 'passed');
  const cleaned = await runReplayCli(['cleanup', '--run-id', runId]); assert.deepEqual(cleaned.output, { runId, state: 'completed', reportRetained: true });
  assert.deepEqual((await runReplayCli(['cleanup', '--run-id', runId])).output, cleaned.output);
  const nonempty = [];
  async function inspect(directory, prefix = '') { for (const name of await readdir(directory)) { const path = join(directory, name), relative = join(prefix, name), info = await lstat(path);
    if (info.isDirectory()) await inspect(path, relative); else if ((await stat(path)).size) nonempty.push(relative); } }
  await inspect(runRoot); assert.deepEqual(nonempty.sort(), ['report.json', 'tombstone.json']);
});

test('native auto-submit verification exercises the closed policy matrix without Python on PATH', { timeout: 60000 }, async () => {
  const { stdout } = await execute(process.execPath, [join(root, 'runtime/cli/native-qa-replay.js'), 'verify-auto-submit', '--fixture',
    join(root, 'qa/fixtures/linkedin-easy-apply-screening-2026-08-v1/fixture.json'), '--json'], { cwd: root, env: { ...process.env, PATH: '' } });
  const output = JSON.parse(stdout); assert.equal(output.status, 'passed'); assert.equal(output.redacted, true);
  assert.equal(Object.keys(output.assertions).length, 11); assert.ok(Object.values(output.assertions).every(value => value === 'passed'));
});
