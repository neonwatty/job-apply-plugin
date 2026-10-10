import { createHash } from 'node:crypto';
import { exact, identifier, record, revision, snapshot } from '../../harness/validation.js';
export class BrowserBoundaryError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'BrowserBoundaryError';
    }
}
const fail = () => { throw new BrowserBoundaryError('invalid_browser_input'); };
const obj = (raw) => record(raw, 'invalid_arguments');
const fields = (raw, names) => exact(raw, names, 'invalid_arguments');
const id = (raw) => identifier(raw, 'invalid_arguments');
const rev = (raw) => revision(raw, 'invalid_arguments');
const member = (raw, choices) => typeof raw === 'string' && choices.includes(raw);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function controlFingerprint(controls) {
    return hash(controls.map(({ id, kind }) => ({ id, kind })));
}
function form(raw) {
    const value = obj(raw);
    fields(value, ['documentId', 'formId', 'origin', 'controlSetFingerprint']);
    if (typeof value.origin !== 'string' || value.origin.length > 2048)
        return fail();
    const url = new URL(value.origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value.origin)
        return fail();
    if (typeof value.controlSetFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.controlSetFingerprint))
        return fail();
    return Object.freeze({ documentId: id(value.documentId), formId: id(value.formId), origin: value.origin,
        controlSetFingerprint: value.controlSetFingerprint });
}
const bindingFields = ['taskId', 'taskRevision', 'jobId', 'attemptRevision', 'authorizationRevision'];
function binding(value) {
    return { taskId: id(value.taskId), taskRevision: rev(value.taskRevision), jobId: id(value.jobId),
        attemptRevision: rev(value.attemptRevision), authorizationRevision: rev(value.authorizationRevision) };
}
function parse(raw, reader) {
    try {
        return reader(obj(snapshot(raw)));
    }
    catch {
        return fail();
    }
}
export function browserBinding(raw) {
    return parse(raw, value => { fields(value, bindingFields); return Object.freeze(binding(value)); });
}
export function browserMutation(raw) {
    return parse(raw, value => {
        fields(value, ['operationId', 'scope', 'kind', 'controlId', 'valueRef']);
        if (value.kind !== 'fill' && value.kind !== 'upload')
            return fail();
        const scope = obj(value.scope);
        fields(scope, [...bindingFields, 'form', 'observationRevision']);
        return Object.freeze({ operationId: id(value.operationId), kind: value.kind, controlId: id(value.controlId),
            valueRef: id(value.valueRef), scope: Object.freeze({ ...binding(scope), form: form(scope.form),
                observationRevision: rev(scope.observationRevision) }) });
    });
}
export function browserObservation(raw) {
    return parse(raw, value => {
        fields(value, ['evidenceKind', 'form', 'observationRevision', 'controls', 'finalAction']);
        if (value.evidenceKind !== 'synthetic_adapter' || !member(value.finalAction, ['untouched', 'activated']))
            return fail();
        if (!Array.isArray(value.controls) || value.controls.length === 0 || value.controls.length > 256)
            return fail();
        let previous = '';
        const controls = value.controls.map(rawControl => {
            const control = obj(rawControl);
            fields(control, ['id', 'kind', 'state']);
            const controlId = id(control.id);
            if (controlId <= previous || !member(control.kind, ['fill', 'upload', 'final'])
                || !member(control.state, ['empty', 'complete', 'unavailable']))
                return fail();
            previous = controlId;
            return Object.freeze({ id: controlId, kind: control.kind, state: control.state });
        });
        const identity = form(value.form);
        if (identity.controlSetFingerprint !== controlFingerprint(controls))
            return fail();
        return Object.freeze({ evidenceKind: 'synthetic_adapter', form: identity, observationRevision: rev(value.observationRevision),
            controls: Object.freeze(controls), finalAction: value.finalAction });
    });
}
export function browserReadback(raw) {
    return parse(raw, value => {
        fields(value, ['observation', 'operationId', 'requestFingerprint', 'effect']);
        if (typeof value.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestFingerprint)
            || !member(value.effect, ['matches', 'differs', 'unavailable']))
            return fail();
        return Object.freeze({ observation: browserObservation(value.observation), operationId: id(value.operationId),
            requestFingerprint: value.requestFingerprint, effect: value.effect });
    });
}
export function browserWriteResult(raw) {
    return parse(raw, value => {
        if (value.status === 'applied') {
            fields(value, ['status']);
            return { status: 'applied' };
        }
        fields(value, ['status', 'reason']);
        if (value.status !== 'not_applied' || !member(value.reason, ['scope_changed', 'control_unavailable']))
            return fail();
        return { status: 'not_applied', reason: value.reason };
    });
}
export const requestFingerprint = (request) => hash(browserMutation(request));
export const sameForm = (left, right) => left.documentId === right.documentId && left.formId === right.formId && left.origin === right.origin
    && left.controlSetFingerprint === right.controlSetFingerprint;
export const sameBinding = (left, right) => bindingFields.every(key => left[key] === right[key]);
