import { PythonObject } from '../contracts/python-object.js';
import { exact } from '../contracts/workspace/automation.js';
import { get, has, int, keys, object, parse, serialize, set, string, JobsError } from '../contracts/workspace/values.js';
import type { Value } from '../contracts/workspace/values.js';
import { AutomationService, automationProjection } from './automation.js';
import type { AutomationRepository } from './automation.js';
import { AccountsService } from './accounts.js';
import { ApplicationAuthorityService } from './application-authority.js';
import type { ApplicationAuthorityRepository } from './application-authority.js';

const response = (value: Value) => ({ status: 200, body: serialize(value) });
function revision(value: Value, label = 'expectedRevision', zero = false): bigint {
  const result = int(value);
  if (result === null || result < (zero ? 0n : 1n)) throw new JobsError(`${label} must be ${zero ? 'a non-negative' : 'a positive'} integer`);
  return result;
}
/** Owner handles generic safe request/storage errors using existing HTTP boundary. */
export async function automationHttp(repository: AutomationRepository & ApplicationAuthorityRepository,
  method: string, path: string, body: string): Promise<{status: number; body: string} | null> {
  const settings = new AutomationService(repository), accounts = new AccountsService(repository);
  const authority = typeof repository.applicationAuthorityTransaction === 'function'
    ? new ApplicationAuthorityService(repository) : null;
  const updateAccount = /^\/api\/employer-accounts\/([^/]+)$/.exec(path);
  if (method === 'GET' && path === '/api/automation') {
    const projection = await automationProjection(repository);
    return response(set(projection, 'applicationAuthority', authority ? await authority.status() : object(parse(
      '{"mode":"guided","status":"active","revision":0,"authorizationId":null,"expiresAt":null,"runId":null,"jobIds":[],"sensitiveAnswerRefs":[]}'
    ), 'application authority projection')));
  }
  if (method === 'GET' && path === '/api/application-authority/progress') return authority ? response(await authority.progress()) : null;
  if (method === 'GET' && updateAccount) {
    const account = await accounts.get(decodeURIComponent(updateAccount[1]!), true);
    if (account === null) throw new JobsError('employer account does not exist');
    return response(account);
  }
  const recognized = method === 'POST' && ['/api/automation/realm-resolve', '/api/automation/settings/copy-profile-email', '/api/employer-accounts',
    '/api/application-authority', '/api/application-authority/revoke', '/api/application-authority/evaluate'].includes(path)
    || method === 'POST' && /^\/api\/application-authority\/(pause|resume|stop)$/u.test(path)
    || method === 'PATCH' && (path === '/api/automation/settings' || updateAccount !== null);
  if (!recognized) return null;
  if (path.startsWith('/api/application-authority') && authority === null) return null;
  const payload = object(parse(body), 'body');
  if (path === '/api/application-authority/evaluate') return response(await authority!.evaluate(payload));
  if (path === '/api/application-authority/revoke') {
    exact(payload, ['expectedRevision'], 'body must contain expectedRevision');
    return response(await authority!.revoke(revision(get(payload, 'expectedRevision'), 'expectedRevision')));
  }
  const control = /^\/api\/application-authority\/(pause|resume|stop)$/u.exec(path);
  if (control) {
    exact(payload, ['expectedRevision'], 'body must contain expectedRevision');
    return response(await authority!.control(control[1] as 'pause' | 'resume' | 'stop', revision(get(payload, 'expectedRevision'))));
  }
  if (path === '/api/application-authority') {
    exact(payload, ['authority', 'expectedRevision'], 'body must contain authority and expectedRevision');
    if (!(get(payload, 'authority') instanceof PythonObject)) throw new JobsError('body must contain authority and expectedRevision');
    return response(await authority!.set(get(payload, 'authority'), revision(get(payload, 'expectedRevision'), 'expectedRevision', true)));
  }
  if (path === '/api/automation/realm-resolve') {
    exact(payload, ['url'], 'body must contain only a portal URL');
    if (string(get(payload, 'url')) === null) throw new JobsError('body must contain only a portal URL');
    return response(accounts.resolve(string(get(payload, 'url'))));
  }
  if (path === '/api/automation/settings/copy-profile-email') {
    exact(payload, ['expectedProfileRevision', 'expectedSettingsRevision'], 'body must contain exact profile and settings revisions');
    const values = ['expectedProfileRevision', 'expectedSettingsRevision'].map(key => int(get(payload, key)));
    if (values.some(value => value === null || value < 1n)) throw new JobsError('profile and settings revisions must be positive integers');
    return response(await settings.copyProfileEmail(values[0]!, values[1]!, true));
  }
  if (method === 'POST' && path === '/api/employer-accounts') {
    if (keys(payload).some(key => !['url', 'signupEmailOverride'].includes(key)) || !has(payload, 'url') || string(get(payload, 'url')) === null) throw new JobsError('body must contain a portal URL and optional signup email override');
    return response(await accounts.create(string(get(payload, 'url')), get(payload, 'signupEmailOverride'), true));
  }
  const label = path === '/api/automation/settings' ? 'settings' : 'account';
  exact(payload, ['patch', 'expectedRevision'], `body must contain a ${label} patch and expectedRevision`);
  if (!(get(payload, 'patch') instanceof PythonObject)) throw new JobsError(`body must contain a ${label} patch and expectedRevision`);
  const expected = revision(get(payload, 'expectedRevision'));
  return response(path === '/api/automation/settings' ? await settings.update(get(payload, 'patch'), expected, true)
    : await accounts.update(decodeURIComponent(updateAccount![1]!), get(payload, 'patch'), expected, true));
}
