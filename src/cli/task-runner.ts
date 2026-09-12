import { readFile } from 'node:fs/promises';
import { NativeJobsRepository } from '../store/native-jobs.js';
import { loadPosixFlockProvider } from '../store/posix-flock.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { object, parse } from '../contracts/workspace/values.js';
import { runTaskCommand } from './task-command.js';
import { classifyTaskError, parseTaskArgs, TaskHelp, TaskRequestError } from './task-protocol.js';

const commands = 'snapshot, activity, intake, select, resolve-pending-answer, semantic-lookup, cleanup-preview, cleanup-approve, approval-preview, approval-approve';
function help(command?: string): string {
  return `Native synthetic-fixture task CLI${command ? `: ${command}` : ''}\n`
    + 'Usage: native-task --root ABSOLUTE_FIXTURE --native-lock ABSOLUTE_ADDON COMMAND [options]\n'
    + `Commands: ${commands}\n`
    + 'Use the Python task command options; --input reads a JSON object from a file.\n'
    + 'Only explicitly initialized native version 10 fixtures are supported.\n';
}
export async function runTask(args: string[]): Promise<{ output: string; exitCode: number }> {
  try {
    const parsed = parseTaskArgs(args);
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
