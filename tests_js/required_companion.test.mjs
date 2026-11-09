import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedCompanionRoot } from './workspace_next_browser_support.mjs';
import { companionRegressionsBrowser } from './companion_regressions_browser_support.mjs';
import { nativeJobsBrowser } from './workspace_native_browser_support.mjs';
import { nextSecurity } from './workspace_next_security_support.mjs';
import { nextEditor } from './workspace_next_editor_support.mjs';

test('native Companion transport rejects unsafe requests and preserves editor contracts', async () => {
  await nextSecurity({ referenceParity: false });
  await nextEditor();
});

test('production TypeScript Companion shares canonical data, revisions, drafts, workflows and guarded Trash', { timeout: 240_000 }, async t => {
  const existing = process.env.JOB_WORKSPACE_TEST_ROOT;
  const isolated = existing ? null : await isolatedCompanionRoot();
  const root = existing ?? isolated.root;
  try {
    if (!existing) await promisify(execFile)('npm', ['run', 'companion:build'], {
      cwd: root, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, env: process.env,
    });
    t.diagnostic(JSON.stringify(await nativeJobsBrowser(root)));
    t.diagnostic(JSON.stringify(await companionRegressionsBrowser(root)));
  } finally { await isolated?.cleanup(); }
});
