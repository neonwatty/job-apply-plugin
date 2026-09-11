import { PythonObject } from '../contracts/python-object.js';
import { exact } from '../contracts/workspace/automation.js';
import { get, has, int, keys, object, parse, serialize, string, JobsError } from '../contracts/workspace/values.js';
import { AutomationService } from './automation.js';
import { AccountsService } from './accounts.js';
const response = (value) => ({ status: 200, body: serialize(value) });
function revision(value, label = 'expectedRevision') {
    const result = int(value);
    if (result === null || result < 1n)
        throw new JobsError(`${label} must be a positive integer`);
    return result;
}
/** Owner handles generic safe request/storage errors using existing HTTP boundary. */
export async function automationHttp(repository, method, path, body) {
    const settings = new AutomationService(repository), accounts = new AccountsService(repository);
    const updateAccount = /^\/api\/employer-accounts\/([^/]+)$/.exec(path);
    if (method === 'GET' && updateAccount) {
        const account = await accounts.get(decodeURIComponent(updateAccount[1]), true);
        if (account === null)
            throw new JobsError('employer account does not exist');
        return response(account);
    }
    const recognized = method === 'POST' && ['/api/automation/realm-resolve', '/api/automation/settings/copy-profile-email', '/api/employer-accounts'].includes(path)
        || method === 'PATCH' && (path === '/api/automation/settings' || updateAccount !== null);
    if (!recognized)
        return null;
    const payload = object(parse(body), 'body');
    if (path === '/api/automation/realm-resolve') {
        exact(payload, ['url'], 'body must contain only a portal URL');
        if (string(get(payload, 'url')) === null)
            throw new JobsError('body must contain only a portal URL');
        return response(accounts.resolve(string(get(payload, 'url'))));
    }
    if (path === '/api/automation/settings/copy-profile-email') {
        exact(payload, ['expectedProfileRevision', 'expectedSettingsRevision'], 'body must contain exact profile and settings revisions');
        const values = ['expectedProfileRevision', 'expectedSettingsRevision'].map(key => int(get(payload, key)));
        if (values.some(value => value === null || value < 1n))
            throw new JobsError('profile and settings revisions must be positive integers');
        return response(await settings.copyProfileEmail(values[0], values[1], true));
    }
    if (method === 'POST' && path === '/api/employer-accounts') {
        if (keys(payload).some(key => !['url', 'signupEmailOverride'].includes(key)) || !has(payload, 'url') || string(get(payload, 'url')) === null)
            throw new JobsError('body must contain a portal URL and optional signup email override');
        return response(await accounts.create(string(get(payload, 'url')), get(payload, 'signupEmailOverride'), true));
    }
    const label = path === '/api/automation/settings' ? 'settings' : 'account';
    exact(payload, ['patch', 'expectedRevision'], `body must contain a ${label} patch and expectedRevision`);
    if (!(get(payload, 'patch') instanceof PythonObject))
        throw new JobsError(`body must contain a ${label} patch and expectedRevision`);
    const expected = revision(get(payload, 'expectedRevision'));
    return response(path === '/api/automation/settings' ? await settings.update(get(payload, 'patch'), expected, true)
        : await accounts.update(decodeURIComponent(updateAccount[1]), get(payload, 'patch'), expected, true));
}
