import { exact } from '../contracts/workspace/automation.js';
import { object, parse, serialize } from '../contracts/workspace/values.js';
import type { AccountOperationRepository } from './account-operation.js';
import { AccountOperationService } from './account-operation.js';
import { SyntheticAccountService } from './synthetic-account.js';

export async function accountOperationHttp(repository: AccountOperationRepository, method: string, path: string, body: string) {
  const service = new AccountOperationService(repository);
  if (method === 'GET' && path === '/api/account-operation') return { status: 200, body: serialize(await service.status()) };
  if (method === 'POST' && path === '/api/account-operation/execute-synthetic') {
    return { status: 200, body: serialize(await new SyntheticAccountService(repository).execute(parse(body))) };
  }
  if (method === 'POST' && path === '/api/account-operation/recover') {
    exact(object(parse(body), 'account recovery body'), [], 'account recovery body must be empty');
    return { status: 200, body: serialize(await service.recover()) };
  }
  return null;
}
