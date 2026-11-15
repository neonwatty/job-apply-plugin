import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const execute = promisify(execFile);
const root = new URL('../', import.meta.url);
const fixture = 'linkedin-easy-apply-screening-2026-08-v1';
const scenario = 'linkedin-screening';
const email = 'qa-screening-browser@example.invalid';
const phone = '480-555-0198';

const resumeFilename = 'synthetic-resume.pdf';
const controls = ['contact.email', 'contact.phone', 'resume.file', 'preference.top_choice', 'authorization.sponsorship'];

async function screeningFixture() {
  const folder = new URL('qa/scenarios/' + scenario + '/', root);
  const filenames = await readdir(folder, { withFileTypes: true });
  assert.deepEqual(filenames.map(entry => entry.name).sort(), ['expected.json', 'profile.json', resumeFilename]);
  assert.ok(filenames.every(entry => entry.isFile()), 'screening inputs must be regular files');
  const profile = JSON.parse(await readFile(new URL('profile.json', folder), 'utf8'));
  assert.equal(profile.name, 'Avery Replay');
  assert.match(profile.email, /^[a-z.]+@example\.com$/);
  assert.match(profile.phone, /^[2-9]\d{2}-555-01\d{2}$/);
  assert.equal(profile.resumePath, resumeFilename);
  const expected = JSON.parse(await readFile(new URL('expected.json', folder), 'utf8'));
  assert.deepEqual(expected, { controlIds: controls, resumeFilename });
  for (const value of [profile.name, profile.email, profile.phone]) {
    assert.equal(JSON.stringify(expected).toLowerCase().includes(value.toLowerCase()), false);
  }
  const resume = await readFile(new URL(resumeFilename, folder));
  assert.ok(resume.equals(await readFile(new URL('qa/scenarios/complete-profile/' + resumeFilename, root))),
    'screening resume must match the canonical synthetic resume');
  return resume;
}

test('committed LinkedIn screening fixture reaches native review with zero final action', { timeout: 60_000 }, async t => {
  const syntheticResume = await screeningFixture();
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'linkedin-screening-')));
  const runs = join(temporary, 'runs');
  const env = { ...process.env, JOB_APPLY_QA_RUNS_ROOT: runs,
    JOB_APPLY_QA_FIXTURES_ROOT: fileURLToPath(new URL('qa/fixtures/', root)),
    JOB_APPLY_QA_SCENARIOS_ROOT: fileURLToPath(new URL('qa/scenarios/', root)) };
  let runId;
  const replay = async (command, ...args) => {
    const { stdout, stderr } = await execute(process.execPath, ['runtime/cli/native-qa-replay.js', command, ...args], {
      cwd: root, env, timeout: 20_000,
    });
    assert.equal(stderr, '', command);
    return JSON.parse(stdout);
  };
  t.after(async () => {
    try { if (runId) await replay('cleanup', '--run-id', runId); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  });
  await mkdir(runs, { mode: 0o700 });
  await chmod(runs, 0o700);
  const prepared = await replay('prepare', '--fixture', fixture, '--scenario', scenario);
  const url = new URL(prepared.url);
  runId = new URLSearchParams(url.hash.slice(1)).get('qa-route')?.split('.')[0];
  assert.match(runId, /^qa-run-20\d{6}-[a-f0-9]{8}$/);
  const runRoot = join(runs, runId);
  assert.equal(prepared.fixtureId, fixture);
  assert.equal(prepared.scenarioId, scenario);
  assert.equal(dirname(prepared.storeRoot), runRoot);
  assert.equal(url.hostname, '127.0.0.1');
  assert.deepEqual(await replay('started', '--run-id', runId), { runId, transition: 'started', changed: true });
  await assert.rejects(replay('reviewed', '--run-id', runId), /replay review event not observed/);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url.href);
  const continueForm = page.getByRole('button', { name: 'Continue' });
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Phone number').fill(phone);
  await continueForm.click();
  const resumePath = join(runRoot, resumeFilename);
  assert.ok(syntheticResume.equals(await readFile(resumePath)), 'prepared resume must match the synthetic fixture');
  await page.getByLabel('Resume').setInputFiles(resumePath);
  await continueForm.click();
  await page.getByLabel('Mark as a top choice').check();
  await continueForm.click();
  await continueForm.click();
  const question = 'Will you require employment visa sponsorship?';
  await page.getByText(question + ' is required', { exact: true }).waitFor();
  assert.equal(await page.getByRole('group', { name: question }).getAttribute('aria-invalid'), 'true');

  await page.getByLabel('No', { exact: true }).check();
  await continueForm.click();
  await page.getByRole('heading', { name: 'Review application' }).waitFor();
  await page.getByRole('button', { name: 'Submit application', exact: true }).waitFor();

  const response = await fetch(new URL('/__qa/state', url), { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.finalActionActivations, 0);
  assert.ok(state.events.some(event => event.type === 'reviewed'));
  assert.deepEqual(state.events.filter(event => ['filled', 'uploaded'].includes(event.type)).map(event => event.controlId), controls);
  assert.equal(state.events.find(event => event.type === 'uploaded').expectedFilenameMatched, true);
  const eventKeys = {
    filled: ['controlId', 'stepId', 'type'],
    uploaded: ['controlId', 'expectedFilenameMatched', 'stepId', 'type'],
    advanced: ['controlId', 'stepId', 'type'],
    validation: ['controlId', 'stepId', 'type'],
    reviewed: ['controlId', 'stepId', 'type'],
  };
  for (const event of state.events) assert.deepEqual(Object.keys(event).sort(), eventKeys[event.type]);
  const events = JSON.stringify(state);
  for (const value of [email, phone, 'No', resumeFilename, prepared.storeRoot]) assert.equal(events.includes(value), false);

  assert.deepEqual(await replay('reviewed', '--run-id', runId), { runId, transition: 'reviewed', changed: true });
  const report = await replay('evaluate', '--run-id', runId);
  assert.equal(report.status, 'passed');
  assert.equal(report.assertions['final-action-untouched'], 'passed');
  assert.equal(report.assertions['session-value-free'], 'passed');
  assert.deepEqual(Object.keys(report).sort(), ['assertions', 'failureCategories', 'fixtureId', 'missingControlIds', 'scenarioId', 'status']);
  assert.ok(Object.values(report.assertions).every(value => value === 'passed'));
  assert.deepEqual(report.failureCategories, []);
  assert.deepEqual(report.missingControlIds, []);
  const cleaned = await replay('cleanup', '--run-id', runId);
  assert.deepEqual(cleaned, { runId, state: 'completed', reportRetained: true });
  assert.deepEqual(await replay('cleanup', '--run-id', runId), cleaned);
  const retained = [];
  for (const entry of await readdir(runRoot, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    assert.equal(entry.isFile(), true, 'cleanup retains only directories and regular files');
    const file = join(entry.parentPath, entry.name);
    if ((await stat(file)).size) retained.push(relative(runRoot, file));
  }
  assert.deepEqual(retained.sort(), ['report.json', 'tombstone.json']);
  assert.deepEqual(JSON.parse(await readFile(join(runRoot, 'report.json'), 'utf8')), report);
  runId = undefined;
});
