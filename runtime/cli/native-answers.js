import { answerKey } from '../contracts/workspace/answers.js';
import { AnswersService } from '../workspace-core/answers.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { object, parse, set, text, JobsError } from '../contracts/workspace/values.js';
export const answerCommands = {
    'answer-key': ['--question', '--scope'], 'answer-find': ['--question', '--scope'],
    'answer-get': ['--key', '--include-trashed'], 'answer-reveal': ['--key'],
    'answer-list': ['--state', '--review-status', '--all-review-statuses', '--query', '--offset', '--limit', '--include-trashed', '--trashed-only'],
    'answer-put': ['--input', '--expected-revision', '--remember-sensitive'],
    'answer-observe': ['--input'],
    'answer-semantic-lookup': ['--input'],
    'answer-update': ['--key', '--input', '--expected-revision', '--remember-sensitive'],
    'answer-review': ['--key', '--decision', '--input', '--expected-revision', '--remember-sensitive'],
};
export async function runAnswerCommand(command, repository, options, payload) {
    const service = new AnswersService(repository);
    const required = (key) => {
        const value = options.get(key);
        if (!value)
            throw new JobsError(`required option: ${key}`);
        return value;
    };
    const revision = () => {
        const value = required('--expected-revision');
        if (!/^[0-9]+$/.test(value) || BigInt(value) < 1n)
            throw new JobsError('expected revision must be a positive integer');
        return BigInt(value);
    };
    const consent = options.has('--remember-sensitive');
    switch (command) {
        case 'answer-key': return set(emptyObject(), 'key', text(answerKey(required('--question'), object(parse(options.get('--scope') ?? '{}'), 'scope'))));
        case 'answer-find': return service.find(required('--question'), object(parse(options.get('--scope') ?? '{}'), 'scope'));
        case 'answer-get': return service.get(required('--key'), false, options.has('--include-trashed'));
        case 'answer-reveal': {
            const value = await service.get(required('--key'), true);
            if (value === null)
                throw new JobsError('answer does not exist');
            return value;
        }
        case 'answer-list': {
            if (options.has('--all-review-statuses') && options.has('--review-status'))
                throw new JobsError('answer review filters are mutually exclusive');
            return service.query({ query: options.get('--query') ?? '', state: options.get('--state') ?? null, reviewStatus: options.has('--all-review-statuses') ? null : options.get('--review-status') ?? 'accepted',
                offset: Number(options.get('--offset') ?? '0'), limit: Number(options.get('--limit') ?? '50'), includeTrashed: options.has('--include-trashed'), trashedOnly: options.has('--trashed-only') });
        }
        case 'answer-put': return service.put(await payload(), consent, options.has('--expected-revision') ? revision() : null);
        case 'answer-observe': return service.observe(await payload());
        case 'answer-semantic-lookup': return service.semanticLookup(await payload());
        case 'answer-update': return service.update(required('--key'), await payload(), revision(), consent);
        case 'answer-review': {
            const status = required('--decision');
            if (status !== 'accepted' && status !== 'declined')
                throw new JobsError('answer review decision must be accepted or declined');
            return service.update(required('--key'), options.has('--input') ? await payload() : emptyObject(), revision(), consent, status);
        }
        default: throw new JobsError('unsupported native answer command');
    }
}
