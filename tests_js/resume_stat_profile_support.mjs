import assert from 'node:assert/strict';

/** Identify one observed CPython build profile; OS alone does not determine fusion. */
export function nativeStatTimeMode(rows) {
  const distinguishing = rows.find(row => row.requestedNs === '-600');
  assert.ok(distinguishing, 'Native stat profile requires the -600 ns fixture');
  assert.equal(distinguishing.actualNs, '-600', 'Native filesystem must preserve exact nanoseconds');
  const modes = new Map([
    ['bea421f5f40489ae', 'fused'],
    ['bea421f5f4000000', 'separate'],
  ]);
  const mode = modes.get(distinguishing.secondsHex);
  assert.ok(mode, `Unrecognized CPython native stat arithmetic: ${distinguishing.secondsHex}`);
  return mode;
}
