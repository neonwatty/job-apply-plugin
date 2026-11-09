/** Error categories used by Python's float timestamp conversion. */
export class ResumeTimestampError extends Error {
  constructor(name: "ValueError" | "OverflowError" | "OSError", message: string) {
    super(message);
    this.name = name;
  }
}

function roundHalfEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  return fraction < 0.5 ? lower : fraction > 0.5 ? lower + 1 : lower % 2 === 0 ? lower : lower + 1;
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

function civilYear(seconds: bigint): bigint {
  const days = floorDiv(seconds, 86400n) + 719468n;
  const era = floorDiv(days, 146097n);
  const dayOfEra = days - era * 146097n;
  const yearOfEra = (dayOfEra - dayOfEra / 1460n + dayOfEra / 36524n - dayOfEra / 146096n) / 365n;
  const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const month = (5n * dayOfYear + 2n) / 153n;
  return yearOfEra + era * 400n + (month >= 10n ? 1n : 0n);
}

/** Match datetime.fromtimestamp(binary64, UTC).isoformat(timespec="seconds"). */
export function resumeModifiedAt(mtimeSeconds: number): string {
  if (Number.isNaN(mtimeSeconds)) throw new ResumeTimestampError("ValueError", "Invalid value NaN");
  if (!Number.isFinite(mtimeSeconds)) throw new ResumeTimestampError("OverflowError", "timestamp is infinite");
  const integral = Math.trunc(mtimeSeconds);
  if (integral >= 2 ** 63 || integral < -(2 ** 63)) {
    throw new ResumeTimestampError("OverflowError", "timestamp out of range for platform time_t");
  }
  // Python splits the float before multiplying its fractional part by 1e6.
  const microseconds = roundHalfEven((mtimeSeconds - integral) * 1_000_000);
  const seconds = BigInt(integral) + BigInt(Math.floor(microseconds / 1_000_000));
  const year = civilYear(seconds);
  if (year - 1900n < -2147483648n || year - 1900n > 2147483647n) {
    throw new ResumeTimestampError("OSError", "timestamp exceeds native calendar range");
  }
  if (year < 1n || year > 9999n) throw new ResumeTimestampError("ValueError", "year must be in 1..9999");
  return new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z");
}
