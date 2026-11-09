import { AccountOperationService } from '../workspace-core/account-operation.js';
export const accountOperationCommands = {
    'employer-account-operation-status': [],
    'employer-account-operation-recover': [],
};
export function runAccountOperationCommand(command, repository) {
    const service = new AccountOperationService(repository);
    return command === 'employer-account-operation-status' ? service.status() : service.recover();
}
