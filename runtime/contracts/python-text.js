/** Explicit Python codepoint text; adjacent surrogate points are never merged. */
export class PythonText {
    #points;
    constructor(points) {
        if (!Array.isArray(points))
            throw new TypeError("Codepoints must be an array");
        const copy = Array.from(points);
        for (const point of copy) {
            if (typeof point !== "number")
                throw new TypeError("Codepoints must be numbers");
            if (!Number.isInteger(point) || point < 0 || point > 0x10ffff) {
                throw new RangeError("Codepoint must be an integer from 0 through 0x10ffff");
            }
        }
        this.#points = Object.freeze(copy.map(point => point === 0 ? 0 : point));
        Object.freeze(this);
    }
    static fromCodePoints(points) {
        return new PythonText(points);
    }
    /** Interpret JavaScript pairs as scalars; lone surrogates remain codepoints. */
    static fromJavaScript(text) {
        if (typeof text !== "string")
            throw new TypeError("JavaScript text must be a string");
        const points = [];
        for (const character of text)
            points.push(character.codePointAt(0));
        return new PythonText(points);
    }
    get codePoints() { return this.#points; }
    get length() { return this.#points.length; }
    equals(other) { return this.compare(other) === 0; }
    compare(other) {
        if (!(other instanceof PythonText) || !(#points in other))
            throw new TypeError("Expected PythonText");
        const count = Math.min(this.length, other.length);
        for (let index = 0; index < count; index++) {
            if (this.#points[index] < other.#points[index])
                return -1;
            if (this.#points[index] > other.#points[index])
                return 1;
        }
        return this.length < other.length ? -1 : this.length > other.length ? 1 : 0;
    }
    concat(...others) {
        const points = Array.from(this.#points);
        for (const other of others) {
            if (!(other instanceof PythonText) || !(#points in other))
                throw new TypeError("Expected PythonText");
            for (const point of other.#points)
                points.push(point);
        }
        return new PythonText(points);
    }
    /** Collision-free content identity for explicit lookup; not encoded text. */
    contentKey() { return `python-text:${this.#points.map(point => point.toString(16)).join(",")}`; }
    encodeUtf8() {
        const start = this.#points.findIndex(point => point >= 0xd800 && point <= 0xdfff);
        if (start !== -1) {
            let end = start + 1;
            while (end < this.length && this.#points[end] >= 0xd800 && this.#points[end] <= 0xdfff)
                end++;
            throw new PythonUnicodeEncodeError(this, start, end);
        }
        const bytes = [];
        for (const point of this.#points) {
            if (point < 0x80)
                bytes.push(point);
            else if (point < 0x800)
                bytes.push(0xc0 | point >> 6, 0x80 | point & 0x3f);
            else if (point < 0x10000)
                bytes.push(0xe0 | point >> 12, 0x80 | point >> 6 & 0x3f, 0x80 | point & 0x3f);
            else
                bytes.push(0xf0 | point >> 18, 0x80 | point >> 12 & 0x3f, 0x80 | point >> 6 & 0x3f, 0x80 | point & 0x3f);
        }
        return Buffer.from(bytes);
    }
    [Symbol.toPrimitive]() { throw new TypeError("PythonText has no implicit string conversion"); }
    toString() { throw new TypeError("PythonText has no implicit string conversion"); }
    toJSON() { throw new TypeError("PythonText requires explicit JSON serialization"); }
}
export class PythonUnicodeEncodeError extends Error {
    encoding = "utf-8";
    reason = "surrogates not allowed";
    object;
    start;
    end;
    constructor(object, start, end) {
        const position = end - start === 1
            ? `character '\\u${object.codePoints[start].toString(16).padStart(4, "0")}' in position ${start}`
            : `characters in position ${start}-${end - 1}`;
        super(`'utf-8' codec can't encode ${position}: surrogates not allowed`);
        this.name = "UnicodeEncodeError";
        this.object = object;
        this.start = start;
        this.end = end;
    }
}
