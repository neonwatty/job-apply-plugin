#!/usr/bin/env node
import { constants } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { JobsError } from '../contracts/workspace/values.js';
import { expandRoot } from '../final-action-policy/repository.js';
import { resolvePackagedNativeLock } from '../package/native-lock-artifact.js';
import { NativeJobsRepository } from '../store/native-jobs.js';
import { NativeLiveSubmissionLedger } from '../store/native-live-submission-ledger.js';
import { withNativeStore } from '../store/native-store-provider.js';
import { openPrivateStoreFile } from '../store/private-store-entry.js';
import { canonicalWindowsRoot } from '../store/windows-activation.js';
import { LiveSubmissionService } from '../workspace-core/live-submission.js';

const options = {
  root: { type: 'string' }, input: { type: 'string' }, preview: { type: 'string' },
  approval: { type: 'string' }, id: { type: 'string' }, 'owner-confirmed': { type: 'boolean' },
  'source-root': { type: 'string' }, 'expected-revision': { type: 'string' },
} as const;
const commands: Record<string, string[]> = {
  status: [], preview: ['input'], approve: ['input', 'preview', 'owner-confirmed'], claim: ['input', 'approval'],
  outcome: ['input'], inspect: ['id'], fingerprint: ['input'],
  reconcile: ['source-root', 'id', 'expected-revision', 'owner-confirmed'],
};

async function privateInput(path: string, maxBytes: number) {
  const file = await openPrivateStoreFile(expandRoot(path), constants.O_RDONLY, 'submission input must be private and owned');
  try {
    if ((await file.stat()).size > maxBytes) throw new JobsError('submission input is too large');
    try { return JSON.parse(await file.readFile('utf8')) as unknown; }
    catch { throw new JobsError('submission input is invalid'); }
  } finally { await file.close(); }
}

async function run(args: string[]) {
  const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  const command = parsed.positionals[0] ?? '', permitted = commands[command];
  if (!Object.hasOwn(commands, command) || parsed.positionals.length !== 1 || !permitted
    || Object.keys(parsed.values).some(key => key !== 'root' && !permitted.includes(key))
    || permitted.some(key => !Object.hasOwn(parsed.values, key))) throw new JobsError('invalid submission command arguments');
  if (permitted.includes('owner-confirmed') && parsed.values['owner-confirmed'] !== true) throw new JobsError('explicit owner approval is required');
  const selected = parsed.values.root ?? process.env.JOB_APPLY_STORE_DIR ?? join(homedir(), '.job-apply');
  const normalize = (path: string) => process.platform === 'win32' ? canonicalWindowsRoot(expandRoot(path)) : expandRoot(path);
  const root = await normalize(selected);
  const plugin = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const addon = await resolvePackagedNativeLock(plugin);
  const make = (path: string, provider: ConstructorParameters<typeof NativeJobsRepository>[1]) =>
    new LiveSubmissionService(new NativeJobsRepository(path, provider), new NativeLiveSubmissionLedger(path));
  if (command === 'reconcile') {
    const sourceRoot = await normalize(parsed.values['source-root']!);
    if (sourceRoot === root) throw new JobsError('reconciliation requires separate source and destination Stores');
    return withNativeStore(root, addon, provider => {
      const target = make(root, provider);
      return target.reconcileFrom({
        confirmedReceiptForTransfer: jobId => withNativeStore(sourceRoot, addon,
          sourceProvider => make(sourceRoot, sourceProvider).confirmedReceiptForTransfer(jobId)),
      }, parsed.values.id!, parsed.values['expected-revision']!);
    });
  }
  return withNativeStore(root, addon, async provider => {
    const input = parsed.values.input ? await privateInput(parsed.values.input, command === 'fingerprint' ? 256 * 1024 : 32_768) : null;
    const service = make(root, provider);
    switch (command) {
      case 'status': return service.status();
      case 'fingerprint': return service.fingerprint(input);
      case 'preview': return service.preview(input);
      case 'approve': return service.preview(input, parsed.values.preview!);
      case 'claim': return service.claim(parsed.values.approval!, input);
      case 'outcome': return service.outcome(input);
      default: return service.inspect(parsed.values.id!);
    }
  });
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await run(process.argv.slice(2))) + '\n'); }
  catch (error) {
    process.stderr.write(`job-apply-submission: ${error instanceof JobsError ? error.message : 'submission operation failed'}\n`);
    process.exitCode = 2;
  }
}
