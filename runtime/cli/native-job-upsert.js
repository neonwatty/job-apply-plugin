import { JobUpsertService } from '../workspace-core/job-upsert.js';
import { JobsError } from '../contracts/workspace/values.js';
export const jobUpsertCommands = {
    'job-upsert-preview': ['--input', '--origin'],
    'job-upsert-commit': ['--input', '--origin', '--token'],
};
export async function runJobUpsertCommand(command, repository, options, payload) {
    const required = (key) => {
        const value = options.get(key);
        if (!value)
            throw new JobsError(`required option: ${key}`);
        return value;
    };
    const author = required('--origin');
    const service = new JobUpsertService(repository);
    if (command === 'job-upsert-preview')
        return service.preview(await payload(), author);
    const token = required('--token');
    return service.commit(await payload(), author, token);
}
