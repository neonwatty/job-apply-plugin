import { GroupedApprovalsService } from '../workspace-core/grouped-approvals.js';
import { get, keys, object, JobsError } from '../contracts/workspace/values.js';
const shared = ['--id', '--expected-job-revision', '--expected-session-revision', '--input'];
export const groupedApprovalCommands = {
    'approval-preview': shared,
    'approval-approve': [...shared, '--preview-token', '--owner-confirmed'],
};
export async function runGroupedApprovalCommand(command, repository, options, payload) {
    const required = (key) => {
        const value = options.get(key);
        if (!value)
            throw new JobsError(`required option: ${key}`);
        return value;
    };
    const revision = (key) => {
        const value = required(key);
        if (!/^[0-9]+$/.test(value) || BigInt(value) < 1n)
            throw new JobsError('grouped approval revision is invalid');
        return BigInt(value);
    };
    const incoming = object(await payload(), 'grouped approval input');
    if (keys(incoming).length !== 1 || !Array.isArray(get(incoming, 'decisions'))) {
        throw new JobsError('grouped approval input is invalid');
    }
    const service = new GroupedApprovalsService(repository);
    const id = required('--id'), jobRevision = revision('--expected-job-revision');
    const sessionRevision = revision('--expected-session-revision'), decisions = get(incoming, 'decisions');
    return command === 'approval-preview' ? service.preview(id, jobRevision, sessionRevision, decisions)
        : service.approve(id, jobRevision, sessionRevision, decisions, required('--preview-token'), options.has('--owner-confirmed'));
}
