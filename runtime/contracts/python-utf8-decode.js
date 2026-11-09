import { PythonUnicodeDecodeError } from "./python-byte-errors.js";
export function decodePythonUtf8(bytes) {
    const points = [];
    const fail = (start, end, reason) => {
        throw new PythonUnicodeDecodeError("utf-8", bytes, start, end, reason);
    };
    for (let index = 0; index < bytes.length;) {
        const first = bytes[index];
        if (first < 0x80) {
            points.push(first);
            index++;
            continue;
        }
        const width = first >= 0xc2 && first <= 0xdf ? 2
            : first >= 0xe0 && first <= 0xef ? 3
                : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
        if (!width)
            fail(index, index + 1, "invalid start byte");
        // CPython's surrogatepass handler handles a complete encoded surrogate only.
        // Otherwise preserve the strict decoder's failure at its second-byte check.
        const second = bytes[index + 1];
        if (first === 0xed && second !== undefined && second >= 0xa0 && second <= 0xbf) {
            const third = bytes[index + 2];
            if (third === undefined || third < 0x80 || third > 0xbf) {
                fail(index, index + 1, "invalid continuation byte");
            }
            points.push((first & 15) * 4096 + (second & 63) * 64 + (third & 63));
            index += 3;
            continue;
        }
        let point = first & (width === 2 ? 31 : width === 3 ? 15 : 7);
        for (let offset = 1; offset < width; offset++) {
            const byte = bytes[index + offset];
            if (byte === undefined)
                fail(index, index + offset, "unexpected end of data");
            const lower = offset === 1 && first === 0xe0 ? 0xa0
                : offset === 1 && first === 0xf0 ? 0x90 : 0x80;
            const upper = offset === 1 && first === 0xf4 ? 0x8f : 0xbf;
            if (byte < lower || byte > upper)
                fail(index, index + offset, "invalid continuation byte");
            point = point * 64 + (byte & 63);
        }
        points.push(point);
        index += width;
    }
    return points;
}
