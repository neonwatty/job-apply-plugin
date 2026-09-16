import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeJobsRepository } from '../store/native-jobs.js';
import { loadPosixFlockProvider } from '../store/posix-flock.js';
import { resolvePackagedNativeLock } from '../package/native-lock-artifact.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { object, parse } from '../contracts/workspace/values.js';
import { runTaskCommand } from './task-command.js';
import { classifyTaskError, parseTaskArgs, TaskHelp, TaskRequestError } from './task-protocol.js';

const commands = 'snapshot, activity, intake, select, resolve-pending-answer, semantic-lookup, cleanup-preview, cleanup-approve, approval-preview, approval-approve';
function help(command?: string): string {
  return `Native prepared-Store task CLI${command ? `: ${command}` : ''}\n`
    + 'Usage: native-task --root ABSOLUTE_STORE --native-lock ABSOLUTE_ADDON COMMAND [options]\n'
    + `Commands: ${commands}\n`
    + 'Use the Python task command options; --input reads a JSON object from a file.\n'
    + 'Only explicitly initialized fixtures or prepared canonical clones are supported.\n';
}
async function installedTaskArgs(args: string[]): Promise<string[]> {
  const completed = [...args];
  if (!completed.some(argument => argument === '--root' || argument.startsWith('--root='))) {
    const configured = process.env.JOB_APPLY_STORE_DIR;
    const expanded = configured === '~' || configured?.startsWith('~/')
      ? realpathSync(homedir()) + configured.slice(1) : configured;
    completed.unshift('--root', expanded ? resolve(expanded) : join(realpathSync(homedir()), '.job-apply'));
  }
  if (!completed.some(argument => argument === '--native-lock' || argument.startsWith('--native-lock='))
    && !completed.includes('--help') && !completed.includes('-h')) {
    const executable = fileURLToPath(import.meta.url);
    completed.unshift('--native-lock', await resolvePackagedNativeLock(realpathSync(resolve(dirname(executable), '../..'))));
  }
  return completed;
}
export async function runTask(args: string[]): Promise<{ output: string; exitCode: number }> {
  try {
    const parsed = parseTaskArgs(await installedTaskArgs(args));
    const repository = new NativeJobsRepository(parsed.options.get('--root')!, loadPosixFlockProvider(parsed.options.get('--native-lock')!));
    const payload = async () => {
      try {
        // Python Path.read_text is strict UTF-8 and treats '-' as an ordinary filename.
        const bytes = await readFile(parsed.options.get('--input')!);
        return object(parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)), 'task input');
      } catch { throw new TaskRequestError(); }
    };
    return { output: canonicalJson(await runTaskCommand(parsed, repository, payload)) + '\n', exitCode: 0 };
  } catch (error) {
    if (error instanceof TaskHelp) return { output: help(error.command), exitCode: 0 };
    return { output: canonicalJson(classifyTaskError(error)) + '\n', exitCode: 2 };
  }
}
