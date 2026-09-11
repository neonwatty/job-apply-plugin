import { TaskIntakeService } from '../workspace-core/task-intake.js';
import type { JobUpsertRepository } from '../workspace-core/job-upsert.js';
import type { Value } from '../contracts/workspace/values.js';

export const taskIntakeCommands: Record<string, string[]> = {
  'task-intake': ['--input', '--origin'],
};
export async function runTaskIntakeCommand(repository: JobUpsertRepository,
  options: Map<string, string>, payload: () => Promise<Value>): Promise<Value> {
  return new TaskIntakeService(repository).intake(await payload(), options.get('--origin'));
}
