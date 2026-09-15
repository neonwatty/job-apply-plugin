import { AccountsService } from '../workspace-core/accounts.js';
import { AutomationService } from '../workspace-core/automation.js';
import { SyntheticAccountService } from '../workspace-core/synthetic-account.js';
import { fromJSON, get, keys, object, JobsError } from '../contracts/workspace/values.js';
export const nativeAutomationCommandNames = new Set([
    'automation-settings-get', 'automation-settings-update',
    'automation-settings-copy-profile-email', 'automation-capability',
    'account-realm-resolve', 'employer-account-list', 'employer-account-get',
    'employer-account-create', 'employer-account-update',
    'employer-account-execute-synthetic',
]);
const commandOptions = {
    'automation-settings-get': { allowed: [], required: [] },
    'automation-settings-update': { allowed: ['--input', '--expected-revision'], required: ['--input', '--expected-revision'] },
    'automation-settings-copy-profile-email': {
        allowed: ['--expected-profile-revision', '--expected-settings-revision'],
        required: ['--expected-profile-revision', '--expected-settings-revision'],
    },
    'automation-capability': { allowed: ['--platform'], required: [] },
    'account-realm-resolve': { allowed: ['--url'], required: ['--url'] },
    'employer-account-list': { allowed: [], required: [] },
    'employer-account-get': { allowed: ['--realm-ref'], required: ['--realm-ref'] },
    'employer-account-create': { allowed: ['--url', '--input'], required: ['--url'] },
    'employer-account-update': {
        allowed: ['--realm-ref', '--input', '--expected-revision'],
        required: ['--realm-ref', '--input', '--expected-revision'],
    },
    'employer-account-execute-synthetic': { allowed: ['--input'], required: ['--input'] },
};
function optionsFor(command, args) {
    const specification = commandOptions[command];
    const options = new Map();
    for (let index = 0; index < args.length; index++) {
        const key = args[index];
        if (!key.startsWith('--'))
            throw new JobsError('unexpected CLI argument');
        if (options.has(key))
            throw new JobsError('duplicate CLI option');
        const value = args[++index];
        if (!value || value.startsWith('--'))
            throw new JobsError('missing CLI option value');
        options.set(key, value);
    }
    if ([...options.keys()].some(key => !specification.allowed.includes(key))) {
        throw new JobsError('unsupported native account automation command or option');
    }
    for (const key of specification.required)
        if (!options.has(key))
            throw new JobsError(`required option: ${key}`);
    if (options.has('--platform') && !['darwin', 'linux', 'win32'].includes(options.get('--platform'))) {
        throw new JobsError('platform must be darwin, linux, or win32');
    }
    for (const key of ['--expected-revision', '--expected-profile-revision', '--expected-settings-revision']) {
        const value = options.get(key);
        if (value !== undefined && !/^[+-]?[0-9]+$/.test(value)) {
            throw new JobsError('expected revision must be a positive integer');
        }
    }
    return options;
}
function inputObject(value) {
    try {
        return object(value, 'input');
    }
    catch (error) {
        if (error instanceof JobsError)
            throw new JobsError('input must be a JSON object');
        throw error;
    }
}
function automationCapability(platform) {
    if (platform === 'darwin')
        return fromJSON({
            providerId: 'macos-keychain', state: 'available', reasonCode: 'native_compound_boundary',
            credentialOperationsReady: false, syntheticOperationsReady: true,
            productionSeamReady: true, liveExecutionEnabled: false, discoveryMode: 'side_effect_free',
            accountFlowAutomation: {
                productionSeamReady: true, liveExecutionEnabled: false,
                workdayPasswordAccountReady: true, greenhouseAccountlessClassificationReady: true,
                providerId: 'macos-accessibility', state: 'available', emailOnlyCandidateProfileReady: true,
                credentialOperationsReady: false, discoveryMode: 'side_effect_free',
            },
        });
    const windows = platform === 'win32';
    const unsupported = platform !== 'linux' && !windows;
    return fromJSON({
        providerId: null, state: 'unsupported',
        reasonCode: unsupported ? 'platform_unsupported'
            : windows ? 'provider_not_implemented_windows' : 'provider_not_implemented_linux',
        credentialOperationsReady: false, syntheticOperationsReady: false, discoveryMode: 'side_effect_free',
        accountFlowAutomation: {
            productionSeamReady: false, liveExecutionEnabled: false,
            workdayPasswordAccountReady: false, greenhouseAccountlessClassificationReady: false,
            providerId: null, state: 'unsupported',
            reasonCode: unsupported ? 'platform_unsupported'
                : windows ? 'account_flow_not_implemented_windows' : 'account_flow_not_implemented_linux',
            discoveryMode: 'side_effect_free',
        },
    });
}
export async function runNativeAutomationCommand(command, args, context) {
    if (!nativeAutomationCommandNames.has(command))
        return null;
    const options = optionsFor(command, args);
    const required = (key) => options.get(key);
    const revision = (key) => BigInt(required(key));
    const payload = async () => {
        let value;
        try {
            value = await context.readInput(required('--input'));
        }
        catch {
            throw new JobsError('input is not a readable JSON object');
        }
        return inputObject(value);
    };
    const automation = context.now
        ? new AutomationService(context.repository, context.now)
        : new AutomationService(context.repository);
    const accounts = context.now
        ? new AccountsService(context.repository, context.now)
        : new AccountsService(context.repository);
    switch (command) {
        case 'automation-settings-get': return automation.get(true);
        case 'automation-settings-update':
            return automation.update(await payload(), revision('--expected-revision'), true);
        case 'automation-settings-copy-profile-email':
            return automation.copyProfileEmail(revision('--expected-profile-revision'), revision('--expected-settings-revision'), true);
        case 'automation-capability': return automationCapability(options.get('--platform') ?? process.platform);
        case 'account-realm-resolve': return accounts.resolve(required('--url'));
        case 'employer-account-list': return accounts.list(true);
        case 'employer-account-get': return accounts.get(required('--realm-ref'), true);
        case 'employer-account-create': {
            const metadata = options.has('--input') ? await payload() : object(fromJSON({}), 'employer account input');
            if (keys(metadata).some(key => key !== 'signupEmailOverride')) {
                throw new JobsError('employer account input contains unsupported fields');
            }
            return accounts.create(required('--url'), get(metadata, 'signupEmailOverride'), true);
        }
        case 'employer-account-update':
            return accounts.update(required('--realm-ref'), await payload(), revision('--expected-revision'), true);
        case 'employer-account-execute-synthetic': {
            const synthetic = context.now
                ? new SyntheticAccountService(context.repository, context.syntheticExecutor, context.now)
                : new SyntheticAccountService(context.repository, context.syntheticExecutor);
            return synthetic.execute(await payload());
        }
        default: return null;
    }
}
