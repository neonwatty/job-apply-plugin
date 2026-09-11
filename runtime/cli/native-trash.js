import { TrashService } from '../workspace-core/trash.js';
import { JobsError } from '../contracts/workspace/values.js';
export const trashCommands = {
    'trash-list': [], 'job-trash': ['--id', '--expected-revision'], 'job-restore': ['--id', '--expected-revision'],
};
export function runTrashCommand(command, repository, options) {
    const service = new TrashService(repository);
    if (command === 'trash-list')
        return service.list();
    const id = options.get('--id'), revision = options.get('--expected-revision');
    if (!id)
        throw new JobsError('required option: --id');
    if (!revision || !/^[0-9]+$/.test(revision) || BigInt(revision) < 1n)
        throw new JobsError('expected revision must be a positive integer');
    return command === 'job-trash' ? service.trashJob(id, BigInt(revision)) : service.restoreJob(id, BigInt(revision));
}
