import { runGroupedApprovalCommand } from './native-grouped-approvals.js';
import { ReplayTransitionService } from '../workspace-core/replay-transition.js';
import { TrustedFillService } from '../workspace-core/trusted-fill.js';
import { JobsError } from '../contracts/workspace/values.js';
import { ApplicationAuthorityService } from '../workspace-core/application-authority.js';
export const nativeAuthorityCommands = {
    'attention-approval-preview': ['--id', '--expected-job-revision', '--expected-session-revision', '--input'],
    'attention-approval-approve': ['--id', '--expected-job-revision', '--expected-session-revision', '--preview-token', '--input', '--owner-confirmed'],
    'replay-transition': ['--id', '--transition', '--ats'],
    'trusted-fill-approve': ['--input'], 'trusted-fill-status': ['--id'],
    'trusted-fill-evaluate': ['--input'], 'trusted-fill-revoke': ['--id', '--expected-approval-revision'],
    'application-authority-status': [], 'application-authority-set': ['--input', '--expected-revision'],
    'application-authority-revoke': ['--expected-revision'], 'application-authority-evaluate': ['--input'],
    'application-authority-progress': [], 'application-authority-pause': ['--expected-revision'],
    'application-authority-resume': ['--expected-revision'], 'application-authority-stop': ['--expected-revision'],
};
const flags = new Set(['--owner-confirmed']);
function positive(value, label, zero = false) {
    const source = value.trim();
    if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(source))
        throw new JobsError(`${label} must be a positive integer`);
    const parsed = BigInt(source.replaceAll('_', ''));
    if (parsed < (zero ? 0n : 1n))
        throw new JobsError(`${label} must be ${zero ? 'a non-negative' : 'a positive'} integer`);
    return parsed.toString();
}
function optionsFor(command, args) {
    const allowed = nativeAuthorityCommands[command], options = new Map();
    for (let index = 0; index < args.length; index++) {
        const key = args[index];
        if (!key.startsWith('--'))
            throw new JobsError('unexpected CLI argument');
        if (options.has(key))
            throw new JobsError('duplicate CLI option');
        if (flags.has(key))
            options.set(key, 'true');
        else {
            const value = args[++index];
            if (value === undefined || value.startsWith('--'))
                throw new JobsError('missing CLI option value');
            options.set(key, value);
        }
    }
    if ([...options.keys()].some(key => !allowed.includes(key)))
        throw new JobsError('unsupported native authority command or option');
    for (const key of allowed.filter(key => !flags.has(key)))
        if (!options.has(key))
            throw new JobsError(`required option: ${key}`);
    for (const key of ['--expected-job-revision', '--expected-session-revision', '--expected-approval-revision', '--expected-revision']) {
        const value = options.get(key);
        if (value !== undefined)
            options.set(key, positive(value, key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), key === '--expected-revision'));
    }
    return options;
}
export async function runNativeAuthorityCommand(command, args, context) {
    if (!Object.hasOwn(nativeAuthorityCommands, command))
        return null;
    const options = optionsFor(command, args), required = (key) => options.get(key);
    const input = async () => {
        try {
            return await context.readInput(required('--input'));
        }
        catch {
            throw new JobsError('input is not a readable JSON object');
        }
    };
    if (command.startsWith('attention-approval-')) {
        const delegated = command === 'attention-approval-preview' ? 'approval-preview' : 'approval-approve';
        return runGroupedApprovalCommand(delegated, context.repository, options, input);
    }
    if (command === 'replay-transition')
        return new ReplayTransitionService(context.repository, context.now).record(required('--id'), required('--transition'), required('--ats'));
    const application = new ApplicationAuthorityService(context.repository, context.now);
    if (command === 'application-authority-status')
        return application.status();
    if (command === 'application-authority-progress')
        return application.progress();
    if (command === 'application-authority-set')
        return application.set(await input(), BigInt(required('--expected-revision')));
    if (command === 'application-authority-revoke')
        return application.revoke(BigInt(required('--expected-revision')));
    if (command === 'application-authority-evaluate')
        return application.evaluate(await input());
    if (command.startsWith('application-authority-'))
        return application.control(command.slice('application-authority-'.length), BigInt(required('--expected-revision')));
    const trusted = new TrustedFillService(context.repository, context.now);
    if (command === 'trusted-fill-approve')
        return trusted.approve(await input(), { public: false });
    if (command === 'trusted-fill-status')
        return trusted.status(required('--id'), { public: false });
    if (command === 'trusted-fill-evaluate')
        return trusted.evaluate(await input(), { consume: false });
    return trusted.revoke(required('--id'), BigInt(required('--expected-approval-revision')), { public: false });
}
