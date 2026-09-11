import { createHash } from 'node:crypto';
import { fromJSON, get, has, int, object, set, string, same, JobsError } from './values.js';
import type { Document, Value } from './values.js';
import { exact, optionalEmail, revisionAndTime } from './automation.js';
import { emailFlow, passwordFlow } from './account-realm.js';

const legacy = ['realmRef', 'adapterId', 'descriptorVersion', 'descriptor', 'signupEmailOverride', 'providerId', 'credentialRef', 'credentialVersion', 'lifecycleState', 'revision', 'createdAt', 'updatedAt'];
const lifecycles = ['discovered', 'credential_provisioned', 'signup_in_progress', 'active', 'verification_required', 'reset_required', 'failed_definitive', 'ambiguous'];
export function validateAccount(key: string, value: Value): Document {
  const record = object(value, 'employer account');
  exact(record, record.size === legacy.length ? legacy : [...legacy, 'flowKind', 'credentialRequired'], 'employer account record is invalid');
  if (string(get(record, 'realmRef')) !== key) throw new JobsError('employer account record is invalid');
  if (!/^[0-9a-f]{64}$/.test(key)) throw new JobsError('employer account realm reference is invalid');
  const adapter = string(get(record, 'adapterId')), descriptor = string(get(record, 'descriptor'));
  const flow = has(record, 'flowKind') ? string(get(record, 'flowKind')) : passwordFlow;
  const required = has(record, 'credentialRequired') ? get(record, 'credentialRequired') : true;
  if (!['workday', 'oracle-recruiting'].includes(adapter ?? '') || flow !== (adapter === 'workday' ? passwordFlow : emailFlow)
    || required !== (adapter === 'workday') || !same(get(record, 'descriptorVersion'), fromJSON(1))
    || !descriptor?.startsWith(`${adapter}:v1:`) || createHash('sha256').update(descriptor).digest('hex') !== key) throw new JobsError('employer account realm descriptor is invalid');
  optionalEmail(get(record, 'signupEmailOverride'), 'signup email override');
  const provider = get(record, 'providerId'), reference = get(record, 'credentialRef'), version = get(record, 'credentialVersion');
  const lifecycle = string(get(record, 'lifecycleState')) ?? '';
  if (!lifecycles.includes(lifecycle)) throw new JobsError('account lifecycle state is invalid');
  if (provider === null) {
    const allowed = flow === emailFlow ? ['discovered', 'signup_in_progress', 'active', 'verification_required', 'failed_definitive', 'ambiguous'] : ['discovered', 'signup_in_progress', 'ambiguous'];
    if (reference !== null || version !== null || !allowed.includes(lifecycle)) throw new JobsError('credential metadata requires the protected provider');
  } else if (flow === emailFlow) throw new JobsError('email-only account cannot have protected credential metadata');
  else if (!/^[a-z][a-z0-9-]{2,63}$/.test(string(provider) ?? '') || !/^credential_[0-9a-f]{64}$/.test(string(reference) ?? '') || (int(version) ?? 0n) < 1n || lifecycle === 'discovered') throw new JobsError('protected credential metadata is invalid');
  revisionAndTime(record, 'employer account');
  return record;
}
export function validateAccountsDocument(value: Value): Document {
  const document = object(value, 'employer accounts');
  if (int(get(document, 'schemaVersion')) !== 1n) throw new JobsError('employer accounts schema version is unsupported');
  exact(document, ['schemaVersion', 'accounts', 'metadata'], 'employer accounts document contains unsupported fields');
  const accounts = object(get(document, 'accounts'), 'employer accounts');
  const metadata = object(get(document, 'metadata'), 'employer account metadata');
  exact(metadata, ['createdAt', 'updatedAt'], 'employer account metadata is invalid');
  for (const field of ['createdAt', 'updatedAt']) if (!string(get(metadata, field))) throw new JobsError('employer account metadata timestamp is invalid');
  for (const [key, record] of accounts.entries()) validateAccount(string(key)!, record);
  return document;
}
export function publicAccount(record: Document): Document {
  const result = object(fromJSON({}), 'account projection');
  for (const field of ['realmRef', 'adapterId', 'descriptorVersion', 'lifecycleState', 'credentialVersion', 'revision', 'createdAt', 'updatedAt']) set(result, field, get(record, field));
  set(result, 'flowKind', has(record, 'flowKind') ? get(record, 'flowKind') : fromJSON(passwordFlow));
  set(result, 'credentialRequired', has(record, 'credentialRequired') ? get(record, 'credentialRequired') : true);
  set(result, 'signupEmailOverrideConfigured', get(record, 'signupEmailOverride') !== null);
  return set(result, 'providerAssigned', get(record, 'providerId') !== null);
}
