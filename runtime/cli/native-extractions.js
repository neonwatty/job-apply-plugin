import { ExtractionService } from '../workspace-core/extraction.js';
import { JobsError } from '../contracts/workspace/values.js';
export const extractionCommands = {
    'resume-extraction-request-create': ['--resume-id', '--expected-resume-revision'],
    'resume-extraction-request-get': ['--id'],
    'resume-extraction-request-list': ['--resume-id', '--status'],
    'resume-extraction-request-cancel': ['--id', '--expected-revision'],
    'resume-extraction-request-fail': ['--id', '--reason', '--expected-revision'],
    'resume-extraction-request-retry': ['--id', '--expected-revision', '--expected-resume-revision'],
    'resume-extraction-request-complete': ['--id', '--input', '--expected-request-revision', '--expected-profile-revision', '--expected-pending-proposal-id'],
    'resume-proposal-create': ['--resume-id', '--input', '--expected-resume-revision', '--expected-profile-revision', '--supersedes'],
    'resume-proposal-get': ['--id'],
    'resume-proposal-list': ['--resume-id', '--status', '--summary-only'],
    'resume-proposal-review': ['--id', '--input', '--expected-revision', '--expected-profile-revision'],
};
export async function runExtractionCommand(command, repository, options, payload) {
    const service = new ExtractionService(repository);
    const required = (key) => {
        const value = options.get(key);
        if (!value)
            throw new JobsError(`required option: ${key}`);
        return value;
    };
    const revision = (key = '--expected-revision') => {
        const value = required(key);
        if (!/^[0-9]+$/.test(value) || BigInt(value) < 1n)
            throw new JobsError(`${key} must be a positive integer`);
        return BigInt(value);
    };
    switch (command) {
        case 'resume-extraction-request-create': return service.createRequest(required('--resume-id'), revision('--expected-resume-revision'));
        case 'resume-extraction-request-get': return service.getRequest(required('--id'));
        case 'resume-extraction-request-list': return service.listRequests(options.get('--resume-id'), options.get('--status'));
        case 'resume-extraction-request-cancel': return service.cancelRequest(required('--id'), revision());
        case 'resume-extraction-request-fail': return service.failRequest(required('--id'), required('--reason'), revision());
        case 'resume-extraction-request-retry': return service.retryRequest(required('--id'), revision(), revision('--expected-resume-revision'));
        case 'resume-extraction-request-complete': return service.completeRequest(required('--id'), await payload(), revision('--expected-request-revision'), revision('--expected-profile-revision'), options.get('--expected-pending-proposal-id'));
        case 'resume-proposal-create': return service.createProposal(required('--resume-id'), await payload(), revision('--expected-resume-revision'), revision('--expected-profile-revision'), options.get('--supersedes'));
        case 'resume-proposal-get': return service.getProposal(required('--id'));
        case 'resume-proposal-list': return service.listProposals(options.get('--resume-id'), options.get('--status'), options.has('--summary-only'));
        case 'resume-proposal-review': return service.reviewProposal(required('--id'), await payload(), revision(), revision('--expected-profile-revision'));
        default: throw new JobsError('unsupported native extraction command');
    }
}
