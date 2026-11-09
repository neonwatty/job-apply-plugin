import { homedir } from 'node:os';
import { LegacyJobsService, type LegacyJobsRepository } from '../workspace-core/legacy-jobs.js';
import { discoverLegacyJobs } from '../store/legacy-job-discovery.js';
import { loadPosixDirectoryProvider } from '../store/posix-directory.js';
import { JobsError, type Value } from '../contracts/workspace/values.js';

export const legacyJobCommands: Record<string,string[]> = {
  'legacy-jobs-preview':['--select'],
  'legacy-jobs-commit':['--select','--confirm'],
};
export async function runLegacyJobCommand(command:string, repository:LegacyJobsRepository,
  options:Map<string,string>, selected:string[]):Promise<Value> {
  const provider = loadPosixDirectoryProvider(options.get('--native-lock')!);
  const service = new LegacyJobsService(repository, () => discoverLegacyJobs(homedir(),provider));
  if (command === 'legacy-jobs-preview') return service.preview(selected);
  if (!selected.length) throw new JobsError('required option: --select');
  const token = options.get('--confirm');
  if (!token) throw new JobsError('required option: --confirm');
  return service.commit(selected,token);
}
