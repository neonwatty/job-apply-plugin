import { JobsError } from '../contracts/workspace/values.js';
import type { AnswerRepository } from '../workspace-core/answers.js';
import { AnswerLifecycleService } from '../workspace-core/answer-lifecycle.js';

export const answerLifecycleCommands: Record<string, string[]> = {
  'answer-trash': ['--key', '--expected-revision'],
  'answer-restore': ['--key', '--expected-revision'],
  'answer-delete': ['--key', '--expected-revision'],
};
export function runAnswerLifecycleCommand(command: string, repository: AnswerRepository, options: Map<string, string>) {
  const key = options.get('--key'), revision = options.get('--expected-revision');
  if (!key) throw new JobsError('required option: --key');
  if (!revision || !/^[0-9]+$/.test(revision) || BigInt(revision) < 1n) throw new JobsError('expected revision must be a positive integer');
  const service = new AnswerLifecycleService(repository);
  if (command === 'answer-trash') return service.trash(key, BigInt(revision));
  if (command === 'answer-restore') return service.restore(key, BigInt(revision));
  if (command === 'answer-delete') return service.delete(key, BigInt(revision));
  throw new JobsError('unsupported native answer lifecycle command');
}
