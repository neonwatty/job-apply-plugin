#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexModelTransport } from './codex-model-transport.mjs';
import { runCodexModelTrials } from './codex-model-trials.mjs';
import { createInstalledModelFixture } from './model-fixture.mjs';

const execute = promisify(execFile);
const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const usage = 'Usage: codex-model-cli.mjs --readiness --binary /native/codex OR '
  + '--binary /native/codex --auth-home /existing/codex/home --output /new/directory [--trials 1..5] [--max-turns 1..20]';

export function parseCodexModelArguments(args) {
  if (!Array.isArray(args)) throw Error('codex_cli_invalid_arguments');
  const options = {};
  const valueFlags = new Set(['--binary', '--auth-home', '--output', '--trials', '--max-turns']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (Object.hasOwn(options, flag)) throw Error('codex_cli_duplicate_option');
    if (flag === '--readiness') { options[flag] = true; continue; }
    if (!valueFlags.has(flag) || typeof args[index + 1] !== 'string' || !args[index + 1]
      || args[index + 1].startsWith('--')) throw Error('codex_cli_invalid_arguments');
    options[flag] = args[++index];
  }
  if (typeof options['--binary'] !== 'string' || !isAbsolute(options['--binary'])) throw Error('codex_cli_absolute_binary_required');
  if (options['--readiness']) {
    if (Object.keys(options).some(key => !['--binary', '--readiness'].includes(key))) throw Error('codex_cli_readiness_options');
    return { mode: 'readiness', binary: options['--binary'] };
  }
  if (typeof options['--auth-home'] !== 'string' || !isAbsolute(options['--auth-home'])
    || typeof options['--output'] !== 'string') throw Error('codex_cli_trial_options_required');
  const count = (flag, fallback, limit) => {
    const text = options[flag] ?? String(fallback);
    if (!/^[1-9][0-9]*$/.test(text) || Number(text) > limit) throw Error('codex_cli_invalid_count');
    return Number(text);
  };
  return { mode: 'trials', binary: options['--binary'], authHome: options['--auth-home'],
    outputDirectory: resolve(options['--output']), trials: count('--trials', 3, 5), maxTurns: count('--max-turns', 12, 20) };
}

export async function cleanCodexRevision(repository = repositoryDirectory, expected) {
  const git = async args => (await execute('git', ['-C', repository, ...args], { maxBuffer: 1048576 })).stdout.trim();
  const revision = await git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(revision) || (expected && revision !== expected)) throw Error('codex_cli_revision_changed');
  if (await git(['status', '--porcelain=v1', '--untracked-files=all'])) throw Error('codex_cli_dirty_checkout');
  return revision;
}

async function validateEvidenceDestination(outputDirectory) {
  const path = relative(repositoryDirectory, outputDirectory);
  if (path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))) {
    try { await execute('git', ['-C', repositoryDirectory, 'check-ignore', '--quiet', '--no-index', outputDirectory]); }
    catch { throw Error('codex_cli_output_must_be_ignored_or_external'); }
  }
}

/** Explicit CLI only: importing this module never starts a runtime or inference. */
export async function runCodexModelCli(args) {
  let options;
  try { options = parseCodexModelArguments(args); }
  catch (error) { return { code: 2, report: { ready: false, failure: error.message, usage } }; }
  const report = { schemaVersion: 1, mode: options.mode, revision: null, phase: 'configuration',
    ready: false, inferenceRequested: options.mode === 'trials', diagnostics: null, trials: null, failure: null, cleanupConfirmed: false };
  let transport, emptyAuthHome, outputCreated = false;
  try {
    if (options.mode === 'readiness') {
      emptyAuthHome = await mkdtemp(join(tmpdir(), 'codex-probe-empty-auth-'));
    } else {
      report.revision = await cleanCodexRevision();
      await validateEvidenceDestination(options.outputDirectory);
      await mkdir(options.outputDirectory, { recursive: false, mode: 0o700 });
      outputCreated = true;
    }
    report.phase = 'capability_probe';
    transport = await createCodexModelTransport({ binary: options.binary, authHome: emptyAuthHome ?? options.authHome });
    await transport.verifyIsolation();
    report.diagnostics = transport.diagnostics();
    report.ready = true;
    if (options.mode === 'trials') {
      report.phase = 'trials';
      report.trials = await runCodexModelTrials({ transport, revision: report.revision,
        outputDirectory: join(options.outputDirectory, 'trials'), trials: options.trials, maxTurns: options.maxTurns,
        fixtureFactory: async () => {
          await cleanCodexRevision(repositoryDirectory, report.revision);
          const fixture = await createInstalledModelFixture();
          try { await cleanCodexRevision(repositoryDirectory, report.revision); return fixture; }
          catch (error) { await fixture.cleanup(); throw error; }
        } });
      await cleanCodexRevision(repositoryDirectory, report.revision);
      if (report.trials.failure || report.trials.trials.length !== options.trials
        || report.trials.trials.some(trial => !trial.complete || trial.failure)) report.failure = 'codex_cli_incomplete_trials';
    }
    report.phase = 'finished';
  } catch (error) {
    report.failure = /^codex_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'codex_cli_failed';
  } finally {
    if (transport) report.diagnostics = transport.diagnostics();
    try {
      if (report.failure?.includes('cleanup_unconfirmed')) throw Error('codex_cli_cleanup_unconfirmed');
      if (transport) await transport.close();
      if (emptyAuthHome) await rm(emptyAuthHome, { recursive: true, force: true });
      report.cleanupConfirmed = true;
    } catch { report.failure = 'codex_cli_cleanup_unconfirmed'; }
    if (outputCreated) await writeFile(join(options.outputDirectory, 'cli-report.json'),
      JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  return { code: report.failure ? 1 : 0, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCodexModelCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');
  process.exitCode = result.code;
}
