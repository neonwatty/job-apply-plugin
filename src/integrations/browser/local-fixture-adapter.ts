import { browserMutation, browserObservation, browserReadback, browserWriteResult,
  BrowserBoundaryError, requestFingerprint, sameForm } from './contract.js';
import type { BrowserAdapter, BrowserMutation, BrowserObservation, BrowserReadback, BrowserWriteResult } from './contract.js';
import type { LocalFixturePagePort } from './local-fixture-page.js';

export interface LocalFixtureControl {
  readonly valueRef: string;
  readonly value: string;
}

/**
 * Experimental loopback fixture transport, using an injected trusted browser driver.
 * Real Chromium transport is still synthetic evidence: no ATS or human identity claims.
 * Only host-mapped text fills are supported. Upload and final actions are unavailable.
 */
export class LocalFixtureBrowserAdapter implements BrowserAdapter {
  readonly evidenceKind = 'synthetic_adapter' as const;
  readonly #origin: string;
  readonly #controls: ReadonlyMap<string, LocalFixtureControl>;
  #observation: BrowserObservation | null = null;
  constructor(private readonly page: LocalFixturePagePort, origin: string,
    controls: ReadonlyMap<string, LocalFixtureControl>) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
      throw new BrowserBoundaryError('invalid_browser_input');
    }
    this.#origin = origin;
    this.#controls = new Map([...controls].map(([id, value]) => [id, Object.freeze({ ...value })]));
  }
  #checked(raw: unknown): BrowserObservation {
    const observation = browserObservation(raw);
    if (observation.form.origin !== this.#origin) throw new BrowserBoundaryError('scope_changed');
    return observation;
  }
  async observe(): Promise<BrowserObservation> {
    this.#observation = this.#checked(await this.page.observe());
    return this.#observation;
  }
  async mutate(raw: BrowserMutation): Promise<BrowserWriteResult> {
    const request = browserMutation(raw), expected = this.#observation;
    if (!expected || !sameForm(expected.form, request.scope.form)
      || expected.observationRevision !== request.scope.observationRevision || expected.finalAction !== 'untouched') {
      return { status: 'not_applied', reason: 'scope_changed' };
    }
    const mapped = this.#controls.get(request.controlId);
    const control = expected.controls.find(item => item.id === request.controlId);
    if (request.kind !== 'fill' || !mapped || mapped.valueRef !== request.valueRef
      || control?.kind !== 'fill' || control.state === 'unavailable') {
      return { status: 'not_applied', reason: 'control_unavailable' };
    }
    // The page port rechecks in the browser turn. A separate host-side observation is insufficient.
    this.#observation = null;
    return browserWriteResult(await this.page.compareAndFill({ expected, controlId: request.controlId, value: mapped.value }));
  }
  async readback(raw: BrowserMutation): Promise<BrowserReadback> {
    const request = browserMutation(raw), mapped = this.#controls.get(request.controlId);
    if (!mapped || mapped.valueRef !== request.valueRef || request.kind !== 'fill') {
      return { observation: await this.observe(), operationId: request.operationId,
        requestFingerprint: requestFingerprint(request), effect: 'unavailable' };
    }
    const result = await this.page.readback(request.controlId, mapped.value);
    const observation = this.#checked(result.observation);
    this.#observation = observation;
    return browserReadback({ observation, effect: result.effect, operationId: request.operationId,
      requestFingerprint: requestFingerprint(request) });
  }
}
