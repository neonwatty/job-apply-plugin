import { TrashService } from '../workspace-core/trash.js';
import type { TrashRepository } from '../workspace-core/trash.js';
import { JobsError } from '../contracts/workspace/values.js';

export const trashCommands: Record<string, string[]> = {
  'trash-list': [], 'job-trash': ['--id', '--expected-revision'], 'job-restore': ['--id', '--expected-revision'],
  'job-delete': ['--id', '--expected-revision'],
};
export function runTrashCommand(command: string, repository: TrashRepository, options: Map<string, string>) {
  const service = new TrashService(repository);
  if (command === 'trash-list') return service.list();
  const id = options.get('--id'), revision = options.get('--expected-revision');
  if (!id) throw new JobsError('required option: --id');
  if (!revision || !/^[0-9]+$/.test(revision) || BigInt(revision) < 1n) throw new JobsError('expected revision must be a positive integer');
  if (command === 'job-trash') return service.trashJob(id, BigInt(revision));
  if (command === 'job-restore') return service.restoreJob(id, BigInt(revision));
  if (command === 'job-delete') return service.deleteJob(id, BigInt(revision));
  throw new JobsError('unsupported trash command');
}
