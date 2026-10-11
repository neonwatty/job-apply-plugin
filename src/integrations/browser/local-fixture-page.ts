import type { BrowserObservation, BrowserWriteResult } from './contract.js';

/** A trusted controlled-fixture page driver. Never expose this port to the model. */
export interface LocalFixturePagePort {
  /** Returns opaque identity and state only; values and selectors stay in the host. */
  observe(): Promise<BrowserObservation>;
  /**
   * Runs comparison and fill synchronously in a single browser execution turn.
   * Compare complete form identity, revision, control availability and final-action state.
   * A successful fill advances the document's revision exactly once, including DOM events.
   * State belongs to the surviving document, so replacing a host must not reset its revision.
   */
  compareAndFill(input: {
    expected: BrowserObservation;
    controlId: string;
    value: string;
  }): Promise<BrowserWriteResult>;
  /** Compare privately; never return the field's actual value. */
  readback(controlId: string, value: string): Promise<{
    observation: BrowserObservation;
    effect: 'matches' | 'differs' | 'unavailable';
  }>;
}
