import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Keep addon/module bootstrap failures inside the same value-free envelope. */
export async function runAttemptCli(args: string[]): Promise<{ output: string; exitCode: number }> {
  let invalid = false;
  try {
    const protocol = await import('./attempt-protocol.js');
    const { canonicalJson } = await import('../contracts/workspace/canonical-json.js');
    const { get } = await import('../contracts/workspace/values.js');
    const executable = fileURLToPath(import.meta.url);
    if (args.includes('--broker')) {
      if (args.length !== 3 || args[0] !== '--broker' || args[1] !== '--root') {
        invalid = true; throw new Error('invalid invocation');
      }
      const root = protocol.resolveAttemptRoot(args[2], process.env, homedir());
      const pluginRoot = realpathSync(resolve(dirname(executable), '../..'));
      const { resolvePackagedNativeLock } = await import('../package/native-lock-artifact.js');
      const { loadPosixFlockProvider } = await import('../store/posix-flock.js');
      const { NativeJobsRepository } = await import('../store/native-jobs.js');
      const { ClaimsService } = await import('../workspace-core/claims.js');
      const { ApplicationAuthorityService } = await import('../workspace-core/application-authority.js');
      const { runAttemptBroker } = await import('./attempt-broker.js');
      const provider = loadPosixFlockProvider(await resolvePackagedNativeLock(pluginRoot));
      const repository = new NativeJobsRepository(root, provider);
      await runAttemptBroker(root, new ClaimsService(repository), provider, {}, new ApplicationAuthorityService(repository));
      return { output: '', exitCode: 0 };
    }
    let invocation;
    try { invocation = protocol.parseAttemptArgs(args, process.env, homedir()); }
    catch (error) {
      if (error instanceof protocol.AttemptHelp) {
        return { output: 'Detached, Store-scoped broker for one canonical application attempt.\n'
          + 'Usage: job-apply-attempt [--root ROOT] {start,restart-review,heartbeat,progress,authority-evaluate,handoff}\n'
          + 'start / restart-review: --id ID --owner OWNER --expected-revision INTEGER\n'
          + 'restart-review: --owner-confirmed-not-submitted\n'
          + 'progress / authority-evaluate: --input FILE; handoff: --status {needs_info,awaiting_review} --input FILE\n', exitCode: 0 };
      }
      invalid = error instanceof protocol.AttemptInvocationError; throw error;
    }
    const request = await protocol.attemptRequest(invocation);
    const { requestAttempt } = await import('./attempt-broker.js');
    const response = await requestAttempt(invocation.root, request, {
      start: invocation.kind === 'start' || invocation.kind === 'restart-review', executable,
    });
    return { output: canonicalJson(response) + '\n', exitCode: get(response, 'ok') === true ? 0 : 2 };
  } catch {
    return { output: `{"error":{"code":"${invalid ? 'invalid_invocation' : 'attempt_unavailable'}"},"ok":false}\n`, exitCode: 2 };
  }
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const result = await runAttemptCli(process.argv.slice(2));
  process.stdout.write(result.output); process.exitCode = result.exitCode;
}
