import assert from 'node:assert/strict';
import { PythonText } from '../runtime/contracts/python-text.js';

export const text = points => typeof points === 'string'
  ? PythonText.fromJavaScript(points) : PythonText.fromCodePoints(points);
export const pairs = object => object.entries().map(([key, value]) => [Array.from(key.codePoints), value]);
export const points = object => object.entries().map(([key]) => Array.from(key.codePoints));
export function unchanged(object, operation) {
  const before = object.entries();
  assert.throws(operation, TypeError);
  const after = object.entries();
  assert.equal(after.length, before.length);
  for (let index = 0; index < before.length; index++) {
    assert.equal(after[index][0], before[index][0]);
    assert.equal(after[index][1], before[index][1]);
  }
}

// Genuine runtime branding with adversarial prototype methods. The TypeScript
// private constructor prevents ordinary TS subclassing, but emitted JS permits it.
export class HostileText extends PythonText {
  contentKey() { throw new Error('overridden contentKey'); }
  get codePoints() { throw new Error('overridden codePoints'); }
  equals() { throw new Error('overridden equals'); }
  compare() { throw new Error('overridden compare'); }
}
