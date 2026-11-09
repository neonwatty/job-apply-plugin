export class FilesystemEncodeError extends Error {
    constructor() {
        super("Filesystem path contains an unencodable surrogate");
        this.name = "UnicodeEncodeError";
    }
}
/** Python UTF-8 filesystem encoding with surrogateescape; NUL is legal here. */
export function filesystemEncode(value) {
    const chunks = [];
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (unit < 0xd800 || unit > 0xdfff)
            continue;
        if (unit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                index += 1;
                continue;
            }
            throw new FilesystemEncodeError();
        }
        if (unit < 0xdc80 || unit > 0xdcff)
            throw new FilesystemEncodeError();
        chunks.push(Buffer.from(value.slice(start, index), "utf8"));
        chunks.push(Buffer.from([unit - 0xdc00]));
        start = index + 1;
    }
    chunks.push(Buffer.from(value.slice(start), "utf8"));
    return Buffer.concat(chunks);
}
/** Decode valid UTF-8 scalars; retain every invalid byte as U+DC80–U+DCFF. */
export function filesystemDecode(bytes) {
    const output = [];
    let index = 0;
    while (index < bytes.length) {
        const first = bytes[index];
        if (first < 0x80) {
            output.push(String.fromCharCode(first));
            index += 1;
            continue;
        }
        const length = first >= 0xc2 && first <= 0xdf ? 2
            : first >= 0xe0 && first <= 0xef ? 3
                : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
        let valid = length !== 0 && index + length <= bytes.length;
        for (let offset = 1; valid && offset < length; offset += 1) {
            const next = bytes[index + offset];
            if (next < 0x80 || next > 0xbf)
                valid = false;
        }
        const second = bytes[index + 1];
        if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second >= 0xa0)
            || (first === 0xf0 && second < 0x90) || (first === 0xf4 && second >= 0x90))
            valid = false;
        if (!valid) {
            output.push(String.fromCharCode(0xdc00 + first));
            index += 1;
            continue;
        }
        let scalar = first & (length === 2 ? 0x1f : length === 3 ? 0x0f : 0x07);
        for (let offset = 1; offset < length; offset += 1) {
            scalar = (scalar << 6) | (bytes[index + offset] & 0x3f);
        }
        output.push(String.fromCodePoint(scalar));
        index += length;
    }
    return output.join("");
}
