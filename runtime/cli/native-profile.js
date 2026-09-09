import { ProfileService } from '../workspace-core/profile.js';
import { FactGroupsService } from '../workspace-core/fact-groups.js';
import { JobsError } from '../contracts/workspace/values.js';
export const profileCommands = {
    'profile-get': [], 'profile-inspect': [], 'preferences-get': [],
    'profile-patch': ['--input', '--expected-revision', '--source'],
    'profile-replace': ['--input', '--expected-revision', '--source'],
    'preferences-set': ['--input', '--expected-revision', '--source', '--replace'],
    'fact-group-list': [], 'fact-group-get': ['--id'], 'fact-group-create': ['--input'],
    'fact-group-update': ['--id', '--input', '--expected-revision'],
    'fact-group-delete': ['--id', '--expected-revision'],
};
export async function runProfileCommand(command, repository, options, payload) {
    const profile = new ProfileService(repository), groups = new FactGroupsService(repository);
    const required = (key) => {
        const value = options.get(key);
        if (!value)
            throw new JobsError(`required option: ${key}`);
        return value;
    };
    const revision = () => {
        const value = required('--expected-revision');
        if (!/^[0-9]+$/.test(value) || BigInt(value) < (command === 'profile-replace' ? 0n : 1n))
            throw new JobsError('expected revision must be a positive integer');
        return BigInt(value);
    };
    switch (command) {
        case 'profile-get': return profile.get();
        case 'profile-inspect': return profile.inspect();
        case 'preferences-get': return profile.preferences();
        case 'profile-patch': return profile.patch(await payload(), revision(), required('--source'));
        case 'profile-replace': return profile.replace(await payload(), revision(), required('--source'));
        case 'preferences-set': return profile.setPreferences(await payload(), revision(), required('--source'), options.has('--replace'));
        case 'fact-group-list': return groups.list();
        case 'fact-group-get': return groups.get(required('--id'));
        case 'fact-group-create': return groups.create(await payload());
        case 'fact-group-update': return groups.update(required('--id'), await payload(), revision());
        case 'fact-group-delete': return groups.delete(required('--id'), revision());
        default: throw new JobsError('unsupported native profile command');
    }
}
