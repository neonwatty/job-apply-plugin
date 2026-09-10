import { ClaimsService } from '../workspace-core/claims.js';
import { object, text, JobsError } from '../contracts/workspace/values.js';
export const claimCommands = {
    'job-review-restart': ['--id', '--owner', '--expected-revision', '--owner-confirmed-not-submitted'],
    'task-select': ['--id', '--expected-revision', '--owner-confirmed'],
    'job-acquire': ['--id', '--owner', '--expected-revision'], 'claim-status': [],
    'claim-heartbeat': ['--id', '--token'], 'claim-recover': ['--id', '--owner'],
    'claim-progress': ['--id', '--token', '--input'],
    'claim-handoff': ['--id', '--token', '--status', '--input', '--expected-revision'],
};
export async function runClaimCommand(command, repository, options, payload) {
    const service = new ClaimsService(repository);
    const required = (key) => {
        const value = options.get(key);
        if (!value)
            throw new JobsError(`required option: ${key}`);
        return value;
    };
    const revision = () => {
        const value = required('--expected-revision');
        if (!/^[+-]?[0-9]+$/.test(value))
            throw new JobsError('expected revision must be an integer');
        return BigInt(value);
    };
    if (command === 'claim-status')
        return service.status();
    const id = required('--id');
    if (command === 'task-select')
        return service.select(id, revision(), options.has('--owner-confirmed'));
    if (command === 'job-review-restart')
        return service.restart(id, text(required('--owner')), revision(), options.has('--owner-confirmed-not-submitted'));
    if (command === 'job-acquire')
        return service.acquire(id, text(required('--owner')), revision());
    if (command === 'claim-recover')
        return service.recover(id, text(required('--owner')));
    const token = text(required('--token'));
    if (command === 'claim-heartbeat')
        return service.heartbeat(id, token);
    if (command === 'claim-progress')
        return service.progress(id, token, object(await payload(), 'session'));
    return service.handoff(id, token, required('--status'), object(await payload(), 'session'), revision());
}
