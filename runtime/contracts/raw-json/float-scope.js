function power10(exponent) {
    return 10n ** BigInt(exponent);
}
function exactMagnitude(value) {
    const bytes = new ArrayBuffer(8);
    const view = new DataView(bytes);
    view.setFloat64(0, value, false);
    const bits = view.getBigUint64(0, false);
    const exponentBits = Number((bits >> 52n) & 2047n);
    const fraction = bits & ((1n << 52n) - 1n);
    const significand = exponentBits === 0 ? fraction : (1n << 52n) + fraction;
    const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
    return exponent >= 0
        ? { numerator: significand << BigInt(exponent), denominator: 1n }
        : { numerator: significand, denominator: 1n << BigInt(-exponent) };
}
function comparePower(value, exponent) {
    const left = exponent < 0 ? value.numerator * power10(-exponent) : value.numerator;
    const right = exponent < 0 ? value.denominator : value.denominator * power10(exponent);
    return left < right ? -1 : left > right ? 1 : 0;
}
function decimalExponent(value, magnitude) {
    // log10 is only a starting estimate; exact comparisons resolve power boundaries.
    let exponent = Math.floor(Math.log10(magnitude));
    while (comparePower(value, exponent) < 0)
        exponent -= 1;
    while (comparePower(value, exponent + 1) >= 0)
        exponent += 1;
    return exponent;
}
function decimalComponents(magnitude) {
    const exact = exactMagnitude(magnitude);
    const exponent = decimalExponent(exact, magnitude);
    // Every finite binary64 has a round-tripping decimal with <=17 significant digits.
    // At each decimal grid, floor and ceil bracket the exact value. Any farther
    // candidate in the contiguous rounding interval implies a bracketing one is
    // also in that interval. Select shortest first, then nearest, then even.
    for (let precision = 1; precision <= 17; precision += 1) {
        const scale = exponent - precision + 1;
        const numerator = scale < 0 ? exact.numerator * power10(-scale) : exact.numerator;
        const denominator = scale < 0 ? exact.denominator : exact.denominator * power10(scale);
        const floor = numerator / denominator;
        let selected;
        let distance;
        for (const candidate of [floor, floor + 1n]) {
            if (Number(`${candidate}e${scale}`) !== magnitude)
                continue;
            const signedDistance = candidate * denominator - numerator;
            const candidateDistance = signedDistance < 0n ? -signedDistance : signedDistance;
            if (distance === undefined || candidateDistance < distance ||
                (candidateDistance === distance && candidate % 2n === 0n)) {
                selected = candidate;
                distance = candidateDistance;
            }
        }
        if (selected !== undefined) {
            const digits = selected.toString();
            return { digits: digits.replace(/0+$/, ""), exponent: scale + digits.length - 1 };
        }
    }
    throw new Error("binary64 shortest decimal invariant failed");
}
export function floatScope(value) {
    if (Number.isNaN(value))
        return "NaN";
    if (value === Infinity)
        return "Infinity";
    if (value === -Infinity)
        return "-Infinity";
    if (value === 0)
        return Object.is(value, -0) ? "-0.0" : "0.0";
    const sign = value < 0 ? "-" : "";
    const { digits, exponent } = decimalComponents(Math.abs(value));
    if (exponent < -4 || exponent >= 16) {
        const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
        const exponentSign = exponent < 0 ? "-" : "+";
        return `${sign}${digits[0]}${fraction}e${exponentSign}${String(Math.abs(exponent)).padStart(2, "0")}`;
    }
    const decimalPoint = exponent + 1;
    if (decimalPoint <= 0)
        return `${sign}0.${"0".repeat(-decimalPoint)}${digits}`;
    if (decimalPoint >= digits.length) {
        return `${sign}${digits}${"0".repeat(decimalPoint - digits.length)}.0`;
    }
    return `${sign}${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`;
}
