import { browserMutation, browserObservation, requestFingerprint, sameForm } from './contract.js';
/** Fictional private values only. This adapter never accesses browser, network, files or Store. */
export class SyntheticBrowserAdapter {
    evidenceKind = 'synthetic_adapter';
    #observation;
    #values;
    #entered = new Map();
    #calls = { observe: 0, mutate: 0, readback: 0, writes: 0 };
    constructor(observation, values) {
        this.#observation = browserObservation(observation);
        this.#values = new Map(values);
    }
    get calls() {
        return Object.freeze({ ...this.#calls });
    }
    async observe() {
        this.#calls.observe++;
        return this.#observation;
    }
    async mutate(raw) {
        this.#calls.mutate++;
        const request = browserMutation(raw), current = this.#observation;
        if (!sameForm(current.form, request.scope.form) || current.observationRevision !== request.scope.observationRevision
            || current.finalAction !== 'untouched')
            return { status: 'not_applied', reason: 'scope_changed' };
        const control = current.controls.find(item => item.id === request.controlId), value = this.#values.get(request.valueRef);
        if (!control || control.kind !== request.kind || control.state === 'unavailable' || value === undefined) {
            return { status: 'not_applied', reason: 'control_unavailable' };
        }
        // No await between comparison and write: the fictional state change is conditional and atomic.
        this.#entered.set(control.id, value);
        this.#calls.writes++;
        this.#observation = browserObservation({ ...current,
            observationRevision: String(BigInt(current.observationRevision) + 1n),
            controls: current.controls.map(item => item.id === control.id ? { ...item, state: 'complete' } : item) });
        return { status: 'applied' };
    }
    async readback(request) {
        this.#calls.readback++;
        const expected = this.#values.get(request.valueRef), actual = this.#entered.get(request.controlId);
        return { observation: this.#observation, operationId: request.operationId, requestFingerprint: requestFingerprint(request),
            effect: expected === undefined || actual === undefined ? 'unavailable' : expected === actual ? 'matches' : 'differs' };
    }
    /** Test driver: replacing/rerendering a form discards its fictional entered values. */
    replaceForm(observation) {
        this.#observation = browserObservation(observation);
        this.#entered.clear();
    }
}
