import { PythonObject } from '../python-object.js';
import { get, string } from './values.js';
function field(value, name) {
    return value instanceof PythonObject ? get(value, name) : null;
}
export const submitAfterApprovalPath = '/applicationPreferences/submitAfterApproval';
export function submitAfterApprovalValue(profile) {
    return field(field(profile, 'applicationPreferences'), 'submitAfterApproval');
}
export function submitAfterApprovalEnabled(profile, provenance) {
    const owner = field(provenance, submitAfterApprovalPath);
    return submitAfterApprovalValue(profile) === true && string(field(owner, 'source')) === 'user';
}
export function liveSubmissionEnabled(document) {
    return submitAfterApprovalEnabled(get(document, 'profile'), field(get(document, 'metadata'), 'factProvenance'));
}
