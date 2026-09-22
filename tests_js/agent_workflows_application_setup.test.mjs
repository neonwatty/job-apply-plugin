import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  applicationSetupPreferencesHostPreflight,
  applicationSetupPreferencesLayout,
  probeApplicationSetupPreferences,
} from '../.workflows/fixtures/job-apply.synthetic-application-setup-preferences-v1/host-preflight.mjs';

const repository = resolve(new URL('..', import.meta.url).pathname);
const workflowPath = join(repository, '.workflows/workflows/job-apply.synthetic-application-setup-preferences.workflow.yaml');
const execute = promisify(execFile);

test('application-setup workflow satisfies the installed runner schema', async () => {
  const cli = join(repository, 'node_modules/@lineagehq/workflows/bin/workflow.js');
  const { stdout } = await execute(process.execPath, [cli, 'validate', '--json', workflowPath], { cwd: repository });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.data.items[0].id, 'job-apply.synthetic-application-setup-preferences');
});

test('application-setup workflow is explicitly local-only and exercises live-agent to UI durability', async () => {
  const source = await readFile(workflowPath, 'utf8');
  assert.match(source, /id: job-apply\.synthetic-application-setup-preferences/);
  assert.match(source, /LOCAL MANUAL RUN ONLY/);
  assert.match(source, /Never schedule this workflow in CI, a remote agent/);
  assert.match(source, /width: 1280[\s\S]*height: 720/);
  assert.match(source, /profile revision 2[\s\S]*profile revision 3[\s\S]*revision 4/);
  assert.match(source, /job-apply:application-setup/);
  assert.match(source, /run-fresh-setup-writer[\s\S]*Chrome, Ask before switching, and Guided/);
  assert.match(source, /audit-agent-setup-in-companion/);
  assert.match(source, /applicationPreferences contains codex_browser, other_supported, and standard/);
  assert.match(source, /run-fresh-setup-reader/);
  assert.match(source, /does not restart the questionnaire because the request was view-only/);
  assert.match(source, /local-agent-writer-redacted-receipt[\s\S]*required: false/);
  assert.match(source, /local-agent-reader-redacted-receipt[\s\S]*required: false/);
  assert.match(source, /Never pass runner-store, journey-root, or the default ~\/\.job-apply Store/);
  assert.match(source, /Run native-qa-replay cleanup/);
  assert.doesNotMatch(source, /https:\/\/(?!example\.invalid)/);
});

test('application-setup host preflight proves the exact local plugin without creating the journey', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'application-setup-preflight-')));
  await chmod(parent, 0o700);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const journeyRoot = join(parent, 'application-setup-preferences-preflight-1234');
  const isolatedCodexHome = join(tmpdir(), 'application-setup-preferences-preflight-1234-codex-home');
  assert.deepEqual(applicationSetupPreferencesLayout(journeyRoot, isolatedCodexHome), {
    journeyRoot,
    runnerStoreRoot: join(journeyRoot, 'runner-store'),
    qaRunsRoot: join(journeyRoot, 'qa-runs'),
    isolatedCodexHome,
    receiptRoot: join(journeyRoot, 'agent-receipts'),
    legacyProfilePath: join(journeyRoot, 'no-legacy-profile.json'),
  });
  const expectedCapability = await probeApplicationSetupPreferences(repository);
  assert.equal(expectedCapability.id, 'job-apply.local-agent-control');
  assert.deepEqual(expectedCapability.operations, ['fresh-setup-writer', 'fresh-setup-reader']);
  assert.equal(expectedCapability.constraints.localOnly, true);
  assert.equal(expectedCapability.constraints.canonicalStoreAccess, false);
  const preflight = await applicationSetupPreferencesHostPreflight({ journeyRoot, isolatedCodexHome, repositoryRoot: repository, localRoot: parent });
  assert.deepEqual(preflight.capabilityContract, expectedCapability);
  await assert.rejects(applicationSetupPreferencesHostPreflight({ journeyRoot: join(parent, 'wrong'), isolatedCodexHome,
    repositoryRoot: repository, localRoot: parent }), /fresh direct child/);
  await assert.rejects(applicationSetupPreferencesHostPreflight({ journeyRoot, isolatedCodexHome: join(repository, '.workflows/local/codex-home'),
    repositoryRoot: repository, localRoot: parent }), /outside the plugin source/);
});
