import { WorkflowError } from './contracts.js';
import type { Schema, WorkflowErrorCode } from './contracts.js';

export function requireCondition(condition: unknown, code: WorkflowErrorCode): asserts condition {
  if (!condition) throw new WorkflowError(code);
}

export function record(value: unknown, code: WorkflowErrorCode): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), code);
  const prototype = Object.getPrototypeOf(value);
  requireCondition(prototype === Object.prototype || prototype === null, code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireCondition(Reflect.ownKeys(value).every(key => typeof key === 'string'
    && descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value')), code);
  return value as Record<string, unknown>;
}

export function exact(value: Record<string, unknown>, fields: readonly string[], code: WorkflowErrorCode): void {
  requireCondition(Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)), code);
}

export function identifier(value: unknown, code: WorkflowErrorCode): string {
  requireCondition(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
    && !value.includes('..'), code);
  return value;
}

export function revision(value: unknown, code: WorkflowErrorCode): string {
  requireCondition(typeof value === 'string' && value.length <= 4300 && /^[1-9][0-9]*$/.test(value), code);
  return value;
}

export function version(value: unknown, code: WorkflowErrorCode): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, code);
  return value;
}

export function parseSchema<T>(schema: Schema<T>, input: unknown, code: WorkflowErrorCode): T {
  try { return schema.parse(input); }
  catch { throw new WorkflowError(code); }
}

/** JSON-shaped copy prevents later caller mutation and rejects unsupported values instead of coercing them. */
export function snapshot(value: unknown, depth = 0, budget = { nodes: 10000, characters: 131072 }): unknown {
  requireCondition(depth <= 32 && --budget.nodes >= 0, 'invalid_proposal');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    budget.characters -= value.length;
    requireCondition(value.length <= 65536 && budget.characters >= 0, 'invalid_proposal');
    return value;
  }
  if (typeof value === 'number') {
    // Exact large integers must cross this new protocol as decimal strings.
    requireCondition(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)), 'invalid_proposal');
    return value;
  }
  if (Array.isArray(value)) {
    requireCondition(value.length <= budget.nodes && Reflect.ownKeys(value).length === value.length + 1, 'invalid_proposal');
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      requireCondition(descriptor && Object.hasOwn(descriptor, 'value'), 'invalid_proposal');
      copy.push(snapshot(descriptor.value, depth + 1, budget));
    }
    return Object.freeze(copy);
  }
  const input = record(value, 'invalid_proposal');
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(input)) {
    budget.characters -= key.length;
    requireCondition(key.length <= 128 && budget.characters >= 0, 'invalid_proposal');
    copy[key] = snapshot(item, depth + 1, budget);
  }
  return Object.freeze(copy);
}
