import { exact, identifier, record, revision, snapshot } from '../../harness/validation.js';
import { BrowserBoundaryError } from './browser-boundary.js';

export type BrowserValueGrant =
  | { readonly kind: 'fill'; readonly source: 'profile'; readonly field: string; readonly profileRevision: string }
  | { readonly kind: 'fill'; readonly source: 'answer'; readonly answerRef: string; readonly answerRevision: string }
  | { readonly kind: 'upload'; readonly source: 'resume'; readonly resumeId: string;
      readonly resumeRevision: string; readonly contentRevision: string };
export const browserProfileFields: readonly string[] = Object.freeze(['name', 'firstName', 'lastName', 'email', 'phone']);
/** Trusted host input. Public requests carry only an opaque reference to this frozen grant. */
export function browserValueGrant(raw: unknown): BrowserValueGrant {
  try {
    const value = record(snapshot(raw), 'invalid_arguments');
    if (value.source === 'profile' && value.kind === 'fill') {
      exact(value, ['kind', 'source', 'field', 'profileRevision'], 'invalid_arguments');
      if (typeof value.field !== 'string' || !browserProfileFields.includes(value.field)) throw new Error();
      return Object.freeze({ kind: 'fill', source: 'profile', field: value.field,
        profileRevision: revision(value.profileRevision, 'invalid_arguments') });
    }
    if (value.source === 'answer' && value.kind === 'fill') {
      exact(value, ['kind', 'source', 'answerRef', 'answerRevision'], 'invalid_arguments');
      return Object.freeze({ kind: 'fill', source: 'answer', answerRef: identifier(value.answerRef, 'invalid_arguments'),
        answerRevision: revision(value.answerRevision, 'invalid_arguments') });
    }
    if (value.source === 'resume' && value.kind === 'upload') {
      exact(value, ['kind', 'source', 'resumeId', 'resumeRevision', 'contentRevision'], 'invalid_arguments');
      if (typeof value.contentRevision !== 'string' || !/^content_[A-Za-z0-9_-]{32,128}$/.test(value.contentRevision)) throw new Error();
      return Object.freeze({ kind: 'upload', source: 'resume', resumeId: identifier(value.resumeId, 'invalid_arguments'),
        resumeRevision: revision(value.resumeRevision, 'invalid_arguments'), contentRevision: value.contentRevision });
    }
    throw new Error();
  } catch { throw new BrowserBoundaryError('invalid_browser_input'); }
}
