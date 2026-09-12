import type { AccountOperationRepository } from '../workspace-core/account-operation.js';
import { AccountOperationService } from '../workspace-core/account-operation.js';
import type { Value } from '../contracts/workspace/values.js';

export const accountOperationCommands: Record<string, string[]> = {
  'employer-account-operation-status': [],
  'employer-account-operation-recover': [],
};
export function runAccountOperationCommand(command: string, repository: AccountOperationRepository): Promise<Value> {
  const service = new AccountOperationService(repository);
  return command === 'employer-account-operation-status' ? service.status() : service.recover();
}
