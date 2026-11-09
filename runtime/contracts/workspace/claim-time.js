import { JobsError } from './values.js';
function invalid() { throw new JobsError('coordinator timestamp is invalid'); }
function overflow() {
    const error = new RangeError('date value out of range');
    error.name = 'OverflowError';
    throw error;
}
const dayMicros = 86400000000n;
function midnight(year, month, day) {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    if (year < 1 || year > 9999 || date.getUTCFullYear() !== year
        || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
        invalid();
    return BigInt(date.getTime()) * 1000n;
}
function clock(value, offset) {
    const match = /^(\d{2})(?:(:?)(\d{2})(?:\2(\d{2}))?)?(?:[.,](\d+))?$/.exec(value);
    if (!match)
        invalid();
    const hour = Number(match[1]), minute = Number(match[3] ?? 0), second = Number(match[4] ?? 0);
    if (!offset && (hour > 23 || minute > 59 || second > 59))
        invalid();
    const integral = BigInt(hour * 3600 + minute * 60 + second) * 1000000n;
    // CPython treats any all-zero integral UTC offset as UTC, ignoring fractions.
    if (offset && integral === 0n)
        return 0n;
    return integral + BigInt((match[5] ?? '').slice(0, 6).padEnd(6, '0'));
}
/** Python's aware ISO calendar/week dates, offsets and truncated microseconds. */
export function claimTime(value) {
    const input = value.replaceAll('Z', '+00:00');
    const date = /^(\d{4})(?:(-?)(\d{2})\2(\d{2})|(-?)W(\d{2})(?:\5([1-7]))?)/.exec(input);
    if (!date)
        invalid();
    const year = Number(date[1]);
    let epoch;
    if (date[3])
        epoch = midnight(year, Number(date[3]), Number(date[4]));
    else {
        const week = Number(date[6]), day = Number(date[7] ?? 1);
        const jan4 = midnight(year, 1, 4);
        const weekday = (new Date(Number(jan4 / 1000n)).getUTCDay() + 6) % 7;
        epoch = jan4 + BigInt((week - 1) * 7 + day - 1 - weekday) * dayMicros;
        const thursday = new Date(Number((epoch + BigInt(4 - day) * dayMicros) / 1000n));
        if (week < 1 || week > 53 || thursday.getUTCFullYear() !== year)
            invalid();
    }
    const suffix = input.slice(date[0].length);
    if (!suffix)
        invalid();
    const rest = Array.from(suffix).slice(1).join('');
    const zone = /([+-])([^+-]+)$/.exec(rest);
    if (!zone)
        invalid();
    const local = clock(rest.slice(0, zone.index), false);
    const offset = clock(zone[2], true);
    if (offset >= dayMicros)
        invalid();
    const result = epoch + local - (zone[1] === '-' ? -offset : offset);
    if (result < midnight(1, 1, 1) || result >= midnight(9999, 12, 31) + dayMicros)
        overflow();
    return result;
}
export function claimTimeString(micros) {
    if (micros < midnight(1, 1, 1) || micros >= midnight(9999, 12, 31) + dayMicros)
        overflow();
    const milliseconds = micros >= 0n ? micros / 1000n : (micros - 999n) / 1000n;
    return new Date(Number(milliseconds)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
