import { exact } from '../contracts/workspace/automation.js';
import { object, parse, serialize } from '../contracts/workspace/values.js';
import { AccountOperationService } from './account-operation.js';
export async function accountOperationHttp(repository, method, path, body) {
    const service = new AccountOperationService(repository);
    if (method === 'GET' && path === '/api/account-operation')
        return { status: 200, body: serialize(await service.status()) };
    if (method === 'POST' && path === '/api/account-operation/recover') {
        exact(object(parse(body), 'account recovery body'), [], 'account recovery body must be empty');
        return { status: 200, body: serialize(await service.recover()) };
    }
    return null;
}
