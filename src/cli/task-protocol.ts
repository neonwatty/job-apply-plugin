import { JobsError, fromJSON, object, type Document } from '../contracts/workspace/values.js';
import { StoreValidationError } from '../store/validation.js';

export class TaskRequestError extends Error {
  constructor() { super('invalid task request'); }
}
export class TaskHelp extends Error {
  constructor(readonly command?: string) { super('task help requested'); }
}

const revisionFields = ['--expected-job-revision', '--expected-session-revision'];
const approvalFields = ['--id', ...revisionFields, '--input'];
export const taskCommandFields: Record<string, readonly string[]> = {
  snapshot: [], activity: ['--id'], intake: ['--input'],
  select: ['--id', '--expected-revision', '--owner-confirmed'],
  'resolve-pending-answer': ['--id', '--reference', ...revisionFields,
    '--expected-answer-revision', '--owner-confirmed'],
  'semantic-lookup': ['--input'], 'cleanup-preview': [],
  'cleanup-approve': ['--input', '--owner-confirmed'],
  'approval-preview': approvalFields,
  'approval-approve': [...approvalFields, '--preview-token', '--owner-confirmed'],
};

// Unicode 15.0 decimal block starts, matching the pinned CPython 3.12 oracle.
// Each block contains ten digits; the five mathematical alphabets are separate blocks.
const digitStarts = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6,
  0xc66, 0xce6, 0xd66, 0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0,
  0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50,
  0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0,
  0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0,
  0x11650, 0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50, 0x11da0,
  0x11f50, 0x16a60, 0x16ac0, 0x16b50, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec,
  0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e950, 0x1fbf0,
];
function decimalText(value: string): string {
  return Array.from(value, character => {
    const point = character.codePointAt(0)!;
    const start = digitStarts.find(start => point >= start && point < start + 10);
    return start === undefined ? character : String(point - start);
  }).join('');
}
export function parseTaskRevision(value: string): bigint {
  // int() accepts Unicode whitespace but rejects ASCII information separators and BOM.
  const stripped = value.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');
  const normalized = decimalText(stripped);
  if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(normalized)) throw new TaskRequestError();
  const digits = normalized.replace(/[+_-]/g, '');
  if (digits.length > 4300) throw new TaskRequestError();
  return BigInt(normalized.replaceAll('_', ''));
}
function optionName(raw: string, supported: readonly string[]): string {
  if (supported.includes(raw)) return raw;
  const matches = raw.startsWith('--') ? supported.filter(name => name.startsWith(raw)) : [];
  if (matches.length !== 1) throw new TaskRequestError();
  return matches[0]!;
}
function isValue(value: string): boolean {
  return !value.startsWith('-') || value === '-' || value.includes(' ')
    || /^-(?:[0-9]+|[0-9]*\.[0-9]+)$/.test(decimalText(value));
}
export function parseTaskArgs(args: string[]): {
  command: string; options: Map<string, string>; ownerConfirmed: boolean;
} {
  let command: string | undefined;
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith('-')) {
      if (command || !Object.hasOwn(taskCommandFields, argument)) throw new TaskRequestError();
      command = argument;
      continue;
    }
    const supported = command ? taskCommandFields[command]! : ['--root', '--native-lock'];
    const equals = argument.indexOf('=');
    const raw = equals < 0 ? argument : argument.slice(0, equals);
    const key = optionName(raw, [...supported, '--help', '-h']);
    if (key === '--help' || key === '-h') {
      if (equals >= 0) throw new TaskRequestError();
      throw new TaskHelp(command);
    }
    if (key === '--owner-confirmed') {
      if (equals >= 0) throw new TaskRequestError();
      options.set(key, 'true');
      continue;
    }
    let value: string;
    if (equals >= 0) value = argument.slice(equals + 1);
    else {
      const next = args[++index];
      if (next === undefined || !isValue(next)) throw new TaskRequestError();
      value = next;
    }
    if (key.startsWith('--expected-')) value = parseTaskRevision(value).toString();
    options.set(key, value);
  }
  if (!command || !options.get('--root') || !options.get('--native-lock')) throw new TaskRequestError();
  for (const key of taskCommandFields[command]!) {
    if (key !== '--owner-confirmed' && !options.has(key)) throw new TaskRequestError();
  }
  return { command, options, ownerConfirmed: options.has('--owner-confirmed') };
}

export function classifyTaskError(error: unknown): Document {
  let code = 'store_unavailable';
  let message = 'The canonical store is unavailable.';
  if (error instanceof TaskRequestError) {
    code = 'invalid_request'; message = 'The task request is invalid.';
  } else if (error instanceof JobsError || error instanceof StoreValidationError) {
    const detail = error.message;
    const rules: [boolean, string, string][] = [
      [detail.includes('owner confirmation') || detail.includes('owner approval'),
        'owner_confirmation_required', 'Explicit owner confirmation is required.'],
      [detail.includes('revision conflict') || detail.includes('preview is stale'),
        'stale_revision', 'A selected canonical revision is stale.'],
      [detail.includes('reference is stale'), 'stale_revision', 'The pending question reference is stale.'],
      [detail.includes('sensitive pending'), 'sensitive_answer',
        'Sensitive answers require fresh owner reconfirmation in Answers.'],
      [detail.includes('not accepted and confirmed') || detail.includes('no referenced answer'),
        'answer_unavailable', 'The referenced answer is not accepted and confirmed.'],
      [detail.includes('preflight failed'), 'preflight_failed', 'The selected job is not ready.'],
      [detail.includes('intake conflict') || detail.includes('one active job'),
        'job_identity_conflict', 'The URL does not resolve to one active job.'],
      [detail.includes('unavailable') || detail.includes('does not exist'),
        'job_unavailable', 'The requested job is unavailable.'],
      [detail.includes('intake invalid') || detail.includes('input') || detail.includes('URL'),
        'invalid_request', 'The task request is invalid.'],
    ];
    const matched = rules.find(([matches]) => matches);
    code = matched?.[1] ?? 'store_rejected';
    message = matched?.[2] ?? 'The canonical store rejected the task request.';
  }
  return object(fromJSON({ ok: false, error: { code, message } }), 'task error');
}
