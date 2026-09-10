import { PendingAnswersService } from '../workspace-core/pending-answers.js';
import type { PendingAnswerRepository } from '../workspace-core/pending-answers.js';
import { JobsError } from '../contracts/workspace/values.js';
import type { Value } from '../contracts/workspace/values.js';

export const pendingAnswerCommands: Record<string, string[]> = {
  'pending-answer-list': [],
  'resolve-pending-answer': ['--id','--reference','--expected-job-revision','--expected-session-revision','--expected-answer-revision','--owner-confirmed'],
};
export async function runPendingAnswerCommand(command: string, repository: PendingAnswerRepository, options: Map<string,string>): Promise<Value> {
  const service = new PendingAnswersService(repository);
  if (command === 'pending-answer-list') return service.list();
  const required = (key: string): string => {
    const value = options.get(key);
    if (!value) throw new JobsError(`required option: ${key}`);
    return value;
  };
  const revision = (key: string): bigint => {
    const value = required(key);
    if (!/^[0-9]+$/.test(value) || BigInt(value) < 1n) throw new JobsError('answer resolution revision is invalid');
    return BigInt(value);
  };
  return service.resolve(required('--id'),required('--reference'),revision('--expected-job-revision'),
    revision('--expected-session-revision'),revision('--expected-answer-revision'),options.has('--owner-confirmed'));
}
