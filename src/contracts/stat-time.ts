/** Native CPython builds can fuse the seconds-plus-nanoseconds expression. */
export type StatTimeMode = "fused" | "separate";

const coefficientBits = Buffer.alloc(8);
coefficientBits.writeDoubleBE(1e-9);
const coefficientSignificand = (coefficientBits.readBigUInt64BE() & ((1n << 52n) - 1n)) | (1n << 52n);

/** Convert signed 64-bit native seconds and nanoseconds using an explicit build profile. */
export function statSecondsFromNanoseconds(ns: bigint, mode: StatTimeMode): number {
  if (mode !== "fused" && mode !== "separate") throw new TypeError("Unknown stat time arithmetic mode");
  let seconds = ns / 1_000_000_000n;
  let remainder = ns % 1_000_000_000n;
  if (remainder < 0n) {
    seconds -= 1n;
    remainder += 1_000_000_000n;
  }
  if (seconds < -(1n << 63n) || seconds >= (1n << 63n)) {
    throw new RangeError("Native seconds exceed signed 64-bit time_t");
  }
  const roundedSeconds = Number(seconds);
  if (mode === "separate") return roundedSeconds + 1e-9 * Number(remainder);
  // binary64(1e-9) has exponent -82 after extracting its 53-bit significand.
  // The bounded integer sum is rounded once; scaling by a power of two is exact.
  const numerator = (BigInt(roundedSeconds) << 82n) + coefficientSignificand * remainder;
  return Number(numerator) * 2 ** -82;
}
