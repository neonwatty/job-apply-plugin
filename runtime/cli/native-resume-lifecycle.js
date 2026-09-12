import { JobsError } from '../contracts/workspace/values.js';
import { ResumeLifecycleService } from '../workspace-core/resume-lifecycle.js';
export const resumeLifecycleCommands = {
    'resume-trash': ['--id', '--expected-revision'],
    'resume-restore': ['--id', '--expected-revision'],
    'resume-delete': ['--id', '--expected-revision'],
};
export function runResumeLifecycleCommand(command, repository, options) {
    const id = options.get('--id'), revision = options.get('--expected-revision');
    if (!id)
        throw new JobsError('required option: --id');
    if (!revision || !/^[0-9]+$/.test(revision) || BigInt(revision) < 1n) {
        throw new JobsError('expected revision must be a positive integer');
    }
    const service = new ResumeLifecycleService(repository);
    if (command === 'resume-trash')
        return service.trash(id, BigInt(revision));
    if (command === 'resume-restore')
        return service.restore(id, BigInt(revision));
    if (command === 'resume-delete')
        return service.delete(id, BigInt(revision));
    throw new JobsError('unsupported native resume lifecycle command');
}
