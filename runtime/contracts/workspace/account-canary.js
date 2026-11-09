import { createHash } from 'node:crypto';
import { emailFlow, resolveAccountRealm } from './account-realm.js';
import { exact } from './automation.js';
import { fingerprint } from './synthetic-account.js';
import { copy, fromJSON, get, has, int, integer, object, set, string, JobsError } from './values.js';
const fingerprintPattern = /^sha256:[0-9a-f]{64}$/u;
const realmPattern = /^[0-9a-f]{64}$/u;
const claimPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const capabilityPattern = /^canary_[0-9a-f]{64}$/u;
const bindingFields = ['jobId', 'jobRevision', 'claimId', 'realmRef', 'accountRevision',
    'settingsRevision', 'portalFingerprint', 'portalNameFingerprint', 'accountCreationControlsFingerprint',
    'approvalRevision', 'flowKind', 'termsDocumentFingerprint', 'accountFormFingerprint',
    'emailControlFingerprint', 'termsControlFingerprint', 'nextControlFingerprint',
    'passwordControlFingerprint', 'createAccountControlFingerprint'];
const liveFields = ['capabilityRef', 'binding', 'portalName', 'portalUrl', 'accountFormFingerprint',
    'emailControlFingerprint', 'termsControlFingerprint', 'termsDocumentFingerprint',
    'nextControlFingerprint', 'passwordControlFingerprint', 'createAccountControlFingerprint'];
const componentFields = ['accountFormFingerprint', 'emailControlFingerprint', 'termsControlFingerprint',
    'termsDocumentFingerprint', 'nextControlFingerprint'];
function positive(binding, field) {
    const value = int(get(binding, field));
    if (value === null || value < 1n)
        throw new JobsError('canary revision binding is invalid');
    return value;
}
export function validateOracleCanaryBinding(value) {
    const binding = object(value, 'Oracle canary binding');
    exact(binding, bindingFields, 'canary binding is invalid');
    if (!string(get(binding, 'jobId')) || !claimPattern.test(string(get(binding, 'claimId')) ?? '')) {
        throw new JobsError('canary job or claim binding is invalid');
    }
    if (!realmPattern.test(string(get(binding, 'realmRef')) ?? '') || string(get(binding, 'flowKind')) !== emailFlow) {
        throw new JobsError('canary realm or flow binding is invalid');
    }
    for (const field of ['jobRevision', 'accountRevision', 'settingsRevision', 'approvalRevision'])
        positive(binding, field);
    for (const field of ['portalFingerprint', 'portalNameFingerprint', 'accountCreationControlsFingerprint', ...componentFields]) {
        if (!fingerprintPattern.test(string(get(binding, field)) ?? ''))
            throw new JobsError('canary fingerprint binding is invalid');
    }
    if (get(binding, 'passwordControlFingerprint') !== null || get(binding, 'createAccountControlFingerprint') !== null) {
        throw new JobsError('canary credential controls are invalid');
    }
    const aggregate = fingerprint(componentFields.map(field => string(get(binding, field))).join(':'));
    if (aggregate !== string(get(binding, 'accountCreationControlsFingerprint'))) {
        throw new JobsError('canary aggregate control binding is invalid');
    }
    return binding;
}
function scalar(binding, key) {
    const number = int(get(binding, key));
    if (number !== null)
        return number.toString();
    const value = get(binding, key);
    if (value === null)
        return 'null';
    return JSON.stringify(string(value));
}
export function validateOracleCanaryFinalScope(value) {
    const scope = object(value, 'Oracle canary final scope');
    exact(scope, bindingFields.filter(field => field !== 'claimId'), 'claim-independent final scope is invalid');
    const execution = copy(scope);
    set(execution, 'claimId', fromJSON('00000000-0000-4000-8000-000000000000'));
    validateOracleCanaryBinding(execution);
    return scope;
}
function domainDigest(domain, binding, omitClaim) {
    if (omitClaim && !has(binding, 'claimId'))
        validateOracleCanaryFinalScope(binding);
    else
        validateOracleCanaryBinding(binding);
    const keys = bindingFields.filter(key => !(omitClaim && key === 'claimId')).sort();
    const canonical = `{${keys.map(key => `${JSON.stringify(key)}:${scalar(binding, key)}`).join(',')}}`;
    return `sha256:${createHash('sha256').update(`job-apply-account-canary:${domain}:v1\0${canonical}`).digest('hex')}`;
}
export const canaryBindingDigest = (binding) => domainDigest('claim-bound-execution', binding, false);
export const canaryFinalScopeDigest = (binding) => domainDigest('final-owner-approval', binding, true);
export const privateCanaryDigest = (value) => `sha256:${createHash('sha256').update(value, 'ascii').digest('hex')}`;
export function validateLiveEmailCanaryRequest(value) {
    const request = object(value, 'live email canary request');
    exact(request, liveFields, 'live canary request is invalid');
    const capabilityRef = string(get(request, 'capabilityRef')) ?? '';
    if (!capabilityPattern.test(capabilityRef))
        throw new JobsError('live canary capability is invalid');
    const binding = validateOracleCanaryBinding(get(request, 'binding'));
    const portalName = string(get(request, 'portalName')) ?? '';
    const portalUrl = string(get(request, 'portalUrl')) ?? '';
    let portal;
    try {
        portal = new URL(portalUrl);
    }
    catch {
        throw new JobsError('live canary portal is invalid');
    }
    if (!portalName.trim() || [...portalName].length > 160 || portal.protocol !== 'https:' || !portal.hostname
        || portal.username || portal.password || portal.search || portal.hash || !portal.pathname.startsWith('/')) {
        throw new JobsError('live canary requires one exact named HTTPS portal');
    }
    const realm = resolveAccountRealm(portalUrl);
    if (realm.status !== 'resolved' || realm.adapterId !== 'oracle-recruiting' || realm.flowKind !== emailFlow
        || realm.realmRef !== string(get(binding, 'realmRef')))
        throw new JobsError('email-only canary realm binding is invalid');
    for (const field of componentFields) {
        const item = string(get(request, field));
        if (!fingerprintPattern.test(item ?? '') || item !== string(get(binding, field))) {
            throw new JobsError('email-only canary component binding is invalid');
        }
    }
    if (get(request, 'passwordControlFingerprint') !== null || get(request, 'createAccountControlFingerprint') !== null
        || get(binding, 'passwordControlFingerprint') !== null || get(binding, 'createAccountControlFingerprint') !== null) {
        throw new JobsError('email-only canary forbids credential controls');
    }
    if (string(get(binding, 'portalFingerprint')) !== fingerprint(portalUrl)
        || string(get(binding, 'portalNameFingerprint')) !== fingerprint(portalName)) {
        throw new JobsError('email-only canary portal binding is invalid');
    }
    const packet = object(fromJSON({ jobId: string(get(binding, 'jobId')), jobRevision: null,
        expectedClaimId: string(get(binding, 'claimId')), realmRef: realm.realmRef, realmDescriptor: realm.descriptor,
        flowKind: emailFlow, accountRevision: null, settingsRevision: null, portalUrl,
        accountFormFingerprint: string(get(request, 'accountFormFingerprint')),
        emailControlFingerprint: string(get(request, 'emailControlFingerprint')),
        termsControlFingerprint: string(get(request, 'termsControlFingerprint')),
        termsDocumentFingerprint: string(get(request, 'termsDocumentFingerprint')),
        nextControlFingerprint: string(get(request, 'nextControlFingerprint')),
        passwordControlFingerprint: null, createAccountControlFingerprint: null,
        accountCreationControlsFingerprint: string(get(binding, 'accountCreationControlsFingerprint')) }), 'live provider packet');
    for (const field of ['jobRevision', 'accountRevision', 'settingsRevision']) {
        set(packet, field, integer(positive(binding, field)));
    }
    return { capabilityRef, binding, packet };
}
