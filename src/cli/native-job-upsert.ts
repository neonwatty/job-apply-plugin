import { JobUpsertService, type JobUpsertRepository } from '../workspace-core/job-upsert.js';
import { JobsError, type Value } from '../contracts/workspace/values.js';

export const jobUpsertCommands: Record<string, string[]> = {
  'job-upsert-preview': ['--input', '--origin'],
  'job-upsert-commit': ['--input', '--origin', '--token'],
};
export async function runJobUpsertCommand(command: string, repository: JobUpsertRepository,
  options: Map<string, string>, payload: () => Promise<Value>): Promise<Value> {
  const required = (key: string): string => {
    const value = options.get(key);
    if (!value) throw new JobsError(`required option: ${key}`);
    return value;
  };
  const author = required('--origin');
  const service = new JobUpsertService(repository);
  if (command === 'job-upsert-preview') return service.preview(await payload(), author);
  const token = required('--token');
  return service.commit(await payload(), author, token);
}
