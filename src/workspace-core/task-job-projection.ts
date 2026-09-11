import { get, has, set, object, fromJSON, type Document } from '../contracts/workspace/values.js';

/** Shared task view excludes URLs, notes, provenance and claim credentials. */
export function taskJobProjection(record: Document): Document {
  const result = object(fromJSON({}), 'task job');
  for (const field of ['id', 'role', 'company', 'location', 'workplaceType', 'employmentType',
    'status', 'priority', 'revision', 'createdAt', 'updatedAt']) {
    if (has(record, field)) set(result, field, get(record, field));
  }
  return result;
}
