import { createHash } from 'node:crypto';
import { exact, identifier, record, revision, snapshot } from '../../harness/validation.js';

export type BrowserErrorCode = 'invalid_browser_input' | 'authority_denied' | 'scope_changed'
  | 'observation_required' | 'operation_conflict' | 'reconciliation_required' | 'capacity_reached'
  | 'adapter_unavailable' | 'invalid_browser_state' | 'storage_unavailable';
export class BrowserBoundaryError extends Error {
  constructor(readonly code: BrowserErrorCode) { super(code); this.name = 'BrowserBoundaryError'; }
}
export interface BrowserBinding {
  readonly taskId: string;
  readonly taskRevision: string;
  readonly jobId: string;
  readonly attemptRevision: string;
  readonly authorizationRevision: string;
}
export interface BrowserForm {
  readonly documentId: string;
  readonly formId: string;
  readonly origin: string;
  readonly controlSetFingerprint: string;
}
export interface BrowserScope extends BrowserBinding {
  readonly form: BrowserForm;
  readonly observationRevision: string;
}
export interface BrowserMutation {
  readonly operationId: string;
  readonly scope: BrowserScope;
  readonly kind: 'fill' | 'upload';
  readonly controlId: string;
  /** Opaque identifier resolved privately by the trusted adapter; never an applicant value/path. */
  readonly valueRef: string;
}
export interface BrowserControl {
  readonly id: string;
  readonly kind: 'fill' | 'upload' | 'final';
  readonly state: 'empty' | 'complete' | 'unavailable';
}
export interface BrowserObservation {
  readonly evidenceKind: 'synthetic_adapter';
  readonly form: BrowserForm;
  readonly observationRevision: string;
  readonly controls: readonly BrowserControl[];
  readonly finalAction: 'untouched' | 'activated';
}
export interface BrowserReadback {
  readonly observation: BrowserObservation;
  readonly operationId: string;
  readonly requestFingerprint: string;
  /** Comparison with the privately resolved intended value, not merely a nonempty control. */
  readonly effect: 'matches' | 'differs' | 'unavailable';
}
export type BrowserWriteResult = { readonly status: 'applied' }
  | { readonly status: 'not_applied'; readonly reason: 'scope_changed' | 'control_unavailable' };
export interface BrowserAdapter {
  readonly evidenceKind: 'synthetic_adapter';
  observe(): Promise<BrowserObservation>;
  /** Must compare form + observation revision at the write boundary before any effect. */
  mutate(request: BrowserMutation): Promise<BrowserWriteResult>;
  readback(request: BrowserMutation): Promise<BrowserReadback>;
}
/** Trusted embedding assumption. Never expose this port as a model approval tool. */
export interface BrowserAuthority {
  check(request: BrowserMutation): Promise<{ readonly authorized: boolean; readonly requestFingerprint: string }>;
}
export interface BrowserReceipt {
  readonly operationId: string;
  readonly status: 'verified' | 'uncertain' | 'not_applied';
  readonly evidenceKind: 'synthetic_adapter';
  readonly reason: 'readback_matched' | 'reconciliation_required' | 'scope_changed' | 'control_unavailable' | 'authority_denied';
}

const fail = (): never => { throw new BrowserBoundaryError('invalid_browser_input'); };
const obj = (raw: unknown) => record(raw, 'invalid_arguments');
const fields = (raw: Record<string, unknown>, names: string[]) => exact(raw, names, 'invalid_arguments');
const id = (raw: unknown) => identifier(raw, 'invalid_arguments');
const rev = (raw: unknown) => revision(raw, 'invalid_arguments');
const member = (raw: unknown, choices: readonly string[]): raw is string =>
  typeof raw === 'string' && choices.includes(raw);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function controlFingerprint(controls: readonly BrowserControl[]): string {
  return hash(controls.map(({id, kind}) => ({id, kind})));
}
function form(raw: unknown): BrowserForm {
  const value = obj(raw);
  fields(value, ['documentId', 'formId', 'origin', 'controlSetFingerprint']);
  if (typeof value.origin !== 'string' || value.origin.length > 2048) return fail();
  const url = new URL(value.origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value.origin) return fail();
  if (typeof value.controlSetFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.controlSetFingerprint)) return fail();
  return Object.freeze({documentId:id(value.documentId), formId:id(value.formId), origin:value.origin,
    controlSetFingerprint:value.controlSetFingerprint});
}
const bindingFields = ['taskId', 'taskRevision', 'jobId', 'attemptRevision', 'authorizationRevision'];
function binding(value: Record<string, unknown>): BrowserBinding {
  return {taskId:id(value.taskId), taskRevision:rev(value.taskRevision), jobId:id(value.jobId),
    attemptRevision:rev(value.attemptRevision), authorizationRevision:rev(value.authorizationRevision)};
}
function parse<T>(raw: unknown, reader: (value: Record<string, unknown>) => T): T {
  try { return reader(obj(snapshot(raw))); } catch { return fail(); }
}
export function browserBinding(raw: unknown): BrowserBinding {
  return parse(raw, value => { fields(value, bindingFields); return Object.freeze(binding(value)); });
}
export function browserMutation(raw: unknown): BrowserMutation {
  return parse(raw, value => {
    fields(value, ['operationId', 'scope', 'kind', 'controlId', 'valueRef']);
    if (value.kind !== 'fill' && value.kind !== 'upload') return fail();
    const scope = obj(value.scope);
    fields(scope, [...bindingFields, 'form', 'observationRevision']);
    return Object.freeze({operationId:id(value.operationId), kind:value.kind, controlId:id(value.controlId),
      valueRef:id(value.valueRef), scope:Object.freeze({...binding(scope), form:form(scope.form),
        observationRevision:rev(scope.observationRevision)})});
  });
}
export function browserObservation(raw: unknown): BrowserObservation {
  return parse(raw, value => {
    fields(value, ['evidenceKind', 'form', 'observationRevision', 'controls', 'finalAction']);
    if (value.evidenceKind !== 'synthetic_adapter' || !member(value.finalAction, ['untouched', 'activated'])) return fail();
    if (!Array.isArray(value.controls) || value.controls.length === 0 || value.controls.length > 256) return fail();
    let previous = '';
    const controls = value.controls.map(rawControl => {
      const control = obj(rawControl);
      fields(control, ['id', 'kind', 'state']);
      const controlId = id(control.id);
      if (controlId <= previous || !member(control.kind, ['fill','upload','final'])
        || !member(control.state, ['empty','complete','unavailable'])) return fail();
      previous = controlId;
      return Object.freeze({id:controlId, kind:control.kind, state:control.state}) as BrowserControl;
    });
    const identity = form(value.form);
    if (identity.controlSetFingerprint !== controlFingerprint(controls)) return fail();
    return Object.freeze({evidenceKind:'synthetic_adapter', form:identity, observationRevision:rev(value.observationRevision),
      controls:Object.freeze(controls), finalAction:value.finalAction as BrowserObservation['finalAction']});
  });
}
export function browserReadback(raw: unknown): BrowserReadback {
  return parse(raw, value => {
    fields(value, ['observation', 'operationId', 'requestFingerprint', 'effect']);
    if (typeof value.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestFingerprint)
      || !member(value.effect, ['matches', 'differs', 'unavailable'])) return fail();
    return Object.freeze({observation:browserObservation(value.observation), operationId:id(value.operationId),
      requestFingerprint:value.requestFingerprint, effect:value.effect as BrowserReadback['effect']});
  });
}
export function browserWriteResult(raw: unknown): BrowserWriteResult {
  return parse(raw, value => {
    if (value.status === 'applied') { fields(value, ['status']); return {status:'applied'}; }
    fields(value, ['status', 'reason']);
    if (value.status !== 'not_applied' || !member(value.reason, ['scope_changed', 'control_unavailable'])) return fail();
    return {status:'not_applied', reason:value.reason as 'scope_changed' | 'control_unavailable'};
  });
}
export const requestFingerprint = (request: BrowserMutation): string => hash(browserMutation(request));
export const sameForm = (left: BrowserForm, right: BrowserForm): boolean =>
  left.documentId === right.documentId && left.formId === right.formId && left.origin === right.origin
  && left.controlSetFingerprint === right.controlSetFingerprint;
export const sameBinding = (left: BrowserBinding, right: BrowserBinding): boolean =>
  bindingFields.every(key => left[key as keyof BrowserBinding] === right[key as keyof BrowserBinding]);
