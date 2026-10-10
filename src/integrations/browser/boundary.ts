import { BrowserBoundaryError, browserBinding, browserMutation, browserObservation, browserReadback,
  browserWriteResult, requestFingerprint, sameBinding, sameForm } from './contract.js';
import type { BrowserAdapter, BrowserAuthority, BrowserBinding, BrowserMutation, BrowserObservation,
  BrowserReceipt } from './contract.js';

interface Operation { request: BrowserMutation; fingerprint: string; receipt: BrowserReceipt }

/** In-process synthetic experiment. No Store, host authentication or external exactly-once guarantee. */
export class BrowserBoundary {
  readonly #binding: BrowserBinding;
  #observation: BrowserObservation | null = null;
  #operations = new Map<string, Operation>();
  #uncertain: string | null = null;
  #pending = Promise.resolve();
  constructor(private readonly adapter: BrowserAdapter, private readonly authority: BrowserAuthority,
    binding: BrowserBinding) {
    this.#binding = browserBinding(binding);
    if (adapter.evidenceKind !== 'synthetic_adapter') throw new BrowserBoundaryError('adapter_unavailable');
  }
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation);
    this.#pending = result.then(() => {}, () => {});
    return result;
  }
  /** Reads never grant permission or clear an uncertain operation. */
  observe(): Promise<BrowserObservation> {
    return this.#serial(async () => {
      try {
        this.#observation = browserObservation(await this.adapter.observe());
        return this.#observation;
      } catch {
        this.#observation = null;
        throw new BrowserBoundaryError('adapter_unavailable');
      }
    });
  }
  async #authorize(request: BrowserMutation): Promise<void> {
    try {
      const decision = await this.authority.check(request);
      if (decision.authorized === true && decision.requestFingerprint === requestFingerprint(request)) return;
    } catch { /* Fixed denial conceals authority and applicant diagnostics. */ }
    throw new BrowserBoundaryError('authority_denied');
  }
  #scope(request: BrowserMutation): void {
    if (!sameBinding(this.#binding, request.scope)) throw new BrowserBoundaryError('scope_changed');
    const observation = this.#observation;
    if (!observation) throw new BrowserBoundaryError('observation_required');
    if (!sameForm(observation.form, request.scope.form)
      || observation.observationRevision !== request.scope.observationRevision || observation.finalAction !== 'untouched') {
      throw new BrowserBoundaryError('scope_changed');
    }
    const control = observation.controls.find(item => item.id === request.controlId);
    if (!control || control.kind !== request.kind || control.state === 'unavailable') {
      throw new BrowserBoundaryError('scope_changed');
    }
  }
  #receipt(request: BrowserMutation, status: BrowserReceipt['status'], reason: BrowserReceipt['reason']): BrowserReceipt {
    return Object.freeze({operationId:request.operationId, status, evidenceKind:'synthetic_adapter', reason});
  }
  async #readback(operation: Operation): Promise<BrowserReceipt> {
    const {request, fingerprint} = operation;
    try {
      const readback = browserReadback(await this.adapter.readback(request));
      const observed = readback.observation;
      this.#observation = observed;
      if (readback.operationId === request.operationId && readback.requestFingerprint === fingerprint
        && readback.effect === 'matches' && sameForm(observed.form, request.scope.form)
        && observed.observationRevision === String(BigInt(request.scope.observationRevision) + 1n)
        && observed.finalAction === 'untouched'
        && observed.controls.some(control => control.id === request.controlId
          && control.kind === request.kind && control.state === 'complete')) {
        operation.receipt = this.#receipt(request, 'verified', 'readback_matched');
        this.#uncertain = null;
        return operation.receipt;
      }
    } catch { /* A missing/malformed readback is an uncertain outcome, never permission to retry. */ }
    this.#uncertain = request.operationId;
    this.#observation = null;
    return operation.receipt;
  }
  execute(raw: unknown): Promise<BrowserReceipt> {
    // Snapshot before queueing so caller edits cannot change a queued proposal.
    let request: BrowserMutation;
    try { request = browserMutation(raw); } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const fingerprint = requestFingerprint(request), previous = this.#operations.get(request.operationId);
      if (previous && previous.fingerprint !== fingerprint) throw new BrowserBoundaryError('operation_conflict');
      if (previous) {
        await this.#authorize(request);
        return previous.receipt;
      }
      if (this.#uncertain) throw new BrowserBoundaryError('reconciliation_required');
      this.#scope(request);
      if (this.#operations.size >= 64) throw new BrowserBoundaryError('capacity_reached');
      // Last asynchronous check before the adapter's conditional write. Registration grants nothing.
      await this.#authorize(request);
      const operation: Operation = {request, fingerprint,
        receipt:this.#receipt(request, 'uncertain', 'reconciliation_required')};
      this.#operations.set(request.operationId, operation);
      this.#uncertain = request.operationId;
      try {
        const result = browserWriteResult(await this.adapter.mutate(request));
        if (result.status === 'not_applied') {
          operation.receipt = this.#receipt(request, 'not_applied', result.reason);
          this.#uncertain = null;
          this.#observation = null;
          return operation.receipt;
        }
      } catch {
        this.#observation = null;
        return operation.receipt;
      }
      return this.#readback(operation);
    });
  }
  /** Explicit read-only reconciliation of the original request; never performs another mutation.
   * Only an exact fresh matching readback resolves uncertainty. Otherwise preserve the barrier
   * and hand off. A new operation ID and observe() cannot bypass it.
   */
  reconcile(operationId: string): Promise<BrowserReceipt> {
    return this.#serial(async () => {
      const operation = this.#operations.get(operationId);
      if (!operation) throw new BrowserBoundaryError('operation_conflict');
      await this.#authorize(operation.request);
      if (operation.receipt.status !== 'uncertain') return operation.receipt;
      return this.#readback(operation);
    });
  }
}
