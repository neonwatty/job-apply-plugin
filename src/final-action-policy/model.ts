/** Closed value-free policy documents. No page, answer, or credential values belong here. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { parsePythonJson } from '../contracts/raw-json/parser.js';
import { serializePythonScope } from '../contracts/raw-json/serializer.js';
import { iterPersistedJson } from '../contracts/persisted-json.js';
import type { PythonJson } from '../contracts/raw-json/value.js';

export type ReferenceKind = 'campaign' | 'application' | 'answer' | 'lease' | 'claim' | 'receipt';
export type OpaqueReference<K extends ReferenceKind> = string & { readonly referenceKind: K };
export type Fingerprint = string & { readonly fingerprint: unique symbol };
export interface Rule {
  applicationRef: OpaqueReference<'application'>;
  origin: string;
  urlFingerprint: Fingerprint;
  ats: string;
  jobFingerprint: Fingerprint;
  formRevision: Fingerprint;
  finalControlRevision: Fingerprint;
}
export interface Sensitive {
  answerRef: OpaqueReference<'answer'>;
  questionRevision: Fingerprint;
  answerRevision: Fingerprint;
}
export interface Authorization extends Rule { resumeRevision: Fingerprint; answerRevisions: Sensitive[] }
export type CampaignStatus = 'active' | 'revoked' | 'killed' | 'expired';
export type ApplicationStatus = 'lease_issued' | 'action_claimed' | 'retry_available' | 'confirmed_submitted' | 'uncertain_exhausted' | 'blocked';
export type Outcome = 'confirmed_submitted' | 'uncertain' | 'blocked';
export interface Campaign {
  schemaVersion: 1;
  campaignId: OpaqueReference<'campaign'>;
  mode: 'auto_submit';
  status: CampaignStatus;
  createdAt: string;
  expiresAt: string;
  maxApplications: number;
  applicationRules: Rule[];
  resumeRevision: Fingerprint;
  sensitiveAllowlist: Sensitive[];
  confirmationAuthorityRevision: Fingerprint;
  riskAcknowledgedAt: string;
  killSwitch: boolean;
  killSwitchAt: string | null;
  reservedApplications: number;
}
export interface Receipt {
  schemaVersion: 1;
  receiptId: OpaqueReference<'receipt'>;
  campaignId: OpaqueReference<'campaign'>;
  applicationRef: OpaqueReference<'application'>;
  slot: number;
  attempt: number;
  leaseId: OpaqueReference<'lease'>;
  claimId: OpaqueReference<'claim'>;
  outcome: Outcome;
  status: ApplicationStatus;
  at: string;
  confirmationRevision: Fingerprint | null;
}
export interface Attempt {
  attempt: number;
  leaseId: OpaqueReference<'lease'>;
  issuedAt: string;
  expiresAt: string;
  claimId: OpaqueReference<'claim'> | null;
  claimedAt: string | null;
  outcome: Outcome | null;
  outcomeAt: string | null;
  confirmationRevision: Fingerprint | null;
  receipt: Receipt | null;
}
export interface Application {
  schemaVersion: 1;
  campaignId: OpaqueReference<'campaign'>;
  applicationRef: OpaqueReference<'application'>;
  slot: number;
  authorizationFingerprint: Fingerprint;
  authorization: Authorization;
  status: ApplicationStatus;
  attempts: Attempt[];
  createdAt: string;
  updatedAt: string;
}
export interface Claim {
  mode: 'auto_submit';
  reason: 'atomic_action_claim';
  campaignId: OpaqueReference<'campaign'>;
  applicationRef: OpaqueReference<'application'>;
  slot: number;
  attempt: number;
  claimId: OpaqueReference<'claim'>;
  claimProof: string;
}
export const RULE_FIELDS = ['applicationRef', 'origin', 'urlFingerprint', 'ats', 'jobFingerprint', 'formRevision', 'finalControlRevision'];
export const SENSITIVE_FIELDS = ['answerRef', 'questionRevision', 'answerRevision'];
export const MAX_DURATION = 14400000;
export const LEASE_DURATION = 300000;
export const OUTCOMES = ['confirmed_submitted', 'uncertain', 'blocked'];
export const APPLICATION_STATUSES = ['lease_issued', 'action_claimed', 'retry_available', 'confirmed_submitted', 'uncertain_exhausted', 'blocked'];
export class PolicyError extends Error {}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PolicyError(message);
}
export function object(value: unknown, label: string): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be a JSON object`);
  return value as Record<string, unknown>;
}
export function closed(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  check(Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)), `${label} fields are invalid`);
}
export function fingerprint(value: unknown, label: string): Fingerprint {
  check(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value), `${label} must be an opaque revision fingerprint`);
  return value as Fingerprint;
}
export function reference<K extends ReferenceKind>(value: unknown, kind: K, label: string): OpaqueReference<K> {
  check(typeof value === 'string' && new RegExp(`^${kind}:[0-9a-f]{64}$`).test(value), `${label} must be an opaque ${kind} reference`);
  return value as OpaqueReference<K>;
}
export const newReference = <K extends ReferenceKind>(kind: K): OpaqueReference<K> => reference(`${kind}:${randomBytes(32).toString('hex')}`, kind, kind);
export function formatTime(value: Date): string {
  check(Number.isFinite(value.getTime()), 'timestamp is invalid');
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function dateSeparator(value: string): number {
  if (value[4] === '-') {
    if (value[5] !== 'W') return 10;
    if (value[8] !== '-') return 8;
    return /[0-9]/.test(value[10] ?? '') ? 8 : 10;
  }
  if (value[4] !== 'W') return 8;
  let index = 7;
  while (index < value.length && /[0-9]/.test(value[index]!)) index++;
  return index < 9 ? index : index % 2 === 0 ? 7 : 8;
}
function calendarDate(value: string): Date {
  const calendar = /^(\d{4})(-?)(\d{2})\2(\d{2})$/.exec(value);
  const week = /^(\d{4})(-?)W(\d{2})(?:\2([1-7]))?$/.exec(value);
  check(calendar || week, 'timestamp is invalid');
  const year = Number((calendar ?? week)![1]);
  check(year >= 1 && year <= 9999, 'timestamp is invalid');
  const date = new Date(0);
  if (calendar) {
    const month = Number(calendar[3]), day = Number(calendar[4]);
    date.setUTCFullYear(year, month - 1, day);
    check(date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day, 'timestamp is invalid');
  } else {
    const weekNumber = Number(week![3]), weekday = Number(week![4] ?? 1);
    date.setUTCFullYear(year, 0, 4);
    const monday = date.getTime() - ((date.getUTCDay() + 6) % 7) * 86400000;
    date.setTime(monday + ((weekNumber - 1) * 7 + weekday - 1) * 86400000);
    const thursday = new Date(monday + ((weekNumber - 1) * 7 + 3) * 86400000);
    check(weekNumber >= 1 && weekNumber <= 53 && thursday.getUTCFullYear() === year, 'timestamp is invalid');
  }
  return date;
}
function timeComponents(value: string, allowEmptyFraction = false): { seconds: number; microseconds: number; validClock: boolean } {
  const match = /^(\d{2})(?:(:?)(\d{2})(?:\2(\d{2}))?)?(?:[.,](\d*))?$/.exec(value);
  // CPython permits a bare fraction separator before the zone, but not inside it.
  check(match && (match[5] !== '' || allowEmptyFraction), 'timestamp is invalid');
  const hours = Number(match[1]), minutes = Number(match[3] ?? 0), seconds = Number(match[4] ?? 0);
  return { seconds: hours * 3600 + minutes * 60 + seconds,
    microseconds: Number((match[5] ?? '').slice(0, 6).padEnd(6, '0')),
    validClock: hours < 24 && minutes < 60 && seconds < 60 };
}
/** Normative CPython 3.12 aware-ISO grammar, including its offset normalization. */
export function parseTime(value: unknown): number {
  check(typeof value === 'string' && value.length > 7, 'timestamp is invalid');
  const expanded = value.replace(/Z/g, '+00:00');
  const separator = dateSeparator(expanded);
  const date = calendarDate(expanded.slice(0, separator));
  const separatorWidth = (expanded.codePointAt(separator) ?? 0) > 0xffff ? 2 : 1;
  const time = expanded.slice(separator + separatorWidth);
  const zone = /^(.+?)([+-])(.+)$/.exec(time);
  check(zone, 'timestamp is invalid');
  const clock = timeComponents(zone[1]!, true);
  check(clock.validClock, 'timestamp is invalid');
  const offset = timeComponents(zone[3]!);
  // CPython recognizes a zero HH/MM/SS offset as UTC even with a fractional suffix.
  const offsetMicros = offset.seconds === 0 ? 0 : offset.seconds * 1000000 + offset.microseconds;
  check(offsetMicros < 86400000000, 'timestamp is invalid');
  const total = BigInt(date.getTime()) * 1000n + BigInt(clock.seconds * 1000000 + clock.microseconds)
    - BigInt(zone[2] === '-' ? -offsetMicros : offsetMicros);
  return Number(total) / 1000000 * 1000;
}
export function origin(value: unknown): string {
  check(typeof value === 'string', 'origin is invalid');
  // Preserve the exact spelling, as Python urlsplit does; canonicalizing it would broaden scope.
  const parsed = value.replace(/^[\x00-\x20]+/, '').replace(/[\t\r\n]/g, '');
  const match = /^https?:\/\/([^/?#]+)\/?\??#?$/i.exec(parsed);
  check(match && !match[1]!.includes('@') && !value.endsWith('/'), 'origin must be an exact HTTP(S) origin');
  const host = match[1]!;
  const normalized = host.replace(/[@:#?]/g, '').normalize('NFKC');
  check(!/[/?#@:]/.test(normalized), 'origin must be an exact HTTP(S) origin');
  if (host.includes('[') || host.includes(']')) {
    const bracket = /^\[([^\]]+)\](?::.*)?$/.exec(host);
    check(bracket && (isIP(bracket[1]!) === 6 || /^v[0-9a-fA-F]+\..+$/.test(bracket[1]!)), 'origin must be an exact HTTP(S) origin');
  } else check(host.split(':')[0]!.length > 0, 'origin must be an exact HTTP(S) origin');
  return value;
}
export function parseRule(value: unknown): Rule {
  const rule = object(value, 'application rule');
  closed(rule, RULE_FIELDS, 'application rule');
  const applicationRef = reference(rule.applicationRef, 'application', 'applicationRef');
  const parsedOrigin = origin(rule.origin);
  const urlFingerprint = fingerprint(rule.urlFingerprint, 'urlFingerprint');
  check(typeof rule.ats === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(rule.ats), 'ats is invalid');
  return { applicationRef, origin: parsedOrigin, urlFingerprint, ats: rule.ats,
    jobFingerprint: fingerprint(rule.jobFingerprint, 'jobFingerprint'), formRevision: fingerprint(rule.formRevision, 'formRevision'),
    finalControlRevision: fingerprint(rule.finalControlRevision, 'finalControlRevision') };
}
export function parseSensitive(value: unknown): Sensitive {
  const item = object(value, 'sensitive answer revision');
  closed(item, SENSITIVE_FIELDS, 'sensitive answer revision');
  return { answerRef: reference(item.answerRef, 'answer', 'answerRef'), questionRevision: fingerprint(item.questionRevision, 'questionRevision'), answerRevision: fingerprint(item.answerRevision, 'answerRevision') };
}
export function unique<T>(items: T[], key: (item: T) => string, message: string): void {
  check(new Set(items.map(key)).size === items.length, message);
}
export function parseAuthorization(value: unknown): Authorization {
  const item = object(value, 'authorization');
  closed(item, [...RULE_FIELDS, 'resumeRevision', 'answerRevisions'], 'authorization');
  const rule = parseRule(Object.fromEntries(RULE_FIELDS.map(key => [key, item[key]])));
  const resumeRevision = fingerprint(item.resumeRevision, 'resumeRevision');
  check(Array.isArray(item.answerRevisions), 'answerRevisions must be a list');
  const answerRevisions = item.answerRevisions.map(parseSensitive);
  unique(answerRevisions, answer => answer.answerRef, 'answerRevisions contains duplicates');
  return { ...rule, resumeRevision, answerRevisions };
}
export const serialization = { pathProfile: '3.12', intMaxStrDigits: 4300 } as const;
export function decodePolicyBytes(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
/** All numeric policy fields are integer tokens; do not erase 1.0/1e0 identity at ingress. */
export function parsePolicyJson(text: string): unknown {
  function convert(value: PythonJson): unknown {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(convert);
    if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, convert(item)]));
    check(value.kind === 'int' && value.value >= BigInt(Number.MIN_SAFE_INTEGER) && value.value <= BigInt(Number.MAX_SAFE_INTEGER), 'policy numeric fields require exact integer tokens');
    return Number(value.value);
  }
  return convert(parsePythonJson(text, serialization));
}
export const pythonValue = (value: unknown): PythonJson => parsePythonJson(JSON.stringify(value), serialization);
export const canonical = (value: unknown): string => serializePythonScope(pythonValue(value));
const ascii = (text: string): string => text.replace(/[\u007f-\uffff]/g, unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
export function serializeDocument(value: unknown): string {
  return [...iterPersistedJson(pythonValue(value), serialization)].map(ascii).join('') + '\n';
}
export function serializeReceiptLine(value: Receipt): Buffer {
  // Collapse only structural whitespace after ensure_ascii escaping; lone surrogate
  // timestamp separators must not pass through an intermediate UTF-8 encoder.
  return Buffer.from(serializeDocument(value).replace(/,\n */g, ', ').replace(/\n */g, '') + '\n');
}
export const digest = (value: unknown): Fingerprint => fingerprint('sha256:' + createHash('sha256').update(canonical(value)).digest('hex'), 'digest');
export function confirmationAuthorityRevision(capability: unknown): Fingerprint {
  check(typeof capability === 'string' && /^[a-f0-9]{64}$/.test(capability), 'trusted confirmation capability is invalid');
  return digest(capability);
}
export function parseConfirmation(value: unknown, claimId: string, authority: string, capability: unknown): Record<string, unknown> {
  const event = object(value, 'confirmation event');
  closed(event, ['eventId', 'claimId', 'source', 'observedAt', 'confirmationRevision', 'activationObserved', 'proof'], 'confirmation event');
  reference(event.eventId, 'receipt', 'confirmation eventId');
  reference(event.claimId, 'claim', 'confirmation claimId');
  check(event.claimId === claimId, 'confirmation event does not match action claim');
  check(event.source === 'isolated_loopback' || event.source === 'approved_real_canary', 'confirmation source is not trusted');
  parseTime(event.observedAt);
  fingerprint(event.confirmationRevision, 'confirmationRevision');
  check(event.activationObserved === true, 'confirmation did not independently observe activation');
  check(typeof capability === 'string' && /^[a-f0-9]{64}$/.test(capability), 'trusted confirmation capability is required');
  check(confirmationAuthorityRevision(capability) === authority, 'confirmation authority does not match campaign');
  check(typeof event.proof === 'string' && /^[a-f0-9]{64}$/.test(event.proof), 'confirmation proof is invalid');
  const signed = Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'proof'));
  const expected = createHmac('sha256', capability).update(canonical(signed)).digest();
  check(timingSafeEqual(Buffer.from(event.proof, 'hex'), expected), 'confirmation proof is invalid');
  return { ...event };
}
export function parseReceipt(value: unknown): Receipt {
  const receipt = object(value, 'receipt');
  closed(receipt, ['schemaVersion', 'receiptId', 'campaignId', 'applicationRef', 'slot', 'attempt', 'leaseId', 'claimId', 'outcome', 'status', 'at', 'confirmationRevision'], 'receipt');
  check(receipt.schemaVersion === 1, 'receipt schema version is unsupported');
  reference(receipt.receiptId, 'receipt', 'receiptId');
  reference(receipt.campaignId, 'campaign', 'campaignId');
  reference(receipt.applicationRef, 'application', 'applicationRef');
  reference(receipt.leaseId, 'lease', 'leaseId');
  reference(receipt.claimId, 'claim', 'claimId');
  for (const field of ['slot', 'attempt']) check(Number.isSafeInteger(receipt[field]) && Number(receipt[field]) >= 1, `receipt ${field} is invalid`);
  check(typeof receipt.outcome === 'string' && OUTCOMES.includes(receipt.outcome), 'receipt outcome is invalid');
  const statuses = receipt.outcome === 'uncertain' ? ['retry_available', 'uncertain_exhausted'] : [receipt.outcome];
  check(typeof receipt.status === 'string' && statuses.includes(receipt.status), 'receipt status is invalid');
  parseTime(receipt.at);
  if (receipt.outcome === 'confirmed_submitted') fingerprint(receipt.confirmationRevision, 'confirmationRevision');
  else check(receipt.confirmationRevision === null, 'receipt confirmation is invalid');
  return structuredClone(receipt) as unknown as Receipt;
}
