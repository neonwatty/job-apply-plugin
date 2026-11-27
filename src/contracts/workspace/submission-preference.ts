import { PythonObject } from '../python-object.js';
import { get, string } from './values.js';
import type { Document, Value } from './values.js';

function field(value: Value, name: string): Value {
  return value instanceof PythonObject ? get(value, name) : null;
}

export const submitAfterApprovalPath = '/applicationPreferences/submitAfterApproval';

export function submitAfterApprovalValue(profile: Value): Value {
  return field(field(profile, 'applicationPreferences'), 'submitAfterApproval');
}

export function submitAfterApprovalEnabled(profile: Value, provenance: Value): boolean {
  const owner = field(provenance, submitAfterApprovalPath);
  return submitAfterApprovalValue(profile) === true && string(field(owner, 'source')) === 'user';
}

export function liveSubmissionEnabled(document: Document): boolean {
  return submitAfterApprovalEnabled(get(document, 'profile'), field(get(document, 'metadata'), 'factProvenance'));
}
