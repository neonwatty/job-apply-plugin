import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { strip } from './job-url.js';

export const passwordFlow = 'password_candidate_account';
export const emailFlow = 'email_only_candidate_profile';
export type Realm = { status: 'unresolved'; reasonCode: string } | {
  status: 'resolved'; adapterId: string; descriptorVersion: number; descriptor: string;
  realmRef: string; authorityKind: string; flowKind: string; credentialRequired: boolean;
};
const unresolved = (reasonCode: string): Realm => ({ status: 'unresolved', reasonCode });
const credentialKey = /(?:^|[_-])(?:access[_-]?token|auth|authorization|cookie|credential|passcode|password|recovery|secret|session|token)(?:$|[_-])/i;
const oracleHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.fa\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.oraclecloud\.com$/;
const oraclePath = /^\/hcmUI\/CandidateExperience\/[a-z]{2}(?:-[A-Z]{2})?\/sites\/([a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?)\/job\/[1-9][0-9]*(?:\/apply\/email)?\/?$/;
function resolved(adapterId: string, descriptor: string, authorityKind: string): Realm {
  return { status: 'resolved', adapterId, descriptorVersion: 1, descriptor,
    realmRef: createHash('sha256').update(descriptor).digest('hex'), authorityKind,
    flowKind: adapterId === 'workday' ? passwordFlow : emailFlow, credentialRequired: adapterId === 'workday' };
}
/** Keep Python urlsplit identity: no WHATWG dot-path, percent or IDNA rewriting. */
export function resolveAccountRealm(input: unknown): Realm {
  if (typeof input !== 'string' || !strip(input)) return unresolved('portal_url_required');
  const value = strip(input).replace(/^[\x00-\x20]+/, '').replace(/[\t\r\n]/g, '');
  const parsed = /^(?:([a-z][a-z0-9+.-]*):)?\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/is.exec(value);
  if (!parsed) return unresolved('portal_not_proven');
  const authority = parsed[2]!, hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (/[/?#@:]/.test(authority.replace(/[@:#?]/g, '').normalize('NFKC'))) return unresolved('portal_url_invalid');
  let host: string, port: string | undefined;
  if (hostPort.includes('[') || hostPort.includes(']')) {
    const bracket = /^\[([^\]]+)\](?::(.*))?$/.exec(hostPort);
    if (!bracket || !(isIP(bracket[1]!) === 6 || /^v[\da-f]+\..+$/i.test(bracket[1]!))) return unresolved('portal_url_invalid');
    host = bracket[1]!; port = bracket[2];
  } else {
    const colon = hostPort.indexOf(':');
    host = colon < 0 ? hostPort : hostPort.slice(0, colon);
    port = colon < 0 ? undefined : hostPort.slice(colon + 1);
  }
  if (host.endsWith('.')) return unresolved('portal_not_proven');
  if (port && (!/^[0-9]+$/.test(port) || BigInt(port) > 65535n)) return unresolved('portal_url_invalid');
  if ((parsed[1] ?? '').toLowerCase() !== 'https' || !host || port && BigInt(port) !== 443n) return unresolved('portal_not_proven');
  if (authority.includes('@')) return unresolved('portal_url_userinfo_rejected');
  if (parsed[5]) return unresolved('portal_url_fragment_rejected');
  if ([...new URLSearchParams(parsed[4] ?? '').keys()].some(key => credentialKey.test(key.replace(/[İı]/g, 'i').replace(/ſ/g, 's').replace(/K/g, 'k')))) return unresolved('portal_url_credential_parameter_rejected');
  host = host.toLowerCase();
  const workday = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(wd[1-9][0-9]*)\.myworkdayjobs\.com$/.exec(host);
  if (workday) return resolved('workday', `workday:v1:${workday[2]}:${workday[1]}`, 'tenant-host');
  if (/^wd[1-9][0-9]*\.myworkday\.com$/.test(host)) return unresolved('ambiguous_auth_gateway');
  if (oracleHost.test(host)) {
    const path = parsed[3]!, match = oraclePath.exec(path);
    if (parsed[4] || path.includes('%') || path.includes('//') || !match) return unresolved('oracle_recruiting_path_unproven');
    return resolved('oracle-recruiting', `oracle-recruiting:v1:${host}:${match[1]}`, 'tenant-site');
  }
  return unresolved('adapter_unresolved');
}
