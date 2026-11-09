/** Error identity remains extensible so callers can compose exception context. */
export class PythonUnicodeDecodeError extends Error {
    encoding;
    start;
    end;
    reason;
    #bytes;
    constructor(encoding, bytes, start, end, reason) {
        const location = end - start === 1
            ? `byte 0x${bytes[start].toString(16).padStart(2, "0")} in position ${start}`
            : `bytes in position ${start}-${end - 1}`;
        super(`'${encoding}' codec can't decode ${location}: ${reason}`);
        this.name = "UnicodeDecodeError";
        this.encoding = encoding;
        this.start = start;
        this.end = end;
        this.reason = reason;
        this.#bytes = Buffer.from(bytes);
    }
    get object() { return Buffer.from(this.#bytes); }
}
