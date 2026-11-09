import { createHash } from 'node:crypto';
import { exact } from './automation.js';
import { trustedFillOperationList } from './trusted-fill.js';
import { fromJSON, get, int, object, set, string, text, JobsError } from './values.js';
const fingerprintPattern = /^sha256:[0-9a-f]{64}$/;
const providerPattern = /^[a-z][a-z0-9-]{2,63}$/;
const packetFields = ['schemaVersion', 'jobId', 'approvalRevision', 'consumedApprovalRevision',
    'observedQuestionFingerprint', 'observedControlFingerprint', 'formFingerprint',
    'allowedOperations', 'operationFingerprint', 'finalActionAuthorized'];
const receiptFields = ['schemaVersion', 'providerId', 'operationFingerprint', 'appliedOperations',
    'finalActionActivated', 'authenticationActivated', 'consentActivated',
    'credentialFieldsTouched', 'privateValuesCleared', 'retryAllowed'];
function positive(value, label) {
    const result = int(value);
    if (result === null || result < 1n)
        throw new JobsError(`${label} must be a positive integer`);
    return result;
}
function fingerprint(value, label) {
    const result = string(value);
    if (!result || !fingerprintPattern.test(result))
        throw new JobsError(`${label} must be a sha256 fingerprint`);
    return result;
}
export function trustedFillNativeOperationFingerprint(value) {
    const packet = object(value, 'trusted fill native packet');
    const fields = ['jobId', 'approvalRevision', 'consumedApprovalRevision', 'observedQuestionFingerprint',
        'observedControlFingerprint', 'formFingerprint'];
    const parts = fields.map(field => {
        const item = get(packet, field);
        return field.includes('Revision') ? positive(item, field).toString() : string(item) ?? '';
    });
    parts.push(...trustedFillOperationList(get(packet, 'allowedOperations')));
    return `sha256:${createHash('sha256').update(`trusted-fill-native:v1:${parts.join(':')}`).digest('hex')}`;
}
export function trustedFillNativePacket(evaluation, decision) {
    const packet = object(fromJSON({ schemaVersion: 1, jobId: string(get(evaluation, 'jobId')),
        approvalRevision: null, consumedApprovalRevision: null,
        observedQuestionFingerprint: string(get(evaluation, 'observedQuestionFingerprint')),
        observedControlFingerprint: string(get(evaluation, 'observedControlFingerprint')),
        formFingerprint: string(get(evaluation, 'formFingerprint')),
        allowedOperations: trustedFillOperationList(get(decision, 'allowedOperations')),
        operationFingerprint: null, finalActionAuthorized: false }), 'trusted fill native packet');
    set(packet, 'approvalRevision', get(evaluation, 'expectedApprovalRevision'));
    set(packet, 'consumedApprovalRevision', get(decision, 'consumedApprovalRevision'));
    set(packet, 'operationFingerprint', text(trustedFillNativeOperationFingerprint(packet)));
    return validateTrustedFillNativePacket(packet);
}
export function validateTrustedFillNativePacket(value) {
    const packet = object(value, 'trusted fill native packet');
    exact(packet, packetFields, 'trusted fill native packet is invalid');
    if (int(get(packet, 'schemaVersion')) !== 1n || !string(get(packet, 'jobId')))
        throw new JobsError('trusted fill native packet is invalid');
    positive(get(packet, 'approvalRevision'), 'approvalRevision');
    positive(get(packet, 'consumedApprovalRevision'), 'consumedApprovalRevision');
    for (const field of ['observedQuestionFingerprint', 'observedControlFingerprint', 'formFingerprint'])
        fingerprint(get(packet, field), field);
    trustedFillOperationList(get(packet, 'allowedOperations'));
    if (get(packet, 'finalActionAuthorized') !== false
        || fingerprint(get(packet, 'operationFingerprint'), 'operationFingerprint') !== trustedFillNativeOperationFingerprint(packet)) {
        throw new JobsError('trusted fill native packet is invalid');
    }
    return packet;
}
export function validateTrustedFillNativeReceipt(value, packet, providerId) {
    const receipt = object(value, 'trusted fill native receipt');
    exact(receipt, receiptFields, 'trusted fill native receipt is invalid');
    if (int(get(receipt, 'schemaVersion')) !== 1n || !providerPattern.test(providerId)
        || string(get(receipt, 'providerId')) !== providerId
        || string(get(receipt, 'operationFingerprint')) !== string(get(packet, 'operationFingerprint'))
        || trustedFillOperationList(get(receipt, 'appliedOperations')).join('\0')
            !== trustedFillOperationList(get(packet, 'allowedOperations')).join('\0')) {
        throw new JobsError('trusted fill native receipt is invalid');
    }
    for (const field of ['finalActionActivated', 'authenticationActivated', 'consentActivated', 'credentialFieldsTouched']) {
        if (get(receipt, field) !== false)
            throw new JobsError('trusted fill native receipt widened authority');
    }
    if (get(receipt, 'privateValuesCleared') !== true || get(receipt, 'retryAllowed') !== false) {
        throw new JobsError('trusted fill native receipt is invalid');
    }
    return receipt;
}
