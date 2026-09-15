import { runGroupedApprovalCommand } from './native-grouped-approvals.js';
import { ReplayTransitionService } from '../workspace-core/replay-transition.js';
import { TrustedFillService } from '../workspace-core/trusted-fill.js';
import { JobsError } from '../contracts/workspace/values.js';
export const nativeAuthorityCommands = {
    'attention-approval-preview': ['--id', '--expected-job-revision', '--expected-session-revision', '--input'],
    'attention-approval-approve': ['--id', '--expected-job-revision', '--expected-session-revision', '--preview-token', '--input', '--owner-confirmed'],
    'replay-transition': ['--id', '--transition', '--ats'],
    'trusted-fill-approve': ['--input'], 'trusted-fill-status': ['--id'],
    'trusted-fill-evaluate': ['--input'], 'trusted-fill-revoke': ['--id', '--expected-approval-revision'],
};
const flags = new Set(['--owner-confirmed']);
function positive(value, label) {
    const source = value.trim();
    if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(source))
        throw new JobsError(`${label} must be a positive integer`);
    const parsed = BigInt(source.replaceAll('_', ''));
    if (parsed < 1n)
        throw new JobsError(`${label} must be a positive integer`);
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
    for (const key of ['--expected-job-revision', '--expected-session-revision', '--expected-approval-revision']) {
        const value = options.get(key);
        if (value !== undefined)
            options.set(key, positive(value, key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())));
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
    const trusted = new TrustedFillService(context.repository, context.now);
    if (command === 'trusted-fill-approve')
        return trusted.approve(await input(), { public: false });
    if (command === 'trusted-fill-status')
        return trusted.status(required('--id'), { public: false });
    if (command === 'trusted-fill-evaluate')
        return trusted.evaluate(await input(), { consume: false });
    return trusted.revoke(required('--id'), BigInt(required('--expected-approval-revision')), { public: false });
}
