import { BrowserBoundaryError, browserBinding, browserMutation, browserObservation, browserReadback,
  browserWriteResult, requestFingerprint, sameBinding, sameForm } from './contract.js';
import type { BrowserAdapter, BrowserAuthority, BrowserBinding, BrowserMutation, BrowserObservation,
  BrowserReceipt } from './contract.js';
import { browserOperationCodeUnitLimit, browserOperationLimit, unresolvedBrowserOperation,
  validateBrowserOperationLedger } from '../../contracts/workspace/browser-operations.js';
import type { BrowserOperation, BrowserOperationState } from '../../contracts/workspace/browser-operations.js';
import type { BrowserOperationStore, BrowserOperationTransaction } from './durable-contract.js';
import { identifier } from '../../harness/validation.js';

/** Synthetic adapter only. Durable intent is a replay fence, not an external exactly-once guarantee. */
export class DurableBrowserBoundary {
  readonly #binding: BrowserBinding;
  #observation: BrowserObservation | null = null;
  #pending = Promise.resolve();
  constructor(private readonly adapter: BrowserAdapter, private readonly authority: BrowserAuthority,
    binding: BrowserBinding, private readonly store: BrowserOperationStore) {
    this.#binding = browserBinding(binding);
    if (adapter.evidenceKind !== 'synthetic_adapter') throw new BrowserBoundaryError('adapter_unavailable');
  }
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation);
    this.#pending = result.then(() => {}, () => {});
    return result;
  }
  async #transaction<T>(operation: (tx: BrowserOperationTransaction) => Promise<T>): Promise<T> {
    try { return await this.store.transaction(operation); }
    catch (error) {
      if (error instanceof BrowserBoundaryError) throw error;
      throw new BrowserBoundaryError('storage_unavailable');
    }
  }
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
    if (!sameBinding(this.#binding, request.scope)) throw new BrowserBoundaryError('scope_changed');
    try {
      const decision = await this.authority.check(request);
      if (decision.authorized === true && decision.requestFingerprint === requestFingerprint(request)) return;
    } catch { /* Never expose private authority diagnostics. */ }
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
  #receipt(request: BrowserMutation, state: BrowserOperationState, reason: BrowserReceipt['reason']): BrowserReceipt {
    return Object.freeze({ operationId: request.operationId, evidenceKind: 'synthetic_adapter', reason,
      status: state === 'verified' ? 'verified' : state === 'rejected' ? 'not_applied' : 'uncertain' });
  }
  async #finish(request: BrowserMutation, state: BrowserOperationState, reason: BrowserReceipt['reason']): Promise<BrowserReceipt> {
    return this.#transaction(async tx => {
      const current = tx.ledger.operations[request.operationId];
      if (!current || current.fingerprint !== requestFingerprint(request)) throw new BrowserBoundaryError('operation_conflict');
      // A concurrent readback may already have proved the effect. Never downgrade its durable receipt.
      if (!unresolvedBrowserOperation(current) || current.state === state) return current.receipt;
      const receipt = this.#receipt(request, state, reason);
      await tx.commit({ ...tx.ledger, operations: { ...tx.ledger.operations,
        [request.operationId]: { ...current, state, receipt } } });
      return receipt;
    });
  }
  async #readback(operation: BrowserOperation): Promise<BrowserReceipt> {
    const { request, fingerprint } = operation;
    let matched = false;
    try {
      const readback = browserReadback(await this.adapter.readback(request));
      const observed = readback.observation;
      matched = readback.operationId === request.operationId && readback.requestFingerprint === fingerprint
        && readback.effect === 'matches' && sameForm(observed.form, request.scope.form)
        && observed.observationRevision === String(BigInt(request.scope.observationRevision) + 1n)
        && observed.finalAction === 'untouched'
        && observed.controls.some(control => control.id === request.controlId
          && control.kind === request.kind && control.state === 'complete');
      this.#observation = matched ? observed : null;
    } catch { this.#observation = null; }
    return this.#finish(request, matched ? 'verified' : 'uncertain', matched ? 'readback_matched' : 'reconciliation_required');
  }
  execute(raw: unknown): Promise<BrowserReceipt> {
    let request: BrowserMutation;
    try { request = browserMutation(raw); } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const fingerprint = requestFingerprint(request);
      const previous = await this.#transaction(async tx => tx.ledger.operations[request.operationId] ?? null);
      if (previous && previous.fingerprint !== fingerprint) throw new BrowserBoundaryError('operation_conflict');
      if (previous) {
        await this.#authorize(request);
        return previous.receipt;
      }
      this.#scope(request);
      await this.#authorize(request);
      const reserved = await this.#transaction(async tx => {
        const existing = tx.ledger.operations[request.operationId];
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new BrowserBoundaryError('operation_conflict');
          return { operation: existing, fresh: false };
        }
        if (Object.values(tx.ledger.operations).some(unresolvedBrowserOperation)) {
          throw new BrowserBoundaryError('reconciliation_required');
        }
        if (Object.keys(tx.ledger.operations).length >= browserOperationLimit) throw new BrowserBoundaryError('capacity_reached');
        const operation: BrowserOperation = { request, fingerprint, state: 'pending',
          receipt: this.#receipt(request, 'pending', 'reconciliation_required') };
        const next = { ...tx.ledger, operations: { ...tx.ledger.operations, [request.operationId]: operation } };
        // Reserve enough room for any terminal state so capacity cannot strand a dispatched operation.
        if (JSON.stringify(next).length + 64 > browserOperationCodeUnitLimit) throw new BrowserBoundaryError('capacity_reached');
        await tx.commit(validateBrowserOperationLedger(next));
        return { operation, fresh: true };
      });
      if (!reserved.fresh) return reserved.operation.receipt;
      // Store I/O is an asynchronous gap. Recheck canonical authority after intent has been committed.
      try { await this.#authorize(request); }
      catch (error) {
        this.#observation = null;
        await this.#finish(request, 'rejected', 'authority_denied');
        throw error;
      }
      let result;
      try { result = browserWriteResult(await this.adapter.mutate(request)); }
      catch {
        this.#observation = null;
        return this.#finish(request, 'uncertain', 'reconciliation_required');
      }
      if (result.status === 'not_applied') {
        this.#observation = null;
        return this.#finish(request, 'rejected', result.reason);
      }
      return this.#readback(reserved.operation);
    });
  }
  /** Only readback of the recorded request can resolve pending/uncertain state; never retry a write. */
  reconcile(operationId: string): Promise<BrowserReceipt> {
    try { identifier(operationId, 'invalid_arguments'); }
    catch { return Promise.reject(new BrowserBoundaryError('invalid_browser_input')); }
    return this.#serial(async () => {
      const operation = await this.#transaction(async tx => Object.hasOwn(tx.ledger.operations, operationId)
        ? tx.ledger.operations[operationId]! : null);
      if (!operation) throw new BrowserBoundaryError('operation_conflict');
      await this.#authorize(operation.request);
      if (!unresolvedBrowserOperation(operation)) return operation.receipt;
      return this.#readback(operation);
    });
  }
}
